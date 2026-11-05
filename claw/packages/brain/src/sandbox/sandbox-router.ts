// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where SaFE-mode requests to the sandbox Router go, and what happens when one
 * of its addresses is down.
 *
 * SANDBOX_ROUTER_URL may name several bases for the same Router -- typically
 * one per gateway node when the Router is in another cluster and reached by
 * node address, with no name that fails over on its own. A request goes to the
 * base that last answered and moves to the next only when no connection could
 * be opened. Anything after a connection opened -- a refused status, a reset
 * mid-response, a timeout waiting for the answer -- is returned or thrown as
 * is: by then the request may have run, and an exec sent twice runs twice.
 *
 * Hands URLs built on one of these bases (see `safeHandsBaseUrl`) get the same
 * failover through `withRouterFailover`, which rewrites only the base and keeps
 * the rest of the URL, so a Hands URL stored while one node was up keeps
 * working after that node goes away.
 */
import pino from "pino";
import { routedHandsSessionId } from "@claw/protocol";
import {
  SAFE_API_URL,
  SANDBOX_CPU_NAMESPACE,
  SANDBOX_CPU_ROUTER_URL,
  SANDBOX_HANDS_VIA_ROUTER,
  SANDBOX_ROUTER_AUTH_ENABLED,
  SANDBOX_ROUTER_URL,
} from "../config.js";

const logger = pino({ name: "sandbox-router" });

/** Comma- or whitespace-separated bases, trailing slashes dropped, duplicates removed. */
export function parseRouterBases(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const base = normalizeBase(part.trim());
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

// Written the way `new URL(...).href` writes it, so a URL a caller built from
// one of these still starts with it after the fetch layer normalises it
// (a default port dropped, a host lower-cased).
function normalizeBase(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

const CONFIGURED_BASES = parseRouterBases(SANDBOX_ROUTER_URL);
// The Router of the CPU workspace's cluster, when that is another cluster than the
// one CONFIGURED_BASES fronts (a Router answers only for its own cluster's sandboxes).
const CPU_BASES = parseRouterBases(SANDBOX_CPU_ROUTER_URL);

/** The configured Router bases, in configured order; empty when none is set. */
export function sandboxRouterBases(): readonly string[] {
  return CONFIGURED_BASES;
}

/**
 * The Router bases for a sandbox in `namespace`: SANDBOX_CPU_ROUTER_URL for the CPU
 * workspace when one is set, SANDBOX_ROUTER_URL for every other namespace (and for
 * all of them when no CPU Router is configured, which is today's behaviour).
 */
export function sandboxRouterBasesFor(namespace?: string | null): readonly string[] {
  const ns = namespace?.trim() ?? "";
  if (ns !== "" && ns === SANDBOX_CPU_NAMESPACE.trim() && CPU_BASES.length > 0) return CPU_BASES;
  return CONFIGURED_BASES;
}

/** Whether Hands of a sandbox in `namespace` is reached through the Router rather than by cluster DNS. */
export function handsViaRouter(namespace?: string | null): boolean {
  return SANDBOX_HANDS_VIA_ROUTER && sandboxRouterBasesFor(namespace).length > 0;
}

/**
 * The Hands base URL for a SaFE workload: the Router's port proxy when
 * `handsViaRouter()`, the sandbox's cluster DNS name otherwise (unchanged).
 */
export function safeHandsBaseUrl(namespace: string, workloadId: string, port: string): string {
  if (!handsViaRouter(namespace)) return `http://${workloadId}.${namespace}.svc.cluster.local:${port}`;
  const base = orderedBases(sandboxRouterBasesFor(namespace))[0];
  return `${base}/v1/namespaces/${encodeURIComponent(namespace)}/code-interpreters/`
    + `${encodeURIComponent(workloadId)}/invocations/proxy/${port}`;
}

/**
 * The Router base a port-proxy URL is built on: the configured Router for the
 * sandbox's namespace (the one that last answered, when several are listed), else
 * the public ingress `${SAFE_API_URL}/sandbox` that `exec` falls back to. Null when
 * neither is set.
 */
export function routerBaseForPortProxy(namespace?: string | null): string | null {
  const configured = orderedBases(sandboxRouterBasesFor(namespace))[0];
  if (configured) return configured;
  const api = SAFE_API_URL.trim().replace(/\/+$/, "");
  return api ? `${api}/sandbox` : null;
}

// Errors that mean the request never left: nothing listened, nothing routed,
// the name did not resolve, or the connection did not open in time.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** True only when `err` shows the request could not have reached the server. */
export function isConnectFailure(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    // undici wraps the socket error in `cause`; happy-eyeballs dials report
    // every attempt in an AggregateError, and only all of them failing counts.
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && errors.every((x) => visit(x))) return true;
    return visit((e as { cause?: unknown }).cause);
  };
  return visit(err);
}

// Which base answered last, per list. Module state because every caller of a
// list benefits from what any of them learned.
const preferredByList = new Map<string, string>();

function orderedBases(bases: readonly string[]): string[] {
  const preferred = preferredByList.get(bases.join(","));
  if (!preferred || !bases.includes(preferred)) return [...bases];
  return [preferred, ...bases.filter((b) => b !== preferred)];
}

function replayable(body: unknown): boolean {
  return body === undefined || body === null || typeof body === "string"
    || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams;
}

type FetchLike<R> = (input: string, init?: RequestInit) => Promise<R>;

/**
 * Fetch `suffix` (path and query, starting with "/") from the first base that
 * accepts a connection, starting with the one that last did.
 */
export async function fetchThroughRouters<R>(
  bases: readonly string[],
  suffix: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike<R>,
): Promise<R> {
  if (bases.length === 0) throw new Error("no sandbox router base configured");
  // One base is one address: the request goes exactly as it did before lists.
  if (bases.length === 1) return fetchImpl(`${bases[0]}${suffix}`, init);
  // A followed redirect would open a second connection whose failure looks
  // like a connect failure although the first hop already received the
  // request. The Router never redirects, so a 3xx is handed back as an answer
  // instead of being followed.
  if ((init?.redirect ?? "follow") === "follow") init = { ...init, redirect: "manual" };
  const order = orderedBases(bases);
  // A body that cannot be replayed gets exactly one try, on the likeliest base.
  const tries = replayable(init?.body) ? order : order.slice(0, 1);
  let lastErr: unknown;
  for (const base of tries) {
    if (init?.signal?.aborted) throw init.signal.reason ?? lastErr;
    try {
      const res = await fetchImpl(`${base}${suffix}`, init);
      preferredByList.set(bases.join(","), base);
      return res;
    } catch (err) {
      lastErr = err;
      if (!isConnectFailure(err)) throw err;
      logger.warn(
        { base, code: (err as { cause?: { code?: string } })?.cause?.code },
        "sandbox_router.connect_failed_trying_next",
      );
    }
  }
  throw lastErr;
}

/**
 * The SaFE key a routed Hands request presents to a Router that runs with
 * `--enable-auth`, per sandbox.
 *
 * Such a Router answers 401 to anything on its /v1 routes without a SaFE cookie
 * or `ak-` key, and 403 unless that key's user owns the sandbox (or is a full
 * admin). A routed Hands request carries only the per-sandbox Hands token, which
 * the Router cannot verify, so it would be refused. The key that may address a
 * sandbox is the one it was created with: its owner's platform key. Every place
 * that learns a Hands URL together with that key records it here, and
 * `withRouterFailover` -- which every routed Hands request in Brain goes through
 * -- puts it in `Authorization`. The Router strips `Authorization` before
 * forwarding, and Hands reads its own token from X-Hands-Token on a routed
 * request, so Hands sees exactly what it saw before.
 *
 * Only consulted while SANDBOX_ROUTER_AUTH_ENABLED is on: with auth off a
 * user's key is not sent anywhere it is not needed. Keyed by the Router session
 * id in the URL (the workload id), bounded, oldest forgotten first; a sandbox
 * whose key was forgotten is relearned the next time its entry is read, and
 * until then fails loudly with the Router's 401 rather than silently.
 */
const ROUTER_CREDENTIALS_MAX = 4096;
const routerCredentials = new Map<string, string>();

/** Remember the key that may address the sandbox at `handsUrl`. Ignores a direct URL or an empty key. */
export function rememberRouterCredential(handsUrl: unknown, platformKey: unknown): void {
  if (typeof handsUrl !== "string" || typeof platformKey !== "string") return;
  const key = platformKey.trim();
  const session = key ? routedHandsSessionId(handsUrl) : null;
  if (!session) return;
  routerCredentials.delete(session);
  routerCredentials.set(session, key);
  if (routerCredentials.size > ROUTER_CREDENTIALS_MAX) {
    const oldest = routerCredentials.keys().next().value;
    if (oldest !== undefined) routerCredentials.delete(oldest);
  }
}

/** Read per call, so a test can flip it; the environment sets it at boot. */
export const routerAuthSettings = { enabled: SANDBOX_ROUTER_AUTH_ENABLED };

/** The key to present for `url`, when the Router authenticates and one is known. */
export function routerCredentialFor(url: string): string | null {
  if (!routerAuthSettings.enabled) return null;
  const session = routedHandsSessionId(url);
  return session ? routerCredentials.get(session) ?? null : null;
}

/** Forget every remembered key. Tests only. */
export function resetRouterCredentialsForTest(): void {
  routerCredentials.clear();
}

// `init` with `Authorization` replaced, whatever shape its headers came in.
function withRouterAuthorization(init: RequestInit | undefined, key: string): RequestInit {
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((value, name) => { headers[name] = value; });
  headers.authorization = `Bearer ${key}`;
  return { ...init, headers };
}

/**
 * Wrap a fetch so a URL on one of `bases` fails over to the others. Any other
 * URL, or a `Request` object, passes straight through.
 *
 * A routed Hands URL also gets its sandbox owner's key in `Authorization` when
 * the Router authenticates (see `rememberRouterCredential`).
 */
export function withRouterFailover<F extends (input: any, init?: any) => Promise<any>>(
  fetchImpl: F,
  bases?: () => readonly string[],
): F {
  // Each list fronts one Router, so a URL fails over only within the list it belongs
  // to: the other list is another cluster's Router, which would answer 404 for it.
  const lists = (): ReadonlyArray<readonly string[]> =>
    bases ? [bases()] : [CONFIGURED_BASES, CPU_BASES];
  const wrapped = (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    if (url === null) return fetchImpl(input, init);
    const routerKey = routerCredentialFor(url);
    if (routerKey) init = withRouterAuthorization(init, routerKey);
    for (const list of lists()) {
      if (list.length < 2) continue;
      const base = list.find((b) => url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`));
      if (base) return fetchThroughRouters(list, url.slice(base.length), init, (u, i) => fetchImpl(u, i));
    }
    return fetchImpl(input, init);
  };
  return wrapped as unknown as F;
}

/** Forget which base answered last. Tests only. */
export function resetRouterPreferenceForTest(): void {
  preferredByList.clear();
}
