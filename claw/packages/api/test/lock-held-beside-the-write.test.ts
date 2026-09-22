// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// lock-held-beside-the-write.test.ts
//
// Both writes below are guarded by an advisory lock held on a DIFFERENT
// connection, so asking "do I still hold it" can never be atomic with the
// write. What it can be is adjacent: these pin that the question is asked
// beside the statement rather than several awaits earlier, which is the
// difference between a window one statement wide and one that spans a pool
// wait, a transaction and a parent authorisation read.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("the turn allocation asks whether the lock is still held, in front of the MAX read", async () => {
  const src = await read("../src/events/completion-turns.ts");
  const head = src.slice(0, src.indexOf("COALESCE(MAX(turn_index)"));
  assert.match(head, /stillHeld\?: \(\) => boolean/, "the probe is a parameter");
  assert.match(head, /if \(stillHeld && !stillHeld\(\)\) throw new CompletionLockLost\(\);/,
    "asked before the read that decides the indices, and THROWN rather than returned: a "
    + "plain return reads as \"saved\" to the caller, which then dispatches the next queued "
    + "message with a history this turn is missing from");
});

test("every completion path hands that probe down rather than dropping it", async () => {
  const src = await read("../src/events/consumer.ts");
  const calls = src.match(/recordCompletionTurns\(sessionId, event, messageId[^;]*/g) ?? [];
  assert.ok(calls.length >= 3, `all the turn-recording call sites are covered, saw ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /stillHeld|lease\.lost\(\)/,
      `a call site that passes no probe reopens the window: ${c}`);
  }
  // And the one that lives inside handleComplete is reached by the same probe,
  // which means handleComplete has to carry it down rather than stop at its own
  // entry check.
  assert.match(src, /stillHeld\?: \(\) => boolean/, "handleComplete takes the probe");
  assert.match(src, /handleComplete\(sessionId, event, rowId, provenance, \(\) => !lease\.lost\(\)\)/,
    "and every caller inside the lock body supplies it");
});

test("the session insert asks it beside the INSERT, not before the awaits that precede it", async () => {
  const src = await read("../src/routes/sessions.ts");
  for (const insert of ["await insertSessionRow(db, row, parentAuth);",
                        "await insertSessionRow(client, row, parentAuth);"]) {
    const at = src.indexOf(insert);
    assert.ok(at > 0, `${insert} is still the insert site`);
    const before = src.slice(Math.max(0, at - 400), at);
    assert.match(before, /if \(stillHeld && !stillHeld\(\)\)/,
      "the lock is re-checked immediately in front of this insert");
    assert.match(before, /return LOCK_LOST_REFUSAL;/, "and the create is refused");
  }
  // The refusal inside the transaction has to give the connection back clean:
  // returning with the transaction open leaves the admission lock held, and
  // that is a lock every other create waits on.
  const txAt = src.indexOf("await insertSessionRow(client, row, parentAuth);");
  const txBefore = src.slice(Math.max(0, txAt - 400), txAt);
  {
    assert.match(txBefore, /await client\.query\("ROLLBACK"\);\s*\n\s*return LOCK_LOST_REFUSAL;/,
      "the transactional refusal rolls back before it returns");
  }
});
