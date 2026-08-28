// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  SafeClient,
  isApiKey,
  AuthUpstreamUnreachableError,
  AuthServiceMisconfiguredError,
  SafeUpstreamHttpError,
} from "./safe-client.js";
import type { UserInfo } from "./models.js";
import { SAFE_API_URL, APP_ENV, MEMORY_LLM_BASE_URL, isKubernetesMode } from "../config.js";
import { cacheUserLlmKey } from "../llm/client.js";
import { resolveUserLlmKey, usePlatformKeyForLlm } from "../llm/key-source.js";
import { ByokInvalidKeyError, ByokRateLimitError, ByokUpstreamUnavailableError, verifyByokKey } from "./byok.js";
import { constantTimeEquals } from "@claw/utils";
import pino from "pino";

const logger = pino({ name: "auth" });

let _client: SafeClient | null = null;

function getClient(): SafeClient | null {
  if (!_client && SAFE_API_URL) _client = new SafeClient(SAFE_API_URL);
  return _client;
}

function isDevMode(): boolean {
  return ["dev", "development", "local"].includes(APP_ENV.toLowerCase());
}

let devBypassWarned = false;

/**
 * Whether to skip SaFE verification and inject a synthetic admin user.
 *
 * This requires an explicit `CLAW_INSECURE_DEV_AUTH=1` opt-in *in addition* to a
 * dev `APP_ENV`. Keying it off `APP_ENV` alone was unsafe: `APP_ENV=dev` is the
 * value shipped in `.env.example`, so any deployment that copied the example
 * file served every anonymous caller a `system-admin` identity.
 */
function devAuthBypassEnabled(): boolean {
  const optIn = (process.env.CLAW_INSECURE_DEV_AUTH ?? "").trim() === "1";
  if (!optIn) return false;
  if (!isDevMode()) {
    if (!devBypassWarned) {
      devBypassWarned = true;
      logger.error({ APP_ENV }, "auth.dev_bypass.refused_outside_dev_app_env");
    }
    return false;
  }
  if (!devBypassWarned) {
    devBypassWarned = true;
    logger.warn(
      { APP_ENV },
      "auth.dev_bypass.ENABLED — CLAW_INSECURE_DEV_AUTH=1: authentication is DISABLED and " +
        "every request is treated as a system-admin. Never set this outside local development.",
    );
  }
  return true;
}

// Routes that must remain anonymous (k8s probes, infra health checks,
// A2A agent discovery). The A2A v1.0 well-known path is `agent-card.json`;
// `agent.json` is the v0.x legacy path kept for backward compatibility.
//
// The agent card is served under both the root and the `/a2a/` prefix, so both
// spellings are listed. The A2A JSON-RPC endpoint is registered as `POST /a2a`
// (no trailing slash) and is deliberately absent from this list, so it
// authenticates like the rest of the API.
//
// This used to be an `ANONYMOUS_PATHS.has(pathname) || pathname.startsWith("/a2a/")`
// check. That prefix did not actually exempt `POST /a2a` — `"/a2a"` does not
// start with `"/a2a/"`, and `ignoreTrailingSlash` is off, so `POST /a2a/` 404s
// rather than reaching the handler anonymously. What the prefix did do was make
// any *future* route under `/a2a/` anonymous by default. Enumerating the three
// genuinely public paths removes that trap without changing which routes
// authenticate today.
const ANONYMOUS_PATHS = new Set([
  "/health",
  "/metrics",
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
  "/a2a/.well-known/agent-card.json",
  "/a2a/.well-known/agent.json",
  "/a2a/health",
]);

/**
 * Whether `pathname` skips the global SaFE authentication in
 * {@link authMiddleware}.
 *
 * `/v1/internal/*` is included because it is not anonymous so much as
 * *differently* authenticated: every route under that prefix attaches its own
 * preHandler, verifying either the Brain's per-task token
 * (`internalTaskAuth`, routes/internal-tasks.ts) or the cluster-wide
 * `AUTH_INTERNAL_TOKEN` (`internalAuth`, routes/admin.ts).
 *
 * Two tests hold the two halves of that claim, and they are not
 * interchangeable. auth-anonymous-paths.test.ts pins this function, so no path
 * joins the set by accident — but a `true` here only says the global middleware
 * steps aside, which for the internal prefix is the permissive direction.
 * internal-routes-auth.test.ts is the one that matters for it: it registers the
 * real route modules and asserts every discovered `/v1/internal/` route both
 * carries a preHandler and answers 401 without credentials. A new route added
 * under the prefix without an auth preHandler fails there, rather than being
 * served to anyone.
 */
export function isAnonymousPath(pathname: string): boolean {
  return ANONYMOUS_PATHS.has(pathname) || pathname.startsWith("/v1/internal/");
}

/**
 * Routes a browser reaches by plain navigation (`<a href>` / `window.open`) and
 * which therefore may carry the API key as a `?token=` query parameter. Kept as
 * narrow as possible — see Path 2 in {@link authMiddleware}.
 */
const BROWSER_DOWNLOAD_PATH_RE =
  /^\/v1\/sessions\/[^/]+\/(files\/.+|zip-tasks\/[^/]+\/download)$/;

export function isBrowserDownloadPath(pathname: string): boolean {
  return BROWSER_DOWNLOAD_PATH_RE.test(pathname);
}

/**
 * The cluster token check that guards `/v1/internal/` routes.
 *
 * One implementation because there is nothing route-specific about it and three
 * copies of a comparison are three chances for one of them to drift into `===`.
 * `constantTimeEquals` already refuses an empty presented token and an empty
 * expected one, so an unset AUTH_INTERNAL_TOKEN closes these routes rather than
 * opening them -- the failure direction that matters, since `isAnonymousPath`
 * waves the whole prefix past the global middleware and this preHandler is what
 * is left.
 *
 * Not for the per-run task endpoints: those compare against a token minted for
 * one run, which is a different question with a different answer.
 */
export async function internalTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!constantTimeEquals(presented, process.env.AUTH_INTERNAL_TOKEN ?? "")) {
    return reply.status(401).send({ ok: false, error: "internal auth required" }) as never;
  }
}

/**
 * Standard API error body: ``{ ok: false, error, message }``.
 * Used by auth middleware and by route ``mapServiceError`` helpers.
 */
export function authErrorPayload(error: string, message: string): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
}

/**
 * Anthropic Managed Agents compatibility error body:
 * ``{ type: "error", error: { type, message } }``. Only used under
 * `/anthropic/*` so the @anthropic-ai/sdk client parses errors the same way
 * it would against the real Anthropic API.
 */
export function anthropicErrorPayload(type: string, message: string): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

/** True for the Anthropic Managed Agents compatibility route prefix. */
export function isAnthropicPath(pathname: string): boolean {
  return pathname.startsWith("/anthropic/");
}

/**
 * Send an auth-related error response, choosing the Anthropic error shape
 * under `/anthropic/*` and the legacy Primus `{ok:false}` shape everywhere
 * else. Must run before the route handler so `/anthropic/*` callers never
 * see the non-standard Primus error body on an auth failure.
 */
function sendAuthError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  legacyError: string,
  anthropicType: string,
  message: string,
): FastifyReply {
  const pathname = authLogPath(req.url);
  if (isAnthropicPath(pathname)) {
    return reply.status(status).send(anthropicErrorPayload(anthropicType, message));
  }
  return reply.status(status).send(authErrorPayload(legacyError, message));
}

/** Strip query credentials before a request target reaches any auth log. */
export function authLogPath(url: string): string {
  return url.split("?")[0];
}

/** The SaFE calls the credential paths need. Narrowed so tests can pass a stub. */
export type CredentialVerifier = Pick<SafeClient, "verifyCookie" | "verifyApiKey">;

/** An error response a credential path asks {@link authMiddleware} to send. */
type AuthErrorSpec = {
  status: number;
  legacyError: string;
  anthropicType: string;
  message: string;
};

/**
 * What one credential path concluded.
 *
 * `absent` means "this kind of credential was not presented", and is the only
 * outcome that lets the next path run. A presented-but-unverifiable credential
 * is `rejected`: falling through on it would let a caller with a bad cookie be
 * authenticated by a different header, and would report the wrong failure.
 */
export type CredentialOutcome =
  | { status: "verified"; user: UserInfo; method: string }
  | { status: "rejected"; error: AuthErrorSpec }
  | { status: "absent" };

const ABSENT: CredentialOutcome = { status: "absent" };

/**
 * Map a SaFE verification failure onto the response to send.
 *
 * "cannot reach SaFE" and "SaFE says this credential is invalid" are different
 * facts and get different statuses: a 401 for an unreachable dependency sends
 * users off to re-authenticate against a service that is down.
 */
function verificationFailureSpec(
  e: unknown,
  unreachableMessage: string,
  invalidLegacyError: string,
): AuthErrorSpec {
  if (e instanceof AuthUpstreamUnreachableError) {
    return {
      status: 503,
      legacyError: "authentication_service_unavailable",
      anthropicType: "api_error",
      message: unreachableMessage,
    };
  }
  if (e instanceof AuthServiceMisconfiguredError) {
    return {
      status: 500,
      legacyError: "authentication_misconfigured",
      anthropicType: "api_error",
      message: (e as Error).message,
    };
  }
  return {
    status: 401,
    legacyError: invalidLegacyError,
    anthropicType: "authentication_error",
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Upstream details worth logging when SaFE rejects or cannot be reached. */
function verificationFailureLogFields(e: unknown): Record<string, unknown> {
  const up = e instanceof SafeUpstreamHttpError ? e : null;
  return {
    errMessage: e instanceof Error ? e.message : String(e),
    errStack: e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : "",
    safeApiUrl: SAFE_API_URL,
    upstreamStatus: up?.status ?? null,
    upstreamRequestId: up?.requestId ?? null,
    upstreamBody: up?.bodySnippet ?? null,
  };
}

const UNREACHABLE_FOR_API_KEY =
  "cannot reach SaFE to verify the API key (check SAFE_API_URL, AUTH_INTERNAL_TOKEN, and network). " +
  "This is not an invalid-key response from SaFE.";

/**
 * Path 1: SaFE session cookie.
 *
 * Exported for tests. The four credential paths are separate functions so each
 * one can be driven directly with a stub verifier, and so the middleware body
 * shows the order they are tried in rather than 150 lines of interleaved
 * extraction, verification and error mapping.
 */
export async function verifySessionCookie(
  req: FastifyRequest,
  client: CredentialVerifier,
  pathname: string,
): Promise<CredentialOutcome> {
  const cookies = req.cookies as Record<string, string> | undefined;
  const tokenCookie = cookies?.Token;
  if (!tokenCookie) return ABSENT;

  const userTypeCookie = cookies?.userType;
  try {
    const user = await client.verifyCookie(tokenCookie, userTypeCookie || "");
    return { status: "verified", user, method: "cookie" };
  } catch (e: unknown) {
    logger.warn({
      path: pathname,
      userType: userTypeCookie || "(empty)",
      tokenLen: tokenCookie.length,
      ...verificationFailureLogFields(e),
    }, "auth.cookie.rejected");
    return {
      status: "rejected",
      error: verificationFailureSpec(
        e,
        "cannot reach SaFE to verify the session cookie (check SAFE_API_URL, AUTH_INTERNAL_TOKEN, and network).",
        "invalid_cookie",
      ),
    };
  }
}

/**
 * Path 2: `?token=` API key, restricted to the file-download routes.
 *
 * A browser navigating via `<a href>` / `window.open` cannot set an
 * Authorization header, so downloads need the key in the URL. URLs leak into
 * access logs, proxy logs, browser history and Referer headers, so this is
 * deliberately not accepted on the rest of the API — only where there is no
 * alternative.
 *
 * A key that fails verification here falls through rather than rejecting: the
 * same request may also carry a header credential, and on these routes the
 * query parameter is the fallback, not the primary scheme.
 *
 * Exported for tests.
 */
export async function verifyDownloadQueryToken(
  req: FastifyRequest,
  client: CredentialVerifier,
  pathname: string,
): Promise<CredentialOutcome> {
  if (!isBrowserDownloadPath(pathname)) return ABSENT;
  const queryToken = (req.query as Record<string, string> | undefined)?.token;
  if (!queryToken || !isApiKey(queryToken)) return ABSENT;

  try {
    const user = await client.verifyApiKey(queryToken);
    return { status: "verified", user, method: "query_token" };
  } catch (e: unknown) {
    logger.warn({
      path: pathname,
      errMessage: e instanceof Error ? e.message : String(e),
    }, "auth.query_token.rejected");
    return ABSENT;
  }
}

/**
 * Path 3: `Authorization: Bearer ak-...`.
 *
 * A Bearer value that is not an `ak-` key is left to the next path rather than
 * rejected, so a caller sending some other scheme still gets the
 * no-credentials response naming what this API accepts.
 *
 * Exported for tests.
 */
export async function verifyBearerApiKey(
  req: FastifyRequest,
  client: CredentialVerifier,
  pathname: string,
): Promise<CredentialOutcome> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return ABSENT;
  const token = authHeader.slice(7);
  if (!isApiKey(token)) return ABSENT;

  try {
    const user = await client.verifyApiKey(token);
    return { status: "verified", user, method: "api_key" };
  } catch (e: unknown) {
    logger.warn({
      path: pathname,
      tokenLen: token.length,
      ...verificationFailureLogFields(e),
    }, "auth.apikey.rejected");
    return {
      status: "rejected",
      error: verificationFailureSpec(e, UNREACHABLE_FOR_API_KEY, "invalid_api_key"),
    };
  }
}

/**
 * Path 4: `x-api-key` header — the @anthropic-ai/sdk default auth scheme.
 *
 * Same `ak-...` key format and SaFE verification as Path 3 (Bearer); only the
 * header name differs. Kept as its own path (rather than folded into Path 3) so
 * existing `/v1/*` clients that never send `x-api-key` are completely
 * unaffected.
 *
 * Exported for tests.
 */
export async function verifyXApiKeyHeader(
  req: FastifyRequest,
  client: CredentialVerifier,
  pathname: string,
): Promise<CredentialOutcome> {
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKeyHeaderValue = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (!apiKeyHeaderValue || !isApiKey(apiKeyHeaderValue)) return ABSENT;

  try {
    const user = await client.verifyApiKey(apiKeyHeaderValue);
    return { status: "verified", user, method: "x_api_key" };
  } catch (e: unknown) {
    logger.warn({
      path: pathname,
      ...verificationFailureLogFields(e),
    }, "auth.x_api_key.rejected");
    return {
      status: "rejected",
      error: verificationFailureSpec(e, UNREACHABLE_FOR_API_KEY, "invalid_api_key"),
    };
  }
}

/**
 * Attach a verified identity to the request.
 *
 * Also refreshes the per-user LLM key cache so background tasks (memory
 * extraction, profile update, skill evolution, summarization) can call the LLM
 * on this user's behalf. See llm/client.ts for the rationale.
 */
function grantVerifiedUser(req: FastifyRequest, user: UserInfo, method: string): void {
  logger.info({
    userId: user.userId, userName: user.userName,
    hasPlatformKey: !!user.platformKey,
    hasVirtualKey: !!user.virtualKey,
    method,
  }, "auth.verified");
  (req as any).user = user;
  const llmKey = resolveUserLlmKey(user);
  if (llmKey) cacheUserLlmKey(user.userId, llmKey, MEMORY_LLM_BASE_URL);
}

type CredentialPath = (
  req: FastifyRequest,
  client: CredentialVerifier,
  pathname: string,
) => Promise<CredentialOutcome>;

/**
 * The credential paths, in the order they are tried. Cookie first: a browser
 * session is the common case and the only path that cannot also arrive as a
 * header.
 *
 * Exported so the order is pinned by a test: moving the cookie path after a
 * header path would let a request with a stale cookie and a valid header
 * authenticate, which is the opposite of the fail-closed behaviour above.
 */
export const CREDENTIAL_PATHS: readonly CredentialPath[] = [
  verifySessionCookie,
  verifyDownloadQueryToken,
  verifyBearerApiKey,
  verifyXApiKeyHeader,
];

/** Fastify preHandler: always authenticate (dev mode bypasses with dev-user). */
export async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Anonymous allowlist — must be checked BEFORE dev bypass so probes never
  // see a synthetic user injected by dev mode either.
  //
  // `/v1/internal/*` is the Brain → Backend callback surface (agent_done /
  // event / backend-mcp). Every route under that prefix attaches its own
  // strict `internalTaskAuth` route-level preHandler that verifies the
  // per-task token via `claw_tasks.internal_token_hash`. Letting the global
  // SaFE auth middleware run first would reject the Brain's per-task token
  // (it is not an ak-... API key nor a SaFE Token cookie) and block every
  // task callback in production. Skipping here delegates auth to
  // `internalTaskAuth` for these routes only.
  //
  // The A2A JSON-RPC surface (`POST /a2a`) is not exempt: it creates sessions
  // and reads task history, so it authenticates like the rest of the API. Only
  // agent-card discovery and health are anonymous, since A2A discovery is
  // unauthenticated by spec. See {@link ANONYMOUS_PATHS}.
  const pathname = authLogPath(req.url);
  if (isAnonymousPath(pathname)) {
    return;
  }

  // Diagnostic: log what auth material reached the server. Cookie NAMES are
  // logged verbatim (non-sensitive); only value-length is surfaced to
  // distinguish "missing" from "present but malformed".
  const cookies = (req.cookies as Record<string, string> | undefined) ?? {};
  const cookieSummary: Record<string, number> = {};
  for (const [k, v] of Object.entries(cookies)) cookieSummary[k] = v?.length ?? 0;
  const rawCookieHeader = (req.headers.cookie ?? "") as string;
  const authHeaderRaw = req.headers.authorization ?? "";
  logger.info({
    // Never log the raw URL: legacy clients may authenticate with
    // `?token=ak-...`, and request logs are commonly shipped off-cluster.
    path: pathname,
    origin: req.headers.origin ?? null,
    host: req.headers.host ?? null,
    rawCookieLen: rawCookieHeader.length,
    parsedCookies: cookieSummary,
    hasAuthorization: authHeaderRaw.length > 0,
    authorizationScheme: authHeaderRaw.split(" ")[0] || null,
    devAuthBypass: devAuthBypassEnabled(),
  }, "auth.incoming");

  // Dev bypass, gated behind CLAW_INSECURE_DEV_AUTH=1. The dev-user is granted
  // `system-admin` so local harness work (task-dag platform trust, seed
  // scripts, etc.) does not need a real SaFE login.
  if (devAuthBypassEnabled()) {
    (req as any).user = {
      userId: "dev-user",
      userName: "Developer",
      roles: ["default", "system-admin"],
      platformKey: "",
      virtualKey: "",
    } satisfies UserInfo;
    return;
  }

  // kubernetes/BYOK mode: no SaFE auth. Verify the caller's own API key
  // against the LLM gateway before allowing metadata writes or sandbox create.
  // The same key flows on as the selected LLM source (virtualKey by default,
  // platformKey in proxy mode) and is injected into the sandbox.
  if (isKubernetesMode()) {
    const key = extractApiKey(req);
    if (!key) {
      return sendAuthError(req, reply, 401, "authentication_required", "authentication_error",
        "provide Bearer <api-key> or x-api-key header") as any;
    }
    let userId: string;
    try {
      userId = await verifyByokKey(key, req.ip);
    } catch (e: unknown) {
      if (e instanceof ByokInvalidKeyError) {
        return sendAuthError(req, reply, 401, "invalid_api_key", "authentication_error", "invalid BYOK API key") as any;
      }
      if (e instanceof ByokRateLimitError) {
        return sendAuthError(req, reply, 429, "rate_limited", "rate_limit_error", "too many BYOK verification attempts") as any;
      }
      if (e instanceof ByokUpstreamUnavailableError) {
        logger.warn({ errMessage: e.message }, "auth.byok_gateway_unavailable");
        return sendAuthError(req, reply, 503, "authentication_service_unavailable", "api_error",
          "cannot reach LLM gateway to verify the BYOK API key") as any;
      }
      if (e instanceof AuthServiceMisconfiguredError) {
        return sendAuthError(req, reply, 500, "authentication_misconfigured", "api_error", e.message) as any;
      }
      throw e;
    }
    const user = {
      userId,
      userName: userId,
      roles: ["default"],
      platformKey: usePlatformKeyForLlm() ? key : "",
      virtualKey: key,
    } satisfies UserInfo;
    (req as any).user = user;
    // Cache for background tasks; base url is the platform LLM gateway (DK2-A).
    cacheUserLlmKey(userId, resolveUserLlmKey(user), MEMORY_LLM_BASE_URL);
    return;
  }

  const client = getClient();
  if (!client) {
    return sendAuthError(req, reply, 500, "authentication_misconfigured", "api_error",
      "SAFE_API_URL is not configured; cannot authenticate") as any;
  }

  for (const verifyCredential of CREDENTIAL_PATHS) {
    const outcome = await verifyCredential(req, client, pathname);
    if (outcome.status === "verified") {
      grantVerifiedUser(req, outcome.user, outcome.method);
      return;
    }
    if (outcome.status === "rejected") {
      const { status, legacyError, anthropicType, message } = outcome.error;
      return sendAuthError(req, reply, status, legacyError, anthropicType, message) as any;
    }
  }

  logger.warn({
    path: pathname,
    parsedCookieNames: Object.keys(cookies),
    hasAuthorization: authHeaderRaw.length > 0,
  }, "auth.rejected.no_credentials");
  return sendAuthError(req, reply, 401, "authentication_required", "authentication_error",
    "provide Bearer API key (ak-...), x-api-key header, or Token cookie") as any;
}

/** Get user from request (set by authMiddleware). */
export function getUser(req: FastifyRequest): UserInfo | null {
  return (req as any).user ?? null;
}

/** Extract the caller's API key from Authorization: Bearer or x-api-key (BYOK mode). */
function extractApiKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  const v = Array.isArray(x) ? x[0] : x;
  return (v ?? "").trim();
}
