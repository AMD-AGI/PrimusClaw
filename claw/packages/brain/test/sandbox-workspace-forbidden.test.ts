// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a person sees when the platform will not let their account start a
// sandbox in the workspace Claw picked.
//
// SaFE refuses a workload in a workspace the account is not a member of with
// HTTP 403 and a body that names the account's internal user id and a platform
// error code. That body used to reach the user verbatim, as
// `Sandbox failure (sandbox_create_failed): Create Hands failed: HTTP 403 {...}`,
// in the chat and in Teams. Asserted where each piece is enforced: the provider
// turns the 403 into a terminal error written for the person, the model is told
// that error and not to retry, the run does not provision a second time, and a
// run that ends on it says the sentence without a code prefix.

process.env.SANDBOX_CPU_NAMESPACE = "global-cpu";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
const { SandboxProvisionTerminalError, SANDBOX_WORKSPACE_FORBIDDEN, sandboxWorkspaceForbiddenText } =
  await import("../src/sandbox/errors.js");
const { SandboxAttachError } = await import("../src/agent/attach-error.js");
const { explainHandsError } = await import("../src/clients/hands.js");
const { isRetryable } = await import("../src/infra/retry.js");
const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { reapPendingHands } = await import("../src/sandbox/reaper.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");
type TaskRunnerSideEffects = import("../src/tasks/runner.js").TaskRunnerSideEffects;
type SandboxProvider = import("../src/sandbox/provider.js").SandboxProvider;
type Engine = import("../src/agent/index.js").Engine;
type ExecuteExtras = import("../src/agent/index.js").ExecuteExtras;
type NatsEmitter = import("../src/events/emitter.js").NatsEmitter;

const USER_ID = "3f9c2b7d81e04a6fa1c5d2e8b7a90c41";
const SAFE_403 = JSON.stringify({
  errorCode: "Primus.00003",
  errorMessage: `The user(${USER_ID}) is not allowed to create workload, workspace: [global-cpu]`,
});

/** Nothing a person cannot act on: no account id, no platform code, no HTTP, no JSON. */
function assertReadable(text: string): void {
  for (const leak of [USER_ID, "Primus.00003", "HTTP 403", "errorCode", "{", "Create Hands failed"]) {
    assert.ok(!text.includes(leak), `"${leak}" reached the user: ${text}`);
  }
}

let realFetch: typeof fetch | null = null;
let restoreProviders: (() => void) | null = null;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  restoreProviders?.();
  restoreProviders = null;
});

function answer(status: number, body: string): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const params = (namespace: string) => ({
  sessionId: "s", namespace, image: "img:1", resources: { cpu: "1" }, env: {}, platformKey: "pk",
});

// ── the provider ─────────────────────────────────────────────────────────────

test("a 403 from SaFE in the CPU workspace is a terminal refusal that names the workspace and the next step", async () => {
  answer(403, SAFE_403);
  const err = await new SafeWorkloadProvider().create(params("global-cpu")).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
  assert.equal(err.reason, SANDBOX_WORKSPACE_FORBIDDEN);
  assert.match(err.message, /You do not have a CPU sandbox workspace yet/);
  assert.match(err.message, /global-cpu/);
  assert.match(err.message, /Ask a SaFE administrator to add your account to the global-cpu workspace/);
  assertReadable(err.message);
  assert.equal(isRetryable(err), false, "a refused account is not redelivered");
});

test("a 403 in another workspace says sandbox workspace, not CPU", async () => {
  answer(403, SAFE_403.replace("global-cpu", "crusoe-spur-vk"));
  const err = await new SafeWorkloadProvider().create(params("crusoe-spur-vk")).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SandboxProvisionTerminalError);
  assert.equal(err.message, sandboxWorkspaceForbiddenText("crusoe-spur-vk", false));
  assert.ok(!/CPU/.test(err.message), err.message);
  assert.match(err.message, /crusoe-spur-vk/);
  assertReadable(err.message);
});

test("every other refusal keeps the error it had", async () => {
  for (const status of [400, 401, 404, 500, 503]) {
    answer(status, "body");
    const err = await new SafeWorkloadProvider().create(params("global-cpu")).then(() => null, (e: unknown) => e);
    assert.ok(!(err instanceof SandboxProvisionTerminalError), `HTTP ${status}`);
    assert.equal((err as Error).message, `Create Hands failed: HTTP ${status} body`);
    globalThis.fetch = realFetch!;
  }
});

// ── what the model reads ─────────────────────────────────────────────────────

test("a lazy open refused this way tells the model the readable reason and not to retry", () => {
  const refused = new SandboxAttachError(
    new SandboxProvisionTerminalError(SANDBOX_WORKSPACE_FORBIDDEN, sandboxWorkspaceForbiddenText("global-cpu", true)),
  );
  const text = explainHandsError(refused, "bash", { command: "ls" });
  assert.ok(text.startsWith("Error: the sandbox could not be started: You do not have a CPU sandbox workspace yet"), text);
  assert.match(text, /will not be started again during this turn/);
  assert.match(text, /Do not retry the call/);
  assertReadable(text);
});

// ── the run ──────────────────────────────────────────────────────────────────

const SESSION = "sess-forbidden";
const TASK = "task-forbidden";

function fakeKv(): KV {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async update(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 2;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

/**
 * One run whose sandbox open is refused with the platform's 403. The engine asks
 * twice, the way a model retrying a tool does, and then -- like the eager path,
 * which awaits the open itself -- ends the run on the refusal.
 */
async function refusedRun(): Promise<{ calls: number; second: unknown; events: Record<string, unknown>[] }> {
  const provider = {
    kind: "safe-workload",
    async stop() {},
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  answer(403, SAFE_403);

  const msg = { seq: 1, info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;
  const kv = fakeKv();
  bindHandsKv(kv);

  let calls = 0;
  const sideEffects = {
    // The real provider behind the open, so the error is the one SaFE's 403 produces.
    ensureHands: (async () => {
      calls++;
      await new SafeWorkloadProvider().create(params("global-cpu"));
      throw new Error("unreachable");
    }) as never,
    destroyHands: noop(undefined),
    reapPendingHands,
    probeSandboxContainer: noop({ verdict: "dead", reason: "x" }),
    fetchPlatformFacts: noop(null),
    restartHandsInSandbox: noop({ ok: true, detail: "" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: (() => Promise.resolve()) as never,
    postTaskRunning: (() => Promise.resolve()) as never,
    postRunLease: noop("running"),
    settleRunAttempt: noop(undefined),
    runScript: noop({} as ExecuteResult),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  let second: unknown = null;
  const engine: Engine = {
    async execute(_r, _e, _s, _h, extras?: ExecuteExtras) {
      const first = await extras!.attachHands!().then(() => null, (e: unknown) => e);
      second = await extras!.attachHands!().then(() => null, (e: unknown) => e);
      throw first;
    },
  };
  const events: Record<string, unknown>[] = [];
  const emitter = { async emit(_sid: string, event: Record<string, unknown>) { events.push(event); } } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt: fakeKv(), emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: TASK, prompt: "hi", user_id: "u1", platform_key: "pk",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: `http://api.test/v1/internal/tasks/${TASK}/lease`, token: "tok" },
  } as unknown as ExecuteRequest;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, "msg-forbidden", "u1", abortCtrl);
  return { calls, second, events };
}

test("a run refused the workspace provisions once, and ends saying the readable sentence and nothing else", async () => {
  const { calls, second, events } = await refusedRun();
  assert.equal(calls, 1, "the retry inside the run is refused without asking SaFE again");
  assert.ok(second instanceof SandboxProvisionTerminalError && second.reason === SANDBOX_WORKSPACE_FORBIDDEN);

  const done = events.find((e) => e.type === "exec_complete");
  assert.ok(done, JSON.stringify(events.map((e) => e.type)));
  assert.equal(done.failed, true);
  assert.equal(done.failure_reason, SANDBOX_WORKSPACE_FORBIDDEN);
  assert.equal(done.final_text, sandboxWorkspaceForbiddenText("global-cpu", true));

  const status = events.find((e) => e.type === "sandboxStatus" && e.status === "failed");
  assert.equal(status?.reason, SANDBOX_WORKSPACE_FORBIDDEN);
  // Everything the run sent toward the user, not only the final text.
  for (const e of events) assertReadable(JSON.stringify(e).replaceAll("{", "").replaceAll("Create Hands failed", ""));
  assert.ok(!JSON.stringify(events).includes(USER_ID));
  assert.ok(!JSON.stringify(events).includes("Primus.00003"));
});
