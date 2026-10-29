// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox-only run (the terminal's start) is not a conversation turn on any
 * outcome. Brain's terminal event carries the run's synthetic prompt, and the
 * completion writer used to turn a failure or a Stop into a user turn plus
 * "[Task failed: ...]" / "[Interrupted by user]", which the next real message
 * then sent to the model as history. The writer now recognises the run from its
 * row and writes nothing, for every outcome; an ordinary run is the control.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { recordCompletionTurns } from "../src/events/completion-turns.js";
import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function turns(): Promise<Record<string, unknown>[]> {
  return await h.sql("SELECT role, content, message_id FROM claw_conversation_turns ORDER BY turn_index");
}

async function seed(sandboxOnly: boolean): Promise<void> {
  await seedSession(h, "s1", { agentStatus: "running", gateOwner: "m1" });
  await seedRun(h, "t1", "s1", {
    messageId: "m1", status: "running",
    spec: { prompt: "[sandbox start]", session_id: "s1", ...(sandboxOnly ? { sandbox_only: true } : {}) },
  });
}

const OUTCOMES: Array<[string, Record<string, unknown>]> = [
  ["success", { prompt: "[sandbox start]", final_text: "done" }],
  ["failure", { prompt: "[sandbox start]", failed: true, failure_reason: "image pull failed" }],
  ["interrupt", { prompt: "[sandbox start]", interrupted: true }],
  ["timeout / reaped run (sweeper placeholder)", {
    prompt: "[sandbox start]", failed: true, failure_reason: "worker_lost", completion_source: "sweeper",
  }],
];

for (const [name, event] of OUTCOMES) {
  test(`sandbox-only run, ${name}: no transcript turn is written`, async () => {
    await seed(true);
    await recordCompletionTurns("s1", event, "m1");
    assert.deepEqual(await turns(), []);
  });

  test(`CONTROL, ordinary run, ${name}: the turns are written`, async () => {
    await seed(false);
    await recordCompletionTurns("s1", event, "m1");
    const written = await turns();
    assert.deepEqual(written.map((t) => t.role), ["user", "assistant"]);
  });
}

test("a sandbox-only run's turns do not reach the history of the next real message", async () => {
  await seed(true);
  await recordCompletionTurns("s1", { prompt: "[sandbox start]", failed: true, failure_reason: "quota" }, "m1");
  await h.sql(
    `INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, token_count, message_id)
     VALUES ('s1', 1, 'user', 'hello', 1, 'm2')`,
  );
  const all = await h.sql("SELECT content FROM claw_conversation_turns WHERE session_id = 's1' AND deleted_at IS NULL");
  assert.deepEqual(all.map((r) => r.content), ["hello"]);
});
