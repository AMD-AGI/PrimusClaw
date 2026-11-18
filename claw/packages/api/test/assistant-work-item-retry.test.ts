// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Retry (`POST /v1/work-items/:id/retry`, `assistant/retry.ts`) over real HTTP, on a real Postgres with the production schema.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   R1  a task whose worker reported failed runs again: in progress at a new generation, the retry in its log, one instruction
 *       queued on its worker session and the session drained; a report of the run that failed is fenced out, the new run's is not
 *   R2  a stopped task runs again the same way, and is open once more (no outcome, no closed_at)
 *   R3  anything else is refused with not_retryable and left as it was, nothing queued: running, a result to accept, a question,
 *       accepted, dropped, a review
 *   R4  a stopped task does not take a slot the person no longer has: too_many_active_items, and nothing changes
 *   R5  another person's item, or none at all, is 404 and changes nothing; a caller without an identity is refused
 *   R6  an instruction that cannot be queued (the worker's session is gone) changes nothing
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const MAX_ACTIVE = 3;

describe("work item retry", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let retry: typeof import("../src/assistant/retry.js");

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_MAX_ACTIVE_ITEMS: String(MAX_ACTIVE) });
    retry = await import("../src/assistant/retry.js");
    w.h.app.chatRun.chatRunPorts.publishInterrupt = () => {};   // (a stop interrupts over the wire, which this world has not)
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
    });
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    await registerAssistantRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_items, claw_work_item_events, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions,
      claw_assistant_says, claw_assistant_messages, claw_notification_outbox CASCADE`);
    w.drains.length = 0;
  });

  async function press(user: string | null, itemId: string): Promise<{ status: number; body: any }> {
    const r = await app.inject({ method: "POST", url: `/v1/work-items/${itemId}/retry`, headers: user ? { "x-test-user": user } : {} });
    return { status: r.statusCode, body: r.json() };
  }

  /** A task of `who` whose worker reported `kind` from its live run (the report's state change, `applyWorkerReport`). */
  async function reported(who: string, title: string, kind: "failed" | "ready" | "blocked" | "progress" | "dropped", question?: string) {
    const u = await w.user(who);
    const it = await w.createItem(u, title);
    const turn = await w.workerTurn(it.itemId);
    const out = await w.mod.workItems.applyWorkerReport(w.h.app.db.db, {
      itemId: it.itemId, generation: turn.gen!, workerSessionId: it.workerSid, source: "worker", runId: turn.task_id,
      report: { kind, summary: `${title} ${kind}`, ...(question ? { question } : {}) },
    });
    assert.equal(out.applied, true);
    await w.closeRun(turn.task_id, kind === "failed" ? "failed" : "completed");
    return { ...it, gen: turn.gen!, userId: who };
  }

  async function stopped(who: string, title: string) {
    const u = await w.user(who);
    const it = await w.createItem(u, title);
    const out = await w.mod.workItems.stopWorkItem({ userId: who, itemId: it.itemId, source: "user" });
    assert.equal(out.status, "ok");
    return { ...it, userId: who };
  }

  const snapshot = async (itemId: string) => {
    const row = await w.item(itemId);
    return { board: row.board_state, last: row.last_report_kind, outcome: row.outcome, gen: row.generation, closed: row.closed_at !== null,
             events: (await w.itemEvents(itemId)).length, pending: (await w.pending(row.worker_session_id)).length };
  };

  test("R1 a failed task runs again at a new generation, with one instruction queued and the old run fenced out", async () => {
    const it = await reported("alice", "build", "failed");
    assert.equal((await w.item(it.itemId)).board_state, "needs_you");
    const before = await w.item(it.itemId);
    const r = await press("alice", it.itemId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.item_id, it.itemId);
    assert.equal(r.body.data.board_state, "in_progress");
    const row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.last_report_kind, row.pending_question, row.outcome], ["in_progress", "progress", null, null]);
    assert.equal(row.generation, before.generation + 1);
    const last = (await w.itemEvents(it.itemId)).at(-1)!;
    assert.deepEqual([last.kind, last.source, last.summary, last.generation], ["progress", "user", "retry", before.generation + 1]);
    const queued = await w.pending(it.workerSid);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].content, retry.RETRY_TEXT);
    assert.deepEqual(w.drains, [{ sessionId: it.workerSid, userId: "alice" }]);
    // The run that failed reports late: fenced out. The next run, started under the new generation, is heard.
    const late = await w.mod.workItems.applyWorkerReport(w.h.app.db.db, {
      itemId: it.itemId, generation: it.gen, workerSessionId: it.workerSid, source: "worker", report: { kind: "ready", summary: "late" },
    });
    assert.equal(late.applied, false);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);
    const next = await w.workerTurn(it.itemId);
    assert.ok(next.gen! >= before.generation + 1, "the next run is started at the retry's generation or later");
    const heard = await w.mod.workItems.applyWorkerReport(w.h.app.db.db, {
      itemId: it.itemId, generation: next.gen!, workerSessionId: it.workerSid, source: "worker", runId: next.task_id,
      report: { kind: "ready", summary: "done this time" },
    });
    assert.equal(heard.applied, true);
    assert.equal((await w.item(it.itemId)).last_report_kind, "ready");
  });

  test("R2 a stopped task is open again and runs", async () => {
    const it = await stopped("alice", "deploy");
    const r = await press("alice", it.itemId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.outcome, row.closed_at], ["in_progress", null, null]);
    assert.equal((await w.pending(it.workerSid)).length, 1);
    assert.equal(w.drains.length, 1);
  });

  for (const [name, kind, question] of [
    ["a running task", "progress", undefined], ["a result to accept", "ready", undefined], ["a question", "blocked", "Which branch?"],
    ["a dropped task", "dropped", undefined],
  ] as const) {
    test(`R3 ${name} is not retried, and nothing changes`, async () => {
      const it = await reported("alice", "t", kind, question);
      const before = await snapshot(it.itemId);
      const r = await press("alice", it.itemId);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "not_retryable");
      assert.equal(r.body.data.item_id, it.itemId);
      assert.deepEqual(await snapshot(it.itemId), before);
      assert.equal(w.drains.length, 0);
    });
  }

  test("R3 an accepted task and a review are not retried", async () => {
    const it = await reported("alice", "t", "ready");
    const version = (await w.item(it.itemId)).result_version;
    assert.equal((await w.mod.workItems.acceptWorkItem("alice", it.itemId, version)).status, "ok");
    const accepted = await snapshot(it.itemId);
    assert.equal((await press("alice", it.itemId)).body.error, "not_retryable");
    assert.deepEqual(await snapshot(it.itemId), accepted);
    const review = await stopped("alice", "review");
    await w.q("UPDATE claw_work_items SET kind = 'review' WHERE item_id = $1", [review.itemId]);
    const before = await snapshot(review.itemId);
    const r = await press("alice", review.itemId);
    assert.deepEqual([r.status, r.body.error], [409, "not_retryable"]);
    assert.deepEqual(await snapshot(review.itemId), before);
  });

  test("R4 a stopped task does not take a slot that is not free", async () => {
    const it = await stopped("alice", "old");
    const u = await w.user("alice");
    for (let n = 0; n < MAX_ACTIVE; n += 1) await w.createItem(u, `open ${n}`);
    const before = await snapshot(it.itemId);
    const r = await press("alice", it.itemId);
    assert.deepEqual([r.status, r.body.error], [409, "too_many_active_items"]);
    assert.deepEqual(await snapshot(it.itemId), before);
    // A failed task holds its slot already: it is retried at the limit.
    const failed = await reported("bob", "f", "failed");
    const ub = await w.user("bob");
    for (let n = 0; n < MAX_ACTIVE - 1; n += 1) await w.createItem(ub, `open ${n}`);
    assert.equal((await press("bob", failed.itemId)).status, 200);
  });

  test("R5 another person's item, or none, is 404; no identity is refused", async () => {
    const it = await reported("alice", "t", "failed");
    const before = await snapshot(it.itemId);
    await w.user("mallory");
    assert.deepEqual([(await press("mallory", it.itemId)).status, (await press("mallory", it.itemId)).body.error], [404, "not_found"]);
    assert.equal((await press("alice", "kwi_does_not_exist")).status, 404);
    assert.equal((await press(null, it.itemId)).status, 403);
    assert.deepEqual(await snapshot(it.itemId), before);
  });

  test("R6 an instruction that cannot be queued changes nothing", async () => {
    const it = await reported("alice", "t", "failed");
    await w.q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [it.workerSid]);
    const before = await snapshot(it.itemId);
    const r = await press("alice", it.itemId);
    assert.deepEqual([r.status, r.body.error], [409, "session_not_found"]);
    assert.deepEqual(await snapshot(it.itemId), before);
    assert.equal(w.drains.length, 0);
  });
});
