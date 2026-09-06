// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What Hands enforces when Brain never told it what to enforce.
 *
 * Hands re-derives the switch-dependent rule itself and falls back to its own
 * literal when `BASH_MAX_TIMEOUT_SEC` supplies no value -- a Hands started
 * without the bootstrap env, one predating the forwarding, or one whose value
 * was blanked. That fallback is the *unheld* ten hours, not the 3540s a
 * default-configured Brain would have forwarded, so the sandbox is an order of
 * magnitude more permissive than the schema the model was shown.
 *
 * The fallback is kept deliberately: with background shells off it is the only
 * route long work has, and a Hands that cannot see Brain's number must not
 * default to two minutes. This file exists so that removing it, or quietly
 * replacing it with a Brain-side value, fails a test that says why.
 *
 * Its own file because the constant is frozen at first import, so one process
 * can establish exactly one state of the variable, and the closed-state Hands
 * file already imports the module under other state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
delete process.env.BASH_MAX_TIMEOUT_SEC;
delete process.env.BG_SHELL_ENABLED;
const { MAX_TIMEOUT_SEC } = await import("../src/tools/shell/bash.js");

/** What a default-configured Brain holds and forwards, in each switch state. */
const BRAIN_HELD_CLOSED = 3540;
const BRAIN_HELD_OPEN = 120;

test("with nothing forwarded and the switch off, the ceiling is ten hours", () => {
  assert.equal(MAX_TIMEOUT_SEC, 36000);
});

test("that number is Hands' own and must never be read as Brain's", () => {
  // Written as inequalities against both held values rather than as a second
  // literal: a future change making the fallback equal what Brain forwards
  // would satisfy a bare `assert.equal(36000)` while erasing the distinction
  // this file exists to keep.
  assert.notEqual(MAX_TIMEOUT_SEC, BRAIN_HELD_CLOSED);
  assert.notEqual(MAX_TIMEOUT_SEC, BRAIN_HELD_OPEN);
});

test("the divergence runs in the permissive direction, which is the hazard", () => {
  // Direction, not magnitude: if the fallback is ever revised the inequality
  // still states what may not happen -- Hands must not become the stricter of
  // the two and start cutting commands the schema promised.
  assert.ok(MAX_TIMEOUT_SEC > BRAIN_HELD_CLOSED,
    "Hands enforces more than Brain states, grants, and builds deadlines against");
});
