// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { consumeEventDelivery, tombstoneReader } from "../src/events/consumer.js";
import { db } from "../src/infra/db.js";
import { sc } from "../src/infra/nats.js";
import { resetDeletedSessionCache } from "../src/sessions/deleted-cache.js";
import { startHarness, seedRun, seedSession, seedTurn, type Harness } from "./scenario-harness.js";

const SESSION = "completion-repair";
const MESSAGE = "message-original";
const originalConnect = db.lockPool.connect;
const originalTombstone = tombstoneReader.has;
let h: Harness;
let nextSequence = 1;

interface LockState {
  held: Set<number>;
  beforeNextAcquire?: () => Promise<void>;
  afterNextAcquire?: () => Promise<void>;
}

let locks: LockState;

function stubLockPool(): LockState {
  const state: LockState = { held: new Set() };
  db.lockPool.connect = (async () => {
    const owned = new Set<number>();
    return {
      async query(sql: string, params: unknown[] = []) {
        const id = params[0];
        assert.equal(typeof id, "number");
        assert.ok(Number.isSafeInteger(id));
        if (sql.includes("pg_try_advisory_lock")) {
          const beforeAcquire = state.beforeNextAcquire;
          state.beforeNextAcquire = undefined;
          await beforeAcquire?.();
          if (state.held.has(id as number)) return { rows: [{ ok: false }] };
          state.held.add(id as number);
          owned.add(id as number);
          const afterAcquire = state.afterNextAcquire;
          state.afterNextAcquire = undefined;
          await afterAcquire?.();
          return { rows: [{ ok: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          const released = owned.delete(id as number) && state.held.delete(id as number);
          return { rows: [{ released }] };
        }
        throw new Error(`Unexpected lock query: ${sql}`);
      },
      release(destroy?: boolean) {
        if (destroy) for (const id of owned) state.held.delete(id);
      },
    };
  }) as unknown as typeof db.lockPool.connect;
  return state;
}

before(async () => {
  h = await startHarness();
  await h.sql(`ALTER TABLE claw_pending_messages
    ADD COLUMN plugin_id INTEGER,
    ADD COLUMN tool_ids JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN workspace_id TEXT,
    ADD COLUMN platform_key TEXT,
    ADD COLUMN llm_api_key TEXT,
    ADD COLUMN credentials_blob TEXT,
    ADD COLUMN image TEXT,
    ADD COLUMN resources JSONB,
    ADD COLUMN timeout INTEGER,
    ADD COLUMN user_env JSONB,
    ADD COLUMN session_env JSONB,
    ADD COLUMN topology JSONB`);
});

beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.reset();
  nextSequence = 1;
  locks = stubLockPool();
  tombstoneReader.has = async () => false;
  resetDeletedSessionCache();
  await seedSession(h, SESSION);
  await seedRun(h, "run-original", SESSION, { status: "running", messageId: MESSAGE });
});

after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.sql("SELECT 1");
  await h.close();
  db.lockPool.connect = originalConnect;
  tombstoneReader.has = originalTombstone;
  resetDeletedSessionCache();
});

function completion(messageId: string | null = MESSAGE): Record<string, unknown> {
  return {
    type: "exec_complete", session_id: SESSION, task_id: "run-original", user_id: "u-1",
    ...(messageId ? { message_id: messageId } : {}),
    prompt: "Inspect the original work", final_text: "The worker finished the original work.",
    failed: false, error_count: 0, skills_used: {},
  };
}

function placeholder(): Record<string, unknown> {
  return {
    ...completion(), completion_source: "sweeper", failed: true,
    failure_reason: "worker_lost", final_text: "The worker lease expired.",
  };
}

async function deliver(event: Record<string, unknown>, sequence = nextSequence++) {
  let acks = 0;
  const naks: Array<number | undefined> = [];
  await consumeEventDelivery({
    subject: `events.${SESSION}`, data: sc.encode(JSON.stringify(event)), seq: sequence,
    ack: () => { acks++; }, nak: (delay) => { naks.push(delay); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.sql("SELECT 1");
  return { sequence, acks, naks };
}

async function consumeSuccessfully(event: Record<string, unknown>, sequence?: number): Promise<number> {
  const result = await deliver(event, sequence);
  assert.deepEqual({ acks: result.acks, naks: result.naks }, { acks: 1, naks: [] });
  return result.sequence;
}

async function turns() {
  return h.sql(
    `SELECT turn_index, role, content, tool_calls, tool_results, message_id, is_placeholder
       FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL
      ORDER BY turn_index`,
    [SESSION],
  );
}

async function activeSummaries() {
  return h.sql(
    "SELECT summary, summarized_up_to FROM claw_session_summaries WHERE session_id = $1 AND deleted_at IS NULL",
    [SESSION],
  );
}

async function seedSummary(summarizedUpTo: number): Promise<void> {
  await h.sql(
    "INSERT INTO claw_session_summaries (session_id, summary, summarized_up_to) VALUES ($1, $2, $3)",
    [SESSION, "The original worker was lost.", summarizedUpTo],
  );
}

async function seedNewerWork(): Promise<void> {
  await seedRun(h, "run-current", SESSION, { status: "running", messageId: "message-current" });
  await h.sql("UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1", [SESSION]);
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, content) VALUES ($1, $2)",
    [SESSION, "Keep this message behind the current turn"],
  );
}

async function sideEffects() {
  return {
    sessions: await h.sql("SELECT * FROM claw_sessions WHERE session_id = $1", [SESSION]),
    runs: await h.sql("SELECT * FROM claw_tasks WHERE session_id = $1 ORDER BY task_id", [SESSION]),
    pending: await h.sql("SELECT * FROM claw_pending_messages WHERE session_id = $1 ORDER BY id", [SESSION]),
  };
}

function completionEffectQueries(): string[] {
  return h.statements.filter((sql) => sql.startsWith("UPDATE claw_sessions")
    || sql.startsWith("UPDATE claw_tasks") || sql.includes("FROM claw_pending_messages"));
}

async function processed(sequence: number): Promise<boolean> {
  const rows = await h.sql(
    "SELECT processed_at FROM claw_session_events WHERE event_id = $1 AND session_id = $2",
    [`claw-${sequence}`, SESSION],
  );
  assert.equal(rows.length, 1);
  return rows[0].processed_at !== null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function deliverTool(messageId: string, actionId: string, status: "start" | "success") {
  await consumeSuccessfully({
    type: "toolUsed", message_id: messageId, actionId, tool: "run_command", status,
    description: `${actionId} result`, full_output: "large output excluded from history",
  });
}

test("late worker completion repairs the original turn, tools, and summary without replaying effects", async () => {
  await seedTurn(h, SESSION, 1, "user", "An earlier request");
  await seedTurn(h, SESSION, 2, "assistant", "An earlier answer");
  await deliverTool(MESSAGE, "original-tool", "start");
  const syntheticSequence = await consumeSuccessfully(placeholder());
  const originalTurns = await turns();
  assert.equal(originalTurns[3].is_placeholder, true);
  await consumeSuccessfully({ ...placeholder(), final_text: "A repeated synthetic failure." });
  assert.deepEqual(await turns(), originalTurns);

  await deliverTool(MESSAGE, "original-tool", "success");
  await consumeSuccessfully({ ...completion("message-later"), prompt: "Later request", final_text: "Later answer" });
  await deliverTool("message-later", "unrelated-tool", "start");
  await deliverTool("message-later", "unrelated-tool", "success");
  await seedSummary(5);
  await seedNewerWork();
  const beforeEffects = await sideEffects();
  h.statements.length = 0;

  const workerSequence = await consumeSuccessfully(completion());
  const repaired = await turns();
  assert.deepEqual(repaired.map((row) => row.turn_index), [1, 2, 3, 4, 5, 6]);
  assert.equal(repaired[2].content, "Inspect the original work");
  assert.equal(repaired[3].content, completion().final_text);
  assert.equal(repaired[3].is_placeholder, false);
  assert.deepEqual((repaired[3].tool_calls as Array<{ actionId: string }>).map((tool) => tool.actionId), ["original-tool"]);
  const results = repaired[3].tool_results as Array<{ actionId: string; full_output?: string }>;
  assert.deepEqual(results.map((tool) => tool.actionId), ["original-tool"]);
  assert.equal(results[0].full_output, undefined);
  assert.deepEqual(await activeSummaries(), []);
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
  assert.equal(await processed(workerSequence), true);

  for (const [event, sequence] of [
    [completion(), workerSequence],
    [placeholder(), syntheticSequence],
    [{ ...completion(), final_text: "Repeated worker text must not replace the answer." }, undefined],
    [placeholder(), undefined],
  ] as const) {
    await consumeSuccessfully(event, sequence);
    assert.deepEqual(await turns(), repaired);
  }
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
});

test("a worker result cannot be replaced by later synthetic or genuine duplicates", async () => {
  await consumeSuccessfully(completion());
  const original = await turns();
  assert.equal(original[1].is_placeholder, false);
  await seedSummary(3);
  const summary = await activeSummaries();
  await seedNewerWork();
  const beforeEffects = await sideEffects();
  h.statements.length = 0;

  for (const event of [placeholder(), placeholder(), { ...completion(), final_text: "Duplicate worker result" }]) {
    const sequence = await consumeSuccessfully(event);
    assert.equal(await processed(sequence), true);
    assert.deepEqual(await turns(), original);
    assert.deepEqual(await activeSummaries(), summary);
  }
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
});

test("a summary ending before the repaired assistant turn remains valid", async () => {
  await seedTurn(h, SESSION, 1, "user", "Earlier request");
  await seedTurn(h, SESSION, 2, "assistant", "Earlier answer");
  await consumeSuccessfully(placeholder());
  await seedSummary(4);
  const summary = await activeSummaries();

  await consumeSuccessfully(completion());
  assert.equal((await turns())[3].content, completion().final_text);
  assert.equal((await turns())[3].is_placeholder, false);
  assert.deepEqual(await activeSummaries(), summary);
});

test("completions without a message id deduplicate only the same delivery", async () => {
  const legacy = completion(null);
  const sequence = await consumeSuccessfully(legacy);
  await consumeSuccessfully(legacy, sequence);
  assert.equal((await turns()).length, 2);
  await consumeSuccessfully({ ...legacy, prompt: "Another legacy request", final_text: "Another legacy answer" });
  const beforeTurns = await turns();
  assert.equal(beforeTurns.length, 4);
  assert.ok(beforeTurns.every((row) => row.message_id === null));
  await seedNewerWork();
  const beforeEffects = await sideEffects();
  h.statements.length = 0;

  await consumeSuccessfully(legacy, sequence);
  assert.deepEqual(await turns(), beforeTurns);
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
});

test("a concurrent completion naks a busy lock and repairs history on retry", { timeout: 10_000 }, async () => {
  const acquired = deferred();
  const resume = deferred();
  locks.afterNextAcquire = async () => { acquired.resolve(); await resume.promise; };
  const first = deliver(placeholder());
  let retrySequence = 0;
  try {
    await Promise.race([acquired.promise, first.then(() => { throw new Error("completion did not acquire a lock"); })]);
    const busy = await deliver(completion());
    retrySequence = busy.sequence;
    assert.equal(busy.acks, 0);
    assert.equal(busy.naks.length, 1);
    assert.ok((busy.naks[0] ?? 0) > 0);
    assert.equal(await processed(retrySequence), false);
    assert.deepEqual(await turns(), []);
  } finally {
    resume.resolve();
    const finished = await first;
    assert.deepEqual({ acks: finished.acks, naks: finished.naks }, { acks: 1, naks: [] });
  }
  assert.equal((await turns())[1].is_placeholder, true);
  await seedNewerWork();
  const beforeEffects = await sideEffects();
  h.statements.length = 0;

  await consumeSuccessfully(completion(), retrySequence);
  const repaired = await turns();
  assert.equal(repaired.length, 2);
  assert.equal(repaired[1].is_placeholder, false);
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
  assert.equal(locks.held.size, 0);
});

test("processed_at is rechecked after acquiring the lock for a delivery without a message id", { timeout: 10_000 }, async () => {
  const waiting = deferred();
  const resume = deferred();
  locks.beforeNextAcquire = async () => { waiting.resolve(); await resume.promise; };
  const event = completion(null);
  const sequence = nextSequence++;
  const delayed = deliver(event, sequence);
  let beforeEffects: Awaited<ReturnType<typeof sideEffects>> | undefined;
  try {
    await Promise.race([waiting.promise, delayed.then(() => { throw new Error("completion did not acquire a lock"); })]);
    await consumeSuccessfully(event, sequence);
    assert.equal(await processed(sequence), true);
    assert.equal((await turns()).length, 2);
    await seedNewerWork();
    beforeEffects = await sideEffects();
    h.statements.length = 0;
  } finally {
    resume.resolve();
    const finished = await delayed;
    assert.deepEqual({ acks: finished.acks, naks: finished.naks }, { acks: 1, naks: [] });
  }
  assert.equal((await turns()).length, 2);
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
  assert.equal(locks.held.size, 0);
});

test("a failed summary invalidation rolls back the correction and leaves the delivery retryable", async () => {
  await consumeSuccessfully(placeholder());
  const original = await turns();
  await seedSummary(3);
  const summary = await activeSummaries();
  await seedNewerWork();
  const beforeEffects = await sideEffects();
  await h.sql(`CREATE FUNCTION reject_completion_summary_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'summary correction unavailable'; END $$`);
  await h.sql(`CREATE TRIGGER reject_completion_summary_change
    BEFORE DELETE OR UPDATE ON claw_session_summaries
    FOR EACH ROW EXECUTE FUNCTION reject_completion_summary_change()`);
  let sequence = 0;
  h.statements.length = 0;
  try {
    const failed = await deliver(completion());
    sequence = failed.sequence;
    assert.equal(failed.acks, 0);
    assert.equal(failed.naks.length, 1);
    assert.equal(await processed(sequence), false);
    assert.deepEqual(await turns(), original);
    assert.deepEqual(await activeSummaries(), summary);
    assert.deepEqual(await sideEffects(), beforeEffects);
    assert.equal(locks.held.size, 0);
  } finally {
    await h.sql("DROP TRIGGER reject_completion_summary_change ON claw_session_summaries");
    await h.sql("DROP FUNCTION reject_completion_summary_change()");
  }

  await consumeSuccessfully(completion(), sequence);
  const repaired = await turns();
  assert.equal(repaired.length, 2);
  assert.equal(repaired[1].content, completion().final_text);
  assert.equal(repaired[1].turn_index, original[1].turn_index);
  assert.equal(repaired[1].is_placeholder, false);
  assert.deepEqual(await activeSummaries(), []);
  assert.equal(await processed(sequence), true);
  assert.deepEqual(await sideEffects(), beforeEffects);
  assert.deepEqual(completionEffectQueries(), []);
});
