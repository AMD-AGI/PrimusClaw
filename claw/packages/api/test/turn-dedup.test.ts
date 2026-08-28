// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What stops one finished turn being recorded as two.
 *
 * A completion is not delivered once. JetStream redelivers it after a nak, and
 * Brain publishes it again when a run that was interrupted is picked back up and
 * finishes on another pod. The consumer only ever recognised the first of those:
 * its idempotency key is the event id, which is derived from the stream
 * sequence, and a re-publish has a sequence of its own. Everything downstream
 * then ran a second time -- the user's message and the assistant's reply written
 * into the history twice, so the user reads their own message twice and so does
 * the model on every later turn, and the message queued behind this one
 * dispatched twice, as two runs.
 *
 * The message id is the one thing that is constant across all of it, because it
 * names the user's message rather than the delivery. Two things use it, and the
 * split matters: the check below skips work that has already been done, and the
 * unique index makes the turns unrepeatable whether or not the check saw it --
 * which is the case two replicas handling the same turn in the same instant.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { db } from "../src/infra/db.js";
import { completionAlreadyProcessed, recordCompletionTurns } from "../src/events/consumer.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

let seen: SeenQuery[] = [];
beforeEach(() => { seen = []; });

/** Answer each statement by matching on it; anything unmatched comes back empty. */
function stubDb(answers: Array<[RegExp, unknown]> = []): void {
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    for (const [re, rows] of answers) {
      if (re.test(sql)) return { rows: rows as unknown[], rowCount: (rows as unknown[]).length };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

/** The turn-index read every turn write starts from. */
const LAST_INDEX: Array<[RegExp, unknown]> = [[/^SELECT COALESCE\(MAX\(turn_index\)/, [{ max: 4 }]]];

const turnInserts = (): SeenQuery[] =>
  seen.filter((q) => /^INSERT INTO claw_conversation_turns/.test(q.sql));

test("a completion published a second time is recognised as the same one", async () => {
  stubDb([[/FROM claw_session_events/, [{ "?column?": 1 }]]]);
  assert.equal(await completionAlreadyProcessed("s-1", "msg-1"), true);

  const sql = seen[0].sql;
  assert.deepEqual(seen[0].params, ["s-1", "msg-1"],
    "the key is the message, not the delivery: that is the whole point");
  assert.match(sql, /processed_at IS NOT NULL/,
    "an attempt that died half way through left this NULL on purpose, and its "
    + "retry has to finish the job rather than be told it is already done");
  assert.match(sql, /event = 'exec_complete'/,
    "the other events of a turn carry the same message id and say nothing about it");
  assert.match(sql, /deleted_at IS NULL/);
});

test("a completion nobody has handled is handled", async () => {
  stubDb();
  assert.equal(await completionAlreadyProcessed("s-1", "msg-1"), false);
});

test("a completion with no message id falls back to the per-delivery check", async () => {
  // Answering from the session alone would read as "some completion of this
  // session was processed", which is true of nearly every event on a session
  // that has ever finished a turn, and would drop the work of all of them.
  stubDb([[/FROM claw_session_events/, [{ "?column?": 1 }]]]);
  assert.equal(await completionAlreadyProcessed("s-1", ""), false);
  assert.equal(seen.length, 0, "and it costs no query to say so");
});

test("the two turns of one exchange are written under the message that asked for it", async () => {
  stubDb(LAST_INDEX);
  await recordCompletionTurns(
    "s-1",
    { prompt: "hello", final_text: "hi", message_id: "msg-1" },
    "msg-1",
  );

  const [user, assistant] = turnInserts();
  assert.equal(user.params[2], "user");
  assert.equal(user.params[5], "msg-1");
  assert.equal(assistant.params[2], "assistant");
  assert.equal(assistant.params[7], "msg-1");
  assert.equal(user.params[1], 5, "turn indexes continue from the last one recorded");
  assert.equal(assistant.params[1], 6);
});

test("writing a turn that is already there is not an error", async () => {
  // The check for an earlier delivery cannot cover two replicas handling one
  // turn at the same instant: neither can see a processed_at the other has not
  // written yet. Both reach here, and one of them has to yield rather than
  // raise -- raising would nak the message and try the whole thing again.
  stubDb(LAST_INDEX);
  await recordCompletionTurns("s-1", { prompt: "hello", final_text: "hi" }, "msg-1");

  for (const insert of turnInserts()) {
    assert.match(insert.sql, /ON CONFLICT DO NOTHING$/);
    assert.ok(!/ON CONFLICT \(/.test(insert.sql),
      "untargeted, because the index it has to catch is partial and naming it "
      + "here means repeating its predicate for the two to stay in step");
  }
});

test("a caller that sends no message id writes turns that are not compared", async () => {
  // Null rather than the empty string, and the index partial on it. An empty
  // string is a value: every such turn of a session would collide with the
  // first, and the conversation would stop being recorded after one exchange.
  stubDb(LAST_INDEX);
  await recordCompletionTurns("s-1", { prompt: "hello", final_text: "hi" }, null);

  const [user, assistant] = turnInserts();
  assert.equal(user.params[5], null);
  assert.equal(assistant.params[7], null);
});

test("a turn is recorded even when the run failed, and even with nothing to show", async () => {
  // Losing the history on failure is how the next message reaches the model with
  // an empty context and either redoes finished work or invents tool calls.
  stubDb(LAST_INDEX);
  await recordCompletionTurns("s-1", { prompt: "hello", failed: true }, "msg-1");
  assert.match(String(turnInserts()[1].params[3]), /Task failed/);

  seen = [];
  await recordCompletionTurns("s-1", { prompt: "hello", interrupted: true }, "msg-2");
  assert.match(String(turnInserts()[1].params[3]), /Interrupted by user/);
});

test("a completion that produced nothing at all writes no turn", async () => {
  stubDb(LAST_INDEX);
  await recordCompletionTurns("s-1", { prompt: "hello" }, "msg-1");
  assert.equal(seen.length, 0);
});

test("the schema is what makes the duplicate impossible, not the insert", () => {
  // `ON CONFLICT DO NOTHING` with nothing to conflict on is an ordinary insert.
  // It reads as a guard, it passes review as a guard, and it writes the second
  // turn -- on a deployment that looks entirely healthy.
  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/db.ts", import.meta.url)),
    "utf-8",
  ).replace(/\s+/g, " ");
  assert.match(
    src,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_turns_message_role ON claw_conversation_turns\(session_id, message_id, role\) WHERE message_id IS NOT NULL AND deleted_at IS NULL/,
    "one turn per (session, message, role)",
  );
  assert.ok(
    !/CREATE UNIQUE INDEX[^;]*uq_turns_message_role[^;]*\)\s*\.catch/.test(src),
    "a constraint that fails to be created must not be swallowed like a hint",
  );
});
