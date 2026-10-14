// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A script run handed over under the plaintext (v3) checkpoint format.
 *
 * Progress is tool results verbatim -- captures and the last structured
 * result -- and v3 is plaintext behind a redactor that both leaves values it
 * does not recognise readable and rewrites the ones it does. So under v3 none
 * of it is written:
 *
 *   V1 a drained run still hands over (lease released, request published again,
 *      delivery acked), and puts nothing of its results into the bucket
 *   V2 the worker taking it over starts from the first step, and the background
 *      start there is sent under the same step identity, which is what lets it
 *      resolve to the shell already running rather than start the job again
 */
process.env.CHECKPOINT_WRITE_VERSION = "3";

import test from "node:test";
import assert from "node:assert/strict";

const {
  runWorker, sharedKv, untilAborted, SIGTERM_ABORT_REASON, START_THEN_WAIT, SUBJECT, TASK,
} = await import("./fixtures/script-worker.js");

test("V1/V2 under v3 a drained run is handed over, keeps no results, and is replayed by step identity", async () => {
  const { kv, store } = sharedKv();
  const SECRET_SHAPED = "value-only-the-tool-returned-7f3a";

  const first = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 60,
    answer: async (name, _args, w, signal) => {
      if (name === "bash") {
        return { text: "started", structured: { shell_id: "sh-live", data: SECRET_SHAPED } };
      }
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });
  assert.deepEqual(first.released, [{ taskId: TASK, releaseLease: true }]);
  assert.equal(first.republished.length, 1, "the hand-over does not depend on the checkpoint format");
  assert.equal(first.republished[0].subject, SUBJECT);
  assert.deepEqual(first.delivery.settled, ["ack"]);
  for (const [key, value] of store) {
    assert.ok(!new TextDecoder().decode(value).includes(SECRET_SHAPED),
      `a tool result reached the plaintext bucket under ${key}`);
  }

  const second = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: false, seq: 61,
    answer: async (name) => {
      if (name === "bash") return { text: "already started", structured: { shell_id: "sh-live" } };
      return { structured: { finished: true } };
    },
  });
  assert.deepEqual(second.calls.map((c) => [c.name, c.step]), [["bash", "script:0"], ["wait", "script:1"]],
    "without progress the takeover replays from the first step, under the identity that deduplicates it");
  assert.equal(second.done[0]?.abortReason, "completed");
});
