// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Client for the Agent Sandbox grant admin API.
 * The caller token is the Claw API service-account token.
 */
import { readFileSync } from "node:fs";

export class GrantClientError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "GrantClientError";
  }
}

export interface GrantTemplateBody {
  name: string;
  perGpuCount?: number[];
  spec?: unknown;
}

export interface IssueGrantBody {
  grantId: string;
  owner: { userId: string; userName: string; workspaces: string[] };
  platformKey: string;
  issuer: { sessionId: string; appRunId: string };
  roles: Record<string, { templates: string[]; maxSandboxes: number; maxGpus: number }>;
  templates: GrantTemplateBody[];
  gpuHoursBudget: number;
  maxSandboxSeconds: number;
  expiresAt: string;
  attestation: string;
}

export interface IssueGrantResult {
  grantId: string;
  keys?: Record<string, string>;
  status: number;
}

export interface GrantCaller {
  issue(body: IssueGrantBody): Promise<IssueGrantResult>;
  extend(grantId: string, body: { expiresAt: string; attestation: string }): Promise<void>;
  revoke(grantId: string): Promise<void>;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

/** Build a caller from SANDBOX_GRANT_URL and the service-account token. */
export function grantCallerFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn: FetchFn = defaultFetch): GrantCaller {
  const base = (env.SANDBOX_GRANT_URL || "").replace(/\/$/, "");
  if (!base) throw new GrantClientError(503, "grant_unavailable", "SANDBOX_GRANT_URL is not configured");
  const token = callerToken(env);
  const call = (method: string, path: string, body?: unknown) =>
    request(fetchFn, base + path, method, token, body);
  return {
    async issue(body) {
      const res = await call("POST", "/internal/v1/grants", body);
      const keys = res.body && typeof res.body === "object"
        ? (res.body as { keys?: Record<string, string> }).keys
        : undefined;
      return { grantId: body.grantId, keys, status: res.status };
    },
    async extend(grantId, body) {
      await call("PATCH", `/internal/v1/grants/${encodeURIComponent(grantId)}`, body);
    },
    async revoke(grantId) {
      await call("DELETE", `/internal/v1/grants/${encodeURIComponent(grantId)}`);
    },
  };
}

function callerToken(env: NodeJS.ProcessEnv): string {
  const inline = env.SANDBOX_GRANT_TOKEN?.trim();
  if (inline) return inline;
  const path = env.SANDBOX_GRANT_TOKEN_FILE?.trim()
    || "/var/run/secrets/kubernetes.io/serviceaccount/token";
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  } catch {
    // The file is absent outside the cluster. The error below names that.
  }
  throw new GrantClientError(503, "caller_token_missing", "grant caller token is not configured");
}

async function request(
  fetchFn: FetchFn,
  url: string,
  method: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (res.status >= 400) {
    const rec = parsed && typeof parsed === "object" ? parsed as { reason?: string; message?: string } : {};
    throw new GrantClientError(res.status, rec.reason || "grant_request_failed", rec.message || `grant request failed: ${res.status}`);
  }
  return { status: res.status, body: parsed };
}

async function defaultFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
}
