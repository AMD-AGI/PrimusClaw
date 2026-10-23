// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";

import type { ExecuteRequest } from "@claw/protocol";

export interface SandboxGrantEnv {
  appRunId: string;
  values: Record<string, string>;
}

interface GrantResponse {
  env?: unknown;
  action?: string;
  reason?: string;
}

/** Issue or reuse the grant whose keys are injected into one Hands sandbox. */
export async function openSandboxGrant(
  sessionId: string,
  request: ExecuteRequest,
  image: string,
  platformKey: string,
): Promise<SandboxGrantEnv> {
  const base = (process.env.INTERNAL_BACKEND_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.AUTH_INTERNAL_TOKEN ?? "").trim();
  const workspace = request.workspace_id?.trim() ?? "";
  if (!base || !token || !workspace || !platformKey) {
    throw new Error(
      "sandbox grant requires INTERNAL_BACKEND_URL, AUTH_INTERNAL_TOKEN, workspace_id, and platform key",
    );
  }

  const appRunId = `ar-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
  const response = await fetch(
    `${base}/v1/internal/app-runs/${encodeURIComponent(appRunId)}/grant`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(grantDocument(sessionId, request, image, platformKey, workspace)),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as GrantResponse;
  if (!response.ok) {
    throw new Error(`sandbox grant request failed: ${response.status}`);
  }
  if (!payload.env || typeof payload.env !== "object") {
    throw new Error("sandbox grant response has no environment");
  }
  const values = Object.fromEntries(
    Object.entries(payload.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1] !== ""),
  );
  if (!values.E2B_API_URL || !values.E2B_SANDBOX_URL || !values.HYPERLOOM_SANDBOX_KEY_MEASUREMENT) {
    throw new Error("sandbox grant response is missing E2B access variables");
  }
  return { appRunId, values };
}

/**
 * Grant request for one Claw-started sandbox.
 * input is the application's own document. resources.grant is the child-sandbox budget.
 */
function grantDocument(
  sessionId: string,
  request: ExecuteRequest,
  image: string,
  platformKey: string,
  workspace: string,
): Record<string, unknown> {
  const userId = request.user_id?.trim() || "default";
  const given = request.resources?.grant;
  return {
    userId,
    workspaces: [workspace],
    platformKey,
    sessionId,
    input: requestInput(request),
    resources: {
      image,
      workspace,
      cpu: textField(request.resources?.cpu),
      memory: textField(request.resources?.memory),
      gpus: countField(request.resources?.gpus ?? request.resources?.gpu),
      grant: isGrant(given) ? given : defaultGrant(),
      templates: roleTemplates(image),
    },
  };
}

/** Child-sandbox budget used when the caller does not send resources.grant. */
function defaultGrant(): Record<string, unknown> {
  return {
    roles: {
      measurement: { max_sandboxes: 1, max_gpus: 8 },
      subrun: { max_sandboxes: 1, max_gpus: 1 },
      dev: { max_sandboxes: 1, max_gpus: 8 },
    },
  };
}

function roleTemplates(image: string): unknown[] {
  const spec = { template: { fromImage: image } };
  return [
    { name: "measurement", perGpuCount: [1, 2, 4, 8], spec, roles: ["measurement"] },
    { name: "subrun", perGpuCount: [1], spec, roles: ["subrun"] },
    { name: "dev", perGpuCount: [1, 2, 4, 8], spec, roles: ["dev"] },
  ];
}

function requestInput(request: ExecuteRequest): unknown {
  const extra = request as ExecuteRequest & { input?: unknown };
  return extra.input ?? {};
}

function isGrant(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function countField(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface SandboxGrantDecision {
  restart: boolean;
  reason?: string;
}

/**
 * Takeover check for a Claw-created sandbox.
 * An ended sandbox is not restarted. Only a missing execution copy restarts it.
 */
export async function reconcileSandboxGrant(
  sessionId: string,
  request: ExecuteRequest,
  image: string,
  platformKey: string,
  runEnded: boolean,
): Promise<SandboxGrantDecision> {
  if (runEnded) return { restart: false, reason: "run_ended" };
  const base = (process.env.INTERNAL_BACKEND_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.AUTH_INTERNAL_TOKEN ?? "").trim();
  const workspace = request.workspace_id?.trim() ?? "";
  if (!base || !token || !workspace || !platformKey) {
    return { restart: false, reason: "copy_unavailable" };
  }
  const appRunId = `ar-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
  try {
    const response = await fetch(
      `${base}/v1/internal/app-runs/${encodeURIComponent(appRunId)}/grant/reconcile`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...grantDocument(sessionId, request, image, platformKey, workspace),
          runEnded: false,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = await response.json().catch(() => ({})) as GrantResponse;
    if (!response.ok) return { restart: false, reason: "copy_unavailable" };
    return { restart: payload.action === "reissued", reason: payload.reason };
  } catch {
    return { restart: false, reason: "copy_unavailable" };
  }
}
