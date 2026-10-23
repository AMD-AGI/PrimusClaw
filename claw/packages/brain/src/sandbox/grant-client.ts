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
      body: JSON.stringify({
        userId: request.user_id?.trim() || "default",
        workspaces: [workspace],
        platformKey,
        sessionId,
        demand: {
          placement: { max_parallel_tests: 1 },
          hardware: { tp: 1 },
        },
        templates: [{
          name: "gpu",
          perGpuCount: [1],
          spec: { template: { fromImage: image } },
          roles: ["measurement"],
        }],
      }),
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
