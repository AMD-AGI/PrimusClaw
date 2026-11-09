// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { epochSeconds, richMessage, silentLogger, textMessage, type Clock } from "../src/index.js";

test("epochSeconds is the wall clock in (fractional) seconds, the stored unit", () => {
  const clock: Clock = { epochMs: () => 1_700_000_000_250, monotonicMs: () => 0, sleep: () => Promise.resolve() };
  assert.equal(epochSeconds(clock), 1_700_000_000.25);
});

test("the silent logger drops everything, and so do its children", () => {
  silentLogger.debug("a");
  silentLogger.info("a", { n: 1 });
  silentLogger.warn("a");
  silentLogger.error("a");
  assert.equal(silentLogger.child({ module: "x" }), silentLogger);
});

test("textMessage and richMessage build the two plain bodies", () => {
  assert.deepEqual(textMessage("hi"), { body: { type: "text", text: "hi" } });
  assert.deepEqual(richMessage("**a**"), { body: { type: "rich", markdown: "**a**", lead: false } });
  assert.deepEqual(richMessage("x", { lead: true, aiGenerated: true }), {
    body: { type: "rich", markdown: "x", lead: true },
    aiGenerated: true,
  });
});
