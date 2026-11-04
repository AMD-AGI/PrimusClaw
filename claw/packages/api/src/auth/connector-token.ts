// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Access tokens for connectors.
 *
 * A connector is a program on a user's machine that talks to the connector side
 * of remote agents (`remote-agents/connector-routes.ts`). Beside the credentials
 * the whole API accepts, those routes accept `Authorization: Bearer <JWT>`, an
 * RFC 9068 access token the identity provider issued for this API and for this
 * purpose. It is verified here with the shared identity client; nothing in this
 * file reads a signature or a key.
 *
 *   - It authenticates on the four connector-side routes and nowhere else. On
 *     any other route this path does not run, the bearer value is not an `ak-`
 *     key, and the request is refused like any request with no credential.
 *   - The caller is the token's `sub`. Its roles are `default`: whatever
 *     the token says about groups or roles is not copied, so a connector never
 *     acts as an administrator. Every remote-agents row is owned by the caller's
 *     id, and the user's own clients are owned by the id their credential
 *     resolves to, so `sub` must be that same id; nothing here can check it,
 *     because this process has no second source for the user's id (see
 *     docs/remote-agents.md).
 *   - The token must name this API as its audience, be typed `at+jwt`, and carry
 *     the connector scope. A token for another audience or purpose is refused.
 *   - A token cannot be revoked by checking it locally, so it is good until it
 *     expires (minutes). With `CLAW_CONNECTOR_TOKEN_INTROSPECT` on, the provider
 *     is also asked whether it is still active (cached for a few seconds by the
 *     client), and a revoked grant stops being honoured at once.
 *
 * Off unless remote agents and the identity client are both on; with either off
 * this path abstains and the request is judged by the credentials it already had.
 */
import type { FastifyRequest } from "fastify";
import pino from "pino";
import { IdentityUnavailableError, JwtVerificationError } from "@claw/utils";
import { CLAW_REMOTE_AGENTS_ENABLED, connectorTokenSettings } from "../config.js";
import { isConnectorSideRoute } from "../remote-agents/connector-routes.js";
import { identityClient } from "./identity.js";
import type { CredentialOutcome } from "./middleware.js";
import { getAuthExpiry, getAuthMethod } from "./request-credential.js";

const logger = pino({ name: "auth" });

/** What `req` records as the way the caller was authenticated, and what the audit trail names. */
export const CONNECTOR_TOKEN_METHOD = "connector_token";

/** The scope an access token needs to act as a connector. */
export const CONNECTOR_TOKEN_SCOPE = "claw.connector";

const ABSENT: CredentialOutcome = { status: "absent" };
// Three base64url segments. An `ak-` key, a cookie or any other opaque credential does not look like this.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const MAX_SUBJECT_CHARS = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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

/**
 * Path 0: a connector's access token, on a connector-side route.
 *
 * `absent` unless this is such a route, the feature is on, and the bearer value
 * is shaped like a JWT. Once it is, the answer is final: a token that does not
 * verify is `rejected` and is never retried as some other kind of credential.
 *
 * Exported for tests.
 */
export async function verifyConnectorToken(req: FastifyRequest, pathname: string): Promise<CredentialOutcome> {
  if (!CLAW_REMOTE_AGENTS_ENABLED) return ABSENT;
  const identity = identityClient();
  if (!identity) return ABSENT;
  if (!isConnectorSideRoute(req.method, pathname)) return ABSENT;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return ABSENT;
  const token = header.slice(7).trim();
  if (!JWT_SHAPE.test(token)) return ABSENT;

  const settings = connectorTokenSettings();
  const reject = (reason: string, outcome: CredentialOutcome): CredentialOutcome => {
    logger.warn({ path: pathname, reason }, "auth.connector_token.rejected");
    return outcome;
  };
  try {
    const { claims } = await identity.verifyJwt(token, { audience: settings.audience, typ: "at+jwt" });
    if (!scopesOf(claims.scope).includes(CONNECTOR_TOKEN_SCOPE)) {
      return reject("scope", refuse(403, "insufficient_scope", `the access token needs the ${CONNECTOR_TOKEN_SCOPE} scope`));
    }
    // Exactly as the issuer wrote it: it becomes the owner of every row, so a subject that
    // is not canonical (blank, padded, with a control character) is refused, not repaired,
    // or two distinct subjects could name one owner.
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!sub || sub.length > MAX_SUBJECT_CHARS || sub !== sub.trim() || CONTROL_CHARS.test(sub)) {
      return reject("subject", refuse(401, "invalid_token", "the access token names no usable subject"));
    }
    if (settings.introspect) {
      const answer = await identity.introspect(token, { tokenTypeHint: "access_token" });
      if (!answer.active || (answer.sub !== undefined && answer.sub !== sub)) {
        return reject("inactive", refuse(401, "invalid_token", "the access token is no longer active"));
      }
    }
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
    return {
      status: "verified",
      method: CONNECTOR_TOKEN_METHOD,
      expiresAt: exp,
      user: {
        userId: sub,
        userName: (text(claims.name) || text(claims.preferred_username) || text(claims.email) || sub).slice(0, MAX_SUBJECT_CHARS),
        roles: ["default"],
        platformKey: "",
        virtualKey: "",
      },
    };
  } catch (err) {
    if (err instanceof JwtVerificationError) {
      return reject(err.reason, refuse(401, "invalid_token", `the access token was refused (${err.reason})`));
    }
    if (err instanceof IdentityUnavailableError) {
      // Not "the token is bad": the provider could not be asked, so nobody is told to re-authenticate.
      logger.warn({ path: pathname, reason: err.reason }, "auth.connector_token.provider_unavailable");
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

/**
 * Whether the access token this request authenticated with has expired. A
 * command stream is authenticated once, when it opens, and may stay open for
 * hours; it ends when its token does, and the connector reconnects with a fresh
 * one, so a token that is no longer honoured cannot keep receiving commands.
 */
export function tokenExpired(req: FastifyRequest): boolean {
  if (getAuthMethod(req) !== CONNECTOR_TOKEN_METHOD) return false;
  const expiresAt = getAuthExpiry(req);
  return expiresAt !== null && Date.now() >= expiresAt;
}

/**
 * Whether the provider now says the token this request authenticated with is
 * no longer active (its grant was revoked). Only asked when
 * `CLAW_CONNECTOR_TOKEN_INTROSPECT` is on. A provider that cannot be asked
 * does not end a stream that was authenticated: the token's own expiry still
 * bounds it, and one provider outage must not disconnect every connector.
 */
export async function tokenRevoked(req: FastifyRequest): Promise<boolean> {
  if (getAuthMethod(req) !== CONNECTOR_TOKEN_METHOD || !connectorTokenSettings().introspect) return false;
  const identity = identityClient();
  const header = req.headers.authorization;
  if (!identity || !header?.startsWith("Bearer ")) return false;
  try {
    return !(await identity.introspect(header.slice(7).trim(), { tokenTypeHint: "access_token" })).active;
  } catch (err) {
    if (err instanceof IdentityUnavailableError) return false;
    throw err;
  }
}
