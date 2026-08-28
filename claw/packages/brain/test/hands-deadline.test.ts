// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The deadline on a sandbox call, and what the model is told when it passes.
 *
 * Two tools mean two different things by waiting. `bash` has `timeout`: how
 * long a command that is doing something may run. `wait` has `timeout_sec`:
 * how long to do nothing while a background shell runs. Reading only the first
 * measured a wait against the hard cap rather than its own limit -- invisible
 * while the cap is the larger number, a silently truncated wait as soon as it
 * is not.
 *
 * Which tool it is matters as much as which field. Hands clamps a timeout it
 * cannot honour instead of refusing it, so a deadline built from the argument as
 * sent can be many times the longest the call could ever have taken -- a block
 * held open against a sandbox that answered, or died, long before.
 *
 * The message matters as much as the number. What came back before was
 * `MCP error -32001: Request timed out`, which names a JSON-RPC code and
 * nothing a model can use -- and the thing it prompts, re-running with a larger
 * `timeout`, is futile whatever the argument was: the deadline is already past
 * the timeout the tool granted, and a command that reaches its timeout is
 * answered rather than abandoned, so reaching this deadline means the sandbox
 * did not answer at all.
 *
 * What the message may not do is claim the command was killed. Nothing on the
 * Hands side cancels a foreground command when this side stops waiting, so that
 * sentence is a false statement the model goes on to act on. Nor may it say any
 * of this about a tool the sandbox does not run: this file's process has the
 * chart's default flags, so the background-shell half of the same contract is
 * in bg-shell-gate-on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { callDeadlineMs, explainHandsError } from "../src/clients/hands.js";
import { WAIT_MAX_SEC } from "../src/config.js";

const HOUR_MS = 60 * 60 * 1000;
const SLACK_MS = 60_000;

test("a bash timeout sets the deadline, plus slack for transport", () => {
  assert.equal(callDeadlineMs("bash", { command: "make", timeout: 300 }), 300_000 + SLACK_MS);
});

test("wait's own timeout field is honoured too", () => {
  // The regression this exists for: `wait` never sets `timeout`, so before
  // this it fell through to the hard cap every time.
  assert.equal(callDeadlineMs("wait", { shell_id: "bg-1", timeout_sec: 1800 }), 1_800_000 + SLACK_MS);
});

test("a call that names no timeout gets the hard cap", () => {
  // The cap is not a work budget. It is there so a half-dead sandbox -- TCP up,
  // MCP server hung -- cannot hold a run open indefinitely.
  assert.equal(callDeadlineMs("read", { path: "/workspace/a.py" }), HOUR_MS);
});

test("no tool can talk its way past the hard cap", () => {
  // 36000s is the foreground ceiling where background shells are off, and ten
  // times what one call may hold a run open for.
  assert.equal(callDeadlineMs("bash", { command: "sleep 99999", timeout: 36000 }), HOUR_MS);
});

test("a wait is measured against how long a wait can last", () => {
  // Hands clamps `timeout_sec` to its own maximum and answers there, so a
  // deadline built from the argument as sent would leave the run blocked for the
  // half-hour after the wait it is waiting on has already come back.
  assert.equal(
    callDeadlineMs("wait", { shell_id: "bg-1", timeout_sec: 999_999 }),
    WAIT_MAX_SEC * 1000 + SLACK_MS,
  );
});

test("a nonsensical timeout falls back rather than producing a tiny deadline", () => {
  // A zero or negative deadline would abort the call immediately, turning a
  // bad argument into an unexplained failure of the tool.
  assert.equal(callDeadlineMs("bash", { timeout: 0 }), HOUR_MS);
  assert.equal(callDeadlineMs("bash", { timeout: -5 }), HOUR_MS);
  assert.equal(callDeadlineMs("bash", { timeout: "300" as unknown as number }), HOUR_MS);
});

/** The MCP client's own deadline, as the SDK reports it. */
function toolTimeout(): Error {
  return Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 });
}

test("the deadline that stopped the call is the one reported", () => {
  // Raising the timeout is the observed response to this failure, and it is
  // rarely the repair: the deadline is the granted timeout plus slack, and Hands
  // answers a command that hits the granted timeout. So the message names the
  // number that stopped the call -- which the JSON-RPC code it used to carry
  // instead does not -- and then argues the retry down rather than sizing it.
  const asked = explainHandsError(toolTimeout(), "bash", { command: "make", timeout: 300 });
  assert.match(asked, /`bash`/);
  assert.ok(!asked.includes("-32001"), "the code is not something the model can act on");
  assert.match(asked, /360s deadline/, "its own timeout plus transport slack");
  assert.match(asked, /unlikely to be the repair/,
    "argued down rather than sized, and hedged rather than asserted: the clamp "
      + "the argument rests on is enforced in the sandbox, so one bootstrapped "
      + "before Brain's ceiling reached it is still honouring a longer number");
  assert.doesNotMatch(asked, /does raise it/);

  const capped = explainHandsError(toolTimeout(), "bash", { command: "make", timeout: 36000 });
  assert.match(capped, /3600s deadline/, "a timeout past the ceiling is the ceiling");
  assert.match(capped, /unlikely to be the repair/, "and here the argument cannot even move it");

  const bare = explainHandsError(toolTimeout(), "read", {});
  assert.match(bare, /3600s deadline/, "a call that named no timeout gets the ceiling");
  assert.match(bare, /no timeout of its own/,
    "and a tool with none is not told the timeout it was granted has passed: "
      + "the premise is empty there, and the argument it argues down absent");
  assert.doesNotMatch(bare, /run_in_background/,
    "nor sent at background shells for work that never named a duration");
});

test("a tool the sandbox does not run is not given a sandbox's deadline", () => {
  // Platform MCP tools and a2a_call go out over their own client, which has its
  // own request timeout and reports the same -32001. Describing that as a
  // sandbox deadline invented a number no part of this call was measured
  // against, offered a timeout argument the tool does not have, and sent the
  // model looking in /workspace for a process that was never there.
  const text = explainHandsError(toolTimeout(), "mcp__github__create_issue", {});
  assert.doesNotMatch(text, /\d+s deadline/, "no deadline of ours stopped it");
  assert.doesNotMatch(text, /sandbox/);
  assert.doesNotMatch(text, /still be running/);
  assert.match(text, /arguments moves that deadline/, "so raising a timeout is not the repair");
  assert.match(text, /check its effect/, "and what it did is unknown from this side");
});

test("the abandoned command is not claimed to be dead", () => {
  // Nothing on the Hands side cancels it: `bash` is given a command and a
  // timeout and no cancellation channel, so when this side gives up the process
  // keeps running in the sandbox and keeps writing to /workspace. A model told
  // its process group was killed re-runs the command, and the two copies then
  // write over each other.
  const text = explainHandsError(toolTimeout(), "bash");
  assert.doesNotMatch(text, /killed/);
  assert.match(text, /may still be running/, "what is actually known about it");
  assert.match(text, /before starting it again/, "so the model looks before re-running");
});

test("with no background shells, the advice does not name one", () => {
  // `BG_SHELL_ENABLED` is false here, which is the chart's default. The bash
  // schema tells the model this deployment has no background mode, so pointing
  // it at run_in_background would contradict the schema and send it at a call
  // the router refuses.
  const text = explainHandsError(toolTimeout(), "bash");
  assert.doesNotMatch(text, /run_in_background/);
  assert.match(text, /no background mode/);
  assert.match(text, /split into steps/, "the route that does exist here");
});

test("an unreachable sandbox is described as recoverable, because it is", () => {
  const text = explainHandsError(new Error("fetch failed: ECONNREFUSED"), "read");
  assert.match(text, /unreachable/);
  assert.match(text, /restored/, "the files come back, so the model should not start over");
});

test("a server that is not the sandbox is not described as one either", () => {
  // The same connect errors arrive from an `mcp__*` server or an a2a peer, and
  // the sandbox story about those is wrong twice over: there is no rebuild
  // coming, and /workspace was never involved, so a model told to wait for its
  // files to come back waits for something that is not going to happen.
  const text = explainHandsError(new Error("fetch failed: ECONNREFUSED"), "mcp__github__create_issue");
  assert.doesNotMatch(text, /the sandbox running/);
  assert.doesNotMatch(text, /rebuilt/);
  assert.doesNotMatch(text, /restored/);
  assert.match(text, /could not be reached/, "which is all that is known");
  assert.match(text, /ECONNREFUSED/, "with what the transport said");
  assert.match(text, /not the sandbox/, "so the model does not go looking there");
});

test("a tool name off the prototype chain does not become a NaN deadline", () => {
  // Not every name reaching HandsClient is one of ours: a hook and a script step
  // both carry the tool name they were configured with. Looked up in an object
  // literal, `toString` answers with a function that `?? Infinity` does not
  // replace, `Math.min` turns into NaN, and the MCP SDK abandons on the first
  // tick -- an unknown tool failing as an instant request timeout.
  assert.equal(callDeadlineMs("toString", {}), HOUR_MS);
  assert.equal(callDeadlineMs("constructor", { timeout: 30 }), 30_000 + SLACK_MS);
});

test("anything else is passed through rather than dressed up", () => {
  assert.equal(explainHandsError(new Error("file not found"), "read"), "Error: file not found");
});
