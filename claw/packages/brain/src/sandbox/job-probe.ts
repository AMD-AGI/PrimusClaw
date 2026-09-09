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

export interface JobProbeEntry {
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;
  platformKey?: string;
  sessionId?: string;
  sandboxName?: string;
  namespace?: string;
  userId?: string;
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
function parseCount(body: unknown): number {
  const count = (body as { user_process_count?: unknown } | null)?.user_process_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`sandbox jobs probe returned invalid user_process_count=${String(count)}`);
  }
  return count;
}

/** Return the number of user task processes after independently confirming Running. */
export async function countSandboxUserProcesses(
  entry: JobProbeEntry,
  timeoutMs = 5_000,
): Promise<number> {
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
    throw new Error(`sandbox jobs probe failed: HTTP ${response.status}`);
  }
  return parseCount(await response.json().catch(() => null));
}
