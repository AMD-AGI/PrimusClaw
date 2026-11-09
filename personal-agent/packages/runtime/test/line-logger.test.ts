// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { lineLogger } from "../src/index.js";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const log = lineLogger({ level, write: (l) => lines.push(l), now: () => Date.UTC(2026, 10, 9, 12, 0, 0) });
  return { lines, log };
}

test("a line is time, level, message and the fields as key=value", () => {
  const { lines, log } = capture();
  log.info("outbound send", { chars: 12, ack: false, id: "a:b/c", none: null, missing: undefined });
  assert.deepEqual(lines, [
    "2026-11-09T12:00:00.000Z INFO outbound send chars=12 ack=false id=a:b/c none=null missing=-",
  ]);
});

test("a value that is not a simple token is quoted", () => {
  const { lines, log } = capture();
  log.warn("x", { reason: "two words", empty: "" });
  assert.deepEqual(lines, ['2026-11-09T12:00:00.000Z WARN x reason="two words" empty=""']);
});

test("lines below the level are dropped", () => {
  const { lines, log } = capture("warn");
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.deepEqual(
    lines.map((l) => l.split(" ")[1]),
    ["WARN", "ERROR"],
  );
});

test("a child's fields come first, and a call's own fields override them", () => {
  const { lines, log } = capture();
  const child = log.child({ module: "turn", conv: "c1" }).child({ user: "u1" });
  child.error("failed", { conv: "c2", kind: "TypeError" });
  child.debug("d");
  assert.deepEqual(lines, [
    "2026-11-09T12:00:00.000Z ERROR failed module=turn conv=c2 user=u1 kind=TypeError",
    "2026-11-09T12:00:00.000Z DEBUG d module=turn conv=c1 user=u1",
  ]);
});
