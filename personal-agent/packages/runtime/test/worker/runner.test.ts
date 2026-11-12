// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The worker's parts are each closed when it stops, even when one before fails to close. */
import assert from "node:assert/strict";
import { it } from "node:test";

import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { closeAll } from "../../src/worker/runner.js";

it("every part is closed even when one before it fails, and the failure is logged by its kind", async () => {
  const closed: string[] = [];
  const logger = new RecordingLogger();
  await closeAll(logger, [
    () => {
      closed.push("outbound");
      throw new TypeError("connection reset");
    },
    () => Promise.reject(new RangeError("queue gone")).finally(() => closed.push("inbound")),
    () => {
      closed.push("store");
    },
  ]);
  assert.deepEqual(closed, ["outbound", "inbound", "store"]);
  assert.deepEqual(
    logger.lines.map((l) => [l.level, l.fields["error"]]),
    [
      ["error", "TypeError"],
      ["error", "RangeError"],
    ],
  );
  assert.ok(!logger.dump().includes("connection reset"));
});
