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
import { SAFE_API_URL, SANDBOX_DEFAULT_TIMEOUT_SECONDS, SANDBOX_NAMESPACE, isKubernetesMode } from "../config.js";
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

export interface AppSandboxDeps {
  /** Persist `claw_app_runs.sandbox_workload_id`. Called as soon as an id exists. */
  recordWorkloadId(runId: string, workloadId: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** Wait for a workload to be Running; defaults to the shared poll. */
  waitRunning?: (workloadId: string, apiKey: string) => Promise<void>;
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

/**
 * The env the sandbox is created with: the spec's, the run's identity, and the
 * model credential Hands sandboxes get: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
 * (applyModelKeyEnv; platform-owned, so it wins over the spec).
 *
 * In SaFE mode that key is the session owner's SaFE platform key. Code in the
 * sandbox can use it to call the SaFE API as the session owner, exactly as it can
 * in a Hands sandbox. The run's AppRunner scrubs it from forwarded output and it
 * is never stored in `claw_app_runs`.
 *
 * Only those two variables carry it: `SAFE_API_KEY` is not set (and one a spec
 * supplies is dropped), and no gateway URL is injected (the SaFE path leaves URLs
 * to the image / the manifest's env, so a manifest can point its agent elsewhere;
 * see ensureHands).
 */
export function appSandboxEnv(run: Pick<AppSandboxRun, "runId" | "sandboxSpec" | "platformKey">): Record<string, string> {
  const env: Record<string, string> = { ...withoutSessionEnv(run.sandboxSpec.env), [APP_RUN_ID_ENV]: run.runId };
  delete env.SAFE_API_KEY;
  applyModelKeyEnv(env, run.platformKey);
  return env;
}

const appSandboxNamespace = (run: Pick<AppSandboxRun, "workspaceId">): string =>
  run.workspaceId?.trim() || SANDBOX_NAMESPACE;

/**
 * The handle of an app sandbox whose workload id is already known: a run being
 * reconciled after a restart or a takeover reads the id from its row and needs
 * the instance without creating anything.
 */
export function appSandboxInstance(
  run: Pick<AppSandboxRun, "workspaceId" | "platformKey">,
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
 */
export async function ensureAppSandbox(run: AppSandboxRun, deps: AppSandboxDeps): Promise<AppSandbox> {
  if (isKubernetesMode()) {
    throw new Error("app sandboxes are created through SaFE; kubernetes mode is not supported");
  }
  if (!run.platformKey) throw new Error("ensureAppSandbox: platformKey is required");
  if (!run.sandboxSpec?.image?.trim()) throw new Error("ensureAppSandbox: sandbox_spec has no image");
  const ns = appSandboxNamespace(run);
  const wait = deps.waitRunning ?? ((id, key) => pollWorkloadUntilRunning(id, key, undefined, undefined, "app"));
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
        await wait(adopted.id, run.platformKey);
      } catch (err) {
        // A workload that cannot be brought to Running (queued past the ceiling, or
        // gone terminal) is stopped, as on the create path: left live, the next
        // attempt would find and adopt it again, for ever. The surplus is left for
        // that next attempt: it is not known to be bad, and stopping it too would
        // leave the run with nothing.
        await reclaim(adopted.id, "adopted_wait_failed");
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
    });
    logger.info({ runId: run.runId, workloadId: inst.id }, "app_sandbox.created");
    // The handle is built here, as on the adopt path: the provider's carries a Hands
    // URL, and the same run must not get one when created and none when adopted.
    return { instance: instanceFor(inst.id), workloadId: inst.id, created: true };
  } catch (err) {
    if (createdId !== undefined) await reclaim(createdId, "create_failed");
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

