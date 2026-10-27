// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The AppRunner as Brain runs it: the real sandbox provider, the API-backed
 * store, and the grant hooks, which are no-ops until a grant implementation
 * binds itself.
 */
import { getSafeWorkloadProvider } from "../sandbox/factory.js";
import {
  AppRunner, noopAppGrant, type AppGrantRunHooks, type AppRunnerSeams, type AppSandboxOps,
} from "./app-runner.js";
import { httpAppRunStore, type AppRunRecord, type AppRunStore } from "./app-run-store.js";
import { createEventTailer } from "./event-tailer.js";
import {
  appSandboxInstance, ensureAppSandbox, findLiveAppSandboxes, readSandboxNodeName,
} from "./app-sandbox.js";

export function realAppSandbox(store: AppRunStore): AppSandboxOps {
  return {
    ensure: (run) => ensureAppSandbox(run, {
      recordWorkloadId: async (runId, workloadId) => { await store.patch(runId, { sandbox_workload_id: workloadId }); },
    }),
    instance: appSandboxInstance,
    status: (inst) => getSafeWorkloadProvider().get(inst),
    exec: (inst, command, timeout, opts) => getSafeWorkloadProvider().exec(inst, command, timeout, undefined, opts),
    stop: (inst) => getSafeWorkloadProvider().stop(inst),
    liveIds: async (runId, platformKey) => (await findLiveAppSandboxes(runId, platformKey)).map((w) => w.id),
    nodeName: (workloadId, platformKey) => readSandboxNodeName(workloadId, platformKey),
  };
}

/** What a grant implementation or a later change plugs into. Bound once, at boot. */
let boundGrant: AppGrantRunHooks = noopAppGrant;
let boundSeams: AppRunnerSeams = {};

export function bindAppRunnerExtensions(ext: { grant?: AppGrantRunHooks; seams?: AppRunnerSeams }): void {
  if (ext.grant) boundGrant = ext.grant;
  if (ext.seams) boundSeams = ext.seams;
}

/** To the session's event stream (`events.<sessionId>`). */
export type AppEventPublisher = (sessionId: string, event: Record<string, unknown>, opts?: { msgID?: string }) => Promise<void>;

/** What `last_exit` shows a client: the outcome, not the runner's bookkeeping (`finish_done`, `stop_at`, `recovery`). */
export function publicLastExit(exit: AppRunRecord["last_exit"]): Record<string, unknown> | null {
  if (!exit) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["at", "cause", "final", "returncode", "stop_reason", "error"] as const) {
    if (exit[key] !== undefined) out[key] = exit[key];
  }
  return out;
}

/**
 * The seams that forward the application's events (5.7): its progress events as
 * `appEvent`, and the run's state changes as `appStatus`. Without a publisher
 * there is nothing to forward to, and the seams are not installed.
 */
export function eventForwardingSeams(
  store: AppRunStore, sandbox: AppSandboxOps, publish: AppEventPublisher | undefined,
): AppRunnerSeams {
  if (!publish) return {};
  const tailer = createEventTailer({
    // Untracked, like every other exec the runner makes: a forwarding round is not user work.
    exec: (inst, command, timeout) => sandbox.exec(inst, command, timeout, { untracked: true }),
    store,
    // The same event published again (a takeover re-reads a batch) is dropped by the stream itself.
    publish: (sessionId, message) => publish(sessionId, message, { msgID: `${message.app_task_id}:${String(message.event.id)}` }),
  });
  return {
    ...tailer,
    stateChanged: async (rec) => {
      await publish(rec.session_id, {
        type: "appStatus", app_task_id: rec.run_id, state: rec.state, restarts: rec.restarts, last_exit: publicLastExit(rec.last_exit),
      });
    },
  };
}

/**
 * `claimCount` is the epoch the caller holds the run at; every write to the row quotes it.
 * `publish` is where the application's events go; the seams bound at boot win over the forwarding ones.
 */
export function createAppRunner(runId: string, platformKey: string, claimCount: number, publish?: AppEventPublisher): AppRunner {
  const store = httpAppRunStore({ claimCount });
  const sandbox = realAppSandbox(store);
  return new AppRunner(runId, platformKey, {
    store, sandbox, grant: boundGrant, seams: { ...eventForwardingSeams(store, sandbox, publish), ...boundSeams },
  });
}
