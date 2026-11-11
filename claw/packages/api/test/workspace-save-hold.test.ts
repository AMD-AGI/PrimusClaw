// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn's workspace save holds the session's next message in the API's queue, not on Brain's workspace lock.
 * Real Postgres, production schema, the real routes and event consumer; only the publish to Brain is a seam.
 * Skipped without DATABASE_URL; a skip is not a pass.
 *
 *   S1 a completion that says a save follows sets the session idle and holds it: a message sent during the save is queued,
 *      not published, for as long as the save runs -- past the ~80 min a run can wait on Brain's lock -- and neither the
 *      orphan drain nor anything else sends it on; the save's finish publishes it at once
 *   S2 a save that failed releases it the same way
 *   S3 a completion with no save drains as before
 *   S4 a finish stored before its completion: the completion sets no hold
 *   S5 a hold no finish released is released by the sweeper once the finish is stored, and drains
 *   S6 a hold past its bound holds nothing: a message is dispatched, and the orphan drain sends a queued one on
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1" };

const skip = postgresSkipReason();
let c: AdmissionCluster;
let consumer: typeof import("../src/events/consumer.js");
let sweeper: typeof import("../src/tasks/sweeper.js");
let hold: typeof import("../src/sessions/save-hold.js");
let ports: typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"];
let pendingPorts: typeof import("../src/tasks/pending-dispatch.js")["pendingDispatchPorts"];
let pendingPristine: Record<string, unknown>;
let registerSessionRoutes: typeof import("../src/routes/sessions.js")["registerSessionRoutes"];
let originalHas: unknown;
let pristine: Record<string, unknown>;
let seq = 5000;
let published: Array<Record<string, unknown>>;
let app: FastifyInstance;
const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

before(async () => {
  if (skip) return;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  c = await startAdmissionCluster({});
  (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
  consumer = await import("../src/events/consumer.js");
  sweeper = await import("../src/tasks/sweeper.js");
  hold = await import("../src/sessions/save-hold.js");
  ports = (await import("../src/sessions/dispatch.js")).sessionDispatchPorts;
  registerSessionRoutes = (await import("../src/routes/sessions.js")).registerSessionRoutes;
  originalHas = consumer.tombstoneReader.has;
  consumer.tombstoneReader.has = async () => false;
  pristine = { ...ports };
  pendingPorts = (await import("../src/tasks/pending-dispatch.js")).pendingDispatchPorts;
  pendingPristine = { ...pendingPorts };
  app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerSessionRoutes(app);
  await app.ready();
});
beforeEach(async () => {
  if (skip) return;
  for (const t of ["claw_pending_messages", "claw_session_events", "claw_tasks", "claw_sessions"]) {
    await sql(`DELETE FROM ${t}`).catch(() => {});
  }
  Object.assign(ports, pristine);
  published = [];
  ports.doorbellDispatch = closedDoorbellBarrier;
  ports.publishSse = () => {};
  ports.publishTask = async (_s: string, payload: string) => { published.push(JSON.parse(payload)); return published.length; };
  // A queued message is sent on by the drain, through its own publish.
  Object.assign(pendingPorts, pendingPristine, {
    doorbellDispatch: closedDoorbellBarrier,
    publish: async (_subject: string, payload: string) => { published.push(JSON.parse(payload)); return published.length; },
  });
  await sql("INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status) VALUES ('s1', 't', 'u-1', 'claw', 'idle')");
});
after(async () => {
  if (skip) return;
  consumer.tombstoneReader.has = originalHas as typeof consumer.tombstoneReader.has;
  Object.assign(ports, pristine);
  Object.assign(pendingPorts, pendingPristine);
  await app?.close();
  await c?.stop();
});

async function deliver(event: Record<string, unknown>): Promise<void> {
  const verdicts: string[] = [];
  await consumer.consumeEventDelivery({
    subject: "events.s1",
    data: new TextEncoder().encode(JSON.stringify(event)),
    seq: ++seq,
    ack: () => { verdicts.push("ack"); },
    nak: () => { verdicts.push("nak"); },
  });
  assert.deepEqual(verdicts, ["ack"], `${String(event.type)} was not taken`);
}

async function send(content: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/messages", payload: { content } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Record<string, unknown>;
}

const session = async () =>
  (await sql("SELECT agent_status, workspace_save_id, workspace_save_until FROM claw_sessions WHERE session_id = 's1'"))[0] as
    { agent_status: string; workspace_save_id: string | null; workspace_save_until: Date | null };
const queued = async () => (await sql("SELECT count(*)::int AS n FROM claw_pending_messages WHERE session_id = 's1'"))[0].n as number;

/** The completion Brain publishes for the turn it was handed, saying a save `saveId` follows (or none). */
function completionOf(turn: Record<string, unknown>, saveId: string | null): Record<string, unknown> {
  return {
    type: "exec_complete", session_id: "s1", message_id: turn.message_id, task_id: turn.task_id,
    user_id: "u-1", final_text: "done", failed: false, turns: 1, error_count: 0, skills_used: {},
    ...(saveId ? { workspace_save: "pending", workspace_save_id: saveId } : {}),
  };
}
const finishOf = (turn: Record<string, unknown>, saveId: string, outcome: string) => ({
  type: "workspaceSave", phase: "finished", outcome, save_id: saveId, message_id: turn.message_id,
});

/** A turn that ran and ended saying a save follows. */
async function turnEndedWithSave(saveId: string | null): Promise<Record<string, unknown>> {
  await send("first");
  assert.equal(published.length, 1);
  const turn = published[0]!;
  assert.equal((await session()).agent_status, "running");
  await deliver(completionOf(turn, saveId));
  return turn;
}

test("S1 a message sent during the save waits in the queue, however long, and goes once the save finishes", { skip }, async () => {
  const turn = await turnEndedWithSave("save-1");
  const s = await session();
  assert.equal(s.agent_status, "idle", "the session reads idle as soon as the turn ends");
  assert.equal(s.workspace_save_id, "save-1");

  const second = await send("follow-up");
  assert.equal(second.queued, true, "queued, not dispatched");
  assert.equal(published.length, 1, "nothing was handed to Brain to wait on its lock");
  assert.equal(await queued(), 1);

  // A save longer than any run's lock budget: still nothing is sent, by the orphan drain or anyone.
  await sql("UPDATE claw_session_events SET created_at = created_at - INTERVAL '90 minutes' WHERE session_id = 's1'");
  await sweeper.drainOrphanedPendingMessages();
  await consumer.drainOldestPendingMessage("s1", "u-1");
  assert.equal(published.length, 1, "held past the ~80 minutes a run could wait on Brain's lock");
  assert.equal(await queued(), 1);

  await deliver(finishOf(turn, "save-1", "synced"));
  assert.equal(published.length, 2, "the save's finish sends the queued message at once");
  assert.match(JSON.stringify(published[1]), /follow-up/, "and it is the follow-up that goes");
  assert.equal(await queued(), 0);
  const after = await session();
  assert.equal(after.workspace_save_id, null);
  assert.equal(after.agent_status, "running", "the follow-up is the session's turn now");
});

test("S2 a save that failed releases the queue the same way", { skip }, async () => {
  const turn = await turnEndedWithSave("save-2");
  await send("follow-up");
  assert.equal(published.length, 1);
  await deliver(finishOf(turn, "save-2", "failed"));
  assert.equal(published.length, 2);
  assert.equal(await queued(), 0);
});

test("S2b another save's finish does not release it", { skip }, async () => {
  const turn = await turnEndedWithSave("save-3");
  await send("follow-up");
  await deliver(finishOf(turn, "save-earlier-attempt", "synced"));
  assert.equal(published.length, 1);
  assert.equal((await session()).workspace_save_id, "save-3");
});

test("S3 a completion with no save drains as before", { skip }, async () => {
  await send("first");
  const turn = published[0]!;
  await send("follow-up");
  assert.equal(published.length, 1, "queued behind the running turn");
  await deliver(completionOf(turn, null));
  assert.equal(published.length, 2);
  assert.equal((await session()).workspace_save_id, null);
});

test("S4 a finish stored before its completion: the completion holds nothing", { skip }, async () => {
  await send("first");
  const turn = published[0]!;
  await deliver(finishOf(turn, "save-4", "synced"));
  await deliver(completionOf(turn, "save-4"));
  const s = await session();
  assert.equal(s.agent_status, "idle");
  assert.equal(s.workspace_save_id, null);
  const second = await send("follow-up");
  assert.notEqual(second.queued, true);
  assert.equal(published.length, 2);
});

test("S5 a hold whose finish is stored but was not released is released by the sweeper, which drains", { skip }, async () => {
  const turn = await turnEndedWithSave("save-5");
  await send("follow-up");
  // The finish row, as a replica that did not get to release it left it.
  await sql(
    "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ('claw-fin-5', 's1', 'workspaceSave', $1::jsonb)",
    [JSON.stringify(finishOf(turn, "save-5", "partial"))],
  );
  assert.equal(published.length, 1);
  assert.equal(await hold.releaseFinishedWorkspaceSaves(consumer.drainOldestPendingMessage), 1);
  assert.equal(published.length, 2);
  assert.equal((await session()).workspace_save_id, null);
});

test("S6 a hold past its bound holds nothing", { skip }, async () => {
  await turnEndedWithSave("save-6");
  await send("follow-up");
  assert.equal(published.length, 1);
  // The Brain saving died with it and no finish ever came.
  await sql("UPDATE claw_sessions SET workspace_save_until = NOW() - INTERVAL '1 second' WHERE session_id = 's1'");
  await sweeper.drainOrphanedPendingMessages();
  assert.equal(published.length, 2, "the orphan drain sends the queue on");
});
