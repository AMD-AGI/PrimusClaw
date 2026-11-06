// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sandbox an app run lives in.
 *
 * Created the way a Hands sandbox is -- a SaFE Sandbox workload through the
 * shared creation path -- and unlike one, it is owned by exactly one thing: the
 * run's AppRunner. So it is never written under `hands.<sessionId>` (the
 * keyspace the idle sweeper, the keepalive ticker and the reaper walk, which is
 * what keeps them away from it), it is not admitted against the Hands capacity
 * ceiling, and nothing here bootstraps Hands into it.
 *
 * Everything comes from the run's `sandbox_spec`: image, resources, workspace,
 * timeout, env, labels. Nothing in this file knows what runs inside.
 *
 * Idempotent per run. The run's identity is stamped on the workload twice, as
 * the `primus-claw/app-run-id` label and as the `CLAW_APP_RUN_ID` env (SaFE's
 * workload list matches on env, not on labels -- see multi-node/safe-provider),
 * and a live workload carrying it is returned instead of created again. That
 * lookup, not the recorded id alone, is what makes a retry or a Brain takeover
 * safe: the window between "SaFE accepted the create" and "the id was recorded"
 * is exactly where the recorded id says nothing.
 *
 * Concurrency between two Brains is the run lease's job, not this file's.
 */
import pino from "pino";
import type { SandboxSpecCreate } from "@claw/protocol";
import { SAFE_API_URL, SANDBOX_DEFAULT_TIMEOUT_SECONDS, isKubernetesMode } from "../config.js";
import { sandboxNamespaceForResources } from "../sandbox/workspace-select.js";
import {
  DEFAULT_SANDBOX_TTL_SEC, composeSandboxLabels, createSafeWorkloadSandbox, SESSION_ID_LABEL, COMPONENT_LABEL,
} from "../sandbox/create-sandbox.js";
import { fetchPlatformFacts } from "../sandbox/platform-facts-read.js";
import { parseWorkloadListPage } from "../sandbox/multi-node/workload-parse.js";
import { getSafeWorkloadProvider } from "../sandbox/factory.js";
import { SESSION_ENV } from "../sandbox/multi-node/safe-body.js";
import { ACTIVE_PHASES, TERMINAL_PHASES } from "../sandbox/workload-wait.js";
import { pollWorkloadUntilRunning, SHUTDOWN_BUFFER_SECONDS } from "../sandbox/safe-workload-provider.js";
import type { SandboxInstance } from "../sandbox/provider.js";
import { applyModelKeyEnv } from "../sandbox/params.js";
import { PLATFORM_CREDENTIAL_ENV, workloadSpecEnv } from "../sandbox/workload-env.js";
import { SandboxProvisionTerminalError, provisionTerminalOf } from "../sandbox/errors.js";

const logger = pino({ name: "app-sandbox" });

export const APP_COMPONENT = "app";
export const APP_RUN_ID_LABEL = "primus-claw/app-run-id";
/** Env twin of the label: the one SaFE's workload list can match on. */
export const APP_RUN_ID_ENV = "CLAW_APP_RUN_ID";
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 4;
const LIST_TIMEOUT_MS = 30_000;

/** What ensureAppSandbox needs of a run: the task row plus its app-run row. */
export interface AppSandboxRun {
  /** The app run id (`claw_tasks.task_id`, `claw_app_runs.task_id`). */
  runId: string;
  sessionId: string;
  /** `claw_tasks.sandbox_spec`, a create spec. */
  sandboxSpec: SandboxSpecCreate;
  /** SaFE workspace the sandbox runs in (the request's workspace id). */
  workspaceId?: string;
  /** `claw_app_runs.sandbox_workload_id`, when one was recorded. */
  sandboxWorkloadId?: string | null;
  /** The session owner's platform key: SaFE create / poll / stop. */
  platformKey: string;
}

/**
 * What an `ensure` is told about the run being stopped while it waits.
 *
 * `signal` is the run's: once it has fired no create is sent, and the wait for a
 * workload that exists -- one whose create was already under way included -- ends
 * at once (`sandbox_wait_interrupted`). `reclaimOnAbort`,
 * read when the abort is seen, says whether that stop ends the run -- a cancel,
 * the deadline, a terminal row: the workload is stopped, since nothing else will
 * stop a sandbox that no run is going to use -- or hands it over -- a drain, a
 * lost lease: the workload is left as it is for the Brain that takes the run
 * over, which adopts it by `CLAW_APP_RUN_ID`. Absent means every stop ends the run.
 */
export interface AppSandboxEnsureOptions {
  signal?: AbortSignal;
  reclaimOnAbort?: () => boolean;
}

export interface AppSandboxDeps {
  /** Persist `claw_app_runs.sandbox_workload_id`. Called as soon as an id exists. */
  recordWorkloadId(runId: string, workloadId: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** Wait for a workload to be Running; defaults to the shared poll. */
  waitRunning?: (workloadId: string, apiKey: string, abort?: AppSandboxEnsureOptions) => Promise<void>;
  /** Create through the shared path; defaults to the real provider. */
  create?: typeof createSafeWorkloadSandbox;
  /** Stop a workload this call created or found surplus; defaults to the SaFE provider. */
  stop?: (workloadId: string) => Promise<void>;
}

export interface AppSandbox {
  instance: SandboxInstance;
  workloadId: string;
  /** True only when this call created a workload; false when one already existed. */
  created: boolean;
}

/** The labels an app sandbox carries. The identity ones cannot be overridden by the spec. */
export function appSandboxLabels(run: Pick<AppSandboxRun, "runId" | "sessionId" | "sandboxSpec">): Record<string, string> {
  return {
    ...composeSandboxLabels({
      sessionId: run.sessionId,
      component: APP_COMPONENT,
      own: { [APP_RUN_ID_LABEL]: run.runId },
      extra: run.sandboxSpec.labels,
    }),
    // Reasserted: Pulse attributes by the session label and the reaper-facing
    // component label must say `app`, whatever the manifest put in labels.
    [SESSION_ID_LABEL]: run.sessionId,
    [COMPONENT_LABEL]: APP_COMPONENT,
    [APP_RUN_ID_LABEL]: run.runId,
  };
}

/**
 * Live workloads of this run. Throws when the list cannot be read: "could not
 * look" must never be read as "there is none", or a SaFE blip creates a second
 * sandbox.
 */
export async function findLiveAppSandboxes(
  runId: string,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Array<{ id: string; phase: string }>> {
  const found: Array<{ id: string; phase: string }> = [];
  let seen = 0;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      envKey: APP_RUN_ID_ENV,
      envValue: runId,
      phase: ACTIVE_PHASES,
      sortBy: "creation_time",
      order: "desc",
      limit: String(LIST_PAGE_SIZE),
      offset: String(page * LIST_PAGE_SIZE),
    });
    const resp = await fetchImpl(`${SAFE_API_URL}/api/v1/workloads?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (resp.status !== 200) {
      throw new Error(`app sandbox lookup failed: HTTP ${resp.status}`);
    }
    const parsed = parseWorkloadListPage(await resp.json().catch(() => null));
    if (!parsed) throw new Error("app sandbox lookup failed: unrecognised workload list");
    seen += parsed.items.length;
    // The server was asked for active phases only, but that filter is not
    // guaranteed to apply (a SaFE version without it, or a phase it does not know):
    // a terminal workload is skipped here as well, or the run would adopt a dead
    // one for ever.
    for (const w of parsed.items) {
      if (!(w.kind === "Sandbox" || w.kind === "") || !w.id || TERMINAL_PHASES.has(w.phase)) continue;
      // The env match alone would also take a Hands sandbox whose env happens to
      // carry the same variable. When the entry reports its labels they must say
      // this run's app sandbox; an entry that reports none is judged by the env.
      if (w.labels && (w.labels[COMPONENT_LABEL] !== APP_COMPONENT || w.labels[APP_RUN_ID_LABEL] !== runId)) continue;
      found.push({ id: w.id, phase: w.phase });
    }
    // Items seen, not workloads kept, against the unfiltered total: the same unit.
    if (parsed.items.length === 0 || seen >= parsed.totalCount) return found;
  }
  throw new Error("app sandbox lookup failed: more workloads than one run can own");
}

/** The spec's env without the session correlation variable, which a manifest must not set either. */
function withoutSessionEnv(env: Record<string, string> | undefined): Record<string, string> {
  const { [SESSION_ENV]: _dropped, ...rest } = env ?? {};
  return rest;
}

/** The spec's env as an app sandbox may use it: no session correlation, no platform credential a spec could plant. */
function appSpecEnv(spec: Pick<SandboxSpecCreate, "env"> | null | undefined): Record<string, string> {
  const env = withoutSessionEnv(spec?.env);
  for (const name of PLATFORM_CREDENTIAL_ENV) delete env[name];
  return env;
}

/**
 * The env the sandbox is created with: the spec's plain settings and the run's
 * identity.
 *
 * No credential: everything here is stored by SaFE in the workload and returned
 * to every caller allowed to read it. So the model credential is not set here,
 * a platform credential a spec supplies (`SAFE_API_KEY`, ...) is dropped, and the
 * spec's own credentials (workloadSpecEnv) travel with the application's start
 * command instead (appStartEnv).
 */
export function appSandboxEnv(run: Pick<AppSandboxRun, "runId" | "sandboxSpec">): Record<string, string> {
  return { ...workloadSpecEnv(appSpecEnv(run.sandboxSpec)), [APP_RUN_ID_ENV]: run.runId };
}

/**
 * The execute env of the application's start command: the spec's credentials
 * the workload left out, then the application's own env (as the start
 * command's env always overlaid the pod's), then the model credential, which is
 * platform-owned and so laid last.
 */
export function appStartEnv(
  spec: Pick<SandboxSpecCreate, "env"> | null | undefined,
  appEnv: Record<string, string>,
  platformKey: string | undefined,
): Record<string, string> {
  const specEnv = appSpecEnv(spec);
  const inWorkload = workloadSpecEnv(specEnv);
  const specCredentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(specEnv)) if (!(name in inWorkload)) specCredentials[name] = value;
  return { ...specCredentials, ...appEnv, ...appModelKeyEnv(platformKey) };
}

/**
 * The model credential Hands sandboxes get, `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` (applyModelKeyEnv), for the application's start command.
 *
 * In SaFE mode that key is the session owner's SaFE platform key. Code in the
 * sandbox can use it to call the SaFE API as the session owner, exactly as it can
 * in a Hands sandbox. The run's AppRunner scrubs it from forwarded output and it
 * is never stored in `claw_app_runs`. It travels in the execute request's env,
 * never in the workload (see appSandboxEnv) or the logged command.
 */
export function appModelKeyEnv(platformKey: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  applyModelKeyEnv(env, platformKey);
  return env;
}

const appSandboxNamespace = (run: Pick<AppSandboxRun, "workspaceId" | "sandboxSpec">): string =>
  sandboxNamespaceForResources(run.workspaceId, run.sandboxSpec?.resources);

/**
 * The handle of an app sandbox whose workload id is already known: a run being
 * reconciled after a restart or a takeover reads the id from its row and needs
 * the instance without creating anything.
 */
export function appSandboxInstance(
  run: Pick<AppSandboxRun, "workspaceId" | "platformKey" | "sandboxSpec">,
  workloadId: string,
): SandboxInstance {
  const ns = appSandboxNamespace(run);
  return {
    provider: "safe-workload",
    id: workloadId,
    sandboxName: workloadId,
    namespace: ns,
    // An app sandbox has no Hands in it, so there is no Hands URL to give.
    handsBaseUrl: "",
    platformKey: run.platformKey,
  };
}

/**
 * The run's sandbox: an existing live one, or a fresh one. Returns once the
 * sandbox is Running.
 *
 * `abort` is the run's signal (see {@link AppSandboxEnsureOptions}). A run that is
 * stopped while this waits -- a session deleted seconds after the run was
 * submitted, with the workload still queued -- must not be left holding a
 * sandbox it will never use: the workload is stopped here, at once, rather than
 * waited on until it is Running and stopped (or not) by a finish whose lease has
 * long run out by then.
 */
export async function ensureAppSandbox(
  run: AppSandboxRun,
  deps: AppSandboxDeps,
  abort: AppSandboxEnsureOptions = {},
): Promise<AppSandbox> {
  if (isKubernetesMode()) {
    throw new Error("app sandboxes are created through SaFE; kubernetes mode is not supported");
  }
  if (!run.platformKey) throw new Error("ensureAppSandbox: platformKey is required");
  if (!run.sandboxSpec?.image?.trim()) throw new Error("ensureAppSandbox: sandbox_spec has no image");
  const ns = appSandboxNamespace(run);
  const wait = deps.waitRunning ?? ((id, key, s) => pollWorkloadUntilRunning(id, key, undefined, undefined, "app", {
    signal: s?.signal, reclaimOnAbort: s?.reclaimOnAbort,
  }));
  /**
   * The wait was cut short by a stop that hands the run over: the workload is
   * the next holder's to adopt, and stopping it would leave that holder nothing.
   */
  const handedOver = (err: unknown): boolean =>
    provisionTerminalOf(err)?.reason === "sandbox_wait_interrupted"
    && abort.reclaimOnAbort !== undefined && !abort.reclaimOnAbort();
  // An app sandbox has no Hands in it, so there is no Hands URL to give.
  const instanceFor = (id: string): SandboxInstance => appSandboxInstance(run, id);
  const stop = deps.stop ?? ((id: string) => getSafeWorkloadProvider().stop(instanceFor(id)));
  /** Stop a workload nothing else will; a failed stop is logged with the id, never hidden. */
  const reclaim = async (workloadId: string, why: string): Promise<void> => {
    try {
      await stop(workloadId);
      logger.warn({ runId: run.runId, workloadId, why }, "app_sandbox.reclaimed");
    } catch (err) {
      logger.error({ runId: run.runId, workloadId, why, err: err instanceof Error ? err.message : String(err) }, "app_sandbox.reclaim_failed");
    }
  };

  const live = await findLiveAppSandboxes(run.runId, run.platformKey, deps.fetch);
  if (live.length > 0) {
    // `live` is newest first. More than one means an earlier create was never seen
    // by the run (so it was never recorded or stopped). Which one is the run's:
    // the recorded one that is still live, else one already Running (an
    // application may be in it), only then the newest. The newest alone would stop
    // a running sandbox in favour of a Pending twin.
    const adopted = live.find((w) => w.id === run.sandboxWorkloadId)
      ?? live.find((w) => w.phase === "running")
      ?? live[0]!;
    const surplus = live.filter((w) => w.id !== adopted.id);
    // Recorded before the wait, as on the create path: a wait that gives up must
    // leave the id behind for whoever cleans up.
    if (run.sandboxWorkloadId !== adopted.id) await deps.recordWorkloadId(run.runId, adopted.id);
    if (adopted.phase !== "running") {
      try {
        await wait(adopted.id, run.platformKey, abort);
      } catch (err) {
        // A workload that cannot be brought to Running (queued past the ceiling, or
        // gone terminal), or whose run was cancelled while it waited, is stopped, as
        // on the create path: left live, the next attempt would find and adopt it
        // again, for ever. The surplus is left for that next attempt: it is not known
        // to be bad, and stopping it too would leave the run with nothing. A run
        // being handed over leaves it to the next holder.
        if (!handedOver(err)) await reclaim(adopted.id, "adopted_wait_failed");
        throw err;
      }
    }
    // Only once the adopted one is Running are the others given up; reclaim
    // swallows its errors, so they go together.
    await Promise.all(surplus.map((extra) => reclaim(extra.id, "surplus_live_workload")));
    logger.info({ runId: run.runId, workloadId: adopted.id, surplus: surplus.length }, "app_sandbox.adopted");
    return { instance: instanceFor(adopted.id), workloadId: adopted.id, created: false };
  }

  const spec = run.sandboxSpec;
  // The resources are the run's: an empty set would be sent to SaFE as such and
  // either be refused there with an opaque 400 or scheduled on a default.
  const resources = spec.resources;
  if (!resources || Object.keys(resources).length === 0) {
    throw new Error("ensureAppSandbox: sandbox_spec has no resources");
  }
  // Last look before the create: a run stopped while the lookup above was in
  // flight gets no workload at all. After this the create itself is not cut short
  // (SaFE may accept a create whose answer was dropped, and that workload would
  // have no recorded id); the wait that follows it is.
  if (abort.signal?.aborted) {
    throw new SandboxProvisionTerminalError(
      "sandbox_wait_interrupted", `app run ${run.runId} was stopped before its sandbox was created`,
    );
  }
  const create = deps.create ?? createSafeWorkloadSandbox;
  let createdId: string | undefined;
  try {
    const inst = await create({
      sessionId: run.sessionId,
      namespace: ns,
      image: spec.image,
      resources,
      // No CLAW_SESSION_ID: SaFE's session lookup (multi-node/safe-provider
      // findSessionWorkloads) matches on exactly that env, and session teardown
      // deletes what it finds. This sandbox is the run's AppRunner's alone, so it
      // must not be reachable that way (the session label still attributes it).
      env: appSandboxEnv(run),
      labels: appSandboxLabels(run),
      // A manifest that names no timeout still gets the platform's default, not the
      // longest session the provider allows. The provider adds its shutdown buffer to
      // an explicit timeout, so the buffer is taken off here: SaFE receives the default.
      timeoutSec: spec.timeout ?? Math.max(1, SANDBOX_DEFAULT_TIMEOUT_SECONDS - SHUTDOWN_BUFFER_SECONDS),
      ttlSec: spec.ttl_sec ?? DEFAULT_SANDBOX_TTL_SEC,
      platformKey: run.platformKey,
      // The id is remembered here first, then recorded, then waited on: a failed
      // record or a wait that gives up (Pending past the ceiling) still knows what
      // to stop. There is no hands.* entry or sweeper for this sandbox.
      onProvisioned: async (id) => {
        createdId = id;
        await deps.recordWorkloadId(run.runId, id);
      },
      // The run's stop ends the wait for Running. The provider stops the workload
      // itself (its onGiveUp) when `reclaimOnAbort` says the stop ends the run, and
      // leaves it when it hands the run over.
      ...(abort.signal ? { signal: abort.signal } : {}),
      ...(abort.reclaimOnAbort ? { reclaimOnAbort: abort.reclaimOnAbort } : {}),
    });
    logger.info({ runId: run.runId, workloadId: inst.id }, "app_sandbox.created");
    // The handle is built here, as on the adopt path: the provider's carries a Hands
    // URL, and the same run must not get one when created and none when adopted.
    return { instance: instanceFor(inst.id), workloadId: inst.id, created: true };
  } catch (err) {
    // After a cancel too, although the provider has already stopped the workload
    // then: a stop that failed there is only logged, and a second one costs nothing.
    // Never after a hand-over (see handedOver). A create whose id could not be
    // recorded because the lease had moved on (`not_holder`) is still stopped: the
    // new holder may have adopted it, and then counts it a lost sandbox and makes
    // another, but left running it can be left to nobody, when the new holder had
    // already finished the run before this create landed.
    if (createdId !== undefined && !handedOver(err)) await reclaim(createdId, "create_failed");
    throw err;
  }
}

/**
 * The node the sandbox runs on, for the app's `NODE_NAME`.
 *
 * The provider does not report it: `SandboxInstance` and the create response
 * carry no node. SaFE's workload detail does (the pod's admin node name), and
 * this reads it through the same GET the platform-facts reader already makes.
 * Null when the detail has no pod yet or no node name; the caller decides what
 * an absent node means.
 */
export async function readSandboxNodeName(
  workloadId: string,
  platformKey: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<string | null> {
  const facts = await fetchPlatformFacts(workloadId, platformKey, { fetch: fetchImpl ?? globalThis.fetch });
  return facts?.node ? facts.node : null;
}

