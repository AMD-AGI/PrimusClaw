// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One wait must end before the request carrying it can be cut.
 *
 * The reply to a wait is a single JSON body written when the wait ends, so a
 * proxy in front of Hands sees nothing from it -- not even headers -- until
 * then. The sandbox Router's port proxy gives up after 120s of that and answers
 * 502 "sandbox service unreachable"; a wait asked for 180s therefore failed at
 * exactly 120s, and the agent, told its sandbox was unreachable, started
 * tearing down a job that was running fine. The built-in ceiling has to sit
 * under that limit, with room for the transport, so a long wait is a series of
 * calls that each come back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
// The defaults are the subject, so neither is set here.
delete process.env.WAIT_MAX_SEC;
delete process.env.WAIT_DEFAULT_SEC;

const { WAIT_MAX_SEC, WAIT_DEFAULT_SEC } = await import("../src/tools/shell/wait.js");

/** The shortest response-header limit known to sit in front of Hands. */
const PROXY_HEADER_LIMIT_SEC = 120;
/** Time the call spends outside the wait itself: transport, polling, reply. */
const TRANSPORT_ROOM_SEC = 10;

test("the default per-call wait ceiling ends well before a 120s proxy cuts the request", () => {
  assert.ok(
    WAIT_MAX_SEC + TRANSPORT_ROOM_SEC <= PROXY_HEADER_LIMIT_SEC,
    `a wait may last ${WAIT_MAX_SEC}s, which a ${PROXY_HEADER_LIMIT_SEC}s proxy limit cuts`,
  );
});

test("the default wait is one the ceiling grants in full", () => {
  assert.ok(WAIT_DEFAULT_SEC <= WAIT_MAX_SEC,
    `default ${WAIT_DEFAULT_SEC}s would be clamped to ${WAIT_MAX_SEC}s on every call`);
});
