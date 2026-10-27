// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session-level MCP of a hosted application (hosting design 5.8).
 *
 * A manifest that declares `mcp` names a port, a path and the header its MCP
 * token travels in. While the run is up, the AppRunner builds the sandbox
 * Router's port-proxy URL for that port, sends `initialize` with the run's MCP
 * token, and once the application answers records the URL and the sandbox's
 * session id for the run's session (API `claw_session_app_mcp`). The API puts it
 * into every later turn's `mcp_servers`, building the config then; nothing that
 * is a credential is stored with the record. The record goes when the run ends.
 *
 * Nothing here knows what the application is: the port, path and header are
 * the manifest's.
 */
import pino from "pino";
import type { AppMcp } from "@claw/protocol";
import { SANDBOX_NAMESPACE, SANDBOX_ROUTER_AUTH_ENABLED } from "../config.js";
import { routerBaseForPortProxy } from "../sandbox/sandbox-router.js";
import type { AppRunContext, AppRunnerSeams } from "./app-runner.js";

const logger = pino({ name: "app-mcp" });

const PROBE_TIMEOUT_MS = 3_000;

/** `{routerBase}/v1/namespaces/{ns}/code-interpreters/{workload}/invocations/proxy/{port}{path}` */
export function appMcpUrl(
  routerBase: string, namespace: string, workloadId: string, mcp: Pick<AppMcp, "port" | "path">,
): string {
  return `${routerBase.replace(/\/+$/, "")}/v1/namespaces/${encodeURIComponent(namespace)}`
    + `/code-interpreters/${encodeURIComponent(workloadId)}/invocations/proxy/${mcp.port}${mcp.path}`;
}

export type McpProbeVerdict =
  | { kind: "ok" }
  | { kind: "auth_failed"; status: number }
  | { kind: "unreachable"; detail: string }
  | { kind: "bad_response"; detail: string };

export interface McpProbeInput {
  url: string;
  tokenHeader: string;
  token: string;
  sandboxSessionId: string;
  /** The `Authorization` bearer: the platform key with Router auth on, else the MCP token. */
  bearer: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Same headers the dispatched config produces (the API adds `Authorization` from `token`). */
export function mcpRequestHeaders(i: Pick<McpProbeInput, "tokenHeader" | "token" | "sandboxSessionId" | "bearer">): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${i.bearer}`,
    [i.tokenHeader]: i.token,
    "x-session-id": i.sandboxSessionId,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claw-app-runner", version: "1" } },
};

/** The JSON-RPC message in a JSON or a one-event SSE body, or null. */
function rpcMessage(contentType: string, text: string): any {
  try {
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
      }
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Never puts a token or a response body into the verdict. */
export async function probeAppMcp(i: McpProbeInput): Promise<McpProbeVerdict> {
  const doFetch = i.fetch ?? globalThis.fetch;
  let resp: Response;
  try {
    resp = await doFetch(i.url, {
      method: "POST",
      headers: mcpRequestHeaders(i),
      body: JSON.stringify(INITIALIZE),
      signal: AbortSignal.timeout(i.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "unreachable", detail: (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name ?? "error" };
  }
  if (resp.status === 401 || resp.status === 403) return { kind: "auth_failed", status: resp.status };
  // The Router answers 502/503/504 when nothing listens on the port yet.
  if (resp.status === 404 || resp.status >= 500) return { kind: "unreachable", detail: `status ${resp.status}` };
  if (resp.status < 200 || resp.status >= 300) return { kind: "bad_response", detail: `status ${resp.status}` };
  const msg = rpcMessage(resp.headers.get("content-type") ?? "", await resp.text().catch(() => ""));
  if (!msg || typeof msg !== "object" || msg.error !== undefined || typeof msg.result !== "object" || msg.result === null) {
    return { kind: "bad_response", detail: "not an initialize result" };
  }
  return { kind: "ok" };
}

export interface AppMcpSeamDeps {
  routerBase?: () => string | null;
  namespace?: string;
  routerAuth?: () => boolean;
  fetch?: typeof globalThis.fetch;
  probeTimeoutMs?: number;
}

/**
 * `registerMcp` and `unregisterMcp` for {@link AppRunnerSeams}. Registered once
 * per (run, sandbox): a lost sandbox is a new id and registers again; a Brain
 * that takes the run over has no memory of it and registers again, which the
 * API's upsert makes harmless.
 */
export function appMcpSeams(deps: AppMcpSeamDeps = {}): Pick<AppRunnerSeams, "registerMcp" | "unregisterMcp"> {
  const registered = new Map<string, string>();
  const lastFailure = new Map<string, string>();
  const routerBase = deps.routerBase ?? routerBaseForPortProxy;
  const routerAuth = deps.routerAuth ?? (() => SANDBOX_ROUTER_AUTH_ENABLED);

  return {
    async registerMcp(ctx: AppRunContext): Promise<void> {
      const mcp = ctx.record.manifest.mcp;
      const workloadId = ctx.record.sandbox_workload_id;
      if (!mcp || !ctx.instance || !workloadId) return;
      const runId = ctx.record.run_id;
      if (registered.get(runId) === workloadId) return;
      const base = routerBase();
      if (!base) {
        logger.warn({ runId }, "app_mcp.no_router_base");
        return;
      }
      const url = appMcpUrl(base, ctx.instance.namespace?.trim() || deps.namespace || SANDBOX_NAMESPACE, workloadId, mcp);
      const { mcp_token: token } = await ctx.store.secrets(runId);
      const verdict = await probeAppMcp({
        url, token, tokenHeader: mcp.token_header, sandboxSessionId: workloadId,
        bearer: routerAuth() ? ctx.platformKey : token,
        fetch: deps.fetch, timeoutMs: deps.probeTimeoutMs,
      });
      if (verdict.kind !== "ok") {
        // Once per change, not once per tick: the application is expected to be starting.
        const note = JSON.stringify(verdict);
        if (lastFailure.get(runId) !== note) {
          lastFailure.set(runId, note);
          logger.warn({ runId, verdict }, "app_mcp.probe_failed");
        }
        return;
      }
      await ctx.store.putMcp(runId, { url, sandbox_session_id: workloadId });
      registered.set(runId, workloadId);
      lastFailure.delete(runId);
      logger.info({ runId }, "app_mcp.registered");
    },

    async unregisterMcp(ctx: AppRunContext): Promise<void> {
      if (!ctx.record.manifest.mcp) return;
      await ctx.store.deleteMcp(ctx.record.run_id);
      registered.delete(ctx.record.run_id);
      lastFailure.delete(ctx.record.run_id);
    },
  };
}
