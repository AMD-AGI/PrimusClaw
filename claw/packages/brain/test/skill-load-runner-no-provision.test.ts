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
async function chatTurn(script: Turn[]) {
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
      plugin_id: 5, plugin_tools: [skillRow(2, "agent-board"), mcpRow(17, pw.mcpUrl)],
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
