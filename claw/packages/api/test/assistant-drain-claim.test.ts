// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One drain of a session's queue at a time (`src/sessions/drain-claim.ts`), against a real Postgres: the claim is an
 * advisory lock, and only a second connection can contend for it. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   Q1  soak 6, round 16: a worker's report is being dispatched into the idle assistant when a second report finds
 *       the assistant idle too, and the user asks a question. The second report does not start a turn over the first,
 *       the question is queued at once behind the first turn instead of taking the gate it is about to take, the first turn can still
 *       speak (its say names it), and when it ends the user's question goes before the second report.
 *   Q2  the sweeper and the completion's drain take the same queued message at once: one turn, one run row, and no
 *       duplicate key on `claw_tasks`.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("pending drain claim", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let consumer: typeof import("../src/events/consumer.js");
  let pendingDispatch: typeof import("../src/tasks/pending-dispatch.js");
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let pendingPorts: Record<string, unknown>;
  let sessionPorts: Record<string, unknown>;
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });

  /** What left the process: each turn published, by prompt and message id. */
  let published: Array<{ messageId: string; prompt: string }>;
  /** Held open while a test needs a dispatch to be in flight. */
  let pauses: Array<{ at: "open" | "publish"; reached: () => void; release: Promise<void> }>;

  const gate = () => {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const reachedP = new Promise<void>((r) => { reached = r; });
    return { release, reached, released, reachedP };
  };
  const pauseAt = async (at: "open" | "publish") => {
    const p = pauses.find((x) => x.at === at);
    if (!p) return;
    pauses.splice(pauses.indexOf(p), 1);
    p.reached();
    await p.release;
  };
  /** Until `done` says so, or another connection waits on an advisory lock: the claim is being contended. */
  async function settledOrWaiting(done: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (done()) return;
      if ((await w.q("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).length) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("neither finished nor waited");
  }
  const tracked = <T>(p: Promise<T>) => {
    const t = { done: false, promise: p };
    p.then(() => { t.done = true; }, () => { t.done = true; });
    return t;
  };

  before(async () => {
    w = await startWorld();
    consumer = await import("../src/events/consumer.js");
    pendingDispatch = await import("../src/tasks/pending-dispatch.js");
    dispatch = await import("../src/sessions/dispatch.js");
    prompts = await import("../src/assistant/prompts.js");
    pendingPorts = { ...pendingDispatch.pendingDispatchPorts };
    sessionPorts = { ...dispatch.sessionDispatchPorts };
  });
  after(async () => {
    Object.assign(pendingDispatch.pendingDispatchPorts, pendingPorts);
    Object.assign(dispatch.sessionDispatchPorts, sessionPorts);
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
    published = [];
    pauses = [];
    // Everything a turn does outside the process is stubbed; the run row is real, so its id is a real primary key.
    Object.assign(pendingDispatch.pendingDispatchPorts, pendingPorts, {
      doorbellDispatch: () => null,
      admit: async () => ({ kind: "admit" }),
      bindWorkspace: async () => "kws_1",
      requireWorkspaceBinding: (x?: string) => x as string,
      publishSessionEvent: async () => {},
      openChatRun: async (...a: unknown[]) => {
        await pauseAt("open");
        return (pendingPorts.openChatRun as (...x: unknown[]) => Promise<unknown>)(...a);
      },
      publish: async (_s: string, payload: string) => {
        await pauseAt("publish");
        const task = JSON.parse(payload);
        published.push({ messageId: task.message_id, prompt: task.prompt });
        return published.length;
      },
    });
    // The user's own message, dispatched at once when it finds the session free.
    Object.assign(dispatch.sessionDispatchPorts, sessionPorts, {
      doorbellDispatch: () => null,
      publishSse: () => {},
      admit: async () => ({ kind: "admit" }),
      publishTask: async (_s: string, payload: string) => {
        const task = JSON.parse(payload);
        published.push({ messageId: task.message_id, prompt: task.prompt });
        return published.length;
      },
    });
    w.mod.submit.submitMessagePorts.drainOldestPendingMessage = consumer.drainOldestPendingMessage;
  });

  const report = (seq: number) => `${prompts.WORK_EVENT_PREFIX} #${seq} (item_id: kwi_${seq}) ready v1: wrote s16${seq}.txt`;
  const queueReport = (seq: number) => w.mod.messages.queueServerMessage(w.h.app.db.db, {
    sessionId: alice.routerSid, userId: "alice", content: report(seq), dedupeKey: `wi-evt:${seq}`,
  });
  const ask = (content: string) => w.mod.submit.submitSessionMessage({
    sessionId: alice.routerSid, userId: "alice", user: user("alice"), content, messageType: "text", toolIds: [], sessionEnv: {},
  } as never);
  const session = async () => (await w.q("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1", [alice.routerSid]))[0];
  const runOf = async (messageId: string) =>
    (await w.q("SELECT task_id FROM claw_tasks WHERE session_id = $1 AND metadata->>'message_id' = $2", [alice.routerSid, messageId]))[0]?.task_id as string | undefined;

  test("Q1 a report waking the assistant does not take it from the turn in front, nor from the user's question", { timeout: 30_000 }, async () => {
    const first = gate();
    pauses.push({ at: "publish", reached: first.reached, release: first.released });
    await queueReport(1);
    // The first report's wake: its turn is on its way out, and the session still reads free.
    const one = tracked(w.mod.messages.drainSessionIfIdle(alice.routerSid, "alice"));
    await first.reachedP;
    assert.equal((await session()).agent_status, "idle", "the first turn has not taken the gate yet");

    // The second report finds the assistant idle as well, and its drain runs once the first one is over.
    const firstDone = gate();
    const realDrain = consumer.drainOldestPendingMessage;
    let secondChecked!: () => void;
    const secondCheckedP = new Promise<void>((r) => { secondChecked = r; });
    w.mod.submit.submitMessagePorts.drainOldestPendingMessage = async (sid: string, uid: string) => {
      secondChecked();
      await firstDone.released;
      return realDrain(sid, uid);
    };
    await queueReport(2);
    const two = tracked(w.mod.messages.drainSessionIfIdle(alice.routerSid, "alice"));
    await secondCheckedP;
    w.mod.submit.submitMessagePorts.drainOldestPendingMessage = realDrain;

    // The user asks while the first turn is still being dispatched.
    const asked = tracked(ask("Which of them is done?"));
    await settledOrWaiting(() => asked.done);
    // Queued at once, not held in a transaction (and a pooled connection) until the dispatch is over.
    assert.deepEqual(
      (await w.pending(alice.routerSid)).map((p) => p.content).filter((c) => c.startsWith("Which")), ["Which of them is done?"],
      "the question is queued while the first turn is still being dispatched",
    );
    first.release();
    await one.promise;
    firstDone.release();
    await two.promise;
    const question = await asked.promise;

    assert.equal(published.length, 1, `one turn started, not ${published.map((p) => p.prompt).join(" | ")}`);
    assert.equal(published[0].prompt.startsWith(report(1)), true, "the first report's");
    const turn = published[0].messageId;
    assert.deepEqual(await session(), { agent_status: "running", agent_gate_message_id: turn }, "and it holds the session");
    assert.equal(question.kind, "queued", "the question is behind it, for its completion to drain");

    // The turn in front can still speak, and what it says names it.
    const taskId = await runOf(turn);
    assert.ok(taskId);
    const said = await w.mod.tools.say({ sid: alice.routerSid, role: "router", mid: turn, task_id: taskId!, exp: Math.floor(Date.now() / 1000) + 600 }, { text: "S16a is done." }, w.sayDeps);
    assert.equal(said.ok, true);
    assert.equal(w.events.at(-1)?.turn_message_id, turn);

    // It ends, and the user's question is answered before the second report is passed on.
    await w.closeRun(taskId!);
    await consumer.drainOldestPendingMessage(alice.routerSid, "alice");
    assert.equal(published.length, 2);
    assert.equal(published[1].prompt.startsWith("Which of them is done?"), true, `the question goes first, not ${published[1].prompt}`);
    assert.deepEqual((await w.pending(alice.routerSid)).map((p) => p.content), [report(2)], "the report waits its turn");
  });

  test("Q2 the sweeper and the completion's drain of one message start one turn", { timeout: 30_000 }, async () => {
    const opening = gate();
    pauses.push({ at: "open", reached: opening.reached, release: opening.released });
    await queueReport(1);
    // The completion's drain has reserved the run id and is about to write the row.
    const completion = tracked(consumer.drainOldestPendingMessage(alice.routerSid, "alice"));
    await opening.reachedP;
    // The sweeper finds the same message on a session that still reads free.
    const sweep = tracked(w.mod.sweeper.drainOrphanedPendingMessages());
    await settledOrWaiting(() => sweep.done);
    opening.release();
    await completion.promise;
    await sweep.promise;

    assert.equal(published.length, 1, "one turn");
    assert.equal((await w.q("SELECT 1 FROM claw_tasks WHERE session_id = $1", [alice.routerSid])).length, 1, "one run row");
    assert.deepEqual(await w.pending(alice.routerSid), [], "and the message is off the queue");
  });
});
