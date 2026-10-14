// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One worker's attempt at a script run, through the real runner and the real
 * script executor, with the outside world faked. Shared by the script takeover
 * tests, which differ only in the checkpoint format the process is configured
 * with -- read once at module scope, so each format needs its own file.
 */
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult, ScriptStep } from "@claw/protocol";

export const runner = await import("../../src/tasks/runner.js");
export const { SIGTERM_ABORT_REASON, activeAbort } = await import("../../src/tasks/abort-registry.js");
type SideEffects = import("../../src/tasks/runner.js")["TaskRunnerSideEffects"];

const SESSION = "sess-script-takeover";
export const TASK = "task-script-takeover";
export const SUBJECT = "tasks.execute";
export const PAYLOAD = new TextEncoder().encode('{"the":"request"}');

/** One bucket shared by every worker in a test, which is what a takeover reads. */
export function sharedKv() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1 } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async update(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  };
  return { kv: kv as unknown as KV, store };
}

interface Delivery {
  msg: JsMsg;
  settled: string[];
}

function delivery(seq: number): Delivery {
  const settled: string[] = [];
  const msg = {
    seq,
    subject: SUBJECT,
    data: PAYLOAD,
    info: { deliveryCount: 1 },
    ack() { settled.push("ack"); },
    nak() { settled.push("nak"); },
    term() { settled.push("term"); },
    working() {},
  } as unknown as JsMsg;
  return { msg, settled };
}

type Answer = { text?: string; structured?: unknown; isError?: boolean };

export interface Worker {
  /** Every tool call this worker's sandbox client received, by step identity. */
  calls: Array<{ name: string; args: Record<string, unknown>; step?: string }>;
  republished: Array<{ subject: string; data: Uint8Array }>;
  released: Array<{ taskId: string; releaseLease: unknown }>;
  done: ExecuteResult[];
  delivery: Delivery;
  abort: AbortController;
}

/**
 * Run one worker's attempt at the script. `answer` decides what each call
 * returns and may raise the drain, the way a rollout raises it mid-call.
 */
export async function runWorker(opts: {
  kvCkpt: KV;
  script: ScriptStep[];
  sandboxCreated: boolean;
  seq: number;
  requestExtra?: Record<string, unknown>;
  answer: (name: string, args: Record<string, unknown>, w: Worker, signal?: AbortSignal) => Promise<Answer>;
}): Promise<Worker> {
  const w: Worker = {
    calls: [], republished: [], released: [], done: [],
    delivery: delivery(opts.seq), abort: new AbortController(),
  };
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  const sideEffects: Partial<SideEffects> = {
    ensureHands: noop({
      handsUrl: "http://hands.test", created: opts.sandboxCreated, token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" },
    }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop("alive"),
    fetchPlatformFacts: noop(null),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: ((_req: ExecuteRequest, result: ExecuteResult) => {
      w.done.push(result);
      return Promise.resolve();
    }) as never,
    postTaskRunning: noop(undefined),
    postRunLease: noop("running"),
    settleRunAttempt: ((taskId: string, _gen: unknown, _rt: unknown, releaseLease: unknown) => {
      w.released.push({ taskId, releaseLease });
      return Promise.resolve();
    }) as never,
    republishTask: (async (subject: string, data: Uint8Array) => {
      w.republished.push({ subject, data });
    }) as never,
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
      reapShells: async () => ({ shells: [], stopped: 0, escalated: 0, surviving: 0 }),
      callToolFull: async (
        name: string, args: Record<string, unknown>, signal?: AbortSignal,
        ctx?: { stepIdentity?: string },
      ) => {
        w.calls.push({ name, args, step: ctx?.stepIdentity });
        const a = await opts.answer(name, args, w, signal);
        return { text: a.text ?? "", structured: a.structured, isError: !!a.isError };
      },
    })) as never,
  };
  runner.bindTaskRunnerDeps({
    kv: sharedKv().kv, kvCkpt: opts.kvCkpt,
    emitter: { async emit() {} } as never,
    engine: { async execute() { throw new Error("a script run must not reach the model engine"); } } as never,
    sideEffects,
  });
  const request = {
    session_id: SESSION, task_id: TASK, message_id: TASK, user_id: "u1",
    mode: "script", script: opts.script,
    callback_url: "http://api.test/v1/internal/dags",
    ...(opts.requestExtra ?? {}),
  } as unknown as ExecuteRequest;
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, w.abort);
  await runner.runHandleTask(w.delivery.msg, request, SESSION, lockKey, TASK, "u1", w.abort);
  activeAbort.delete(lockKey);
  return w;
}

/** The shape of the probe that found this: start a long job, then wait on it. */
export const START_THEN_WAIT: ScriptStep[] = [
  {
    name: "bash",
    arguments: { command: "./long-job.sh", run_in_background: true },
    captures: "job",
  } as ScriptStep,
  {
    name: "wait",
    arguments: { shell_id: "${captures.job.shell_id}" },
    repeat: { until: { path: "finished", equals: true }, max_attempts: 1000, max_seconds: 3600 },
  } as ScriptStep,
];

/** Rejects when the signal fires, the way an aborted MCP request does. */
export function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(new Error("This operation was aborted"));
    signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
  });
}

