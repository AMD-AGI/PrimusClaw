// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SandboxProvider — abstraction over sandbox runtime backends so the Brain's
 * sandbox lifecycle (ensureHands / keepalive / destroy) is decoupled from a
 * single backend.
 *
 *   safe-workload : existing SaFE Workload API path (safe mode).
 *   agent-sandbox : PrimusClaw/Sandbox router API path (kubernetes mode).
 */

export type SandboxProviderKind = "safe-workload" | "agent-sandbox";

/** Inputs for provisioning a sandbox. `env` is already fully composed (incl. BYOK key). */
export interface SandboxCreateParams {
  sessionId: string;
  namespace: string;
  image: string;
  /** Resource map: cpu / memory / gpu / ephemeralStorage. */
  resources: Record<string, string>;
  /** Fully composed env injected into the sandbox (auth token, MCP port, LLM key, ...). */
  env: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSec?: number;
  /** safe-workload: idle TTL (ttlSecondsAfterFinished). Ignored by agent-sandbox. */
  ttlSec?: number;
  /** safe-workload: platform key (bearer) for SaFE workload create/poll/stop. */
  platformKey?: string;
  /** Called once the backend assigns an id, before it becomes ready. Used by the
   *  caller for safe-workload two-phase KV bookkeeping (pending write + rollback). */
  onProvisioned?: (id: string) => Promise<void>;
  /** Provisioning-phase events (safe-workload poll emits Creating/Running/queue). */
  onEvent?: (evt: Record<string, unknown>) => Promise<void>;
  /** safe-workload: pre-built SaFE workload resources array (overrides `resources`
   *  when set), preserving the legacy JSON fallback path. */
  resourcesArray?: Array<Record<string, string | number>>;
  /** kubernetes/BYOK: stable user identity (byok-<fp>) forwarded to the Router
   *  for ownership + audit. Unused by safe-workload. */
  userId?: string;
}

/** Handle to a provisioned sandbox, provider-agnostic. */
export interface SandboxInstance {
  provider: SandboxProviderKind;
  /** safe-workload: workloadId; agent-sandbox: sessionId. */
  id: string;
  sandboxName: string;
  namespace: string;
  /** Resolved Hands base URL: safe = svc DNS:port; agent-sandbox = http://<podIP>:9100. */
  handsBaseUrl: string;
  /** safe-workload: platform key used for stop; agent-sandbox: empty. */
  platformKey?: string;
  /** kubernetes/BYOK: user identity forwarded to the Router on get/exec/stop. */
  userId?: string;
}

export interface SandboxStatus {
  running: boolean;
  healthy: boolean;
  podIp?: string;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Milliseconds meant by an `exec` timeout string (`"5s"`, `"10m"`, `"1h"`).
 *
 * That string is the *command's* deadline inside the container. Providers add
 * their own slack on top of it for the HTTP call that carries it, so the
 * transport never gives up before the command it is waiting for could have.
 */
export function parseExecTimeoutMs(timeout: string): number {
  const m = /^(\d+)\s*([smh]?)$/.exec(timeout.trim());
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = m[2] || "s";
  return unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : n * 1_000;
}

/** Slack a provider allows its HTTP call beyond the command's own deadline. */
export const EXEC_TRANSPORT_SLACK_MS = 15_000;

/** Backend-agnostic sandbox runtime operations. */
export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  create(params: SandboxCreateParams): Promise<SandboxInstance>;
  get(inst: SandboxInstance): Promise<SandboxStatus>;
  exec(
    inst: SandboxInstance,
    command: string,
    timeout: string,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult>;
  stop(inst: SandboxInstance): Promise<void>;
}
