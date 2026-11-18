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
 *     There is no session key behind a token, so the keys come from SaFE (next item).
 *   - In the SaFE deployment mode the caller's keys come from SaFE: `POST /api/v1/auth/verify`, asked
 *     for the platform key and the virtual key. Every per-user call the API makes (the LLM key a turn runs
 *     with, the key a sandbox is created with, what `GET /v1/me` reads) is built on those two, so one answer
 *     here serves all of them. SaFE is not shown the person's token: the API exchanges it at the identity
 *     provider (RFC 8693 service delegation, `delegated-keys.ts`) for a token for SaFE's audience that names
 *     this API as the acting party, and presents that. It needs the provider to have registered this API's
 *     service client for the exchange, and SaFE to accept that actor (see docs/identity-client.md). The
 *     answer must name the token's own `sub`, or its keys are somebody else's and are not used, and it is
 *     kept per person for at most the life the delegated token has left. A token that is itself delegated
 *     (RFC 8693 `act`) is not exchanged again, unless a service the operator named issued it (two items down). A SaFE or a provider that cannot be reached is a 503; a SaFE
 *     that does not accept the delegated token, or a provider that refuses the exchange, leaves the caller
 *     without keys and says so in the log. The token's roles are still not copied, and neither are SaFE's.
 *   - A delegated token has no keys of its own, and one exception: a service the operator named in
 *     `CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS` (default: none, compared exactly as the provider signed the token's
 *     `client_id`) may send the person's own `ak-` key in `x-api-key` beside it, so that a turn it starts runs on the
 *     person's own models and quota. SaFE verifies that key (as for any `ak-` key), and it is taken only when it is the
 *     token's subject's own; the request is judged by the token, so it is still an identity-token caller. Whoever
 *     asked for the key and does not get it is refused, never served keyless: a value that is not an `ak-` key, or
 *     that SaFE does not accept, is a 401 `invalid_api_key`, a key that is somebody else's is a 401
 *     `key_subject_mismatch`, SaFE not answering is a 503. A request from any other service, or with no
 *     `x-api-key`, is as it always was, and so is a token that is not delegated: the header is not read for it.
 *   - A delegated token of a service the operator named in `CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS` (default: none, compared
 *     exactly as the provider signed its `client_id`) that brings no key of the person's own has the keys SaFE holds for its subject,
 *     got as for a token that is not delegated: the API exchanges the service's token once more at the provider (which keeps the service
 *     in the new token's `act` chain) and shows SaFE the result. This is how a chat service that holds no key of the person (a chat
 *     user who never linked one) has the person's turns run on the person's own virtual key. A key the service does bring is the one used.
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
import { DelegatedKeys, safeFailureOf, type SaFeKeys } from "./delegated-keys.js";
import { identityClient } from "./identity.js";
import type { CredentialOutcome } from "./middleware.js";
import { isApiKey, type SafeClient } from "./safe-client.js";

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
  /** The `aud` of the token the API asks the provider for, to present to SaFE in the person's name. */
  delegationAudience: string;
  /** The scope of that token. */
  delegationScope: string;
  /** The services (client ids, compared as signed) whose delegated token may bring its subject's own key in `x-api-key`. */
  ownKeyClientIds: string[];
  /** The services (client ids, compared as signed) whose delegated token is exchanged once more for its subject's SaFE keys. */
  delegatedKeyClientIds: string[];
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
 *   CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE  the `aud` of the delegated token presented to SaFE, default primus-safe
 *   CLAW_IDENTITY_TOKEN_DELEGATION_SCOPE     its scope, default safe.api
 *   CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS   comma- or space-separated client ids of the services whose delegated token may bring
 *                                            the person's own `ak-` key in `x-api-key`; default none
 *   CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS  comma- or space-separated client ids of the services whose delegated token is
 *                                            exchanged once more for the keys SaFE holds for its subject; default none
 */
export function identityTokenSettings(): IdentityTokenSettings {
  return {
    enabled: envBool("CLAW_IDENTITY_TOKEN_AUTH_ENABLED", false),
    audience: setting("CLAW_IDENTITY_TOKEN_AUDIENCE", "claw-api"),
    scope: setting("CLAW_IDENTITY_TOKEN_SCOPE", "claw.api"),
    introspect: envBool("CLAW_IDENTITY_TOKEN_INTROSPECT", false),
    trustedRoles: trustedRoles(process.env.CLAW_IDENTITY_TOKEN_TRUSTED_ROLES),
    delegationAudience: setting("CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE", "primus-safe"),
    delegationScope: setting("CLAW_IDENTITY_TOKEN_DELEGATION_SCOPE", "safe.api"),
    ownKeyClientIds: parseClientIds(process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS),
    delegatedKeyClientIds: parseClientIds(process.env.CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS),
  };
}

/**
 * Client ids as an operator lists them, separated by commas or white space. Not lower-cased and not trimmed past the separators: a
 * client id is compared as the identity provider signed it, and `worker` and `Worker` are two clients.
 */
export function parseClientIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
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
 * What the token path asks of SaFE: the access-token verification, and the verification of an `ak-` key (only for a service that
 * may bring its subject's own). `null` where there is no SaFE (Kubernetes mode).
 */
export type TokenKeyVerifier = Partial<Pick<SafeClient, "verifyAccessToken" | "verifyApiKey">> | null;

// One cache of keys per SaFE client, which is one per process; a test that builds a new client starts with none.
const keyCaches = new WeakMap<object, DelegatedKeys>();

/** The request asked for the person's own key to be used and may not have it: the whole request is refused, never served without it. */
class OwnKeyRefused extends Error {
  constructor(readonly reason: string, readonly outcome: CredentialOutcome) {
    super(reason);
    this.name = "OwnKeyRefused";
  }
}

/**
 * The `x-api-key` this request brought, if it may bring one: its token is delegated and was issued to a service the operator named.
 * `undefined` for every other request, whose header is not read here at all (as it never was on this path). `""` is a header that is
 * there and empty: that is a key asked for and not given, so a refusal, not "no key".
 */
function ownKeyPresented(req: FastifyRequest, claims: Record<string, unknown>, clientId: string, settings: IdentityTokenSettings): string | undefined {
  if (claims.act === undefined || !clientId || !settings.ownKeyClientIds.includes(clientId)) return undefined;
  const header = req.headers["x-api-key"];
  if (header === undefined) return undefined;
  return (Array.isArray(header) ? header[0] ?? "" : header).trim();
}

/**
 * The keys of a person whose own `ak-` key a service brought along with its delegated token. The key is SaFE's to judge, as for any
 * `ak-` key, and it counts only when SaFE says it is the token's subject's: the same rule as for the keys got by delegation.
 */
async function ownKeysOf(verifier: TokenKeyVerifier, key: string, sub: string): Promise<SaFeKeys> {
  const verifyApiKey = verifier?.verifyApiKey?.bind(verifier);
  if (!verifyApiKey) {
    return { status: "misconfigured", message: "CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS needs SaFE to verify the key, and this deployment has none" };
  }
  if (!isApiKey(key)) throw new OwnKeyRefused("not_an_api_key", refuse(401, "invalid_api_key", "x-api-key must be the user's own API key (ak-...)"));
  let user: UserInfo;
  try {
    user = await verifyApiKey(key);
  } catch (err) {
    const failure = safeFailureOf(err);
    if (failure.status !== "none") return failure;
    throw new OwnKeyRefused(failure.reason, refuse(401, "invalid_api_key", "SaFE does not accept the x-api-key"));
  }
  if (user.userId !== sub) throw new OwnKeyRefused("key_of_another_user", refuse(401, "key_subject_mismatch", "the x-api-key is not the access token's user's own key"));
  if (!user.platformKey && !user.virtualKey) throw new OwnKeyRefused("key_without_keys", refuse(401, "invalid_api_key", "SaFE holds no keys for the x-api-key"));
  return { status: "keys", platformKey: user.platformKey, virtualKey: user.virtualKey };
}

/**
 * Ask SaFE for the keys of the person a verified token names, in the API's own name and theirs.
 *
 * The token has already been verified here (signature, audience, scope, the provider's
 * answer when that is asked for). It is not shown to SaFE: it is the proof the provider needs to
 * issue this API a token for SaFE's audience that acts for the person, and that token is what SaFE is
 * shown (`delegated-keys.ts`). A token that is itself delegated is not exchanged again: the question
 * has no useful answer for a party that was not sent the person's own token, unless the operator named the service it was issued to in
 * `CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS`: that token is exchanged as the person's own would be, and the provider keeps the
 * service in the chain of actors of the token SaFE is shown.
 *
 * `unavailable` is SaFE or the provider not being able to answer (unreachable, 5xx) and `misconfigured` is this
 * API not being able to ask (no `AUTH_INTERNAL_TOKEN`), as for a cookie or a key: neither is "no
 * keys", so the caller is told so rather than served as a keyless user. Everything
 * else (the provider refusing the exchange, SaFE's 401 or 403, an id that is not the subject) is `none`, with the reason for the log.
 *
 * A delegated token has no keys of its own, but a service the operator named may bring the person's own key
 * (`ownKeysOf`): what that asks of SaFE is a refusal of the request (`OwnKeyRefused`), never `none`.
 */
async function safeKeysOf(
  verifier: TokenKeyVerifier, identity: NonNullable<ReturnType<typeof identityClient>>, token: string, sub: string,
  claims: Record<string, unknown>, clientId: string, ownKey: string | undefined, settings: IdentityTokenSettings,
): Promise<SaFeKeys> {
  if (ownKey !== undefined) return ownKeysOf(verifier, ownKey, sub);
  const verifyAccessToken = verifier?.verifyAccessToken?.bind(verifier);
  if (!verifier || !verifyAccessToken) return { status: "none", reason: "no_safe" };
  if (claims.act !== undefined && !(clientId && settings.delegatedKeyClientIds.includes(clientId))) {
    return { status: "none", reason: "delegated_token" };
  }
  let cache = keyCaches.get(verifier);
  if (!cache) keyCaches.set(verifier, (cache = new DelegatedKeys()));
  return cache.keysOf(sub, token, { audience: settings.delegationAudience, scope: settings.delegationScope }, {
    identity, safe: { verifyAccessToken },
  });
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
 * other credential paths; the second is what SaFE is asked through, or `null` where
 * there is no SaFE.
 */
export async function verifyIdentityAccessToken(
  req: FastifyRequest,
  verifier: TokenKeyVerifier,
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
    // Exactly as signed, not trimmed: an allowlist compares it, and `worker` and
    // `worker ` are two clients (only a blank id is no id).
    const clientId = typeof claims.client_id === "string" && claims.client_id.trim() !== "" ? claims.client_id : "";
    const ownKey = ownKeyPresented(req, claims, clientId, settings);
    const keys = await safeKeysOf(verifier, identity, token, sub, claims, clientId, ownKey, settings);
    if (keys.status === "unavailable") {
      logger.warn({ path: pathname, source: keys.source }, "auth.identity_token.keys_unavailable");
      return {
        status: "rejected",
        error: {
          status: 503, legacyError: "authentication_service_unavailable", anthropicType: "api_error",
          message: keys.source === "safe"
            ? "cannot reach SaFE to look up the keys of the access token's user"
            : "cannot reach the identity provider to act for the access token's user",
        },
      };
    }
    if (keys.status === "misconfigured") {
      logger.error({ path: pathname }, "auth.identity_token.safe_misconfigured");
      return {
        status: "rejected",
        error: { status: 500, legacyError: "authentication_misconfigured", anthropicType: "api_error", message: keys.message },
      };
    }
    if (keys.status === "none" && keys.reason !== "no_safe") {
      // Not an error of the request, but this user has no key for model calls or sandboxes: the log is where that is visible.
      logger.warn({ path: pathname, userId: sub, reason: keys.reason }, "auth.identity_token.no_safe_keys");
    }
    const actorSub = text((claims.act as { sub?: unknown } | undefined)?.sub);
    if (ownKey !== undefined && keys.status === "keys") {
      // A person's own key used on a service's say: the log is where that is visible.
      logger.info({ path: pathname, userId: sub, clientId: clientId.slice(0, MAX_SUBJECT_CHARS) }, "auth.identity_token.own_key_used");
    }
    const user: UserInfo = {
      userId: sub,
      userName: (text(claims.name) || text(claims.preferred_username) || text(claims.email) || sub).slice(0, MAX_SUBJECT_CHARS),
      // The token's `roles` claim is not copied: see the header. What is added is `adopted`, which the operator
      // named, the token claimed and the provider confirmed just now. Otherwise `default` only, as the
      // connector-token path and Kubernetes mode.
      roles: ["default", ...adopted],
      platformKey: keys.status === "keys" ? keys.platformKey : "",
      virtualKey: keys.status === "keys" ? keys.virtualKey : "",
      ...(actorSub || clientId
        ? {
          delegation: {
            // The actor is only ever recorded, so it is clipped. The client id is also
            // compared (CLAW_A2A_IDENTITY_CLIENT_IDS), and a clipped value would let a
            // client whose id begins with an allowed one pass for it: it is the claim
            // as signed, and whoever records it clips its own copy.
            ...(actorSub ? { actorSub: actorSub.slice(0, MAX_SUBJECT_CHARS) } : {}),
            ...(clientId ? { clientId } : {}),
          },
        }
        : {}),
    };
    return { status: "verified", user, method: IDENTITY_TOKEN_METHOD };
  } catch (err) {
    if (err instanceof OwnKeyRefused) return reject(err.reason, err.outcome);
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

/** Why the credentials a service brought for the person a request names were not taken; the code is the HTTP answer's. */
export type ActingAsRefusal = { ok: false; status: 401 | 403 | 500 | 503; error: string; message: string };

/**
 * The person a review is asked of, from the credentials the asking service brought for them (`x-acting-as-token`, `x-acting-as-api-key`):
 * their delegated identity-provider token and their own `ak-` key. Nothing here trusts the service's word that the person is behind it:
 *
 *   - the token must verify as any access token does (type, audience, scope, subject; the provider's answer when introspection is on),
 *     must be delegated (`act`), and must name exactly the person asked of (`sub === actingAs`);
 *   - the service it was issued to must be in both lists an operator keeps for this: the services that may speak for a person
 *     (`allowedClients`, CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS) and the services that may bring a person's own key
 *     (CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS);
 *   - SaFE must accept the key and say it is the token subject's own (`ownKeysOf`, the same rule as for the requester's own key).
 *
 * What comes back is that person with their own keys, which the review's session is sealed with: the work is theirs and runs on their
 * quota. Only for this request; nothing is kept beyond the session it makes.
 */
export async function verifyActingAsCredentials(
  input: { token: string; apiKey: string; actingAs: string; allowedClients: readonly string[] },
  verifier: TokenKeyVerifier,
): Promise<{ ok: true; user: UserInfo } | ActingAsRefusal> {
  const no = (status: ActingAsRefusal["status"], error: string, message: string): ActingAsRefusal => {
    logger.warn({ reason: error, actingAs: input.actingAs.slice(0, MAX_SUBJECT_CHARS) }, "auth.acting_as.refused");
    return { ok: false, status, error, message };
  };
  const settings = identityTokenSettings();
  const identity = settings.enabled ? identityClient() : null;
  if (!identity) return no(503, "acting_as_unverifiable", "this deployment cannot verify a token of the person the review is asked of");
  const token = input.token.trim();
  if (!token || !input.apiKey.trim()) {
    return no(401, "acting_as_credentials_required", "a review asked of another person needs that person's delegated token and own key");
  }
  if (isApiKey(token) || !JWT_SHAPE.test(token)) return no(401, "invalid_acting_as_token", "x-acting-as-token is not an access token");
  try {
    const { claims } = await identity.verifyJwt(token, { audience: settings.audience, typ: "at+jwt" });
    if (!scopesOf(claims.scope).includes(settings.scope)) return no(401, "invalid_acting_as_token", "x-acting-as-token lacks the API scope");
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!sub || sub.length > MAX_SUBJECT_CHARS || sub !== sub.trim() || CONTROL_CHARS.test(sub) || RESERVED_SUBJECTS.has(sub)) {
      return no(401, "invalid_acting_as_token", "x-acting-as-token names no usable subject");
    }
    if (sub !== input.actingAs) return no(403, "acting_as_mismatch", "x-acting-as-token is not the token of the person the review is asked of");
    const clientId = typeof claims.client_id === "string" && claims.client_id.trim() !== "" ? claims.client_id : "";
    const actorSub = text((claims.act as { sub?: unknown } | undefined)?.sub);
    if (claims.act === undefined || !clientId) return no(403, "acting_as_not_delegated", "x-acting-as-token must be a service's delegated token");
    if (!input.allowedClients.includes(clientId) || !settings.ownKeyClientIds.includes(clientId)) {
      return no(403, "service_client_not_allowed", "the service that brought x-acting-as-token may not speak for another person");
    }
    if (settings.introspect) {
      const answer = await identity.introspect(token, { tokenTypeHint: "access_token" });
      if (!answer.active || (answer.sub !== undefined && answer.sub !== sub)) return no(401, "invalid_acting_as_token", "x-acting-as-token is no longer active");
    }
    const keys = await ownKeysOf(verifier, input.apiKey.trim(), sub);
    if (keys.status === "unavailable") return no(503, "acting_as_keys_unavailable", "cannot reach SaFE to verify x-acting-as-api-key");
    if (keys.status !== "keys") return no(500, "authentication_misconfigured", keys.status === "misconfigured" ? keys.message : "no keys");
    return {
      ok: true,
      user: {
        userId: sub,
        userName: (text(claims.name) || text(claims.preferred_username) || text(claims.email) || sub).slice(0, MAX_SUBJECT_CHARS),
        roles: ["default"],
        platformKey: keys.platformKey,
        virtualKey: keys.virtualKey,
        delegation: { ...(actorSub ? { actorSub: actorSub.slice(0, MAX_SUBJECT_CHARS) } : {}), clientId },
      },
    };
  } catch (err) {
    if (err instanceof OwnKeyRefused) {
      const e = err.outcome.status === "rejected" ? err.outcome.error : null;
      return no(401, e?.legacyError === "key_subject_mismatch" ? "key_subject_mismatch" : "invalid_acting_as_api_key",
        e?.legacyError === "key_subject_mismatch" ? "x-acting-as-api-key is not the key of the person the review is asked of" : "SaFE does not accept x-acting-as-api-key");
    }
    if (err instanceof JwtVerificationError) return no(401, "invalid_acting_as_token", `x-acting-as-token was refused (${err.reason})`);
    if (err instanceof IdentityUnavailableError) return no(503, "acting_as_unverifiable", "cannot reach the identity provider to verify x-acting-as-token");
    throw err;
  }
}
