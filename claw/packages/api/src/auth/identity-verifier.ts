// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Caller verification against the identity service (CLAW_AUTH_PROVIDER=identity).
 *
 * The same calls as {@link SafeClient} (`verifyCookie`, `verifyApiKey`), so the credential paths of the
 * middleware are unchanged; only who answers differs.
 *
 *   - Every credential is judged by the identity service's RFC 7662 introspection: an `ak-` key, or the session
 *     token of the `Token` cookie (with its `userType`). The caller is the answer's `sub`; the roles are the
 *     answer's `roles` (the user's groups plus `default`).
 *   - The platform key of an `ak-` caller is the key it presented. The platform key of a session caller is the
 *     one the identity service keeps for the user, read with that session from `GET /api/v1/apikeys/platform`
 *     on the origin of IDENTITY_INTROSPECTION_URL and kept here per user. A user without one is refused with
 *     {@link PlatformKeyMissingError}.
 *   - There is no virtual key: LLM calls use the platform key through SaFE's LLM proxy.
 *
 * Failures are reported with the error classes of {@link SafeClient}, so the middleware maps them the same way:
 * the identity service that cannot be reached is a 503, a client it refuses is a 500, a refused credential a 401.
 */
import { IdentityUnavailableError, type IdentityClient, type IntrospectionResult } from "@claw/utils";
import type { UserInfo } from "./models.js";
import {
  AuthServiceMisconfiguredError,
  AuthUpstreamUnreachableError,
  SafeUpstreamHttpError,
  SafeUpstreamProtocolError,
  isApiKey,
} from "./safe-client.js";

const PLATFORM_KEY_PATH = "/api/v1/apikeys/platform";
const PLATFORM_KEY_TTL_MS = 60_000;
const MAX_PLATFORM_KEYS = 1000;
const MAX_NAME_CHARS = 128;

type Introspect = Pick<IdentityClient, "introspect">;

/** The identity service holds no platform key for the session user. */
export class PlatformKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformKeyMissingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
type ActiveAnswer = Extract<IntrospectionResult, { active: true }>;

/**
 * The identity service's own address: the origin of its introspection endpoint (IDENTITY_INTROSPECTION_URL), which
 * also serves the platform key endpoint. Empty when that is not a usable http(s) URL.
 */
export function identityServiceOrigin(introspectionUrl: string | undefined): string {
  try {
    const u = new URL((introspectionUrl ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

/** Verifies callers with the identity service and resolves their platform keys. */
export class IdentityVerifier {
  private platformKeys = new Map<string, { key: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly identity: Introspect,
    private readonly apiUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Verify an `ak-` key; the key itself is the caller's platform key. */
  async verifyApiKey(apiKey: string): Promise<UserInfo> {
    if (!isApiKey(apiKey)) throw new Error("invalid API key format");
    const answer = await this.introspect(apiKey, {}, "invalid or expired API key");
    if (answer.tokenType !== "api_key") throw new Error("invalid or expired API key");
    return userOf(answer, apiKey);
  }

  /** Verify the session token of a `Token` cookie and resolve the user's platform key with it. */
  async verifyCookie(token: string, userType = ""): Promise<UserInfo> {
    if (!token) throw new Error("empty Token cookie");
    const answer = await this.introspect(token, userType ? { user_type: userType } : {}, "invalid or expired cookie");
    if (answer.tokenType !== "session") throw new Error("invalid or expired cookie");
    const key = await this.platformKeyOf(answer.sub ?? "", token, userType);
    return userOf(answer, key);
  }

  /** Introspect a credential; an inactive answer is `invalidMsg`, an unreachable service an upstream error. */
  private async introspect(token: string, params: Record<string, string>, invalidMsg: string): Promise<ActiveAnswer> {
    let answer: IntrospectionResult;
    try {
      answer = await this.identity.introspect(token, { params });
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
    if (!answer.sub) throw new SafeUpstreamProtocolError("the identity service returned no subject");
    return answer;
  }

  /** The platform key of `userId`, from the cache or read with the user's session; concurrent reads share one per session. */
  private async platformKeyOf(userId: string, token: string, userType: string): Promise<string> {
    const cached = this.platformKeys.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.key;
    const flightKey = `${userType}\n${token}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;
    const flight = this.fetchPlatformKey(userId, token, userType).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, flight);
    return flight;
  }

  /** Ask the identity service for the session user's platform key and keep it. */
  private async fetchPlatformKey(userId: string, token: string, userType: string): Promise<string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (userType) headers.UserType = userType;
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.apiUrl.replace(/\/+$/, "")}${PLATFORM_KEY_PATH}`, {
        method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AuthUpstreamUnreachableError("cannot reach the identity service to read the platform key", err);
    }
    if (resp.status === 404) {
      throw new AuthServiceMisconfiguredError("the identity service does not serve platform keys (needs API_KEY_MODE=local and CREDENTIAL_KEYS_FILE)");
    }
    if (!resp.ok) throw new SafeUpstreamHttpError({ status: resp.status, bodySnippet: "" });
    let body: Record<string, unknown>;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      throw new SafeUpstreamProtocolError("the identity service answered the platform key with a body that is not JSON", err);
    }
    const key = typeof body?.apiKey === "string" ? body.apiKey : "";
    if (body?.userId !== userId || (key !== "" && !isApiKey(key))) {
      throw new SafeUpstreamProtocolError("the identity service answered the platform key without the session user's key");
    }
    if (key === "") throw new PlatformKeyMissingError("the identity service holds no platform key for this user");
    if (this.platformKeys.size >= MAX_PLATFORM_KEYS) {
      const oldest = this.platformKeys.keys().next().value;
      if (oldest !== undefined) this.platformKeys.delete(oldest);
    }
    this.platformKeys.set(userId, { key, expiresAt: Date.now() + PLATFORM_KEY_TTL_MS });
    return key;
  }
}

/** The caller an active introspection answer names, with its platform key. */
function userOf(answer: ActiveAnswer, platformKey: string): UserInfo {
  const userId = answer.sub ?? "";
  const roles = answer.roles.includes("default") ? answer.roles : ["default", ...answer.roles];
  return {
    userId,
    userName: (answer.name || answer.preferredUsername || answer.username || answer.email || userId).slice(0, MAX_NAME_CHARS),
    ...(answer.email ? { email: answer.email } : {}),
    roles,
    platformKey,
    virtualKey: "",
  };
}
