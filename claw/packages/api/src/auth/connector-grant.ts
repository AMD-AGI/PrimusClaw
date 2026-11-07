// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Connector grants: the credential a connector gets by pairing with a one-time code (`remote-agents/pairing.ts`).
 *
 * `Authorization: Bearer cpg_...` is judged here and nowhere else, before any other credential path, so a grant is never
 * sent on to SaFE or to the identity provider as if it were their credential.
 *
 *   - It authenticates on the connector-side routes (`CONNECTOR_SIDE_ROUTES`) and is refused (403) on every other route.
 *   - The caller is the person the code was issued to, with the `default` role only.
 *   - It reaches the routes of the one connector it registered, and before that only registration: any other connector id,
 *     the person's own included, is refused.
 *     When that row is revoked the grant answers 401 `revoked`, which tells the connector to stop and not come back.
 *   - A grant that never registered is good for a day after its claim.
 *
 * Abstains (`absent`) for any other bearer value, and when remote agents are off.
 */
import type { FastifyRequest } from "fastify";
import pino from "pino";
import { CLAW_REMOTE_AGENTS_ENABLED } from "../config.js";
import { isConnectorSideRoute } from "../remote-agents/connector-routes.js";
import { GRANT_PREFIX, UNBOUND_GRANT_TTL_MS, findGrant } from "../remote-agents/pairing.js";
import type { CredentialOutcome } from "./middleware.js";

const logger = pino({ name: "auth" });

/** What `req` records as the way the caller was authenticated, and what the audit trail names. */
export const CONNECTOR_GRANT_METHOD = "connector_grant";

const ABSENT: CredentialOutcome = { status: "absent" };
const CID_IN_PATH = /^\/v1\/remote-agents\/connectors\/([^/]+)\//;
const GRANT_SHAPE = /^cpg_[A-Za-z0-9_-]{43}$/;

function refuse(status: number, legacyError: string, message: string): CredentialOutcome {
  return { status: "rejected", error: { status, legacyError, anthropicType: "authentication_error", message } };
}

const grants = new WeakMap<FastifyRequest, string>();

/** The grant a request authenticated with, for the registration that binds it. */
export function grantOf(req: FastifyRequest): string | null {
  return grants.get(req) ?? null;
}

/** Path 0b: a connector grant. Exported for tests. */
export async function verifyConnectorGrant(req: FastifyRequest, pathname: string, now: number = Date.now()): Promise<CredentialOutcome> {
  if (!CLAW_REMOTE_AGENTS_ENABLED) return ABSENT;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return ABSENT;
  const token = header.slice(7).trim();
  if (!token.startsWith(GRANT_PREFIX)) return ABSENT;
  const reject = (reason: string, outcome: CredentialOutcome): CredentialOutcome => {
    logger.warn({ path: pathname, reason }, "auth.connector_grant.rejected");
    return outcome;
  };
  if (!isConnectorSideRoute(req.method, pathname)) {
    return reject("route", refuse(403, "connector_grant_not_accepted", "a connector grant works only on the connector routes"));
  }
  if (!GRANT_SHAPE.test(token)) return reject("shape", refuse(401, "invalid_token", "the connector grant is not valid"));
  const g = await findGrant(token);
  if (!g) return reject("unknown", refuse(401, "invalid_token", "the connector grant is not valid; pair the machine again"));
  if (g.revoked_at || g.connector_revoked) return reject("revoked", refuse(401, "revoked", "this connector was disconnected; pair the machine again"));
  if (!g.connector_id && now - new Date(g.created_at).getTime() > UNBOUND_GRANT_TTL_MS) {
    return reject("unbound_expired", refuse(401, "invalid_token", "the connector grant was never used and has expired; pair the machine again"));
  }
  // Until it has registered a connector, a grant names none: it may register one, and reach no existing connector of the
  // person's (that would hand whoever claimed a code the command stream of a machine that is already theirs).
  const cid = CID_IN_PATH.exec(pathname)?.[1];
  if (cid && (!g.connector_id || cid.toLowerCase() !== g.connector_id.toLowerCase())) {
    return reject("other_connector", refuse(403, "connector_grant_mismatch", "this connector grant belongs to another connector"));
  }
  grants.set(req, g.grant_id);
  return {
    status: "verified",
    method: CONNECTOR_GRANT_METHOD,
    user: { userId: g.owner_user_id, userName: g.owner_user_id, roles: ["default"], platformKey: "", virtualKey: "" },
  };
}
