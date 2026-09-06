// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a tool call worked is the tool's answer, not the shape of its wording.
 *
 * `by_tool_ok` is what a rollout gate reads to prove a sandbox was touched, and
 * it used to be derived by matching the result text against three prefixes a
 * failure was expected to start with. A failure phrased any other way -- and the
 * phrasing is the tool's to choose -- was counted as a success, which is the
 * gate passing on the exact case it exists to catch.
 *
 * Driven through the real chain: a Hands result carrying `isError`, across
 * `HandsClient`, through `ToolRouter`, into the loop's accounting.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HandsClient } from "../src/clients/hands.js";
import { ToolRouter } from "../src/tools/router.js";
import { bindBgHandleRowsForTest } from "../src/sandbox/bg-row-store.js";

/** A sandbox whose tool answers with `isError` and text of its own choosing. */
function handsAnswering(text: string, isError: boolean): HandsClient {
  const hands = new HandsClient("http://sandbox:9100/mcp", "tok", "sess-1", "ktsk_1");
  (hands as unknown as { connected: boolean }).connected = true;
  (hands as unknown as { client: unknown }).client = {
    callTool: async () => ({ content: [{ type: "text", text }], isError }),
  };
  return hands;
}

/** What the loop records for one call, taken the way the loop takes it. */
async function accountFor(text: string, isError: boolean): Promise<boolean> {
  const restore = bindBgHandleRowsForTest(null);
  try {
    const router = new ToolRouter(handsAnswering(text, isError));
    const outcome = { isError: false };
    await router.route("bash", { command: "echo alive" }, undefined, outcome);
    return !outcome.isError;
  } finally {
    restore();
  }
}

test("a failure whose wording nothing anticipated is still counted as one", async () => {
  // Each of these is a real failure a tool may answer with, and none begins
  // with any of the prefixes the old rule matched on.
  for (const text of [
    "bash: echo: command not found",
    "The sandbox refused this call.",
    "Command terminated by signal SIGKILL",
    "background shells are disabled in this deployment",
    "",
  ]) {
    assert.equal(await accountFor(text, true), false, JSON.stringify(text));
  }
});

test("a success is counted, whatever it happens to say", async () => {
  for (const text of ["alive", "Error: was not the problem, it printed fine", "exit 0 reached"]) {
    assert.equal(await accountFor(text, false), true, JSON.stringify(text));
  }
});

test("the disabled refusal is a failure, not a call that did the work", async () => {
  // The router answers this one itself, before any sandbox is reached.
  const restore = bindBgHandleRowsForTest(null);
  try {
    const router = new ToolRouter(handsAnswering("unused", false));
    const outcome = { isError: false };
    const text = await router.route(
      "bash", { command: "x", run_in_background: true }, undefined, outcome,
    );
    assert.match(text, /disabled/);
    assert.equal(outcome.isError, true,
      "counted as a success, this is a gate proving a sandbox was touched by a "
        + "call that never reached one");
  } finally {
    restore();
  }
});
