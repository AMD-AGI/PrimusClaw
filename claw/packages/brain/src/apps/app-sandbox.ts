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
import { SAFE_API_URL, SANDBOX_NAMESPACE, isKubernetesMode } from "../config.js";
import {
  DEFAULT_SANDBOX_TTL_SEC, composeSandboxLabels, createSafeWorkloadSandbox, SESSION_ID_LABEL, COMPONENT_LABEL,
} from "../sandbox/create-sandbox.js";
import { fetchPlatformFacts } from "../sandbox/platform-facts-read.js";
import { parseWorkloadListPage } from "../sandbox/multi-node/workload-parse.js";
import { safeHandsBaseUrl } from "../sandbox/sandbox-router.js";
import { pollWorkloadUntilRunning } from "../sandbox/safe-workload-provider.js";
import type { SandboxInstance } from "../sandbox/provider.js";

const logger = pino({ name: "app-sandbox" });

export const APP_COMPONENT = "app";
export const APP_RUN_ID_LABEL = "primus-claw/app-run-id";
/** Env twin of the label: the one SaFE's workload list can match on. */
export const APP_RUN_ID_ENV = "CLAW_APP_RUN_ID";
const SESSION_ENV = "CLAW_SESSION_ID";
const ACTIVE_PHASES = "Pending,Running,Updating,NotReady";
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
    for (const w of parsed.items) if (w.kind === "Sandbox" || w.kind === "") found.push({ id: w.id, phase: w.phase });
    if (parsed.items.length === 0 || found.length >= parsed.totalCount) return found;
  }
  throw new Error("app sandbox lookup failed: more workloads than one run can own");
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
    handsBaseUrl: safeHandsBaseUrl(ns, workloadId, "9100"),
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
  const wait = deps.waitRunning ?? ((id, key) => pollWorkloadUntilRunning(id, key));
  const instanceFor = (id: string): SandboxInstance => appSandboxInstance(run, id);

  const live = await findLiveAppSandboxes(run.runId, run.platformKey, deps.fetch);
  if (live.length > 0) {
    // Newest first. More than one means an earlier create was never seen by the
    // run (so it was never stopped); adopt the newest and say so.
    const adopted = live[0]!;
    if (live.length > 1) {
      logger.warn({ runId: run.runId, workloadIds: live.map((w) => w.id) }, "app_sandbox.multiple_live");
    }
    if (adopted.phase !== "running") await wait(adopted.id, run.platformKey);
    if (run.sandboxWorkloadId !== adopted.id) await deps.recordWorkloadId(run.runId, adopted.id);
    logger.info({ runId: run.runId, workloadId: adopted.id }, "app_sandbox.adopted");
    return { instance: instanceFor(adopted.id), workloadId: adopted.id, created: false };
  }

  const spec = run.sandboxSpec;
  const resources = Object.fromEntries(
    Object.entries(spec.resources ?? {}).map(([k, v]) => [k, String(v)]),
  );
  const create = deps.create ?? createSafeWorkloadSandbox;
  const inst = await create({
    sessionId: run.sessionId,
    namespace: ns,
    image: spec.image,
    resources,
    env: { ...(spec.env ?? {}), [SESSION_ENV]: run.sessionId, [APP_RUN_ID_ENV]: run.runId },
    labels: appSandboxLabels(run),
    timeoutSec: spec.timeout,
    ttlSec: spec.ttl_sec ?? DEFAULT_SANDBOX_TTL_SEC,
    platformKey: run.platformKey,
    // Recorded before the wait for Running, so a Brain that dies while the
    // workload queues leaves the id behind rather than an unrecorded workload.
    onProvisioned: (id) => deps.recordWorkloadId(run.runId, id),
  });
  logger.info({ runId: run.runId, workloadId: inst.id }, "app_sandbox.created");
  return { instance: inst, workloadId: inst.id, created: true };
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

