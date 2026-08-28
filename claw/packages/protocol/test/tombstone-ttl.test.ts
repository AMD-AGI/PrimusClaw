// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deletion tombstone has to outlive every message that could still ask about
 * it, and this is the part of that budget the protocol owns.
 *
 * The tombstone answers one question -- was this session deleted while this
 * message was in flight? -- and it used to live in the registry bucket, whose
 * five-minute TTL is chosen for `lock.<key>`, which wants the opposite: to
 * expire fast so a dead worker's claim is released. Sharing the bucket meant
 * the tombstone inherited that, and the gap is not marginal. A redelivery can
 * arrive as late as the stream's retention allows, so for the default budget
 * the mark was gone for the last three hours of the window in which it was the
 * only thing standing between a deleted session and work being dispatched into
 * it: a session the user threw away, quietly given a sandbox and a task.
 *
 * Deriving it from the same budget as the retention is what keeps this bound and
 * the redelivery window from drifting apart. It is a lower bound rather than the
 * lifetime, though, and these tests pin it as one: the API asks the same mark
 * about every event on its own event stream, whose retention is not this
 * package's to know, and it raises the bound to cover that too. What must hold
 * here is that no redelivery can outlast the answer.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTaskStreamMaxAgeNs,
  resolveTombstoneTtlMs,
  DEFAULT_TASK_MAX_DELIVER,
} from "../src/task-consumer.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

test("the tombstone outlives the window in which a message can be redelivered", () => {
  const ttlMs = resolveTombstoneTtlMs(DEFAULT_TASK_MAX_DELIVER);
  const retentionMs = resolveTaskStreamMaxAgeNs(DEFAULT_TASK_MAX_DELIVER) / 1_000_000;

  assert.ok(ttlMs >= retentionMs, "a mark that expires first answers nothing at the end");
});

test("it is far longer than the registry TTL it used to inherit", () => {
  // The concrete size of the old hole: hours of the redelivery window during
  // which a deleted session would have accepted work.
  const ttlMs = resolveTombstoneTtlMs(DEFAULT_TASK_MAX_DELIVER);
  assert.ok(ttlMs > FIVE_MINUTES_MS * 10, `expected well over five minutes, got ${ttlMs}ms`);
  assert.equal(ttlMs, 161 * 60 * 1000, "23 deliveries x (2min ack_wait + 5min nak ceiling)");
});

test("retention covers the nak backoff, not just the ack window", () => {
  // The trap this replaces: retention used to be 2 x maxDeliver x ack_wait,
  // which was right only while the nak ceiling happened to equal ack_wait.
  // Shortening ack_wait under that expression would have left a contended
  // task's message deleted mid-budget -- and a message the stream has dropped
  // is a task that vanishes with its session stuck on 'running'.
  const retentionMs = resolveTaskStreamMaxAgeNs(DEFAULT_TASK_MAX_DELIVER) / 1_000_000;
  const worstCaseBackoffMs = 20 * 60 * 1000 + 10 * 60 * 1000;
  assert.ok(
    retentionMs > worstCaseBackoffMs,
    `retention ${retentionMs}ms must outlast the whole backoff chain`,
  );
});

test("changing the redelivery budget moves both numbers together", () => {
  // The point of deriving rather than choosing: someone raising max_deliver
  // cannot leave the tombstone behind at the old value.
  for (const maxDeliver of [3, 10, 25, 100]) {
    assert.equal(
      resolveTombstoneTtlMs(maxDeliver),
      resolveTaskStreamMaxAgeNs(maxDeliver) / 1_000_000,
    );
  }
});
