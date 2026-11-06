// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With skill evolution on, a completion that selected an inline skill has `skills_used` filled in and its stored event
 * written again (`handleComplete`). That second write stores the masked copy too, not the event the turn's handling holds.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

process.env.CLAW_SKILL_EVOLUTION_ENABLED = "true";
const { consumeEventDelivery, tombstoneReader, completionPorts } = await import("../src/events/consumer.js");
const { db } = await import("../src/infra/db.js");
const { sc } = await import("../src/infra/nats.js");
const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
const { startHarness, seedRun, seedSession } = await import("./scenario-harness.js");

// Assembled from pieces so no scanner reads this file as holding a credential.
const SAFE_KEY = `ak-${"Q7w8E9r0T1y2".repeat(4)}`;
const SESSION = "stored-redaction-skills";
const originalLock = db.lockPool.connect;
const originalTombstone = tombstoneReader.has;
const originalPorts = { ...completionPorts };
let h: Awaited<ReturnType<typeof startHarness>>;

before(async () => {
  h = await startHarness();
  await h.sql(`CREATE TABLE IF NOT EXISTS claw_skills (id SERIAL PRIMARY KEY, user_id TEXT, skill_name TEXT, version INT, status TEXT, deleted_at TIMESTAMPTZ)`);
  await h.sql(`CREATE TABLE IF NOT EXISTS claw_skill_files (skill_id INT)`);
  const held = new Set<number>();
  db.lockPool.connect = (async () => ({
    async query(sql: string, params: unknown[] = []) {
      const id = params[0] as number;
      if (sql.includes("pg_try_advisory_lock")) {
        if (held.has(id)) return { rows: [{ ok: false }] };
        held.add(id);
        return { rows: [{ ok: true }] };
      }
      return { rows: [{ released: held.delete(id) }] };
    },
    release() {},
  })) as unknown as typeof db.lockPool.connect;
  tombstoneReader.has = async () => false;
  // The learning that follows is not what this file is about.
  Object.assign(completionPorts, {
    recordSkillFeedback: async () => {}, checkProbationGraduation: async () => {}, maybeSummarize: async () => {},
    maybeRecordTaskPattern: async () => {}, enqueueEvolutionJob: async () => {},
  });
  resetDeletedSessionCache();
});

after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.close();
  db.lockPool.connect = originalLock;
  tombstoneReader.has = originalTombstone;
  Object.assign(completionPorts, originalPorts);
  resetDeletedSessionCache();
});

test("the stored completion an inline skill's backfill writes again is still the masked copy", async () => {
  await seedSession(h, SESSION);
  await seedRun(h, "run-1", SESSION, { status: "running", messageId: "m-1" });
  await h.sql("INSERT INTO claw_skills (user_id, skill_name, version, status) VALUES ('u-1', 'inline-skill', 4, 'active')");
  let acks = 0;
  await consumeEventDelivery({
    subject: `events.${SESSION}`, seq: 1, ack: () => { acks++; }, nak: () => {},
    data: sc.encode(JSON.stringify({
      type: "exec_complete", session_id: SESSION, task_id: "run-1", user_id: "u-1", message_id: "m-1",
      prompt: "deploy", final_text: `deployed with ${SAFE_KEY}`, failed: false, error_count: 0,
      selected_skills: ["inline-skill"], skills_used: {},
    })),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acks, 1);
  const [row] = await h.sql("SELECT data FROM claw_session_events WHERE session_id = $1 AND event = 'exec_complete'", [SESSION]);
  assert.deepEqual(row.data.skills_used, { "inline-skill": 4 }, "the backfill ran, or this proves nothing");
  assert.equal(row.data.final_text, "deployed with <redacted>");
});
