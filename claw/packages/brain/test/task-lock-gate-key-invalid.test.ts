// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A gate key nobody recognises must not turn the gate off.
//
// The switch has two names and no validation between them, so any comparison
// that asks only "is this session?" the wrong way round would read every other
// string as a request for the old per-session key. That is the one answer no
// operator would ask for on purpose: the runs that overlap under it are the ones
// that delete each other's files.
//
// The witness is a near-miss typo rather than the empty string. Blank is no
// longer an unrecognised value -- env() reads it as an absent setting, the way
// envBool and envInt always have (see config-blank-env.test.ts, which pins that
// a blank RUN_GATE_KEY is the default and not a misconfiguration) -- and a typo
// is what the startup error in index.ts is actually written for.
//
// Its own file because the setting is read at module load and the test runner
// gives each file a process.
//
// Coverage:
//   G6 an unrecognised value keys on the workspace, not on the session
//   G7 the raw value survives, so startup can name what it did not understand
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

const TYPO = "sessions";
process.env.RUN_GATE_KEY = TYPO;
const { pickLockKey } = await import("../src/tasks/lock.js");
const { RUN_GATE_KEY, RUN_GATE_KEY_CONFIGURED } = await import("../src/config.js");

test("G6 an unrecognised value falls forward to the workspace, not back to the session", () => {
  assert.equal(RUN_GATE_KEY, "workspace",
    `"${TYPO}" is one character from the value that restores the overlap; it `
    + `must not be read as that value`);

  const request = {
    session_id: "sess-1",
    message_id: "msg-1",
    prompt: "hello",
    history: [],
    user_id: "u1",
    files_workspace_id: "kws_1",
  } as unknown as ExecuteRequest;
  assert.equal(pickLockKey(request), "ws.kws_1");
});

test("G7 the raw value survives, so startup can name what it did not understand", () => {
  // index.ts logs startup.run_gate_key_unrecognised on exactly this inequality.
  // Without the raw value the operator's only evidence is runs queueing where
  // they expected them not to.
  assert.equal(RUN_GATE_KEY_CONFIGURED, TYPO);
  assert.notEqual(RUN_GATE_KEY_CONFIGURED, RUN_GATE_KEY,
    "the mismatch is what makes boot report it");
});
