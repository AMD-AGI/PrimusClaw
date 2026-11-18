// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bot Framework inbound token validation (the Python Function's auth.py, which this replaces).
 *
 * Without this the function is an open relay: anyone who finds the URL could inject activities that the worker would
 * then treat as coming from a real Teams user. It is the single security control on the public surface, so it fails
 * closed on every error path.
 */
import type { Logger } from "@primusclaw/personal-agent";
import { ConnectorHosts, UnaddressableError } from "@primusclaw/personal-agent-teams/connector-hosts";

import { type Clock, type Env, type Fetch, SYSTEM_CLOCK } from "./env.js";
import { decode, JwtError, type VerificationKey } from "./jwt.js";
import { JwksCache } from "./keys.js";
import { get, type JsonObject, rstripChars, strip, truthy } from "./py.js";

export const DEFAULT_OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const DEFAULT_ISSUERS = "https://api.botframework.com";

/**
 * A refused request. `reason` is a category from the security event log (`token_rejected`); the message is for tests
 * and debugging only and is never logged, because parts of it come from the request.
 */
export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    message: string,
    readonly reason = "other",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The security event category of a failure. */
export function reasonOf(error: unknown): string {
  if (error instanceof JwtError) {
    switch (error.kind) {
      case "ExpiredSignatureError":
        return "expired";
      case "ImmatureSignatureError":
        return "not_yet_valid";
      case "InvalidAudienceError":
        return "audience";
      case "InvalidSignatureError":
        return "bad_signature";
      default:
        return "malformed"; // not a JWT, a missing claim, an algorithm other than RS256, ...
    }
  }
  // No published key has the token's kid, the key set could not be read, or the OpenID metadata could not be fetched.
  return "key_unavailable";
}

/** The signing-key source `validateToken` asks; tests replace `client`. */
export interface KeySource {
  client(): Promise<{ getSigningKeyFromJwt(token: string): Promise<VerificationKey> }>;
}

export interface AuthSettings {
  openidConfigUrl: string;
  issuers: readonly string[];
  serviceUrlHosts: ConnectorHosts;
}

/** The settings auth.py reads at import: BOT_OPENID_CONFIG_URL, BOT_TOKEN_ISSUERS and the serviceUrl allow-list. */
export function authSettings(env: Env, logger: Logger): AuthSettings {
  return {
    openidConfigUrl: env["BOT_OPENID_CONFIG_URL"] ?? DEFAULT_OPENID_CONFIG_URL,
    // Overridable as a ";"-separated list so an issuer surprise is a config change rather than a redeploy.
    issuers: (env["BOT_TOKEN_ISSUERS"] ?? DEFAULT_ISSUERS)
      .split(";")
      .map((issuer) => strip(issuer))
      .filter((issuer) => issuer),
    // The serviceUrl hosts an inbound activity may name, and so where replies (and the bot's token) may go.
    serviceUrlHosts: ConnectorHosts.fromSettings(env["BOT_SERVICE_URL_HOSTS"], env["BOT_SERVICE_URL_SUFFIXES"], logger),
  };
}

export class Auth {
  readonly issuers: readonly string[];
  readonly serviceUrlHosts: ConnectorHosts;
  jwks: KeySource;

  constructor(
    settings: AuthSettings,
    fetchImpl: Fetch,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    this.issuers = settings.issuers;
    this.serviceUrlHosts = settings.serviceUrlHosts;
    this.jwks = new JwksCache(settings.openidConfigUrl, fetchImpl, clock);
  }

  /**
   * Validate the inbound bearer token and bind it to the activity's serviceUrl. Returns the token's claims; throws
   * AuthError on anything suspicious.
   */
  async validate(authorization: string | null | undefined, appId: string, serviceUrl: unknown): Promise<JsonObject> {
    const claims = await this.validateToken(authorization, appId);
    // The serviceUrl claim binds the token to the endpoint the reply will be sent to. The Bot Connector puts it in
    // every token it sends a bot, so a token or an activity without one is refused.
    const claimed = truthy(get(claims, "serviceurl")) ? get(claims, "serviceurl") : get(claims, "serviceUrl");
    if (!truthy(claimed) || typeof claimed !== "string") {
      throw new AuthError("token has no serviceUrl claim", "service_url");
    }
    if (!truthy(serviceUrl) || typeof serviceUrl !== "string") {
      throw new AuthError("activity has no serviceUrl", "service_url");
    }
    if (rstripChars(claimed, "/") !== rstripChars(serviceUrl, "/")) {
      throw new AuthError("serviceUrl claim does not match activity", "service_url");
    }
    try {
      this.serviceUrlHosts.check(serviceUrl);
    } catch (error) {
      if (!(error instanceof UnaddressableError)) throw error;
      throw new AuthError(`serviceUrl is not allowed: ${error.message}`, "service_url", { cause: error });
    }
    return claims;
  }

  /**
   * Validate the bearer token alone (signature, expiry, audience, issuer). Not enough to accept an activity: that
   * needs `validate`, which also binds the token to the activity's serviceUrl. This is for a request whose body is not
   * an activity at all, which is refused either way and only needs to know whether the caller authenticated.
   */
  async validateToken(authorization: string | null | undefined, appId: string): Promise<JsonObject> {
    if (!appId) throw new AuthError("bot app id is not configured", "not_configured");
    if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
      throw new AuthError("missing bearer token", "missing_token");
    }
    const token = strip(authorization.slice(authorization.indexOf(" ") + 1));
    let claims: JsonObject;
    try {
      const signingKey = await (await this.jwks.client()).getSigningKeyFromJwt(token);
      claims = await decode(token, signingKey, appId, this.clock.time());
    } catch (error) {
      throw new AuthError(
        `token rejected: ${error instanceof Error ? error.message : String(error)}`,
        reasonOf(error),
        {
          cause: error,
        },
      );
    }
    const issuer = get(claims, "iss");
    if (typeof issuer !== "string" || !this.issuers.includes(issuer)) {
      throw new AuthError(`unexpected issuer ${JSON.stringify(issuer)}`, "issuer");
    }
    return claims;
  }
}
