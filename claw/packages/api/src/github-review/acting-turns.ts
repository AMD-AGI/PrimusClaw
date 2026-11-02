// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may start a turn in a session that acts as a user.
 *
 * Creating such a session is the person's say (`attended.ts`), and so is every turn that runs in it: a turn in a session with
 * `config.acting_as` is offered the review tools (`session-tools.ts`), whoever sent it. The key a sandbox holds is the session owner's own, so
 * a model in any ordinary session of that user finds the acting session with `GET /v1/sessions` and sends it a message with that key; in the
 * self case nothing else asks anyone, and a pull request from outside the organisation is approved and merged with the user's account.
 * Gating only the create left that open, so the same credentials are asked of everything that puts work in front of the session's model:
 *
 *   - a message, and the answer to what the model asked or is waiting for (an approval, a question)    routes/sessions.ts, routes/admin.ts,
 *                                                                                                      routes/anthropic-managed-agents.ts
 *   - a task, a batch, a retry, a hosted application run, a workbench run into the session              routes/tasks.ts, workbenches/routes.ts
 *
 * Stopping a run is not asked for (it can only make the session do less), and neither is starting its sandbox: that run has no model call.
 * `test/github-review-acting-turns.test.ts` lists every place that can start a turn and fails when a new one appears that is in neither group.
 * Nothing here is asked while the feature is off: no tools are offered then, so the session is an ordinary one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { actingUserOf } from "./acting-as.js";
import { classifyAttendedCaller, type AttendedCaller } from "./attended.js";
import { readGithubReviewSettings } from "./settings.js";

const logger = pino({ name: "github-review-acting-turns" });

export type ActingTurnRefusal = Extract<AttendedCaller, { ok: false }>["error"];

/** Anything that can run one SQL statement: the pool, or a client that is inside a transaction. */
interface Statements { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }

/**
 * Why this request may not start a turn in a session whose stored `config.acting_as` is `actingAs`, or null when it may.
 * Only an identity-provider token may (the person's own, or an allowed service's): see `classifyAttendedCaller`.
 */
export function actingTurnRefusal(req: FastifyRequest, actingAs: unknown): ActingTurnRefusal | null {
  if (!CLAW_GITHUB_REVIEW_ENABLED || actingUserOf({ acting_as: actingAs }) === null) return null;
  const user = getUser(req);
  const method = getAuthMethod(req);
  const caller = classifyAttendedCaller(method, { delegation: user?.delegation }, readGithubReviewSettings().decisionClientIds);
  if (caller.ok) return null;
  logger.warn({ userId: user?.userId, method: method ?? "none", clientId: user?.delegation?.clientId?.slice(0, 128) }, `github_review.acting_turn_refused_${caller.error}`);
  return caller.error;
}

/** The session's stored `config.acting_as` (undefined when it has none or is gone): for a route that has the session id and nothing else of the row. */
export async function storedActingAs(sessionId: string, q: Statements = db): Promise<unknown> {
  const rows = (await q.query("SELECT config->'acting_as' AS acting_as FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows;
  return rows[0]?.acting_as;
}

/**
 * `actingTurnRefusal` for a route that has the session id and nothing else of its row. While the feature is off it asks the database nothing,
 * so a deployment that has not turned it on runs exactly the statements it ran before.
 */
export async function actingTurnRefusalFor(req: FastifyRequest, sessionId: string, q: Statements = db): Promise<ActingTurnRefusal | null> {
  if (!CLAW_GITHUB_REVIEW_ENABLED) return null;
  return actingTurnRefusal(req, await storedActingAs(sessionId, q));
}

/**
 * Sends the 403 and returns true when this request may not start a turn in the session. Asked after the route's own access check, so that a
 * caller who may not touch the session at all is told what it was told before, and nothing is said of which sessions act as a user.
 */
export async function refuseUnattendedActingTurn(req: FastifyRequest, reply: FastifyReply, sessionId: string, q: Statements = db): Promise<boolean> {
  const refusal = await actingTurnRefusalFor(req, sessionId, q);
  if (refusal === null) return false;
  await reply.status(403).send({ ok: false, error: refusal });
  return true;
}
