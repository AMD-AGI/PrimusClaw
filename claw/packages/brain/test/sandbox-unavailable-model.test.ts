// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What the model is told when the platform has no sandbox for the run, and that
// the run does not go looking for another.
//
// The open of a lazy sandbox fails inside a tool call, so its error reaches the
// model as the tool's result. A bare "did not become ready" read as a transient
// failure, the model called the tool again, and the user waited the whole
// provisioning wait a second time. Two halves, each asserted where it is
// enforced: the words the model reads (explainHandsError, through the agent
// loop that renders them), and the run's refusal to provision again (the task
// runner's latch, driven with the real reap).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import { handsSessionKey } from "@claw/protocol";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import { agentLoop } from "../src/agent/agent-loop.js";
import { SandboxAttachError } from "../src/agent/attach-error.js";
import { explainHandsError } from "../src/clients/hands.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import { isRetryable } from "../src/infra/retry.js";
import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import { reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { LlmContentBlock, Message } from "../src/llm/types.js";
import type { ToolRouter } from "../src/tools/router.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const WHY = "0/3 nodes are available: 3 node(s) were unschedulable";

function unavailable(reason = "sandbox_unschedulable"): SandboxAttachError {
  return new SandboxAttachError(new SandboxProvisionTerminalError(
    reason, `workload wl-1 could not be scheduled: ${WHY} (admitted by the platform, but no node took its pod for 301s)`,
  ));
}

// ── the words ────────────────────────────────────────────────────────────────

test("the model is told the sandbox is unavailable, why, and not to retry", () => {
  for (const reason of ["sandbox_unschedulable", "sandbox_start_timeout", "sandbox_pending_timeout"]) {
    const text = explainHandsError(unavailable(reason), "read", { path: "/workspace/.skills/x/SKILL.md" });
    assert.ok(text.startsWith("Error: the sandbox could not be started: "), text);
    assert.ok(text.includes(WHY), "the platform's reason is passed on verbatim");
    assert.match(text, /will not be started again during this turn/);
    assert.match(text, /Tell the user plainly that the sandbox is unavailable/);
    assert.match(text, /Do not retry the call/);
  }
});

test("any other failure keeps the plain wording it always had", () => {
  const gone = new SandboxAttachError(new SandboxProvisionTerminalError("sandbox_gone", "workload wl-1 disappeared"));
  assert.equal(explainHandsError(gone, "read"), "Error: workload wl-1 disappeared");
  assert.equal(explainHandsError(new Error("boom"), "read"), "Error: boom");
});

test("through the agent loop, a refused open reaches the model as that instruction", async () => {
  const prompts: Message[][] = [];
  const turns: Array<{ content: LlmContentBlock[]; stopReason: string }> = [
    { content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/workspace/a" } } as LlmContentBlock], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" },
  ];
  let i = 0;
  const router = {
    route: async () => { throw unavailable(); },
    setHands: () => {},
  } as unknown as ToolRouter;
  await agentLoop([{ role: "user", content: "read a file" }], [{ name: "read", description: "d", input_schema: { type: "object" as const } }], {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 3, router,
    onEvent: async () => {}, sessionId: "sess-unavail", userId: "u1",
    llmSession: {
      async streamTurn(messages: Message[]) {
        prompts.push(structuredClone(messages));
        const t = turns[i++]!;
        return { content: t.content, stopReason: t.stopReason,
          usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 };
      },
      async complete() { return "summary"; },
    } as never,
    recreateHands: async () => ({ hands: {} as never, action: "rebuilt" as const }),
    attachHands: async () => { throw unavailable(); },
  } as never);
  const seen = JSON.stringify(prompts.at(-1));
  assert.ok(seen.includes("will not be started again during this turn"), seen);
  assert.ok(seen.includes(WHY), seen);
});

test("a platform reason that happens to read like a transport error does not make the open retryable", async () => {
  // The message carries text the platform wrote. "503" and "nats" are what
  // isRetryable's substring matches look for, and a node or pod name can hold
  // either. A retryable open is rethrown out of the loop to be redelivered, and
  // redelivery provisions, and waits, all over again.
  const why = "0/3 nodes are available: node nats-503 was unschedulable";
  const refused = () => new SandboxAttachError(new SandboxProvisionTerminalError(
    "sandbox_unschedulable", `workload wl-1 could not be scheduled: ${why}`,
  ));
  assert.equal(isRetryable(refused()), false);
  assert.equal(isRetryable(new SandboxProvisionTerminalError("sandbox_gone", "workload wl-502 disappeared")), false);

  let threw: unknown = null;
  const prompts: Message[][] = [];
  let i = 0;
  try {
    await agentLoop([{ role: "user", content: "read a file" }], [{ name: "read", description: "d", input_schema: { type: "object" as const } }], {
      model: "test-model", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 3,
      router: { route: async () => { throw refused(); }, setHands: () => {} } as unknown as ToolRouter,
      onEvent: async () => {}, sessionId: "sess-unavail-503", userId: "u1",
      llmSession: {
        async streamTurn(messages: Message[]) {
          prompts.push(structuredClone(messages));
          const turns = [
            { content: [{ type: "tool_use", id: "t1", name: "read", input: {} } as LlmContentBlock], stopReason: "tool_use" },
            { content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" },
          ];
          const t = turns[i++]!;
          return { content: t.content, stopReason: t.stopReason,
            usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 };
        },
        async complete() { return "summary"; },
      } as never,
      recreateHands: async () => ({ hands: {} as never, action: "rebuilt" as const }),
      attachHands: async () => { throw refused(); },
    } as never);
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, "the turn goes on and the model is told, as for any other refused sandbox");
  assert.ok(JSON.stringify(prompts.at(-1)).includes(why));
});

// ── the latch ────────────────────────────────────────────────────────────────

const SESSION = "sess-latch";
const MESSAGE = "msg-latch";
const TASK = "task-latch";
const OWN = "workload-this-run";

let restoreProviders: (() => void) | null = null;
afterEach(() => { restoreProviders?.(); restoreProviders = null; });

function fakeKv() {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  return {
    store,
    kv: {
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
    } as unknown as KV,
  };
}

/** What the provision's own `onProvisioned` writes: the entry names the task and the attempt that minted it. */
function pendingValue(attemptId: string | undefined): string {
  return JSON.stringify({
    status: "pending", taskId: TASK, attemptId, provider: "safe-workload", workloadId: OWN, platformKey: "pk",
    namespace: "ns", token: "hands-token", runScope: SESSION, createdAt: new Date().toISOString(),
  });
}

interface Snapshot {
  calls: number; stopped: string[]; entry: boolean; first: unknown; second: unknown;
  /** What the run did to the workload, in order: the platform asked, the handle put on the row, the stop. */
  order: string[];
}

/**
 * One run whose engine opens the sandbox twice, the way a model retrying a tool
 * does, with a provision that mints a workload, writes its PENDING entry and then
 * fails with `fail()`. The state is read inside the engine, right after the
 * first failure: that is the moment the run is still going, which is the case
 * the lazy open (and so this clean-up) exists for.
 */
async function runTurn(fail: () => unknown): Promise<Snapshot> {
  const stopped: string[] = [];
  const order: string[] = [];
  const provider = {
    kind: "safe-workload",
    async stop(inst: { id: string }) { stopped.push(inst.id); order.push("stop"); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

  const msg = {
    seq: 1, info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;
  const { kv, store } = fakeKv();
  const { kv: kvCkpt } = fakeKv();
  bindHandsKv(kv);

  let calls = 0;
  const sideEffects = {
    ensureHands: (async (
      _sid: string, _req: unknown, _key: string, _onEvent: unknown, _mn: unknown,
      options?: { attemptId?: string },
    ) => {
      calls++;
      await kv.put(handsSessionKey(SESSION), pendingValue(options?.attemptId));
      throw fail();
    }) as never,
    destroyHands: noop(undefined),
    reapPendingHands,
    probeSandboxContainer: noop({ verdict: "dead", reason: "x" }),
    fetchPlatformFacts: (async () => { order.push("facts"); return null; }) as never,
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
    postRunLease: (async (_req: unknown, renewal: { sandbox?: { handle?: string } }) => {
      if (renewal?.sandbox?.handle) order.push(`lease:${renewal.sandbox.handle}`);
      return "running";
    }) as never,
    settleRunAttempt: noop(undefined),
    runScript: noop({} as ExecuteResult),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  let snap: Snapshot | null = null;
  const engine: Engine = {
    async execute(_r, _e, _s, _h, extras?: ExecuteExtras) {
      const first = await extras!.attachHands!().then(() => null, (e: unknown) => e);
      const afterFirst = { stopped: [...stopped], entry: store.has(handsSessionKey(SESSION)), order: [...order] };
      const second = await extras!.attachHands!().then(() => null, (e: unknown) => e);
      snap = { calls, stopped: afterFirst.stopped, entry: afterFirst.entry, first, second, order: afterFirst.order };
      // Ends the run through the failure path, which is not what is under test.
      throw new Error("401 {\"error\":{\"message\":\"invalid x-api-key\"}}");
    },
  };
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: TASK, prompt: "hi", user_id: "u1", platform_key: "pk",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: `http://api.test/v1/internal/tasks/${TASK}/lease`, token: "tok" },
  } as unknown as ExecuteRequest;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  assert.ok(snap, "the engine ran");
  return snap;
}

for (const reason of ["sandbox_unschedulable", "sandbox_start_timeout", "sandbox_pending_timeout"]) {
  test(`${reason}: the run provisions once, refuses the retry with the same error, and reaps the workload`, async () => {
    const terminal = new SandboxProvisionTerminalError(reason, `workload ${OWN} gave up: ${WHY}`);
    const snap = await runTurn(() => terminal);

    assert.equal(snap.first, terminal);
    assert.equal(snap.second, terminal, "the retry is refused with the error the first open ended on");
    assert.equal(snap.calls, 1, "no second sandbox was provisioned");
    assert.deepEqual(snap.stopped, [OWN], "the workload the failed open left is stopped while the run is still going");
    assert.equal(snap.entry, false, "and its pending binding is gone with it");
    // The failure path's own order: ask the platform about the pod while it still
    // exists, name the workload on the row, and only then stop it. An unschedulable
    // workload is not asked about: it never ran, and the provider has stopped it.
    const asked = reason === "sandbox_unschedulable" ? [] : ["facts"];
    const stops = snap.order.filter((o) => o === "stop" || o === "facts" || o.startsWith("lease:"));
    assert.deepEqual(stops.slice(0, asked.length + 1), [...asked, `lease:${OWN}`], JSON.stringify(snap.order));
    assert.ok(snap.order.indexOf(`lease:${OWN}`) < snap.order.indexOf("stop"), "the handle is on the row before the reap");
  });
}

test("an open that failed for another reason is not latched: the retry provisions again, as before", async () => {
  for (const fail of [
    () => new SandboxProvisionTerminalError("sandbox_gone", `workload ${OWN} disappeared`),
    () => new Error("Create Hands failed: HTTP 500"),
  ]) {
    const snap = await runTurn(fail);
    assert.equal(snap.calls, 2, "a second attempt is made");
    assert.deepEqual(snap.stopped, [], "nothing is reaped while the run might still retry");
    assert.equal(snap.entry, true);
  }
});
