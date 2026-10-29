// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Access tokens from an OpenID Connect identity provider, as a credential for
 * the whole API.
 *
 * A browser application that signs a user in with the provider's authorization
 * code flow holds an RFC 9068 access token (a JWT) for this API. It sends it as
 * `Authorization: Bearer <JWT>`; this path verifies it with the shared identity
 * client (discovery and the issuer's key set, `packages/utils/src/identity`) and
 * nothing in this file reads a signature or a key.
 *
 *   - The token must be typed `at+jwt`, name this API as its audience and carry
 *     the API scope. The typing refuses an ID token (typed `JWT`, issued to the
 *     application); the scope refuses a token issued for some other purpose to the
 *     same audience (a connector's, which carries its own scope).
 *   - The caller is the token's `sub`, named as the issuer wrote it. A subject
 *     that is blank, padded, too long, has a control character or is one of the
 *     owners the API itself uses for a caller it did not authenticate is refused,
 *     not repaired: it becomes the owner of every row, so two distinct subjects
 *     must never name one owner.
 *   - The user model is the one the connector token and Kubernetes mode produce:
 *     `sub` is the user id and the roles are `default` only (but for the opt-in below). Whatever the token says
 *     in `roles` or `groups` is not copied: a provider shared with other applications
 *     can define a role named `system-admin` (or `system-admin-readonly`) that means
 *     something else there, and copying it would make that caller a platform
 *     operator of every tenant's sessions. Enabling this path alone never grants admin.
 *     There is no session key behind a token, so `platformKey` and `virtualKey` are empty.
 *   - The one way a token's role becomes the caller's role is an operator naming it in
 *     `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` (default: none; only `system-admin` and
 *     `system-admin-readonly` can be named). Even then a role is adopted only when all
 *     three hold: the operator named it, the token (already verified as the configured
 *     issuer's, for this audience) claims it, and the provider's RFC 7662 answer for
 *     that token, now, is active, names the same subject and lists it. The provider
 *     is not asked at all for a token that claims none of the named roles. When the
 *     provider cannot be asked the caller is a plain user for that request: never the
 *     token's claim, and not a 503 either, so an outage costs an administrator the
 *     admin pages and nothing else. A token the provider says is inactive is refused.
 *   - A token cannot be revoked by checking it locally, so it is good until it
 *     expires (minutes). With `CLAW_IDENTITY_TOKEN_INTROSPECT` on, the provider is
 *     also asked whether it is still active, and a revoked grant stops at once.
 *
 * Off unless `CLAW_IDENTITY_TOKEN_AUTH_ENABLED` is on and the identity client is
 * built; with either missing this path abstains and the request is judged by the
 * credentials it already had.
 */
import type { FastifyRequest } from "fastify";
import pino from "pino";
import { IdentityUnavailableError, JwtVerificationError } from "@claw/utils";
import type { UserInfo } from "./models.js";
import { envBool } from "../config.js";
import { identityClient } from "./identity.js";
import type { CredentialOutcome } from "./middleware.js";
import { isApiKey } from "./safe-client.js";

const logger = pino({ name: "auth" });

/** What the audit trail and the request's auth log name as the way the caller was authenticated. */
export const IDENTITY_TOKEN_METHOD = "identity_token";

const ABSENT: CredentialOutcome = { status: "absent" };
// Three base64url segments (the signature may be empty: an unsigned token is shaped like a JWT and refused as one).
// An `ak-` key, a cookie or any other opaque credential does not look like this.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const MAX_SUBJECT_CHARS = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Owners the API itself uses for a caller it did not authenticate (the fallback owner of a row, an anonymous
// workbench, the development bypass). A token whose subject is one of them would be that owner, so it is refused.
const RESERVED_SUBJECTS: ReadonlySet<string> = new Set(["default", "anonymous", "dev-user"]);

/** The only roles a token can bring with it, in the order a caller's roles list them. Nothing else is ever adopted. */
export const ADOPTABLE_ROLES: readonly string[] = ["system-admin", "system-admin-readonly"];

export interface IdentityTokenSettings {
  enabled: boolean;
  /** The `aud` the token must name. */
  audience: string;
  /** The scope the token must carry. */
  scope: string;
  /** Also ask the provider whether the token is still active. */
  introspect: boolean;
  /** The platform roles the operator lets a provider-confirmed token confer. Always a subset of {@link ADOPTABLE_ROLES}. */
  trustedRoles: string[];
}

function setting(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

/**
 * Read on each use rather than once, so what a request is judged by is what the
 * environment says now.
 *
 *   CLAW_IDENTITY_TOKEN_AUTH_ENABLED  switch the path on (also needs IDENTITY_CLIENT_ENABLED)
 *   CLAW_IDENTITY_TOKEN_AUDIENCE      the `aud` the token must name, default claw-api
 *   CLAW_IDENTITY_TOKEN_SCOPE         the scope the token must carry, default claw.api
 *   CLAW_IDENTITY_TOKEN_INTROSPECT    also ask the provider whether the token is still active
 *   CLAW_IDENTITY_TOKEN_TRUSTED_ROLES comma- or space-separated platform roles a confirmed token may
 *                                     confer (system-admin, system-admin-readonly); default none
 */
export function identityTokenSettings(): IdentityTokenSettings {
  return {
    enabled: envBool("CLAW_IDENTITY_TOKEN_AUTH_ENABLED", false),
    audience: setting("CLAW_IDENTITY_TOKEN_AUDIENCE", "claw-api"),
    scope: setting("CLAW_IDENTITY_TOKEN_SCOPE", "claw.api"),
    introspect: envBool("CLAW_IDENTITY_TOKEN_INTROSPECT", false),
    trustedRoles: trustedRoles(process.env.CLAW_IDENTITY_TOKEN_TRUSTED_ROLES),
  };
}

/**
 * The adoptable roles an operator named. A name that is not one of
 * {@link ADOPTABLE_ROLES} is ignored, not an error and not adopted: the setting can
 * make a provider's administrators this API's administrators and nothing else.
 */
function trustedRoles(raw: string | undefined): string[] {
  const named = new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
  return ADOPTABLE_ROLES.filter((r) => named.has(r));
}

function refuse(status: number, legacyError: string, message: string): CredentialOutcome {
  return { status: "rejected", error: { status, legacyError, anthropicType: "authentication_error", message } };
}

/** The space-delimited `scope` claim of RFC 9068 (an array is tolerated), as a list. */
function scopesOf(claim: unknown): string[] {
  if (typeof claim === "string") return claim.split(/\s+/).filter(Boolean);
  if (Array.isArray(claim)) return claim.filter((s): s is string => typeof s === "string");
  return [];
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The operator-named roles that a claim lists, in {@link ADOPTABLE_ROLES} order. Only a string array counts. */
function claimedTrustedRoles(trusted: readonly string[], claim: unknown): string[] {
  if (!Array.isArray(claim)) return [];
  return trusted.filter((r) => claim.includes(r));
}

/**
 * Path: an identity provider's access token in `Authorization: Bearer`.
 *
 * `absent` unless the feature is on, the identity client is built, and the
 * bearer value is shaped like a JWT (and is not an `ak-` key). Once it is, the
 * answer is final: a token that does not verify is `rejected` and is never
 * retried as some other kind of credential.
 *
 * Exported for tests and for the middleware. The first two parameters match the
 * other credential paths; this one needs neither SaFE nor a cookie.
 */
export async function verifyIdentityAccessToken(
  req: FastifyRequest,
  _verifier: unknown,
  pathname: string,
): Promise<CredentialOutcome> {
  const settings = identityTokenSettings();
  if (!settings.enabled) return ABSENT;
  const identity = identityClient();
  if (!identity) return ABSENT;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return ABSENT;
  const token = header.slice(7).trim();
  // An `ak-` key is verified by its own path whatever it looks like.
  if (isApiKey(token) || !JWT_SHAPE.test(token)) return ABSENT;

  const reject = (reason: string, outcome: CredentialOutcome): CredentialOutcome => {
    logger.warn({ path: pathname, reason }, "auth.identity_token.rejected");
    return outcome;
  };
  try {
    const { claims } = await identity.verifyJwt(token, { audience: settings.audience, typ: "at+jwt" });
    if (!scopesOf(claims.scope).includes(settings.scope)) {
      return reject("scope", refuse(403, "insufficient_scope", `the access token needs the ${settings.scope} scope`));
    }
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!sub || sub.length > MAX_SUBJECT_CHARS || sub !== sub.trim() || CONTROL_CHARS.test(sub) || RESERVED_SUBJECTS.has(sub)) {
      return reject("subject", refuse(401, "invalid_token", "the access token names no usable subject"));
    }
    // The roles the operator named that this token claims. Only these need the provider's word.
    const claimed = claimedTrustedRoles(settings.trustedRoles, claims.roles);
    let adopted: string[] = [];
    if (settings.introspect || claimed.length > 0) {
      let answer: Awaited<ReturnType<typeof identity.introspect>> | undefined;
      try {
        answer = await identity.introspect(token, { tokenTypeHint: "access_token" });
      } catch (err) {
        // With introspection required the provider being down is a 503 (below). With it asked only to confirm a
        // role, the request is still a valid token's: a plain user, never the claim.
        if (settings.introspect || !(err instanceof IdentityUnavailableError)) throw err;
        logger.warn({ path: pathname, reason: err.reason }, "auth.identity_token.roles_unconfirmed");
      }
      if (answer) {
        if (!answer.active || (answer.sub !== undefined && answer.sub !== sub)) {
          return reject("inactive", refuse(401, "invalid_token", "the access token is no longer active"));
        }
        // The provider's own list, for this subject: an answer that does not name the subject confirms nothing.
        if (answer.sub === sub) adopted = claimed.filter((r) => answer.roles.includes(r));
      }
    }
    const user: UserInfo = {
      userId: sub,
      userName: (text(claims.name) || text(claims.preferred_username) || text(claims.email) || sub).slice(0, MAX_SUBJECT_CHARS),
      // The token's `roles` claim is not copied: see the header. What is added is `adopted`, which the operator
      // named, the token claimed and the provider confirmed just now. Otherwise `default` only, as the
      // connector-token path and Kubernetes mode.
      roles: ["default", ...adopted],
      platformKey: "",
      virtualKey: "",
    };
    return { status: "verified", user, method: IDENTITY_TOKEN_METHOD };
  } catch (err) {
    if (err instanceof JwtVerificationError) {
      return reject(err.reason, refuse(401, "invalid_token", `the access token was refused (${err.reason})`));
    }
    if (err instanceof IdentityUnavailableError) {
      // Not "the token is bad": the provider could not be asked, so nobody is told to re-authenticate.
      logger.warn({ path: pathname, reason: err.reason }, "auth.identity_token.provider_unavailable");
      return {
        status: "rejected",
        error: {
          status: 503, legacyError: "authentication_service_unavailable", anthropicType: "api_error",
          message: "cannot reach the identity provider to verify the access token",
        },
      };
    }
    throw err;
  }
}
