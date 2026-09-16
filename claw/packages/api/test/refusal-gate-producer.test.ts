// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The producer side of the refusal's gate guard.
 *
 * `refusePendingAdmission` declines to take the gate when this message already
 * has a completion, because a second completion for one message is discarded
 * and a gate taken under it would have no releaser. Everything about that
 * branch was pinned with the probe stubbed, which proves the branch works and
 * proves nothing about whether production ever reaches it with `true`.
 *
 * It did not. The first version asked `completionAlreadyProcessed`, which
 * requires `processed_at` -- and the consumer writes that only after
 * `handleComplete` returns, while the drain that reaches the second refusal
 * runs inside `handleComplete`. At the deciding moment the first completion is
 * mid-flight with a NULL `processed_at`, so the guard answered "no" for a
 * completion that was about to discard ours.
 *
 * These cases run the real predicate against a real database in exactly that
 * state: an `exec_complete` row that exists and is not yet processed.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { completionAlreadyPublished } from "../src/events/store.js";
import { completionAlreadyProcessed } from "../src/events/consumer.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";

const SESSION = "s-refusal-gate";
let h: Harness;

before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); await seedSession(h, SESSION); });
after(async () => { await h.close(); });

const putCompletion = (messageId: string, processed: boolean) => h.sql(
  `INSERT INTO claw_session_events (event_id, session_id, event, data, processed_at)
   VALUES ($1::text, $2::text, 'exec_complete', jsonb_build_object('message_id', $3::text),
           CASE WHEN $4::boolean THEN NOW() ELSE NULL END)`,
  [`e-${messageId}-${processed ? "p" : "u"}`, SESSION, messageId, processed],
);

test("a completion still being processed already means the next one is discarded", async () => {
  // The exact state the drain runs in: the row is in, `processed_at` is not.
  await putCompletion("m-1", false);

  assert.equal(
    await completionAlreadyPublished(SESSION, "m-1"), true,
    "the guard the refusal asks sees it",
  );
  assert.equal(
    await completionAlreadyProcessed(SESSION, "m-1"), false,
    "and the processed-only question -- the one this used to ask -- does not",
  );
});

test("a message with no completion at all lets the refusal take the gate", async () => {
  // The positive control. Without it the case above holds just as well against
  // a predicate that answers true for everything.
  await putCompletion("m-other", false);

  assert.equal(await completionAlreadyPublished(SESSION, "m-1"), false);
});

test("and a completion that has been processed counts too", async () => {
  await putCompletion("m-1", true);

  assert.equal(await completionAlreadyPublished(SESSION, "m-1"), true);
});

test("a deleted completion does not count, and an empty message id never does", async () => {
  await putCompletion("m-1", false);
  await h.sql("UPDATE claw_session_events SET deleted_at = NOW() WHERE session_id = $1", [SESSION]);

  assert.equal(await completionAlreadyPublished(SESSION, "m-1"), false);
  assert.equal(await completionAlreadyPublished(SESSION, ""), false);
});
