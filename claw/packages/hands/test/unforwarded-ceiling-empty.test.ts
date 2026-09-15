// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The other half of the fallback's trigger: present but empty.
 *
 * The read is a truthiness fallback over the raw string, so an explicitly-blank
 * value is indistinguishable from an unset one and takes the same branch. A
 * change from that to a presence check would silently narrow which deployments
 * the fallback protects -- a Hands whose forwarded value was blanked would drop
 * to the open-state two minutes with background shells refused.
 *
 * Its own file for the same module-load reason as the unset half.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BASH_MAX_TIMEOUT_SEC = "";
delete process.env.BG_SHELL_ENABLED;
const { MAX_TIMEOUT_SEC } = await import("../src/tools/shell/bash.js");

test("an explicitly-empty value reaches the same fallback as an absent one", () => {
  assert.equal(MAX_TIMEOUT_SEC, 36000);
});
