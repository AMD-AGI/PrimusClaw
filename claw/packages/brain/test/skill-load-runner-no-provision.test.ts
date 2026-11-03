// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a skill must not open a sandbox, measured at the boundary that opens
 * one: the task runner's `ensureHands`, the entry of `provisionHands`.
 *
 * The live incident (11-03): in a Teams group the model called an MCP tool, then
 * wanted `/workspace/.skills/agent-board/SKILL.md` (progressive skills), so
 * Brain provisioned a sandbox for a file read. The cluster had no node for it;
 * the pod stayed Pending, the user watched a progress bar for minutes, and Brain
 * gave up after ~15 min. A skill is instructions for the model; no sandbox is
 * involved in giving it one.
 *
 * Driven through the real `runHandleTask` and the real `AgentEngine` / agent
 * loop; only the edges are fake: LLM, S3, an MCP server, and the runner's side
 * effects, of which `ensureHands` is the one counted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession, skillRow, mcpRow } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
delete process.env.PLATFORM_DEFAULTS_FILE;
const md = (name: string, desc: string, marker: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${marker}\n`;
pw.put("skills/agent-board/SKILL.md", md("agent-board", "Use the agent board", "AGENT-BOARD-BODY-MARKER"));
pw.put("skills/agent-board/scripts/board.py", "print('board')\n");

// Skills longer than the generic tool-result cap (6000 chars), by size:
//  - the repo's own example, 7829 chars, as shipped;
//  - 12399 chars, the size of the agent-board SKILL.md of the 11-03 incident (many short
//    lines and a few 150-char ones, as a hand-written skill has);
//  - 17000+ chars, more than one `load_skill` part.
const prReview = fs.readFileSync(new URL("../../../examples/skills/pr-review/SKILL.md", import.meta.url), "utf8");
function sizedSkill(name: string, chars: number): string {
  let out = `---\nname: ${name}\ndescription: ${name} test skill\n---\n`;
  for (let i = 0; out.length < chars; i++) {
    const line = i % 7 === 3 ? `Step ${i}: ${"call the board and report what changed since the last look; ".repeat(2)}` : `- rule ${i}: keep it short`;
    out += line.slice(0, Math.min(line.length, chars - out.length - 1)) + "\n";
  }
  return out.slice(0, chars - 1) + "\n";
}
const board12k = sizedSkill("board-12k", 12399);
const long17k = sizedSkill("long-17k", 17234);
pw.put("skills/pr-review/SKILL.md", prReview);
pw.put("skills/board-12k/SKILL.md", board12k);
pw.put("skills/long-17k/SKILL.md", long17k);
pw.put("skills/long-17k/scripts/run.py", "print('run')\n");

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { AgentEngine } = await import("../src/agent/engine.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");

test.after(async () => { await world.close(); await pw.close(); });

function fakeKv() {
  const store = new Map<string, Uint8Array>();
  const enc = (v: Uint8Array | string) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  return {
    async get(key: string) { const value = store.get(key); return value ? { key, value, revision: 1, operation: "PUT" } : null; },
    async put(key: string, v: Uint8Array | string) { store.set(key, enc(v)); return 1; },
    async update(key: string, v: Uint8Array | string) { store.set(key, enc(v)); return 2; },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

/** One chat turn of a plugin with a skill and an MCP tool, through the real runner and engine. */
async function chatTurn(script: Turn[], skills = ["agent-board"]) {
  const provisioned: string[] = [];
  const hands: Array<ReturnType<typeof fakeHands>> = [];
  const events: Array<Record<string, unknown>> = [];
  const noop = (v: unknown) => (() => Promise.resolve(v)) as never;
  const sideEffects = {
    // The count under test. A sandbox that "starts" is one fake client.
    ensureHands: (async (sessionId: string) => {
      provisioned.push(sessionId);
      return { handsUrl: "http://hands.test", created: true, token: "hands-token", identity: undefined };
    }) as never,
    makeHandsClient: (() => { const h = { ...fakeHands(), close: async () => {} }; hands.push(h); return h; }) as never,
    destroyHands: noop(undefined), reapPendingHands: noop(undefined),
    probeSandboxContainer: noop({ verdict: "alive", reason: "x" }),
    fetchPlatformFacts: noop(null), restartHandsInSandbox: noop({ ok: true, detail: "" }),
    unregisterSandbox: (() => {}) as never, markHandsIdle: noop({ outcome: "parked" }),
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined), archiveRunToS3: noop(undefined), copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }), restoreWorkspace: noop({ ok: true }),
    postAgentDone: noop(undefined), postTaskRunning: noop(undefined), postRunLease: noop("running"),
    settleRunAttempt: noop(undefined), runScript: noop({}), refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined), flushTranscript: noop(undefined),
  } as unknown as TaskRunnerSideEffects;
  const emitter = { async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); } } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv: fakeKv(), kvCkpt: fakeKv(), emitter, engine: new AgentEngine(), sideEffects });

  const session = uniqueSession();
  const request = {
    ...(baseRequest({
      session_id: session, task_id: `task-${session}`, prompt: "go and look at the board",
      plugin_id: 5, plugin_tools: [...skills.map((n, i) => skillRow(2 + i, n)), mcpRow(17, pw.mcpUrl)],
    }) as object),
  } as unknown as ExecuteRequest;
  const msg = { seq: 1, info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  world.script(script);
  world.llmBodies.length = 0;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${session}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, session, lockKey, `msg-${session}`, "u1", abortCtrl);
  return { provisioned, hands, events, bodies: [...world.llmBodies] };
}

test("a turn that only loads a skill and calls an MCP tool never reaches provisionHands", async () => {
  const before = pw.mcpCalls.length;
  const r = await chatTurn([
    { tool: "mcp__board__ping", input: {} },
    { tool: "load_skill", input: { name: "agent-board" } },
    { text: "the board says pong" },
  ]);
  assert.deepEqual(r.provisioned, [], "ensureHands was not called: no sandbox was asked for");
  assert.deepEqual(r.hands, [], "and no sandbox client was made");
  assert.equal(pw.mcpCalls.length, before + 1, "the MCP tool ran");
  assert.ok(r.bodies[2].includes("AGENT-BOARD-BODY-MARKER"), "the model was handed the skill");
  assert.ok(r.events.some((e) => e.type === "sandboxStatus" && e.status === "deferred"), "the run announced itself as sandbox-less");
  assert.ok(!r.events.some((e) => e.type === "sandboxStatus" && e.status !== "deferred"), "and no other sandbox status followed");
  assert.ok(r.events.some((e) => e.type === "exec_complete"), "the turn completed");
});

test("counter-example: when the model runs the skill's script, the sandbox is provisioned, and the script is in it", async () => {
  const r = await chatTurn([
    { tool: "load_skill", input: { name: "agent-board" } },
    { tool: "bash", input: { command: "python3 /workspace/.skills/agent-board/scripts/board.py" } },
    { text: "done" },
  ]);
  assert.equal(r.provisioned.length, 1, "ensureHands was called, once, by the bash");
  assert.equal(r.hands.length, 1);
  const calls = r.hands[0].calls;
  const script = calls.find((c) => c.name === "write" && String(c.args.path).endsWith(".skills/agent-board/scripts/board.py"));
  assert.equal(String(script?.args.contents), "print('board')\n", "the script was written into the sandbox");
  assert.ok(calls.findIndex((c) => c === script) < calls.findIndex((c) => c.name === "bash"), "before it ran");
  assert.ok(!calls.some((c) => c.name === "read"), "the earlier load was not a sandbox read");
});

// --- skills longer than the generic tool-result cap --------------------------
//
// The loop caps every tool result at 6000 chars (head 4000 + tail 1500) and tells the model
// to re-run "with head/tail/grep/sed". For a skill that advice is the incident again: the only
// ways to "re-run" are `read` and `bash` on /workspace/.skills, which provision a sandbox.
// `load_skill` therefore pages its own files, and its result is not cut by the generic cap.

/** The text of the tool_result the model is answering, from the request body the fake LLM received. */
function lastToolResult(body: string): string {
  const messages = JSON.parse(body).messages as Array<{ content: unknown }>;
  const blocks = messages[messages.length - 1].content as Array<{ type: string; content: unknown }>;
  const c = blocks.find((b) => b.type === "tool_result")?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("") : "";
}
const NEXT_PART = /NOT the whole file[^\n]*"offset":(\d+)/;

/** A model that loads a skill's SKILL.md and, while a result says it is not the whole file, asks for the next part at the offset it names. */
function readsAllParts(name: string, results: string[], file?: string): Turn[] {
  const next = (body: string) => {
    const got = lastToolResult(body);
    results.push(got);
    const m = got.match(NEXT_PART);
    return m ? { tool: "load_skill", input: { name, ...(file ? { file } : {}), offset: Number(m[1]) } } : { text: "I have read all of it" };
  };
  return [{ tool: "load_skill", input: { name, ...(file ? { file } : {}) } }, ...Array.from({ length: 6 }, () => next)];
}
/** What a part says about the file itself: the text before the part's continuation line or the footer. */
const contentOf = (part: string) => part.split("\n\n[load_skill: chars ")[0].split("\n\n---\n[skill '")[0];

for (const [name, body] of [["pr-review", prReview], ["board-12k", board12k]] as const) {
  test(`a ${body.length}-char skill (${name}) over the 6000-char cap arrives whole in one load_skill, and no sandbox is asked for`, async () => {
    assert.ok(body.length > 6000, "longer than the generic cap");
    const results: string[] = [];
    const r = await chatTurn(readsAllParts(name, results), [name]);
    assert.deepEqual(r.provisioned, [], "ensureHands was not called");
    assert.deepEqual(r.hands, [], "and no sandbox client was made");
    assert.equal(results.length, 1, "one call was enough: the model was not told to come back for the rest");
    assert.equal(contentOf(results[0]), body, "the whole SKILL.md, not its head and tail");
    assert.ok(results[0].includes("This skill has no other files."), "the footer is in it too");
    assert.ok(!r.bodies.some((b) => b.includes("truncated for context efficiency")), "the generic cap did not touch it");
    assert.ok(r.events.some((e) => e.type === "exec_complete"), "the turn completed");
  });
}

test("a 17234-char skill is read in parts through load_skill alone: every part retrievable, the file list not cut, no sandbox", async () => {
  const results: string[] = [];
  const r = await chatTurn(readsAllParts("long-17k", results), ["long-17k"]);
  assert.deepEqual(r.provisioned, [], "ensureHands was not called");
  assert.deepEqual(r.hands, [], "and no sandbox client was made");
  assert.ok(results.length >= 2, `more than one part (${results.length})`);
  assert.equal(results.map(contentOf).join(""), long17k, "the parts, joined, are the file, byte for byte");
  assert.ok(results.slice(0, -1).every((p) => NEXT_PART.test(p) && !p.includes("[skill 'long-17k'")), "each part but the last says where the next starts and has no footer");
  const last = results[results.length - 1];
  assert.ok(last.includes("That is the end of the file."), "the last says so");
  assert.ok(last.includes("- scripts/run.py") && last.includes("/workspace/.skills/long-17k/"), "and carries the file list and the script path whole");
  assert.ok(!r.bodies.some((b) => b.includes("truncated for context efficiency")), "no part was cut by the generic cap");
  assert.ok(!results.some((p) => /head\/tail|grep|sed range|read tool/.test(p.slice(contentOf(p).length))), "nothing around the file tells the model to look elsewhere");
  assert.ok(r.events.some((e) => e.type === "exec_complete"), "the turn completed");
});

test("a reference file longer than a part is paged the same way, with the file named in the next call", async () => {
  const ref = sizedSkill("ref", 40000).replace(/^---[^]*?---\n/, "");
  pw.put("skills/long-17k/references/api.md", ref);
  const results: string[] = [];
  const r = await chatTurn(readsAllParts("long-17k", results, "references/api.md"), ["long-17k"]);
  assert.deepEqual(r.provisioned, []);
  assert.ok(results.length >= 3, `40000 chars is at least three parts (${results.length})`);
  assert.equal(results.map(contentOf).join(""), ref);
  assert.match(results[0], /"file":"references\/api\.md","offset":\d+/);
  assert.ok(!r.bodies.some((b) => b.includes("truncated for context efficiency")));
});
