// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import type { Prefs } from "../../src/ports/store/index.js";
import {
  APPROVAL_DEFAULT_SECONDS,
  PERMISSION_DEFAULT_SECONDS,
  approvalExpiry,
  inQuiet,
  isoSeconds,
  muted,
  remoteAskExpiry,
  zoneOf,
} from "../../src/proactive/quiet.js";

const SHANGHAI = "Asia/Shanghai";

/** Epoch seconds of 2026-10-<day> HH:MM in Shanghai (UTC+8, no daylight saving). */
function at(hour: number, minute = 0, day = 27): number {
  return Date.UTC(2026, 9, day, hour - 8, minute) / 1000;
}

function prefs(extra: Partial<Prefs> = {}): Prefs {
  return {
    timezone: SHANGHAI,
    quietEnabled: false,
    quietStart: "22:00",
    quietEnd: "08:00",
    pausedUntil: null,
    briefTriggerId: null,
    lang: "",
    langSet: false,
    remoteWindow: "",
    ...extra,
  };
}

it("in quiet handles a window that wraps midnight and the zone", () => {
  assert.ok(inQuiet(at(23), SHANGHAI, "22:00", "08:00") && inQuiet(at(2), SHANGHAI, "22:00", "08:00"));
  assert.ok(inQuiet(at(22), SHANGHAI, "22:00", "08:00"));
  assert.ok(!inQuiet(at(8), SHANGHAI, "22:00", "08:00"));
  assert.ok(!inQuiet(at(12), SHANGHAI, "22:00", "08:00"));
  assert.ok(inQuiet(at(13), SHANGHAI, "12:00", "14:00") && !inQuiet(at(14), SHANGHAI, "12:00", "14:00"));
  const la = "America/Los_Angeles";
  assert.ok(!inQuiet(at(12), la, "22:00", "08:00"));
  assert.ok(inQuiet(at(14), la, "22:00", "08:00"));
  assert.ok(!inQuiet(at(14), SHANGHAI, "09:00", "09:00"));
});

it("muted says paused before quiet and nothing outside both", () => {
  assert.equal(muted(prefs({ quietEnabled: true }), at(23)), "quiet");
  assert.equal(muted(prefs({ quietEnabled: true, pausedUntil: at(23) + 60 }), at(23)), "paused");
  assert.equal(muted(prefs({ pausedUntil: at(10) }), at(11)), undefined);
  assert.equal(muted(prefs(), at(23)), undefined);
});

it("an unknown zone falls back to the default", () => {
  assert.equal(zoneOf({ timezone: "Mars/Olympus" }), SHANGHAI);
  assert.equal(zoneOf({ timezone: "" }), SHANGHAI);
  assert.equal(zoneOf({ timezone: "Europe/Berlin" }), "Europe/Berlin");
  assert.equal(muted(prefs({ timezone: "Mars/Olympus", quietEnabled: true }), at(23)), "quiet");
});

it("an approval without a usable expiry gets a short life not an open ended one", () => {
  const now = at(12);
  for (const raw of [undefined, "", "soon", "2026-10-27T12:00:00", 7, null]) {
    assert.equal(approvalExpiry({ approval: { expires_at: raw } }, now), now + APPROVAL_DEFAULT_SECONDS, String(raw));
  }
  assert.equal(approvalExpiry({}, now), now + APPROVAL_DEFAULT_SECONDS);
  assert.equal(approvalExpiry({ approval: { expires_at: "2026-10-27T04:30:00Z" } }, now), at(12, 30));
  assert.equal(approvalExpiry({ approval: { expires_at: "2026-10-27T12:30:00+08:00" } }, now), at(12, 30));
});

it("a pushed permission request runs out at most an hour on", () => {
  const now = at(12);
  assert.equal(remoteAskExpiry({ expires_at: "2026-10-27T04:10:00Z" }, now), at(12, 10));
  assert.equal(remoteAskExpiry({ expires_at: "2026-10-28T04:10:00Z" }, now), now + 3600);
  assert.equal(remoteAskExpiry({ expires_at: "nope" }, now), now + PERMISSION_DEFAULT_SECONDS);
  assert.equal(isoSeconds("2026-10-27 04:10:00.5+00:00"), at(12, 10) + 0.5);
});
