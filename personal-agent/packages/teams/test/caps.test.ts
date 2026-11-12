// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { teamsCaps } from "../src/index.js";

test("direct mode streams and deletes; the queue does neither", () => {
  assert.deepEqual(teamsCaps("direct"), {
    channel: "teams",
    name: "Microsoft Teams",
    shortName: "Teams",
    citationsMax: 20,
    suggestionsMax: 3,
    streamSeconds: 600,
    streaming: true,
    messageIds: true,
    edit: true,
    delete: true,
    views: true,
    citations: true,
    suggestions: true,
  });
  const queue = teamsCaps("queue");
  assert.equal(queue.streaming, false);
  assert.equal(queue.delete, false);
  assert.equal(queue.edit, true);
  // (what core says, keys and limits by: the same either way)
  assert.equal(queue.channel, "teams");
  assert.equal(queue.streamSeconds, 600);
});
