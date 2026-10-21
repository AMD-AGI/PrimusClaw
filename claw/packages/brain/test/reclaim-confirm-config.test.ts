// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The reclaim confirmation settings read blank as unset, like every envInt
// setting: `.env.example` ships them empty and start-all.sh exports that "".

import test from "node:test";
import assert from "node:assert/strict";

test("blank reclaim confirmation settings take the defaults", async () => {
  process.env.SANDBOX_RECLAIM_CONFIRM_SWEEPS = "";
  process.env.SANDBOX_RECLAIM_QUIET_SECONDS = "  ";
  const config = await import("../src/config.js");
  assert.equal(config.SANDBOX_RECLAIM_CONFIRM_SWEEPS, 3);
  assert.equal(config.SANDBOX_RECLAIM_QUIET_MS, 300_000);
});

test("a zero confirmation count is refused rather than meaning 'never confirm'", async () => {
  // Read in a fresh module instance so the setting is evaluated again.
  process.env.SANDBOX_RECLAIM_CONFIRM_SWEEPS = "0";
  process.env.SANDBOX_RECLAIM_QUIET_SECONDS = "0";
  const config = await import("../src/config.js?zero");
  assert.equal(config.SANDBOX_RECLAIM_CONFIRM_SWEEPS, 3, "below the minimum of 1: the default applies");
  assert.equal(config.SANDBOX_RECLAIM_QUIET_MS, 0, "0 disables the window");
  assert.ok(config.envSettingProblems().some((p) => p.startsWith("SANDBOX_RECLAIM_CONFIRM_SWEEPS=")),
    "and the refusal is reported at startup");
});
