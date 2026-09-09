// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The lines this work exists to make visible, driven in a child process.
 *
 * The parent (run-identity-logs.test.ts) reads a line's position in this
 * process's stdout as its place in the run. Each pino logger would otherwise
 * own an async sonic-boom on fd 1 and land its lines in whatever order the
 * writes complete, out of step with the marks below; pino builds that
 * sonic-boom only while `process.stdout.write` is still the prototype's, so
 * claiming it before the first logger exists puts every writer in one FIFO.
 */
process.env.BG_SHELL_ENABLED = "true";
process.env.WEB_SEARCH_PROVIDER = "disabled";
process.env.WEB_FETCH_ENABLED = "false";

import assert from "node:assert/strict";
import type { ExecuteRequest, ToolSchema } from "@claw/protocol";

let stdoutWrites = 0;
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((...args: Parameters<typeof stdoutWrite>) => {
  stdoutWrites += 1;
  return stdoutWrite(...args);
}) as typeof process.stdout.write;

const { beginRun, endRun, phaseOf, whileWaiting } = await import("../../src/tasks/run-phase.js");
const { resolveRunIdentity } = await import("../../src/tasks/run-identity.js");
const { AgentEngine } = await import("../../src/agent/engine.js");
const { AnthropicProvider } = await import("../../src/llm/anthropic-provider.js");
const { OpenAiProvider } = await import("../../src/llm/openai-provider.js");
const { runSubagent } = await import("../../src/agent/sub-agent.js");
type HandsClient = import("../../src/clients/hands.js").HandsClient;

const WAIT_SCHEMA = {
  name: "wait",
  description: "Block until a background shell finishes.",
  input_schema: { type: "object", properties: { shell_id: { type: "string" } } },
} as unknown as ToolSchema;

function scriptOneWait(): void {
  let index = 0;
  const turns = [
    { content: [{ type: "tool_use", id: "t1", name: "wait", input: { shell_id: "bg-1" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const session = {
    async streamTurn() {
      const turn = turns[index++];
      if (!turn) throw new Error("scripted session exhausted");
      return { ...turn, usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 };
    },
    async complete() { return "summary"; },
  };
  (AnthropicProvider.prototype as unknown as Record<string, unknown>).createSession = () => session;
  (OpenAiProvider.prototype as unknown as Record<string, unknown>).createSession = () => session;
}

const hands = {
  async callTool(name: string) {
    if (name !== "wait") return "ok";
    await new Promise((r) => setTimeout(r, 20));
    return "shell finished";
  },
  async close() {},
} as unknown as HandsClient;

const mark = (name: string) => console.log(`FIXTURE ${name}`);

// A wait against a key the ledger does not hold: the work still runs, and the
// miss is no longer indistinguishable from a run that never waited.
const orphan = resolveRunIdentity({ session_id: "s", task_id: "never-begun" } as ExecuteRequest, "").identity;
const beforeMiss = stdoutWrites;
assert.equal(await whileWaiting(orphan.key, "background_command", "timed", async () => 7), 7);
assert.ok(stdoutWrites > beforeMiss, "pino bypassed stdout, so no mark below orders anything");
mark("miss-returned-the-work");

// A sub-agent forwarded its parent's identity, so its wait hits: nothing is
// missed and nothing is logged as missed.
scriptOneWait();
const parent = resolveRunIdentity({ session_id: "s", task_id: "sub-parent" } as ExecuteRequest, "").identity;
beginRun(parent.key);
mark("subagent-start");
await runSubagent({
  description: "sub", prompt: "go", parentSchemas: [WAIT_SCHEMA], hands,
  onEvent: async () => {},
  model: "m", apiUrl: "http://localhost:0", apiKey: "k",
  maxTurns: 4, sessionId: "s", depth: 1, runIdentity: parent,
});
assert.equal(phaseOf(parent.key).waits, 1);
mark("subagent-end");
endRun(parent.key);

// The engine reached without an identity, on a request that carries a task id:
// the loop must not be handed a task_id-sourced identity resolved a second time.
scriptOneWait();
const dispatched = { session_id: "s", task_id: "engine-task", prompt: "hi", user_id: "u", llm_api_key: "k" } as ExecuteRequest;
const shadowed = resolveRunIdentity(dispatched, "").identity;
beginRun(shadowed.key);
await new AgentEngine().execute(dispatched, async () => {}, undefined, hands, {});
assert.equal(phaseOf(shadowed.key).waits, 0,
  "a re-resolution would have landed the wait on the entry the runner opened");
endRun(shadowed.key);
mark("engine-did-not-re-resolve");

// A lease URL whose shape the resolver does not recognise, reported by the
// runner rather than quietly demoting the run.
const { bindTaskRunnerDeps, runHandleTask } = await import("../../src/tasks/runner.js");
const { activeAbort } = await import("../../src/tasks/abort-registry.js");
const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
const store = new Map<string, Uint8Array>();
const kv = {
  async get(key: string) { const v = store.get(key); return v ? { key, value: v } : null; },
  async put(key: string, value: Uint8Array | string) {
    store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    return 1;
  },
  async delete(key: string) { store.delete(key); },
};
bindTaskRunnerDeps({
  kv: kv as never, kvCkpt: kv as never,
  emitter: { async emit() {} } as never,
  engine: { async execute() { return { finalText: "", tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 }, turns: 0, pendingMemories: [], pendingSkills: [], skillsUsed: {}, errorCount: 0, toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 0 } as never; } },
  sideEffects: {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined), reapPendingHands: noop(undefined),
    unregisterSandbox: (() => {}) as never, markHandsIdle: (() => {}) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined), archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }), syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }), postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined), postRunLease: noop("running"),
    runScript: noop(undefined), refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => hands) as never,
  } as never,
});
const leaseless = {
  session_id: "s-lease", message_id: "m-lease", prompt: "hi", user_id: "u",
  run_lease: { url: "http://api.test/v2/leases/renew?run=ktsk_z", token: "tok" },
} as ExecuteRequest;
const abortCtrl = new AbortController();
activeAbort.set("lock.s-lease", abortCtrl);
await runHandleTask({ info: { deliveryCount: 1 }, seq: 1, ack() {}, nak() {}, working() {}, term() {} } as never,
  leaseless, "s-lease", "lock.s-lease", "m-lease", "u", abortCtrl);
mark("lease-shape-miss-run-finished");

// A run with nothing to identify it at all: assigned an entry, and said so.
const anonymous = { session_id: "s-anon", prompt: "hi", user_id: "u" } as ExecuteRequest;
const anonAbort = new AbortController();
activeAbort.set("lock.s-anon", anonAbort);
await runHandleTask({ info: { deliveryCount: 1 }, seq: 1, ack() {}, nak() {}, working() {}, term() {} } as never,
  anonymous, "s-anon", "lock.s-anon", "", "u", anonAbort);
mark("unknown-identity-run-finished");
