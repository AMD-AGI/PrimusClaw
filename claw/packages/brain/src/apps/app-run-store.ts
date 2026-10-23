// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The AppRunner's persistence: the API's `claw_app_runs` row, over the
 * cluster-internal routes (api `routes/internal-apps.ts`). Brain has no
 * database of its own, so this is also what makes a run takeable by another
 * Brain: everything the runner needs to carry on is in the row.
 */
import type { AppManifestV1, AppSandboxRole, SandboxSpecCreate } from "@claw/protocol";
import { BRAIN_ID } from "../config.js";
import { apiBase, claimHeaders } from "../clients/run-claim.js";

export const APP_RUN_STATES = [
  "provisioning", "starting", "running", "restarting", "finishing", "ended",
] as const;
export type AppRunState = (typeof APP_RUN_STATES)[number];

/** What `exit.json` and the runner's own endings leave on the row. Never a secret. */
export interface AppLastExit {
  /** ISO time of the exit or the decision. */
  at: string;
  cause: "exit" | "sandbox_lost" | "restarts_exhausted" | "start_failed" | "cancelled" | "deadline" | "row_terminal";
  /** `exit.json` `final`, and nothing else decides a restart. */
  final: boolean;
  returncode?: number | null;
  stop_reason?: string;
  error?: string;
  /**
   * The restart budget is spent and the sandbox was lost: one more sandbox is
   * made only to read `exit.json`, because the application may have written
   * `final` just before it went. Nothing is started in it.
   */
  recovery?: boolean;
  /**
   * Finishing: when SIGTERM was sent to the application. Present means the
   * signal went out, so a Brain that takes the run over keeps waiting out the
   * same `stop_grace_sec` instead of signalling again and starting a new wait.
   */
  stop_at?: string;
  /**
   * Finishing steps that are done, by name. Kept on the row so a Brain that
   * takes a finishing run over does not repeat one (the grant is revoked once).
   */
  finish_done?: string[];
}

export interface AppRunRecord {
  run_id: string;
  session_id: string;
  state: AppRunState;
  restarts: number;
  last_exit: AppLastExit | null;
  state_dir: string | null;
  sandbox_workload_id: string | null;
  manifest: AppManifestV1;
  grant_id: string | null;
  grant_limits: Record<string, unknown> | null;
  /** ISO time the grant lapses; null when it has no expiry or none was issued. */
  grant_expires_at: string | null;
  /** ISO time the grant was revoked; set means it is never extended. */
  grant_revoked_at: string | null;
  created_at: string;
  input: Record<string, unknown>;
  sandbox_spec: SandboxSpecCreate | null;
  workspace_id: string | null;
}

export interface AppRunSecrets {
  mcp_token: string;
  grant_keys: Partial<Record<AppSandboxRole, string>> | null;
}

export interface AppRunPatch {
  state?: AppRunState;
  restarts?: number;
  last_exit?: AppLastExit | null;
  state_dir?: string;
  sandbox_workload_id?: string | null;
  grant_expires_at?: string;
}

export interface AppRunStore {
  load(runId: string): Promise<AppRunRecord>;
  /** `expectState` makes the write a compare-and-set on the row's state. */
  patch(runId: string, patch: AppRunPatch, expectState?: AppRunState): Promise<AppRunRecord>;
  secrets(runId: string): Promise<AppRunSecrets>;
}

/** The API refused a write: another worker holds the run, the state moved, or the run ended. */
export class AppRunWriteRefused extends Error {
  constructor(readonly reason: string, readonly currentState?: string) {
    super(`app run write refused: ${reason}`);
    this.name = "AppRunWriteRefused";
  }
  /** The lease moved to another worker: this one must stop touching the run. */
  get superseded(): boolean { return this.reason === "not_holder"; }
}

export interface HttpStoreOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: () => string;
  headers?: () => Record<string, string>;
  brainId?: string;
}

const TIMEOUT_MS = 10_000;

export function httpAppRunStore(opts: HttpStoreOptions = {}): AppRunStore {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl ?? apiBase;
  const headers = opts.headers ?? claimHeaders;
  const brainId = opts.brainId ?? BRAIN_ID;

  const url = (runId: string, suffix = ""): string => {
    const b = base();
    if (!b) throw new Error("app run store: INTERNAL_BACKEND_URL is not configured");
    return `${b}/v1/internal/app-runs/${encodeURIComponent(runId)}${suffix}`;
  };
  const call = async (u: string, init: RequestInit): Promise<{ status: number; body: any }> => {
    const resp = await doFetch(u, { ...init, headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await resp.json().catch(() => null);
    return { status: resp.status, body };
  };
  const fail = (what: string, r: { status: number; body: any }): never => {
    // The status and the API's error code only: never the body wholesale.
    throw new Error(`app run store: ${what} answered ${r.status}${typeof r.body?.error === "string" ? ` ${r.body.error}` : ""}`);
  };

  return {
    async load(runId) {
      const r = await call(url(runId), { method: "GET" });
      if (r.status !== 200 || !r.body?.run) return fail("read", r);
      return r.body.run as AppRunRecord;
    },
    async patch(runId, patch, expectState) {
      const r = await call(url(runId), {
        method: "PATCH",
        body: JSON.stringify({ brain_id: brainId, ...(expectState ? { expect_state: expectState } : {}), ...patch }),
      });
      if (r.status === 200 && r.body?.run) return r.body.run as AppRunRecord;
      if (r.status === 409) throw new AppRunWriteRefused(String(r.body?.error ?? "conflict"), r.body?.current_state);
      return fail("update", r);
    },
    async secrets(runId) {
      const r = await call(url(runId, "/secrets"), { method: "GET" });
      if (r.status !== 200 || typeof r.body?.mcp_token !== "string") return fail("secrets read", r);
      return { mcp_token: r.body.mcp_token, grant_keys: r.body.grant_keys ?? null };
    },
  };
}
