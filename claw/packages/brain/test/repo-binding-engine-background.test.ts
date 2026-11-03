// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With background shells on, the engine binds a repository with the clone run in
 * the background and waited for, so a repository that takes longer than the
 * 100s foreground ceiling to clone is not a failed binding.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "true";
const { startWorld, baseRequest } = await import("./support/platform-defaults-world.js");
const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

test("the engine clones in the background when background shells are on", async () => {
  const calls: string[] = [];
  const hands = {
    async callTool() { return "ok"; },
    async callToolFull(name: string, args: Record<string, unknown>) {
      const c = String(args.command ?? "");
      if (name === "bash" && args.run_in_background === true) {
        calls.push(/git clone --quiet --/.test(c) ? "clone&" : "bash&");
        return { text: "Started background shell sh-1.", isError: false, structured: { shell_id: "sh-1" } };
      }
      if (name === "wait") {
        calls.push("wait");
        return { text: "Shell sh-1 finished", isError: false, structured: { finished: true, status: "completed", exit_code: 0 } };
      }
      calls.push(name);
      if (/CLAW_REPO_STATE/.test(c)) return { text: "CLAW_REPO_CRED=ok\nCLAW_REPO_STATE=absent\nCLAW_REPO_BOUND=no\n", isError: false };
      if (/CLAW_REPO_CHANGED/.test(c)) return { text: "CLAW_REPO_BRANCH=main\nCLAW_REPO_HEAD=abc1234\nCLAW_REPO_CHANGED=0\n", isError: false };
      return { text: "", isError: false };
    },
  };
  world.llmBodies.length = 0;
  world.script([{ text: "done" }]);
  await new AgentEngine().execute(
    baseRequest({ session_id: "s-bg", repo: { url: "https://github.com/example-org/example-repo" } }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => hands as never } as never,
  );
  assert.deepEqual(calls.slice(0, 3), ["bash", "clone&", "wait"], calls.join());
  const body = world.llmBodies[0] ?? "";
  assert.ok(body.includes("(cloned just now)"), "the model was not told the repository is there");
});
