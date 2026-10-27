// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Schedules are evaluated in the owner's timezone, and a schedule that fires
// too often is refused before it is stored.
import assert from "node:assert/strict";
import test from "node:test";

import { checkSchedule, isValidTimezone, nextFireAfter } from "../src/triggers/schedule.js";

test("08:00 in Asia/Shanghai is 00:00 UTC", () => {
  const next = nextFireAfter("0 8 * * *", "Asia/Shanghai", new Date("2026-10-27T01:00:00Z"));
  assert.equal(next?.toISOString(), "2026-10-28T00:00:00.000Z");
});

test("the same wall-clock time moves in UTC across a spring-forward day", () => {
  const before = nextFireAfter("0 8 * * *", "America/New_York", new Date("2026-03-07T00:00:00Z"));
  const after = nextFireAfter("0 8 * * *", "America/New_York", before!);
  assert.equal(before?.toISOString(), "2026-03-07T13:00:00.000Z"); // EST, UTC-5
  assert.equal(after?.toISOString(), "2026-03-08T12:00:00.000Z"); // EDT, UTC-4
});

test("a wall-clock time that does not exist fires at most once that day", () => {
  const from = new Date("2026-03-08T00:00:00Z");
  const seen: string[] = [];
  let at: Date | null = nextFireAfter("30 2 * * *", "America/New_York", from);
  while (at && at.getTime() < Date.parse("2026-03-10T00:00:00Z")) {
    seen.push(at.toISOString());
    at = nextFireAfter("30 2 * * *", "America/New_York", at);
  }
  assert.ok(seen.length <= 2, `fired ${seen.length} times in two days: ${seen.join(",")}`);
  assert.equal(new Set(seen).size, seen.length);
});

test("the minimum interval is enforced", () => {
  const ok = checkSchedule("*/15 * * * *", "UTC", 15);
  assert.equal(ok.ok, true);
  for (const expr of ["* * * * *", "*/10 * * * *", "0,5 * * * *"]) {
    const r = checkSchedule(expr, "UTC", 15);
    assert.equal(r.ok, false, expr);
  }
  assert.equal(checkSchedule("0 8 * * *", "Asia/Shanghai", 15).ok, true);
});

test("malformed input is refused", () => {
  assert.equal(checkSchedule("0 8 * *", "UTC", 15).ok, false, "four fields");
  assert.equal(checkSchedule("*/15 * * * * *", "UTC", 15).ok, false, "six fields (seconds)");
  assert.equal(checkSchedule("0 8 * * *", "Mars/Olympus", 15).ok, false, "unknown timezone");
  assert.equal(checkSchedule("99 8 * * *", "UTC", 15).ok, false, "out of range");
  assert.equal(isValidTimezone("Asia/Shanghai"), true);
  assert.equal(isValidTimezone(""), false);
});
