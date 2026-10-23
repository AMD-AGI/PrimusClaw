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
import { httpAppRunStore, type AppRunStore } from "./app-run-store.js";
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

/** `claimCount` is the epoch the caller holds the run at; every write to the row quotes it. */
export function createAppRunner(runId: string, platformKey: string, claimCount: number): AppRunner {
  const store = httpAppRunStore({ claimCount });
  return new AppRunner(runId, platformKey, {
    store, sandbox: realAppSandbox(store), grant: boundGrant, seams: boundSeams,
  });
}
