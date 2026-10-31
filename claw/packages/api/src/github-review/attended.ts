// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may speak for the person behind a GitHub review: answer a held merge, or start a session that acts as a user.
 *
 * Both are the person's say, and a model must not be able to give it to itself. Whatever a model can do from inside a sandbox it
 * can do with the key the sandbox holds, and that key is the session owner's own (`SAFE_API_KEY`, `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`). It also reaches the platform that issued the key: with SaFE's built-in sign-in an `ak-` key sets the owner's
 * password and logs in with it, which hands out a session cookie that the API verifies as the person's browser session. So how a
 * request was authenticated is no proof of a person when the method is a key, a BYOK key or a cookie.
 *
 * What a sandbox cannot do is sign in at the identity provider as the person, or hold a service client's own credentials. So the
 * only credential taken here is an identity-provider access token (`identity_token`):
 *
 *  - one with no actor in it is the person's own sign-in with the provider;
 *  - one that names an actor (`act`, RFC 8693: what a service gets when it exchanges its own client credentials for a token that
 *    acts as a user it holds a binding for) is a service answering for that user, and is taken only from a client the operator named
 *    in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`, compared exactly as signed; any other service, and every service while the list is
 *    empty, is refused. The subject is the token's `sub`, which the service cannot choose.
 *
 * Everything else, a browser session cookie included, is `interactive_sign_in_required`. (Primus-SaFE refusing a password change
 * made with an API key would make a cookie trustworthy again; until then it is not.)
 */
import type { UserInfo } from "../auth/models.js";
import { IDENTITY_TOKEN_METHOD } from "../auth/identity-token.js";
import type { DecidedVia } from "./store.js";

/** The ways a request may have been authenticated and be taken as a person's (or their service's) say. */
export const ATTENDED_CREDENTIALS: ReadonlySet<string> = new Set([IDENTITY_TOKEN_METHOD]);

export type AttendedCaller =
  | { ok: true; via: DecidedVia | null }
  | { ok: false; error: "interactive_sign_in_required" | "service_client_not_allowed" };

/**
 * `method` is how the global authentication hook recorded the request (null: no credential path did, as in BYOK mode and the
 * development bypass). `via` is who stood behind the answer when it is a service, and null when it is the person.
 */
export function classifyAttendedCaller(method: string | null, user: Pick<UserInfo, "delegation">, allowedClients: readonly string[]): AttendedCaller {
  if (method === null || !ATTENDED_CREDENTIALS.has(method)) return { ok: false, error: "interactive_sign_in_required" };
  const actorSub = user.delegation?.actorSub;
  if (!actorSub) return { ok: true, via: null };
  const clientId = user.delegation?.clientId ?? "";
  if (!clientId || !allowedClients.includes(clientId)) return { ok: false, error: "service_client_not_allowed" };
  return { ok: true, via: { clientId, actorSub } };
}
