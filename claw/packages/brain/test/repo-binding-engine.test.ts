// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The repository binding through the real engine and agent loop; only the network
 * edges are fake (the LLM, and a Hands that answers the binding's commands).
 *
 *   E1 a request with `repo` opens the sandbox BEFORE the model is asked anything,
 *      sets the tree up, and the model is told: path, branch, the repository's own
 *      instructions
 *   E2 a request without `repo` opens no sandbox for a turn that needs none, and its
 *      prompt is the one `buildPrompt` has always produced
 *   E3 a clone that fails does not fail the run: the model is told what failed
 *   E4 a sandbox that cannot be opened fails the run, as it does for any turn that needs one
 *   E5 the user's GH_TOKEN, present on the request, is in no command, no prompt, no log line
 *   E6 buildPrompt: the block survives a very long user prompt and sits before the session context
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startWorld, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { buildPrompt } = await import("../src/agent/prompt.js");
test.after(async () => { await world.close(); });

const URL = "https://github.com/example-org/example-repo";
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

interface Opts { clone?: "ok" | "fail"; agents?: string }

/** A Hands that is a small fake of the sandbox's side of the binding. */
function bindingHands(o: Opts = {}) {
  const commands: string[] = [];
  return {
    commands,
    async callTool(_name: string, args: Record<string, unknown>) { commands.push(String(args.command ?? "")); return "ok"; },
    signals: [] as Array<AbortSignal | undefined>,
    async callToolFull(_name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const c = String(args.command ?? "");
      commands.push(c);
      this.signals.push(signal);
      if (/CLAW_REPO_STATE/.test(c)) return { text: "CLAW_REPO_CRED=ok\nCLAW_REPO_STATE=absent\nCLAW_REPO_BOUND=no\n", isError: false };
      if (/git clone --quiet --/.test(c)) {
        return o.clone === "fail"
          ? { text: "exit 128\nstdout: \nstderr: remote: Repository not found.\nfatal: repository 'https://github.com/example-org/example-repo/' not found", isError: true }
          : { text: "", isError: false };
      }
      if (/CLAW_REPO_CHANGED/.test(c)) return { text: "CLAW_REPO_BRANCH=main\nCLAW_REPO_HEAD=abc1234\nCLAW_REPO_CHANGED=0\n", isError: false };
      if (/CLAW-REPO-FILE/.test(c) && o.agents) return { text: `@@CLAW-REPO-FILE AGENTS.md@@\n${o.agents}\n@@CLAW-REPO-END@@\n`, isError: false };
      return { text: "", isError: false };
    },
  };
}

type Hands = ReturnType<typeof bindingHands>;

async function run(over: Record<string, unknown>, o: Opts = {}, attachFails = false, signal?: AbortSignal) {
  let attached = 0;
  const sawLlmRequests: number[] = [];
  const hands = bindingHands(o);
  const extras = {
    attachHands: async () => {
      attached++;
      // How many times the model had been asked when the sandbox was opened.
      sawLlmRequests.push(world.llmBodies.length);
      if (attachFails) throw new Error("no capacity for a sandbox");
      return hands as never;
    },
  };
  world.llmBodies.length = 0;
  world.script([{ text: "done" }]);
  // Every line the process logs: pino writes to fd 1 with fs.write / fs.writeSync, not through process.stdout.
  const logs: string[] = [];
  const realWriteSync = fs.writeSync;
  const realWrite = fs.write;
  fs.writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as typeof fs.writeSync;
  fs.write = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
  }) as typeof fs.write;
  try {
    const result = await new AgentEngine().execute(
      baseRequest({ session_id: `s-${Math.random().toString(36).slice(2)}`, ...over }),
      (async () => {}) as never, signal, null as never, extras as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 50)); // pino writes asynchronously
    return { attached, sawLlmRequests, hands, result, body: world.llmBodies[0] ?? "", logs: logs.join("") };
  } finally {
    fs.writeSync = realWriteSync;
    fs.write = realWrite;
  }
}

/** The text of the last user message of the first model request. */
const userText = (body: string): string => {
  const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages;
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  return typeof last.content === "string" ? last.content : (last.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
};

test("E1 a bound session: sandbox opened before the model is asked, tree set up, the model told what it stands in", async () => {
  const abort = new AbortController();
  const r = await run({ repo: { url: URL, branch: "main" } }, { agents: "# Rules\n- run the tests first" }, false, abort.signal);
  assert.equal(r.attached, 1);
  assert.ok(r.hands.signals.length >= 5 && r.hands.signals.every((s) => s === abort.signal), "the run's abort signal reaches every step");
  assert.deepEqual(r.sawLlmRequests, [0], "the sandbox was opened before the first model request");
  const steps = r.hands.commands.map((c) => (/CLAW_REPO_STATE/.test(c) ? "probe" : /git clone/.test(c) ? "clone" : /CLAW_REPO_BRANCH_RESULT/.test(c) ? "branch" : /CLAW_REPO_CHANGED/.test(c) ? "status" : /CLAW-REPO-FILE/.test(c) ? "instructions" : "?"));
  assert.deepEqual(steps, ["probe", "clone", "branch", "status", "instructions"]);
  const text = userText(r.body);
  assert.ok(text.includes("[Repository]"));
  assert.ok(text.includes(`- This session is bound to ${URL}, branch main.`));
  assert.ok(text.includes("- Working tree: /workspace/example-repo (cloned just now), on branch main, at abc1234, the working tree is clean."));
  assert.ok(text.includes("=== AGENTS.md ===\n# Rules\n- run the tests first\n=== END AGENTS.md ==="));
  assert.ok(text.indexOf("[Repository]") < text.indexOf("[Session Context]"), "before the session context");
  assert.ok(text.startsWith("hello there"), "the user's own words stay first");
  assert.equal(r.result.finalText, "done");
});

test("E2 an unbound session: no sandbox for a turn that needs none, and exactly the prompt buildPrompt has always made", async () => {
  const r = await run({});
  assert.equal(r.attached, 0, "nothing opened a sandbox");
  assert.equal(r.hands.commands.length, 0);
  assert.equal(userText(r.body).includes("[Repository]"), false);
  for (const falsy of [undefined, null]) {
    const again = await run({ repo: falsy });
    assert.equal(again.attached, 0);
    assert.equal(userText(again.body).includes("[Repository]"), false);
  }
});

test("E3 a clone that fails does not fail the run: the model is told what failed, with git's own words", async () => {
  const r = await run({ repo: { url: URL } }, { clone: "fail" });
  assert.equal(r.result.finalText, "done", "the turn ran");
  assert.equal(r.attached, 1);
  const text = userText(r.body);
  assert.ok(text.includes(`- This session is bound to ${URL}, but setting up the working tree failed: git clone of ${URL} failed: remote: Repository not found. | fatal: repository 'https://github.com/example-org/example-repo/' not found.`), text);
  assert.ok(text.includes("- /workspace/example-repo is not ready. Tell the user what failed"));
  assert.equal(r.hands.commands.some((c) => /CLAW-REPO-FILE/.test(c)), false, "no instructions are read from a tree that is not there");
});

test("E4 a sandbox that cannot be opened fails the run, as it does for any turn that needs one", async () => {
  await assert.rejects(() => run({ repo: { url: URL } }, {}, true), /no capacity for a sandbox/);
  assert.equal(world.llmBodies.length, 0, "and the model was never asked");
});

test("E5 the user's GH_TOKEN, on the request, is in no command, no prompt, no log line", async () => {
  const r = await run({ repo: { url: URL, branch: "main" }, user_env: { GH_TOKEN: TOKEN }, session_env: { GITHUB_TOKEN: TOKEN } }, { agents: "x" });
  assert.equal(r.attached, 1);
  assert.ok(r.hands.commands.length >= 5);
  for (const c of r.hands.commands) assert.equal(c.includes(TOKEN), false, c);
  assert.equal(r.body.includes(TOKEN), false, "not in the request to the model");
  assert.equal(r.logs.includes(TOKEN), false, "not in a log line");
  assert.ok(r.logs.includes("repo.bound"), "and the binding did log");
});

test("E6 buildPrompt: the block is kept for a very long user prompt, and sits between the policy and the session context", () => {
  const ctx = { sessionId: "s1", userId: "u1" };
  const block = "[Repository]\n- bound";
  const long = "x".repeat(20001);
  const withLong = buildPrompt(long, {}, [], "m", "/workspace", "", ctx, [], block);
  assert.ok(withLong.endsWith(`\n\n${block}`), "kept, and after the user's text");
  assert.ok(withLong.startsWith(long));
  const short = buildPrompt("hi", {}, [], "m", "/workspace", "", ctx, [], block);
  assert.ok(short.indexOf(block) > short.indexOf("hi"));
  assert.ok(short.indexOf(block) < short.indexOf("[Session Context]"));
  // No block: the same string as before the parameter existed.
  assert.equal(buildPrompt("hi", {}, [], "m", "/workspace", "", ctx, [], ""), buildPrompt("hi", {}, [], "m", "/workspace", "", ctx));
  assert.equal(buildPrompt(long, {}, [], "m", "/workspace", "", ctx, [], ""), long);
  assert.equal(short.replace(`${block}\n\n`, ""), buildPrompt("hi", {}, [], "m", "/workspace", "", ctx));
});
