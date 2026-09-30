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
import { SANDBOX_HANDS_VIA_ROUTER, SANDBOX_ROUTER_URL } from "../config.js";

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

/** The configured Router bases, in configured order; empty when none is set. */
export function sandboxRouterBases(): readonly string[] {
  return CONFIGURED_BASES;
}

/** Whether Hands is reached through the Router rather than by cluster DNS. */
export function handsViaRouter(): boolean {
  return SANDBOX_HANDS_VIA_ROUTER && CONFIGURED_BASES.length > 0;
}

/**
 * The Hands base URL for a SaFE workload: the Router's port proxy when
 * `handsViaRouter()`, the sandbox's cluster DNS name otherwise (unchanged).
 */
export function safeHandsBaseUrl(namespace: string, workloadId: string, port: string): string {
  if (!handsViaRouter()) return `http://${workloadId}.${namespace}.svc.cluster.local:${port}`;
  const base = orderedBases(CONFIGURED_BASES)[0];
  return `${base}/v1/namespaces/${encodeURIComponent(namespace)}/code-interpreters/`
    + `${encodeURIComponent(workloadId)}/invocations/proxy/${port}`;
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
  const order = orderedBases(bases);
  // A body that cannot be replayed gets exactly one try, on the likeliest base.
  const tries = replayable(init?.body) ? order : order.slice(0, 1);
  let lastErr: unknown;
  for (const base of tries) {
    if (init?.signal?.aborted) break;
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
  throw lastErr ?? new Error("request aborted before any sandbox router was tried");
}

/**
 * Wrap a fetch so a URL on one of `bases` fails over to the others. Any other
 * URL, or a `Request` object, passes straight through.
 */
export function withRouterFailover<F extends (input: any, init?: any) => Promise<any>>(
  fetchImpl: F,
  bases: () => readonly string[] = sandboxRouterBases,
): F {
  const wrapped = (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    const list = bases();
    if (url === null || list.length < 2) return fetchImpl(input, init);
    const base = list.find((b) => url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`));
    if (!base) return fetchImpl(input, init);
    return fetchThroughRouters(list, url.slice(base.length), init, (u, i) => fetchImpl(u, i));
  };
  return wrapped as unknown as F;
}

/** Forget which base answered last. Tests only. */
export function resetRouterPreferenceForTest(): void {
  preferredByList.clear();
}
