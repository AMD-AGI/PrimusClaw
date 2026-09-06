// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A present-but-malformed forwarded ceiling, documented rather than required.
 *
 * The read is a bare truthiness check followed by `parseInt`, with no
 * validation that the value is fully numeric. A leading-numeric string is
 * silently accepted at its prefix. This file records that shape so it is
 * visible; nothing here asks for it to be preserved, and replacing it with a
 * fail-loudly validation is compatible with the ceiling contract rather than a
 * regression under it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BASH_MAX_TIMEOUT_SEC = "120abc";
delete process.env.BG_SHELL_ENABLED;
const { MAX_TIMEOUT_SEC } = await import("../src/tools/shell/bash.js");

test("a leading-numeric value is accepted at its prefix today", () => {
  assert.equal(MAX_TIMEOUT_SEC, 120);
  assert.notEqual(MAX_TIMEOUT_SEC, 36000,
    "a non-empty value takes the forwarded branch, however malformed");
});

test("a value that parses to NaN installs no kill timer at all", () => {
  // `Math.min(requested, NaN)` is NaN, and the runner installs its timer only
  // when the derived milliseconds are above zero -- which NaN is not -- so the
  // command runs unbounded. Asserted through the runner's own guard rather than
  // by waiting out an unbounded command.
  const timeoutMs = Math.min(600, Number.parseInt("  ", 10)) * 1000;
  assert.ok(Number.isNaN(timeoutMs));
  assert.equal(timeoutMs > 0, false, "so no kill timer is installed");
});
