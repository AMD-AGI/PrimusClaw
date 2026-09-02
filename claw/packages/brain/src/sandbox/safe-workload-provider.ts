// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SafeWorkloadProvider — safe-mode sandbox backend over the SaFE Workload API.
 * Encapsulates workload create + two-phase-pending hook + poll-until-Running +
 * data-plane exec + stop.
 *
 * Extracted from the original inline ensureHands logic; behavior is intended to
 * be equivalent to the pre-refactor safe path. Two-phase KV pending + rollback
 * stay in the caller (ensureHands) via the `onProvisioned` callback so this
 * provider never touches NATS KV (avoids a circular import with index.ts).
 */

import pino from "pino";
import {
  SAFE_API_URL,
  SANDBOX_DEFAULT_TIMEOUT_SECONDS,
  SANDBOX_NAMESPACE,
  SANDBOX_WORKLOAD_PRIORITY,
  SANDBOX_ROUTER_URL,
  AUTH_INTERNAL_TOKEN,
} from "../config.js";
import { SandboxGoneError, SandboxStopUnavailable } from "./errors.js";
import { resourcesMapToWorkloadArray } from "./params.js";
import { EXEC_TRANSPORT_SLACK_MS, parseExecTimeoutMs } from "./provider.js";
import { sandboxWorkloadName } from "./workload-naming.js";
import { waitForWorkloadReady, type WorkloadWaitDeps } from "./workload-wait.js";
import type {
  SandboxProvider,
  SandboxCreateParams,
  SandboxInstance,
  SandboxStatus,
  SandboxExecResult,
} from "./provider.js";

const logger = pino({ name: "safe-workload-provider" });
const HANDS_MCP_PORT = "9100";

export class SafeWorkloadProvider implements SandboxProvider {
  readonly kind = "safe-workload" as const;

  async create(params: SandboxCreateParams): Promise<SandboxInstance> {
    const ns = params.namespace || SANDBOX_NAMESPACE;
    const apiKey = params.platformKey ?? "";

    const SHUTDOWN_BUFFER_SECONDS = 3600;
    const timeout = params.timeoutSec !== undefined
      ? params.timeoutSec + SHUTDOWN_BUFFER_SECONDS
      : SANDBOX_DEFAULT_TIMEOUT_SECONDS;

    const workloadBody: Record<string, unknown> = {
      displayName: sandboxWorkloadName(),
      groupVersionKind: { kind: "Sandbox", version: "v1" },
      priority: SANDBOX_WORKLOAD_PRIORITY,
      ttlSecondsAfterFinished: params.ttlSec ?? 10,
      workspace: ns,
      labels: params.labels ?? {},
      env: params.env,
      images: [params.image.trim()],
      resources: params.resourcesArray ?? resourcesMapToWorkloadArray(params.resources),
      timeout,
    };

    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(workloadBody),
    });
    if (!resp.ok) {
      const errBody = (await resp.text()).slice(0, 300);
      throw new Error(`Create Hands failed: HTTP ${resp.status} ${errBody}`);
    }
    const result = (await resp.json()) as Record<string, unknown>;
    const workloadId = (result.workloadId as string) || "";
    if (!workloadId) throw new Error(`No workloadId returned: ${JSON.stringify(result)}`);
    logger.info({ workloadId }, "safe-workload.created");

    // Two-phase pending hook: caller records a pending KV entry (+ rollback on
    // failure) before we start polling. If it throws, the workload create is
    // rolled back by the caller and we propagate.
    if (params.onProvisioned) await params.onProvisioned(workloadId);

    // Wait for the workload to become Running. A readable Pending (HTTP 2xx
    // carrying a phase) is a healthy queued state, waited on indefinitely and
    // bounded only by the queue ceiling. The ways the wait ends terminally are
    // documented on waitForWorkloadReady, beside the code that enforces them,
    // rather than listed again here.
    await pollWorkloadUntilRunning(workloadId, apiKey, params.onEvent);

    return {
      provider: "safe-workload",
      id: workloadId,
      sandboxName: workloadId,
      namespace: ns,
      handsBaseUrl: `http://${workloadId}.${ns}.svc.cluster.local:${HANDS_MCP_PORT}`,
      platformKey: apiKey,
    };
  }

  async get(inst: SandboxInstance): Promise<SandboxStatus> {
    try {
      const r = await fetch(`${SAFE_API_URL}/api/v1/workloads/${inst.id}`, {
        headers: { Authorization: `Bearer ${inst.platformKey ?? ""}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return { running: false, healthy: false };
      const info = (await r.json()) as Record<string, unknown>;
      const phase = String(info.phase ?? "").toLowerCase();
      return { running: phase === "running", healthy: phase === "running" };
    } catch {
      return { running: false, healthy: false };
    }
  }

  async exec(
    inst: SandboxInstance,
    command: string,
    timeout: string,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    const ns = inst.namespace?.trim() || SANDBOX_NAMESPACE;
    const routerConfigured = SANDBOX_ROUTER_URL.trim();
    const execBase = routerConfigured ? routerConfigured.replace(/\/+$/, "") : `${SAFE_API_URL}/sandbox`;
    const url = `${execBase}/v1/namespaces/${ns}/code-interpreters/${inst.id}/invocations/api/execute`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-session-id": inst.id,
      Authorization: `Bearer ${inst.platformKey ?? ""}`,
    };
    const internalToken = AUTH_INTERNAL_TOKEN.trim();
    if (internalToken) headers["X-Internal-Token"] = internalToken;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: ["sh", "-c", command], timeout }),
      // `timeout` is only the command's deadline inside the container; it says
      // nothing about a Router that accepts the connection and then goes quiet.
      // Without a cap here that fetch inherits undici's 5-minute header
      // timeout, and every caller awaiting an exec waits it out -- including
      // the container probe, which runs on the tool-batch path precisely when
      // the control plane is least likely to answer.
      signal: signal
        ? AbortSignal.any([
          signal,
          AbortSignal.timeout(parseExecTimeoutMs(timeout) + EXEC_TRANSPORT_SLACK_MS),
        ])
        : AbortSignal.timeout(parseExecTimeoutMs(timeout) + EXEC_TRANSPORT_SLACK_MS),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      // A 404/410 is not a failed ping, it is an answer: the workload is gone.
      // Collapsing it into the same untyped Error as a timeout made a definite
      // absence spend the same five keepalive strikes as one dropped packet --
      // five minutes to notice something the first reply already settled.
      const msg = `sandboxExec failed: HTTP ${resp.status} ${errBody.slice(0, 300)}`;
      // The message is deliberately identical for both branches: the container
      // classifier reads this string to decide a gone container licenses a
      // rebuild, so rewording it here silently downgraded a definite 404 to
      // "unreachable". The type is added alongside the message, not instead of
      // it -- one reader parses the text, the other tests the flag.
      if (resp.status === 404 || resp.status === 410) throw new SandboxGoneError(msg);
      throw new Error(msg);
    }
    const result = (await resp.json()) as Record<string, unknown>;
    return {
      exitCode: (result.exit_code as number) ?? (result.exitCode as number) ?? -1,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  }

  async stop(inst: SandboxInstance): Promise<void> {
    if (!inst.id || !inst.platformKey || !SAFE_API_URL) {
      if (inst.id) logger.warn({ workloadId: inst.id }, "safe-workload.stop_skipped_no_key");
      // Unavailable, not failed: nothing here becomes true on a retry. See
      // SandboxStopUnavailable for why teardown must not refuse forever on it.
      throw new SandboxStopUnavailable(
        "safe-workload stop requires workload id, platform key, and API URL",
      );
    }
    try {
      const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${inst.id}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${inst.platformKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if ([200, 202, 204, 404].includes(resp.status)) {
        logger.info({ workloadId: inst.id, status: resp.status }, "safe-workload.stopped");
      } else {
        const body = await resp.text().catch(() => "");
        logger.warn({ workloadId: inst.id, status: resp.status, body: body.slice(0, 300) }, "safe-workload.stop_unexpected");
        throw new Error(`safe-workload stop failed: HTTP ${resp.status}`);
      }
    } catch (e) {
      logger.warn({ err: String(e), workloadId: inst.id }, "safe-workload.stop_failed");
      throw e;
    }
  }

}

/** Injectable dependencies for pollWorkloadUntilRunning, defaulted to the real
 *  runtime. Exposed so the poll loop's reset rules and deadline are unit-tested
 *  with a scripted fetch sequence and a controllable clock (no real waiting). */
export type PollDeps = WorkloadWaitDeps;

/** Wait for a sandbox workload to reach Running.
 *
 *  The rules live in waitForWorkloadReady, shared with the multi-node provider so
 *  the two cannot drift again; this only says what ready means for a sandbox
 *  (the phase, and nothing beyond it) and translates the loop's states into the
 *  event shape this path's consumers already parse.
 *
 *  Nothing is done to the workload when the wait is given up: a sandbox that
 *  never came up is left to the reaper, which is where its lifecycle already
 *  lived. */
export async function pollWorkloadUntilRunning(
  workloadId: string,
  apiKey: string,
  onEvent?: (evt: Record<string, unknown>) => Promise<void>,
  deps?: PollDeps,
): Promise<void> {
  await onEvent?.({ type: "sandboxStatus", event: "phase", phase: "Creating", status: "creating", log: "" });

  await waitForWorkloadReady({
    workloadId,
    apiKey,
    logPrefix: "hands",
    isReady: (detail) => String(detail.phase ?? "").toLowerCase() === "running",
    onReady: async ({ queuePosition }) => {
      await onEvent?.({ type: "sandboxStatus", event: "phase", phase: "Running", status: "running", queuePosition });
    },
    onTerminal: async ({ phase, status, reason }) => {
      await onEvent?.({ type: "sandboxStatus", event: "phase", phase, status, reason });
    },
    onProgress: async ({ phase, queuePosition }) => {
      await onEvent?.({
        type: "sandboxStatus",
        event: "phase",
        phase: phase || "Pending",
        status: "pending",
        queuePosition,
        log: `Waiting in queue (position ${queuePosition})`,
      });
    },
    deps,
  });
}

export const __test__ = { pollWorkloadUntilRunning };
