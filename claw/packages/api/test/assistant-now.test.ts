// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What "now" is for the person a router turn answers (`assistant/now.ts`), pinned to a UTC time whose date and weekday differ from
 * Beijing's: 2026-11-13 16:40 UTC is Friday in UTC and Saturday 00:40 in Asia/Shanghai (sa-eval public-general-irr-026 was answered
 * with the UTC weekday at that hour).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_USER_TIMEZONE, renderNowState, timeZoneOf, wallClock } from "../src/assistant/now.js";
import { parseChannelContext } from "../src/assistant/inbound.js";

const AFTER_BEIJING_MIDNIGHT = new Date("2026-11-13T16:40:00Z");

test("N1 the wall clock in a zone: the date and weekday are the zone's", () => {
  assert.equal(wallClock(AFTER_BEIJING_MIDNIGHT, "Asia/Shanghai"), "Saturday 2026-11-14 00:40");
  assert.equal(wallClock(AFTER_BEIJING_MIDNIGHT, "UTC"), "Friday 2026-11-13 16:40");
  assert.equal(wallClock(AFTER_BEIJING_MIDNIGHT, "America/Los_Angeles"), "Friday 2026-11-13 08:40");
});

test("N2 the router's line: the user's zone first, as the answer; the default zone when the chat names none", () => {
  const none = renderNowState(AFTER_BEIJING_MIDNIGHT);
  assert.equal(DEFAULT_USER_TIMEZONE, "Asia/Shanghai");
  assert.match(none, /^Now, for the user: Saturday 2026-11-14 00:40 in Asia\/Shanghai \(their chat names no time zone, so the default one\); 2026-11-13 16:40 UTC\./);
  assert.match(none, /is in Asia\/Shanghai: answer with that, as the answer, not in a note/);
  const la = renderNowState(AFTER_BEIJING_MIDNIGHT, "America/Los_Angeles");
  assert.match(la, /^Now, for the user: Friday 2026-11-13 08:40 in America\/Los_Angeles \(the user's time zone, as their chat says\)/);
  // A zone that is no zone is not the user's: the default, said as the default.
  assert.match(renderNowState(AFTER_BEIJING_MIDNIGHT, "Mars/Olympus"), /Saturday 2026-11-14 00:40 in Asia\/Shanghai \(their chat names no time zone/);
});

test("N3 a time zone from the chat is kept only when it is one", () => {
  assert.equal(timeZoneOf("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(timeZoneOf("UTC"), "UTC");
  for (const bad of ["", "Mars/Olympus", "+08:00", "Asia/Shanghai; drop", "x".repeat(65), 8, null, undefined]) {
    assert.equal(timeZoneOf(bad), undefined, String(bad));
  }
  assert.equal(parseChannelContext({ timezone: "Europe/Berlin" }).timezone, "Europe/Berlin");
  assert.equal(parseChannelContext({ timezone: "nowhere" }).timezone, undefined);
  assert.ok(!("timezone" in parseChannelContext({})));
});
