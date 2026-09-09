// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  AGENT_SANDBOX_ROUTER_URL,
  AGENT_SANDBOX_NAMESPACE,
  AUTH_INTERNAL_TOKEN,
  SAFE_API_URL,
  SANDBOX_NAMESPACE,
  SANDBOX_ROUTER_URL,
} from "../config.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import type { SandboxInstance, SandboxStatus } from "./provider.js";
import { SandboxRuntimeTerminalError } from "./errors.js";

export interface JobProbeEntry {
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;
  platformKey?: string;
  sessionId?: string;
  sandboxName?: string;
  namespace?: string;
  userId?: string;
  podUid?: string;
  envdInstanceId?: string;
}

export interface JobsProbeResult {
  count: number;
  podUid?: string;
  instanceId?: string;
}

export class SandboxTerminalProbeError extends Error {
  readonly sandboxTerminal = true;

  constructor(
    readonly state: "terminal" | "absent",
    readonly reason = "sandbox_workload_terminal",
  ) {
    super(`sandbox jobs probe found workload state=${state}`);
    this.name = "SandboxTerminalProbeError";
  }
}

export class SandboxTrackingLostError extends Error {
  readonly trackingLost = true;
  constructor() {
    super("sandbox jobs tracking was lost");
    this.name = "SandboxTrackingLostError";
  }
}

/** EnvD on this Pod has no jobs roster. Brain must not idle-reclaim it. */
export class SandboxJobsUnavailableError extends Error {
  readonly jobsUnavailable = true;
  constructor(readonly httpStatus: number) {
    super(`sandbox jobs API is unavailable: HTTP ${httpStatus}`);
    this.name = "SandboxJobsUnavailableError";
  }
}

/** Convert a persisted handle into the provider-neutral sandbox identity. */
function instanceFromEntry(entry: JobProbeEntry): SandboxInstance {
  const agent = entry.provider === "agent-sandbox";
  const id = agent ? entry.sessionId : entry.workloadId;
  if (!id) throw new Error("sandbox jobs probe is missing its workload identity");
  return {
    provider: agent ? "agent-sandbox" : "safe-workload",
    id,
    sandboxName: entry.sandboxName || entry.workloadId || "",
    namespace: entry.namespace || (agent ? AGENT_SANDBOX_NAMESPACE : SANDBOX_NAMESPACE),
    handsBaseUrl: "",
    platformKey: entry.platformKey,
    userId: entry.userId,
  };
}

/** Refuse to inspect jobs unless the control plane confirms Running. */
function requireRunning(status: SandboxStatus): void {
  if (status.state === "terminal" || status.state === "absent") {
    throw new SandboxTerminalProbeError(status.state, status.reason);
  }
  if (!status.running || status.state === "unknown") {
    throw new Error(`sandbox jobs probe requires Running, state=${status.state || "unknown"}`);
  }
}

/** Validate the EnvD response without treating malformed data as idle. */
function parseJobsBody(body: unknown): JobsProbeResult {
  const raw = body as {
    user_process_count?: unknown;
    tracking_lost?: unknown;
    pod_uid?: unknown;
    instance_id?: unknown;
  } | null;
  if (raw?.tracking_lost === true) {
    throw new SandboxTrackingLostError();
  }
  const count = raw?.user_process_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`sandbox jobs probe returned invalid user_process_count=${String(count)}`);
  }
  const podUid = typeof raw?.pod_uid === "string" && raw.pod_uid ? raw.pod_uid : undefined;
  const instanceId = typeof raw?.instance_id === "string" && raw.instance_id
    ? raw.instance_id
    : undefined;
  return { count, podUid, instanceId };
}

/** Bind jobs to one EnvD process; a rebuilt Pod must not look idle. */
function assertSameInstance(entry: JobProbeEntry, result: JobsProbeResult): void {
  if (entry.podUid && result.podUid && entry.podUid !== result.podUid) {
    throw new SandboxRuntimeTerminalError(
      "sandbox_instance_replaced",
      `sandbox Pod UID changed from ${entry.podUid} to ${result.podUid}`,
    );
  }
  if (entry.envdInstanceId && result.instanceId && entry.envdInstanceId !== result.instanceId) {
    throw new SandboxRuntimeTerminalError(
      "sandbox_instance_replaced",
      `EnvD instance changed from ${entry.envdInstanceId} to ${result.instanceId}`,
    );
  }
}

/** Return the number of user task processes after independently confirming Running. */
export async function countSandboxUserProcesses(
  entry: JobProbeEntry,
  timeoutMs = 5_000,
): Promise<number> {
  return (await inspectSandboxJobs(entry, timeoutMs)).count;
}

/** Inspect EnvD jobs and the process identity those jobs belong to. */
export async function inspectSandboxJobs(
  entry: JobProbeEntry,
  timeoutMs = 5_000,
): Promise<JobsProbeResult> {
  const inst = instanceFromEntry(entry);
  const agent = inst.provider === "agent-sandbox";
  const provider = agent ? getAgentSandboxProvider() : getSafeWorkloadProvider();
  requireRunning(await provider.get(inst));

  const base = agent
    ? AGENT_SANDBOX_ROUTER_URL.replace(/\/+$/, "")
    : (SANDBOX_ROUTER_URL.trim()
      ? SANDBOX_ROUTER_URL.replace(/\/+$/, "")
      : `${SAFE_API_URL}/sandbox`);
  if (!base) throw new Error("sandbox jobs probe router URL is not configured");

  const name = agent ? inst.sandboxName : inst.id;
  const url = `${base}/v1/namespaces/${inst.namespace}/code-interpreters/${name}/invocations/api/jobs`;
  const headers: Record<string, string> = { "x-session-id": inst.id };
  if (agent) {
    if (inst.userId) headers.userId = inst.userId;
  } else {
    headers.Authorization = `Bearer ${inst.platformKey ?? ""}`;
    if (AUTH_INTERNAL_TOKEN.trim()) headers["X-Internal-Token"] = AUTH_INTERNAL_TOKEN.trim();
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new SandboxJobsUnavailableError(response.status);
    }
    throw new Error(`sandbox jobs probe failed: HTTP ${response.status}`);
  }
  const result = parseJobsBody(await response.json().catch(() => null));
  assertSameInstance(entry, result);
  return result;
}
