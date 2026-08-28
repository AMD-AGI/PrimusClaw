// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { UserInfo } from "./models.js";
import { safePreview } from "@claw/utils";
import pino from "pino";

const log = pino({ name: "auth.safe" });

const API_KEY_PREFIX = "ak-";

// Cap the SaFE response body we capture into logs / error messages.
// SaFE error bodies are typically small JSON; 2KB is enough and bounds memory.
const MAX_BODY_SNIPPET = 2048;

// Response headers that commonly carry a correlation id on SaFE-side.
const REQUEST_ID_HEADERS = ["x-request-id", "x-trace-id", "x-correlation-id"];

// Read at most MAX_BODY_SNIPPET chars from a response body. Never throws.
//
// Redacted here rather than at each log site: the snippet is an upstream error
// body produced from a request that carried the caller's credential, and an
// upstream that echoes the offending value ("invalid token: ak-...") would
// otherwise put it straight into our logs.
async function readBodySnippet(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    const snippet = safePreview(text, MAX_BODY_SNIPPET);
    if (text.length <= MAX_BODY_SNIPPET) return snippet;
    return `${snippet}(truncated, total ${text.length} chars)`;
  } catch {
    return "(failed to read body)";
  }
}

function pickRequestId(resp: Response): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const v = resp.headers.get(name);
    if (v) return v;
  }
  return undefined;
}

/**
 * Thrown when the SaFE verify HTTP call fails (DNS, TLS, reset, timeout).
 * Distinct from invalid credentials — do not label as "API key verification failed".
 */
export class AuthUpstreamUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AuthUpstreamUnreachableError";
    Object.setPrototypeOf(this, new.target.prototype);
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/** Missing ``AUTH_INTERNAL_TOKEN`` or other preconditions before calling SaFE. */
export class AuthServiceMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthServiceMisconfiguredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * SaFE verify returned a non-2xx HTTP status (other than 401, which maps to a
 * plain invalid-credential error). Carries the upstream response details so
 * callers / logs can see *why* SaFE rejected the call (e.g. internal token
 * revoked -> 403 with a descriptive body).
 */
export class SafeUpstreamHttpError extends Error {
  public readonly status: number;
  public readonly bodySnippet: string;
  public readonly requestId?: string;
  constructor(opts: { status: number; bodySnippet: string; requestId?: string }) {
    const suffix = opts.bodySnippet ? `: ${opts.bodySnippet}` : "";
    super(`SaFE HTTP ${opts.status}${suffix}`);
    this.name = "SafeUpstreamHttpError";
    this.status = opts.status;
    this.bodySnippet = opts.bodySnippet;
    this.requestId = opts.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isUpstreamNetworkError(err: Error): boolean {
  const msg = (err.message || "").toLowerCase();
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  const causeMsg = (cause && typeof cause === "object" && "message" in cause
    ? String((cause as { message?: string }).message || "")
    : "").toLowerCase();
  const blob = `${msg} ${causeMsg}`;
  // AbortSignal.timeout() throws a DOMException named "TimeoutError" (NOT
  // "AbortError") with message "The operation was aborted due to timeout".
  // Treat both — plus textual fallbacks — as upstream-unreachable so a slow SaFE
  // is never misclassified as an invalid credential (and negatively cached).
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network|getaddrinfo|cert|tls|aborted|timed?\s?out/i.test(blob);
}
const CACHE_TTL = 300_000;
const NEGATIVE_TTL = 30_000;
const MAX_CACHE = 1000;
const VERIFY_PATH = "/api/v1/auth/verify";

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

interface CacheEntry { user: UserInfo | null; error: string | null; expiresAt: number; }

export class SafeClient {
  private cache = new Map<string, CacheEntry>();
  // Singleflight: coalesce concurrent verifications of the SAME credential into a
  // single upstream call. Without this, a burst of N requests sharing one API key
  // fires N SaFE verifies, overloading a slow upstream and tripping timeouts.
  private inflight = new Map<string, Promise<UserInfo>>();

  constructor(private baseUrl: string, private timeout = 10_000) {}

  private getCache(key: string): { user: UserInfo | null; hit: boolean } {
    const e = this.cache.get(key);
    if (!e || Date.now() > e.expiresAt) { this.cache.delete(key); return { user: null, hit: false }; }
    if (e.error) return { user: null, hit: true }; // Negative cache: hit but no user → throw cached error
    return { user: e.user, hit: true };
  }

  private setCache(key: string, user: UserInfo | null, error: string | null, ttl: number): void {
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { user, error, expiresAt: Date.now() + ttl });
  }

  private parseResponse(data: Record<string, unknown>): UserInfo {
    const d = (data.data ?? data) as Record<string, unknown>;
    const userId = (d.id as string) || "";
    if (!userId) throw new Error("SaFE returned empty user ID");
    return {
      userId,
      userName: (d.name as string) || "",
      roles: (d.roles as string[]) || [],
      platformKey: (d.platformKey as string) || (d.platform_key as string) || "",
      virtualKey: (d.virtualKey as string) || (d.virtual_key as string) || "",
    };
  }

  private headers(): Record<string, string> {
    // AUTH_INTERNAL_TOKEN doubles as the SaFE platform's internal auth token
    // (presented via X-Internal-Token header). Historically two separate vars
    // existed (SAFE_AUTH_TOKEN); they were unified to simplify rotation.
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const t = process.env.AUTH_INTERNAL_TOKEN;
    if (!t) {
      throw new AuthServiceMisconfiguredError(
        "AUTH_INTERNAL_TOKEN is not set; API cannot call SaFE verify",
      );
    }
    h["X-Internal-Token"] = t;
    return h;
  }

  private body(): Record<string, unknown> {
    return { includePlatformKey: true, includeVirtualKey: true };
  }

  // Cache-lookup + singleflight wrapper shared by the API-key and cookie paths.
  // Warm cache hits (positive or negative) return before touching the in-flight
  // map; concurrent misses for the same credential await one shared upstream call.
  private async verify(
    cacheKey: string,
    payload: Record<string, unknown>,
    invalidMsg: string,
  ): Promise<UserInfo> {
    const { user: cached, hit } = this.getCache(cacheKey);
    if (hit && cached) return cached;
    if (hit) throw new Error("recently failed verification (cached)");

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const flight = this.doVerify(cacheKey, payload, invalidMsg).finally(() => {
      this.inflight.delete(cacheKey);
    });
    this.inflight.set(cacheKey, flight);
    return flight;
  }

  // Single upstream verify call. Timeouts / network faults surface as
  // AuthUpstreamUnreachableError (mapped to 503, NOT negatively cached) so a slow
  // SaFE never blacklists a valid credential for NEGATIVE_TTL.
  private async doVerify(
    cacheKey: string,
    payload: Record<string, unknown>,
    invalidMsg: string,
  ): Promise<UserInfo> {
    try {
      const resp = await fetch(`${this.baseUrl}${VERIFY_PATH}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (resp.status === 401) throw new Error(invalidMsg);
      if (!resp.ok) {
        const bodySnippet = await readBodySnippet(resp);
        const requestId = pickRequestId(resp);
        log.warn({
          method: cacheKey.startsWith("cookie:") ? "cookie" : "apiKey",
          url: `${this.baseUrl}${VERIFY_PATH}`,
          status: resp.status,
          upstreamRequestId: requestId ?? null,
          upstreamBody: bodySnippet,
          contentType: resp.headers.get("content-type") ?? null,
        }, "auth.safe.upstream_error");
        throw new SafeUpstreamHttpError({ status: resp.status, bodySnippet, requestId });
      }
      const user = this.parseResponse(await resp.json() as Record<string, unknown>);
      this.setCache(cacheKey, user, null, CACHE_TTL);
      return user;
    } catch (e: unknown) {
      if (e instanceof AuthServiceMisconfiguredError) throw e;
      const err = e instanceof Error ? e : new Error(String(e));
      if (isUpstreamNetworkError(err)) {
        throw new AuthUpstreamUnreachableError(
          "cannot reach SaFE authentication service (network or timeout)",
          err,
        );
      }
      this.setCache(cacheKey, null, err.message, NEGATIVE_TTL);
      throw err;
    }
  }

  async verifyApiKey(apiKey: string): Promise<UserInfo> {
    if (!isApiKey(apiKey)) throw new Error("invalid API key format");
    return this.verify(apiKey, { ...this.body(), apiKey }, "invalid or expired API key");
  }

  async verifyCookie(token: string, userType = ""): Promise<UserInfo> {
    if (!token) throw new Error("empty Token cookie");
    let cookieStr = `Token=${token}`;
    if (userType) cookieStr += `; userType=${userType}`;
    return this.verify(`cookie:${token}`, { ...this.body(), cookie: cookieStr }, "invalid or expired cookie");
  }
}
