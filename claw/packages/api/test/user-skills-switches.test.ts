// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two skill switches, each deciding only its own half.
 *
 *   W1 CLAW_USER_SKILLS_ENABLED and CLAW_SKILL_AUTO_EVOLUTION_ENABLED are read on their own; the old name,
 *      CLAW_SKILL_EVOLUTION_ENABLED, still turns on auto-evolution (only) while the new name is unset, and the new
 *      name wins when both are set
 *   W2 with only auto-evolution on (as a deployment that kept the old setting has it): no skill reaches a turn, and
 *      what a worker's turn saves is dropped, while the auto-evolution steps of a completion still run
 *
 * The flags are read when the modules load, so W2 sets them first, and W1 reads them in child processes.
 */

process.env.CLAW_SKILL_EVOLUTION_ENABLED = "true";
delete process.env.CLAW_SKILL_AUTO_EVOLUTION_ENABLED;
delete process.env.CLAW_USER_SKILLS_ENABLED;

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const config = await import("../src/config.js");
const { userSkillsForTurn } = await import("../src/sessions/user-skills.js");
const { consumeEventDelivery, tombstoneReader, completionPorts } = await import("../src/events/consumer.js");
const { db } = await import("../src/infra/db.js");
const { sc } = await import("../src/infra/nats.js");
const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
const { startHarness, seedRun, seedSession } = await import("./scenario-harness.js");

const CONFIG = fileURLToPath(new URL("../src/config.ts", import.meta.url));

/** The two switches as a fresh process reads them from `env`. */
function switches(env: Record<string, string>): [boolean, boolean] {
  const base = { ...process.env };
  for (const k of ["CLAW_USER_SKILLS_ENABLED", "CLAW_SKILL_AUTO_EVOLUTION_ENABLED", "CLAW_SKILL_EVOLUTION_ENABLED"]) delete base[k];
  const r = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `const c = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify([c.CLAW_USER_SKILLS_ENABLED, c.CLAW_SKILL_AUTO_EVOLUTION_ENABLED]));`,
  ], { env: { ...base, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

test("W1 each switch is read on its own; the old name is auto-evolution's until the new one is set", () => {
  assert.deepEqual(switches({}), [false, false], "both off by default");
  assert.deepEqual(switches({ CLAW_USER_SKILLS_ENABLED: "true" }), [true, false]);
  assert.deepEqual(switches({ CLAW_SKILL_AUTO_EVOLUTION_ENABLED: "true" }), [false, true]);
  assert.deepEqual(switches({ CLAW_SKILL_EVOLUTION_ENABLED: "true" }), [false, true], "the old name never turns on the user's skills");
  assert.deepEqual(switches({ CLAW_SKILL_EVOLUTION_ENABLED: "true", CLAW_SKILL_AUTO_EVOLUTION_ENABLED: "false" }), [false, false], "the new name wins");
});

const SESSION = "skill-switches";
const originalLock = db.lockPool.connect;
const originalQuery = db.query;
const originalTombstone = tombstoneReader.has;
const originalPorts = { ...completionPorts };
let h: Awaited<ReturnType<typeof startHarness>>;
let calls: string[] = [];

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
  const spy = (name: string) => async () => { calls.push(name); };
  Object.assign(completionPorts, {
    saveUserSkill: async () => { calls.push("saveUserSkill"); return { ok: true, id: 1, version: 1, created: true }; },
    recordSkillFeedback: spy("recordSkillFeedback"), checkProbationGraduation: spy("checkProbationGraduation"),
    maybeSummarize: async () => {}, maybeRecordTaskPattern: spy("maybeRecordTaskPattern"), enqueueEvolutionJob: spy("enqueueEvolutionJob"),
  });
  resetDeletedSessionCache();
});

after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.close();
  db.lockPool.connect = originalLock;
  db.query = originalQuery;
  tombstoneReader.has = originalTombstone;
  Object.assign(completionPorts, originalPorts);
  resetDeletedSessionCache();
});

test("W2 auto-evolution alone: no skill reaches a turn and a turn's saves are dropped; its own steps still run", async () => {
  assert.deepEqual([config.CLAW_USER_SKILLS_ENABLED, config.CLAW_SKILL_AUTO_EVOLUTION_ENABLED], [false, true], "the premise");

  // No skill is listed and the turn keeps none, and the database is not even asked.
  const statements: string[] = [];
  const query = db.query;
  db.query = (async (text: string, ...rest: unknown[]) => { statements.push(text); return (query as any)(text, ...rest); }) as typeof db.query;
  try {
    assert.deepEqual(await userSkillsForTurn(SESSION, "u-1"), { enabled: false });
  } finally {
    db.query = query;
  }
  assert.deepEqual(statements, []);

  await seedSession(h, SESSION);
  await seedRun(h, "run-1", SESSION, { status: "running", messageId: "m-1" });
  await h.sql("INSERT INTO claw_skills (user_id, skill_name, version, status) VALUES ('u-1', 'used-skill', 2, 'active')");
  let acks = 0;
  await consumeEventDelivery({
    subject: `events.${SESSION}`, seq: 1, ack: () => { acks++; }, nak: () => {},
    data: sc.encode(JSON.stringify({
      type: "exec_complete", session_id: SESSION, task_id: "run-1", user_id: "u-1", message_id: "m-1",
      prompt: "go", final_text: "done", failed: false, error_count: 0,
      selected_skills: ["used-skill"], skills_used: {},
      skills_to_save: [{ skill_name: "new-skill", content: "body", description: "d" }],
      skill_file_mutations: [{ action: "add", skill_name: "used-skill", file_path: "references/a.md", content: "x" }],
    })),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acks, 1);
  assert.ok(!calls.includes("saveUserSkill"), "a turn's save is kept with the user's skills off");
  assert.ok(calls.includes("recordSkillFeedback"), "auto-evolution's feedback step did not run: this test proves nothing");
  assert.ok(calls.includes("enqueueEvolutionJob"));
});
