// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a completion saves to the requester's long-term memory, for a session that acts as a user (`config.acting_as`). Its model reads
 * what strangers wrote, so neither what it asked to save (`memories_to_save`, from `save_memory`) nor what would be extracted from its
 * conversation is stored: either is what every later session of the requester would read. Every other effect of the completion is
 * unchanged, and an ordinary run is the control that the same event does trigger both.
 *
 *   C1  an ordinary run saves what was asked, and extracts when nothing was
 *   C2  a run of a session with acting_as saves nothing that was asked, and extracts nothing, and still completes as ever
 *
 * The flags are set before the modules load: the memory, skill-evolution and notification steps are compiled out when their flag is off.
 */

process.env.CLAW_NOTIFICATIONS_ENABLED = "1";
process.env.CLAW_MEMORY_ENABLED = "1";
process.env.CLAW_SKILL_EVOLUTION_ENABLED = "1";
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

const { consumeEventDelivery, tombstoneReader, completionPorts } = await import("../src/events/consumer.js");
const { db } = await import("../src/infra/db.js");
const { sc } = await import("../src/infra/nats.js");
const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
const { startHarness, seedRun, seedSession } = await import("./scenario-harness.js");
type Harness = Awaited<ReturnType<typeof startHarness>>;

const SESSION = "acting-mem";
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
    ADD COLUMN topology JSONB,
    ADD COLUMN tools_allowlist JSONB`);
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

async function seed(actingAs: string | null): Promise<void> {
  await seedSession(h, SESSION, { agentStatus: "running", gateOwner: "m1" });
  await seedRun(h, "run-1", SESSION, {
    status: "running", messageId: "m1",
    spec: { prompt: "review this", session_id: SESSION },
  });
  if (actingAs !== null) {
    await h.sql("UPDATE claw_sessions SET config = $2::jsonb WHERE session_id = $1", [SESSION, JSON.stringify({ acting_as: actingAs })]);
  }
}

function completion(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "exec_complete", session_id: SESSION, task_id: "run-1", message_id: "m1", user_id: "u-1",
    prompt: "review this", error_count: 0, skills_used: {}, selected_skills: [],
    final_text: "done", failed: false,
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

const ASKED = [{ category: "preference", content: "a fact a stranger asked to be kept" }];

test("C1 CONTROL, ordinary run: what was asked is saved; with nothing asked, memory is extracted", async () => {
  await seed(null);
  await consume(completion({ memories_to_save: ASKED }));
  assert.ok(calls.includes("insertMemoryEntry"), `saw ${calls.join(",")}`);
  await h.reset();
  calls = [];
  await seed(null);
  await consume(completion({ memories_to_save: [] }));
  assert.ok(calls.includes("maybeExtractMemory"), `saw ${calls.join(",")}`);
});

test("C2a a session with acting_as saves nothing it asked to save", async () => {
  await seed("someone-else");
  await consume(completion({ memories_to_save: ASKED }));
  assert.equal(calls.includes("insertMemoryEntry"), false, `saw ${calls.join(",")}`);
  assert.ok(calls.includes("maybeSummarize") && calls.includes("recordRunFinished"), "and the completion is otherwise as ever");
  assert.ok((await h.sql("SELECT 1 FROM claw_conversation_turns")).length > 0, "its turns are recorded");
});

test("C2b a session with acting_as has nothing extracted from its conversation", async () => {
  await seed("someone-else");
  await consume(completion({ memories_to_save: [] }));
  assert.equal(calls.includes("maybeExtractMemory"), false, `saw ${calls.join(",")}`);
  assert.ok(calls.includes("maybeSummarize") && calls.includes("recordRunFinished"));
});
