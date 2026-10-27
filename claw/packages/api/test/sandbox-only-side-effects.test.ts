// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox-only run (the terminal's start) is invisible to every completion
 * side effect except releasing the session gate and closing its run row. It is
 * classified once in `handleComplete`; here each side effect is watched, with
 * an ordinary run as the control that the same event does trigger it.
 *
 * The flags are set before the modules load: the memory, skill-evolution and
 * notification steps are compiled out when their flag is off, and a test that
 * left them off would pass for that reason alone.
 */

process.env.CLAW_NOTIFICATIONS_ENABLED = "1";
process.env.CLAW_MEMORY_ENABLED = "1";
process.env.CLAW_SKILL_EVOLUTION_ENABLED = "1";

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

const { consumeEventDelivery, tombstoneReader, completionPorts } = await import("../src/events/consumer.js");
const { db } = await import("../src/infra/db.js");
const { sc } = await import("../src/infra/nats.js");
const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
const { startHarness, seedRun, seedSession } = await import("./scenario-harness.js");
type Harness = Awaited<ReturnType<typeof startHarness>>;

const SESSION = "sbx-side";
const originalConnect = db.lockPool.connect;
const originalTombstone = tombstoneReader.has;
const originalPorts = { ...completionPorts };
let h: Harness;
let seq = 1;
let calls: string[];

function stubLockPool(): void {
  const held = new Set<number>();
  db.lockPool.connect = (async () => {
    const owned = new Set<number>();
    return {
      async query(sql: string, params: unknown[] = []) {
        const id = params[0] as number;
        if (sql.includes("pg_try_advisory_lock")) {
          if (held.has(id)) return { rows: [{ ok: false }] };
          held.add(id); owned.add(id);
          return { rows: [{ ok: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          return { rows: [{ released: owned.delete(id) && held.delete(id) }] };
        }
        throw new Error(`Unexpected lock query: ${sql}`);
      },
      release(destroy?: boolean) { if (destroy) for (const id of owned) held.delete(id); },
    };
  }) as unknown as typeof db.lockPool.connect;
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
  // Read by the skill-feedback step the control run reaches.
  await h.sql(`CREATE TABLE claw_skills (id SERIAL PRIMARY KEY, user_id TEXT, skill_name TEXT,
    status TEXT DEFAULT 'active', version INT DEFAULT 1, deleted_at TIMESTAMPTZ)`);
  await h.sql("CREATE TABLE claw_skill_files (id SERIAL PRIMARY KEY, skill_id INT)");
});
beforeEach(async () => {
  await new Promise<void>((r) => setImmediate(r));
  await h.reset();
  seq = 1;
  stubLockPool();
  tombstoneReader.has = async () => false;
  resetDeletedSessionCache();
  calls = [];
  const spy = (name: string, result: unknown = undefined) => async () => { calls.push(name); return result; };
  Object.assign(completionPorts, originalPorts, {
    insertMemoryEntry: spy("insertMemoryEntry", true),
    saveSkill: spy("saveSkill"),
    recordSkillFeedback: spy("recordSkillFeedback"),
    checkProbationGraduation: spy("checkProbationGraduation"),
    maybeSummarize: spy("maybeSummarize"),
    maybeExtractMemory: spy("maybeExtractMemory"),
    maybeRecordTaskPattern: spy("maybeRecordTaskPattern"),
    enqueueEvolutionJob: spy("enqueueEvolutionJob"),
    recordRunFinished: spy("recordRunFinished", 1),
  });
});
after(async () => {
  Object.assign(completionPorts, originalPorts);
  await new Promise<void>((r) => setImmediate(r));
  await h.sql("SELECT 1");
  await h.close();
  db.lockPool.connect = originalConnect;
  tombstoneReader.has = originalTombstone;
});

async function seed(sandboxOnly: boolean): Promise<void> {
  await seedSession(h, SESSION, { agentStatus: "running", gateOwner: "m1" });
  await seedRun(h, "run-1", SESSION, {
    status: "running", messageId: "m1",
    spec: { prompt: "[sandbox start]", session_id: SESSION, ...(sandboxOnly ? { sandbox_only: true } : {}) },
  });
}

function completion(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "exec_complete", session_id: SESSION, task_id: "run-1", message_id: "m1", user_id: "u-1",
    prompt: "[sandbox start]", error_count: 0, skills_used: {}, selected_skills: ["sk"],
    memories_to_save: [{ content: "a fact", kind: "fact" }],
    skills_to_save: [{ skill_name: "sk", content: "body" }],
    ...extra,
  };
}

async function consume(event: Record<string, unknown>): Promise<void> {
  let acks = 0;
  await consumeEventDelivery({
    subject: `events.${SESSION}`, data: sc.encode(JSON.stringify(event)), seq: seq++,
    ack: () => { acks++; }, nak: () => { throw new Error("nak"); },
  });
  await new Promise<void>((r) => setImmediate(r));
  await h.sql("SELECT 1");
  assert.equal(acks, 1);
}

const SIDE_EFFECTS = [
  "insertMemoryEntry", "saveSkill", "recordSkillFeedback", "checkProbationGraduation", "maybeSummarize",
  "maybeRecordTaskPattern", "enqueueEvolutionJob", "recordRunFinished",
];

const OUTCOMES: Array<[string, Record<string, unknown>]> = [
  ["success", { final_text: "done", failed: false }],
  ["failure", { failed: true, failure_reason: "image pull failed" }],
];

for (const [name, event] of OUTCOMES) {
  test(`sandbox-only run, ${name}: no completion side effect; gate released, run closed, no turns`, async () => {
    await seed(true);
    await consume(completion(event));
    assert.deepEqual(calls, []);
    const session = await h.sql("SELECT agent_status FROM claw_sessions WHERE session_id = $1", [SESSION]);
    assert.notEqual(session[0].agent_status, "running", "the gate is released");
    assert.equal(session[0].agent_status === "idle" || session[0].agent_status === "failed", true);
    const run = await h.sql("SELECT status FROM claw_tasks WHERE task_id = 'run-1'");
    assert.notEqual(run[0].status, "running", "the run row is closed");
    assert.deepEqual(await h.sql("SELECT 1 FROM claw_conversation_turns"), []);
  });

  test(`CONTROL, ordinary run, ${name}: every side effect is triggered`, async () => {
    await seed(false);
    await consume(completion(event));
    for (const effect of SIDE_EFFECTS) {
      assert.ok(calls.includes(effect), `${effect} runs for an ordinary run (saw ${calls.join(",")})`);
    }
    assert.ok((await h.sql("SELECT 1 FROM claw_conversation_turns")).length > 0);
  });
}

test("CONTROL: an ordinary run with nothing saved explicitly still extracts memory; a sandbox-only run does not", async () => {
  await seed(false);
  await consume(completion({ final_text: "done", memories_to_save: [] }));
  assert.ok(calls.includes("maybeExtractMemory"), `saw ${calls.join(",")}`);
  await h.reset();
  calls = [];
  await seed(true);
  await consume(completion({ final_text: "done", memories_to_save: [] }));
  assert.deepEqual(calls, []);
});
