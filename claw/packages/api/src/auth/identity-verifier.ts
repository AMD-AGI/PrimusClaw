// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Caller verification against the identity service (CLAW_AUTH_PROVIDER=identity).
 *
 * The same calls as {@link SafeClient} (`verifyCookie`, `verifyApiKey`), so the credential paths of the
 * middleware are unchanged; only who answers differs.
 *
 *   - Every credential is judged by the identity service's RFC 7662 introspection with allowStale: false
 *     (a revoked credential is never accepted from cache during an outage): an `ak-` key, or the session
 *     token of the `Token` cookie (with its `userType`). The caller is the answer's `sub`. Its roles are
 *     `default` plus the answer's roles the operator lets the provider confer (CLAW_IDENTITY_TOKEN_TRUSTED_ROLES,
 *     a subset of {@link ADOPTABLE_ROLES}).
 *   - The platform key of an `ak-` caller is the key it presented. The platform key of a session caller is the
 *     one the identity service keeps for the user, read from `GET /api/v1/apikeys/platform` under
 *     IDENTITY_API_URL (or the base of IDENTITY_INTROSPECTION_URL) with that session and this API's identity
 *     client, and kept here per user for one minute. A user without one (404 or empty key) or whose key expired
 *     is refused with {@link PlatformKeyMissingError}.
 *   - virtualKey is empty. This provider requires LLM_KEY_SOURCE=platformKey so Engines and the sandbox use
 *     the platform key for the LLM gateway.
 *
 * Failures: an identity service that cannot be reached, or that answers with an error, is
 * {@link AuthUpstreamUnreachableError} or {@link IdentityUpstreamError} (503); one that refuses this API's
 * client is {@link AuthServiceMisconfiguredError} (500); a refused credential is a plain Error (401).
 */
import { IdentityUnavailableError, type IdentityClient, type IntrospectionResult } from "@claw/utils";
import type { UserInfo } from "./models.js";
import { AuthServiceMisconfiguredError, AuthUpstreamUnreachableError, isApiKey } from "./safe-client.js";

const PLATFORM_KEY_PATH = "/api/v1/apikeys/platform";
const INTROSPECTION_PATH = "/oauth/introspect";
const PLATFORM_KEY_TTL_MS = 60_000;
const MAX_PLATFORM_KEYS = 1000;
const MAX_NAME_CHARS = 128;

type Introspect = Pick<IdentityClient, "introspect">;
type ActiveAnswer = Extract<IntrospectionResult, { active: true }>;

/** The identity service holds no usable platform key for the session user. */
export class PlatformKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformKeyMissingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The identity service answered with an error or a body that is not an answer; it has not judged the credential. */
export class IdentityUpstreamError extends Error {
  constructor(message: string, readonly status: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdentityUpstreamError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The service client this API presents to the identity service when it reads a platform key. */
export interface IdentityServiceClient {
  clientId: string;
  clientSecret: string;
}

/** What an IdentityVerifier is built with. */
export interface IdentityVerifierOptions {
  /** Base URL of the identity HTTP APIs, without a trailing slash. */
  apiUrl: string;
  client: IdentityServiceClient;
  /** Platform roles the provider may confer; anything else in an answer is dropped. */
  trustedRoles: readonly string[];
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function httpUrl(raw: string | undefined): URL | null {
  try {
    const u = new URL((raw ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Base URL for identity HTTP APIs (platform key), without a trailing slash. IDENTITY_API_URL when set, path
 * included; otherwise IDENTITY_INTROSPECTION_URL without its `/oauth/introspect` suffix. Empty when neither is a
 * usable http(s) URL.
 */
export function identityApiBase(
  introspectionUrl: string | undefined,
  apiUrl: string | undefined = process.env.IDENTITY_API_URL,
): string {
  const explicit = (apiUrl ?? "").trim();
  if (explicit) {
    const u = httpUrl(explicit);
    return u ? `${u.origin}${u.pathname}`.replace(/\/+$/, "") : "";
  }
  const u = httpUrl(introspectionUrl);
  if (!u) return "";
  const path = u.pathname.replace(/\/+$/, "");
  const prefix = path.endsWith(INTROSPECTION_PATH) ? path.slice(0, -INTROSPECTION_PATH.length) : "";
  return `${u.origin}${prefix}`;
}

/** Verifies callers with the identity service and resolves their platform keys. */
export class IdentityVerifier {
  /** Display name and settings for messages and logs written about this verifier's failures. */
  readonly authProvider = {
    name: "the identity service",
    settings: "IDENTITY_INTROSPECTION_URL, IDENTITY_CLIENT_ID",
    logFields: { identityUrl: process.env.IDENTITY_INTROSPECTION_URL ?? "" },
  };
  private platformKeys = new Map<string, { key: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();
  private readonly apiUrl: string;
  private readonly clientToken: string;
  private readonly trusted: ReadonlySet<string>;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly identity: Introspect, opts: IdentityVerifierOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.clientToken = `${opts.client.clientId}:${opts.client.clientSecret}`;
    this.trusted = new Set(opts.trustedRoles);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Verify an `ak-` key; the key itself is the caller's platform key. */
  async verifyApiKey(apiKey: string): Promise<UserInfo> {
    if (!isApiKey(apiKey)) throw new Error("invalid API key format");
    const answer = await this.introspect(apiKey, {}, "invalid or expired API key");
    if (answer.tokenType !== "api_key") throw new Error("invalid or expired API key");
    return this.userOf(answer, apiKey);
  }

  /** Verify the session token of a `Token` cookie and resolve the user's platform key with it. */
  async verifyCookie(token: string, userType = ""): Promise<UserInfo> {
    if (!token) throw new Error("empty Token cookie");
    const answer = await this.introspect(token, userType ? { user_type: userType } : {}, "invalid or expired cookie");
    if (answer.tokenType !== "session") throw new Error("invalid or expired cookie");
    const key = await this.platformKeyOf(answer.sub ?? "", token, userType);
    return this.userOf(answer, key);
  }

  /** Introspect a credential; an inactive answer is `invalidMsg`, an unreachable service an upstream error. */
  private async introspect(token: string, params: Record<string, string>, invalidMsg: string): Promise<ActiveAnswer> {
    let answer: IntrospectionResult;
    try {
      // Primary auth must not accept a stale active answer during an identity outage.
      answer = await this.identity.introspect(token, { params, allowStale: false });
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        if (err.reason === "client_rejected") {
          throw new AuthServiceMisconfiguredError("the identity service refused this API's client; check IDENTITY_CLIENT_ID and its identity.introspect scope");
        }
        throw new AuthUpstreamUnreachableError("cannot reach the identity service (network, timeout or error answer)", err);
      }
      throw err;
    }
    if (!answer.active) throw new Error(invalidMsg);
    if (!answer.sub) throw new IdentityUpstreamError("the identity service returned no subject");
    return answer;
  }

  /** The platform key of `userId`, from the cache or read with the user's session; concurrent reads share one per session. */
  private async platformKeyOf(userId: string, token: string, userType: string): Promise<string> {
    const cached = this.platformKeys.get(userId);
    if (cached) {
      this.platformKeys.delete(userId);
      if (Date.now() < cached.expiresAt) {
        this.platformKeys.set(userId, cached);
        return cached.key;
      }
    }
    const flightKey = `${userType}\n${token}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;
    const flight = this.fetchPlatformKey(userId, token, userType).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, flight);
    return flight;
  }

  /** Keep a platform key as the most recently used entry, evicting the least recently used one when full. */
  private remember(userId: string, key: string): void {
    this.platformKeys.delete(userId);
    if (this.platformKeys.size >= MAX_PLATFORM_KEYS) {
      const oldest = this.platformKeys.keys().next().value;
      if (oldest !== undefined) this.platformKeys.delete(oldest);
    }
    this.platformKeys.set(userId, { key, expiresAt: Date.now() + PLATFORM_KEY_TTL_MS });
  }

  /** Ask the identity service for the session user's platform key and keep it. */
  private async fetchPlatformKey(userId: string, token: string, userType: string): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Internal-Token": this.clientToken,
      Accept: "application/json",
    };
    if (userType) headers.UserType = userType;
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.apiUrl}${PLATFORM_KEY_PATH}`, {
        method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AuthUpstreamUnreachableError("cannot reach the identity service to read the platform key", err);
    }
    if (resp.status === 404) throw new PlatformKeyMissingError("the identity service holds no platform key for this user");
    if (resp.status === 405) {
      throw new AuthServiceMisconfiguredError("the identity service does not serve platform keys (needs API_KEY_MODE=local and CREDENTIAL_KEYS_FILE)");
    }
    if (resp.status === 403) {
      const message = await errorMessageOf(resp);
      if (/expired/i.test(message)) throw new PlatformKeyMissingError("the user's platform key in the identity service has expired");
      throw new AuthServiceMisconfiguredError(
        "the identity service refused this API's client for the platform key; check IDENTITY_CLIENT_ID and its identity.introspect scope",
      );
    }
    // The session was just introspected as active, so any other refusal is not a verdict on the cookie.
    if (!resp.ok) throw new IdentityUpstreamError(`the identity service answered the platform key with HTTP ${resp.status}`, resp.status);
    let body: Record<string, unknown>;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      throw new IdentityUpstreamError("the identity service answered the platform key with a body that is not JSON", resp.status, { cause: err });
    }
    const key = typeof body?.apiKey === "string" ? body.apiKey : "";
    if (body?.userId !== userId || (key !== "" && !isApiKey(key))) {
      throw new IdentityUpstreamError("the identity service answered the platform key without the session user's key", resp.status);
    }
    if (key === "") throw new PlatformKeyMissingError("the identity service holds no platform key for this user");
    this.remember(userId, key);
    return key;
  }

  /** The caller an active introspection answer names, with its platform key and only the trusted roles. */
  private userOf(answer: ActiveAnswer, platformKey: string): UserInfo {
    const userId = answer.sub ?? "";
    return {
      userId,
      userName: (answer.name || answer.preferredUsername || answer.username || answer.email || userId).slice(0, MAX_NAME_CHARS),
      ...(answer.email ? { email: answer.email } : {}),
      roles: ["default", ...answer.roles.filter((r) => this.trusted.has(r))],
      platformKey,
      virtualKey: "",
    };
  }
}

/** The `errorMessage` of an identity error body, or empty. */
async function errorMessageOf(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { errorMessage?: unknown };
    return typeof body?.errorMessage === "string" ? body.errorMessage : "";
  } catch {
    return "";
  }
}
