// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A key left empty in `.env` is a key nobody set, not a setting whose value is
 * the empty string.
 *
 * Hands inherits its environment two ways and both can hand it a blank: locally
 * `start-all.sh` runs `set -a; source .env`, which EXPORTS every entry
 * `.env.example` leaves empty, and in a sandbox the pod template projects
 * secrets that may resolve to "". `??` substitutes a fallback only for
 * `undefined`, so a cleared line beat the documented default.
 *
 * The outcome, not the mechanism. `MCP_PORT` is parsed with `parseInt`, and
 * `parseInt("")` is NaN: Hands then listens on whatever the server makes of a
 * NaN port while Brain keeps calling 9100, so every tool call in the session
 * times out against a process that came up "healthy". `WORKSPACE_PATH` roots
 * every file tool, and rooting them at "" resolves each relative path against
 * the process CWD instead of the workspace.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import.
 *
 * Coverage:
 *   H1 a blank MCP_PORT still yields the port Brain calls, not NaN
 *   H2 a blank WORKSPACE_PATH still roots the file tools at the workspace
 *   H3 the blank/absent distinction does not leak into the token or the gate
 */
import test from "node:test";
import assert from "node:assert/strict";

// Exactly what `set -a; source .env` does with a blank line. The whitespace is
// deliberate: trim() runs before the fallback decision, so spaces are blank.
process.env.MCP_PORT = "";
process.env.WORKSPACE_PATH = "  ";
process.env.AUTH_CLAW_TOKEN = "";
process.env.AUTH_INTERNAL_TOKEN = "the-live-token";
process.env.BG_SHELL_ENABLED = "";

const { MCP_PORT, WORKSPACE, INTERNAL_TOKEN, BG_SHELL_ENABLED } =
  await import("../src/config.js");

test("H1 a blank MCP_PORT still yields the port Brain calls, not NaN", () => {
  assert.equal(MCP_PORT, 9100,
    "Brain dials 9100; a NaN port leaves a healthy-looking Hands nowhere");
  assert.ok(Number.isInteger(MCP_PORT), "parseInt('') is NaN, which listen() takes");
});

test("H2 a blank WORKSPACE_PATH still roots the file tools at the workspace", () => {
  assert.equal(WORKSPACE, "/workspace",
    "'' resolves every relative tool path against the process CWD instead");
});

test("H3 the blank/absent distinction does not leak into the token or the gate", () => {
  // These two were already written with `||` and a regex, so they were never
  // wrong. They are asserted here so making env() blank-aware is visibly a
  // change that brings the rest of the file into line rather than one that
  // moves these.
  assert.equal(INTERNAL_TOKEN, "the-live-token",
    "a blank legacy alias must not shadow the token that is actually set");
  assert.equal(BG_SHELL_ENABLED, false, "and a blank gate stays closed");
});
