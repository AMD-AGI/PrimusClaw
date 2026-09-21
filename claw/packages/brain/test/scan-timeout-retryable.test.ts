// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A release that never reached the table earns a redelivery.
 *
 * `releaseHandlesForWorkload` bounds its enumeration of `DAG_HANDLES` at
 * `RELEASE_SCAN_TIMEOUT_MS` so a teardown cannot wait on the store for ever.
 * The round that added `DagHandleContendedError` classified that timeout as a
 * permanent failure, on the reasoning that the store had failed -- grouping it
 * with an unparseable row. The two are not alike. An unparseable row hands
 * every reader the same bytes until something rewrites it, so re-reading is
 * asking a question whose answer is already fixed; a scan that timed out
 * produced no answer at all and forecloses nothing about the next one.
 *
 * Measured rather than argued: with a 10.5s enumeration delay injected against
 * the real bucket the release failed at ~10,005ms and the task was acked, and
 * with the delay lifted the SAME release completed in 2.89ms. And the busy
 * bucket that makes a scan overrun is the same busy bucket that makes a CAS
 * race likely -- so the old grouping denied a second delivery to the condition
 * most likely to need one.
 *
 * These assert on the classification rather than on a nak, because the delivery
 * path either side of it is already pinned by
 * gone-handle-release-contention.test.ts: the same `isRetryable` decides both,
 * and driving a real 10s timeout through the runner would buy nothing but ten
 * seconds per run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isRetryable } from "../src/infra/retry.js";
import { DagHandleContendedError, DagHandleScanTimeoutError } from "../src/sandbox/errors.js";

test("a scan that overran its ceiling is retryable", () => {
  assert.equal(
    isRetryable(new DagHandleScanTimeoutError("dag-handles release scan exceeded 10000ms")),
    true,
    "the store was slow for ten seconds, which says nothing about the next read",
  );
  assert.equal(
    isRetryable(new DagHandleScanTimeoutError("dag-handles holder scan exceeded 10000ms")),
    true,
    "and the holder scan raises the same class for the same reason",
  );
});

test("the classification is by class, not by the sentence", () => {
  // The message is prose and prose gets reworded; the earlier round chose a
  // class over a string match for exactly this reason, and the new class is
  // held to it. A plain Error carrying the identical text must NOT be
  // retryable -- otherwise every future `exceeded ...ms` message anywhere in
  // the process inherits a redelivery nobody asked for.
  assert.equal(
    isRetryable(new Error("dag-handles release scan exceeded 10000ms")),
    false,
    "an ordinary Error with the same words is still judged on its own terms",
  );
});

test("the permanent failures out of the same function stay permanent", () => {
  // The line this test defends is a narrow one, and a fix that widened it to
  // "the handle layer is retryable" would spend the delivery budget on
  // questions whose answers cannot change.
  for (const e of [
    new Error("dag-handles.not_initialized -- call initDagHandles(js) at boot"),
    new Error("dag-handle 0 for dag-t1 was not released from w-1: dag-handles row dag-handles.dag-t1 is not a JSON object"),
  ]) {
    assert.equal(isRetryable(e), false, e.message);
  }
  // And the class that earned the first redelivery still earns it.
  assert.equal(isRetryable(new DagHandleContendedError("5 attempts exhausted")), true);
});
