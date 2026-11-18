// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from the Python suite's test_transport.py: the one case there that reads an inbound activity. */
import assert from "node:assert/strict";
import test from "node:test";
import { messageText } from "../../src/activity/inbound/index.js";

test("mention markup is stripped", () => {
  const activity = {
    text: "<at>PrimusClaw Assistant</at> /new",
    entities: [{ type: "mention", text: "<at>PrimusClaw Assistant</at>" }],
  };
  assert.equal(messageText(activity), "/new");
});
