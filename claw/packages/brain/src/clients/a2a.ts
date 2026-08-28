// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";

const logger = pino({ name: "a2a-client" });
const A2A_VERSION = "1.0";

// ---------------------------------------------------------------------------
// A2A v1.0 types — aligned with routes/a2a-types.ts on the server side
// ---------------------------------------------------------------------------

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces?: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
  provider?: { url: string; organization: string };
  capabilities: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  securitySchemes?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId?: string;
  status: { state: string; message?: unknown; timestamp?: string };
  artifacts?: Array<{ artifactId: string; parts: Array<{ text?: string }> }>;
  history?: Array<{ messageId: string; role: string; parts: Array<{ text?: string }> }>;
  metadata?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown[] };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function isErrorResponse(r: JsonRpcResponse): r is JsonRpcErrorResponse {
  return "error" in r;
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------
const agentRegistry = new Map<string, string>();

export function initA2ARegistry(): void {
  const raw = process.env.A2A_AGENTS?.trim();
  if (!raw) return;
  for (const entry of raw.split(",")) {
    const [name, url] = entry.trim().split("=");
    if (name && url) {
      agentRegistry.set(name.trim(), url.trim().replace(/\/$/, ""));
      logger.info({ agent: name.trim(), url: url.trim() }, "a2a.registry.add");
    }
  }
}

export function resolveAgentUrl(nameOrUrl: string): string {
  if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) return nameOrUrl;
  const url = agentRegistry.get(nameOrUrl);
  if (!url) {
    const available = Array.from(agentRegistry.keys()).join(", ");
    throw new Error(`Unknown agent "${nameOrUrl}". Available: ${available || "(none — set A2A_AGENTS env)"}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Low-level JSON-RPC call
// ---------------------------------------------------------------------------
let rpcIdCounter = 1;

function rpcEndpoint(agentUrl: string): string {
  const base = agentUrl.replace(/\/$/, "");
  return base.endsWith("/a2a") ? base : `${base}/a2a`;
}

async function rpcCall(
  agentUrl: string,
  method: string,
  params: Record<string, unknown>,
  opts?: { bearerToken?: string; timeoutMs?: number },
): Promise<unknown> {
  const url = rpcEndpoint(agentUrl);
  const id = rpcIdCounter++;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const headers: Record<string, string> = { "Content-Type": "application/json", "A2A-Version": A2A_VERSION };
  if (opts?.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
  });

  const json = (await res.json()) as JsonRpcResponse;
  if (isErrorResponse(json)) {
    throw new Error(`A2A RPC error [${json.error.code}]: ${json.error.message}`);
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// Discovery — A2A v1.0 spec §8.2 mandates `/.well-known/agent-card.json`.
// Pre-v1.0 servers expose `/.well-known/agent.json`; we fall back so this
// client can talk to both standard and legacy peers.
// ---------------------------------------------------------------------------
export async function discoverAgent(agentUrl: string): Promise<AgentCard> {
  const base = agentUrl.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/agent-card.json`,
    `${base}/.well-known/agent.json`,
  ];
  let lastErr: string = "";
  for (const url of candidates) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return (await res.json()) as AgentCard;
    lastErr = `${res.status} ${res.statusText}`;
    if (res.status !== 404) break; // only fall back on 404
  }
  throw new Error(`Agent discovery failed: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// SendMessage — JSON-RPC method
// ---------------------------------------------------------------------------
export async function sendMessage(
  agentUrl: string,
  text: string,
  opts?: { contextId?: string; taskId?: string; bearerToken?: string; returnImmediately?: boolean; metadata?: Record<string, unknown> },
): Promise<Task> {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const params: Record<string, unknown> = {
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text }],
      ...(opts?.contextId ? { contextId: opts.contextId } : {}),
      ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    },
    ...(opts?.returnImmediately !== undefined
      ? { configuration: { returnImmediately: opts.returnImmediately } }
      : {}),
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  };

  const result = (await rpcCall(agentUrl, "SendMessage", params, opts)) as { task?: Task };
  if (!result.task) throw new Error("SendMessage did not return a task");
  return result.task;
}

// ---------------------------------------------------------------------------
// SendStreamingMessage — JSON-RPC SSE
// ---------------------------------------------------------------------------
export async function sendStreamingMessage(
  agentUrl: string,
  text: string,
  opts?: { contextId?: string; taskId?: string; bearerToken?: string; timeoutMs?: number; metadata?: Record<string, unknown> },
): Promise<string> {
  const url = rpcEndpoint(agentUrl);
  const id = rpcIdCounter++;
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method: "SendStreamingMessage",
    params: {
      message: {
        messageId,
        role: "ROLE_USER",
        parts: [{ text }],
        ...(opts?.contextId ? { contextId: opts.contextId } : {}),
        ...(opts?.taskId ? { taskId: opts.taskId } : {}),
      },
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "A2A-Version": A2A_VERSION,
  };
  if (opts?.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 600_000),
  });

  if (!res.ok) throw new Error(`SendStreamingMessage failed: ${res.status}`);
  return consumeSSEStream(res);
}

// ---------------------------------------------------------------------------
// SSE stream consumer — shared by streaming methods
// Collects all artifact text parts and returns when terminal status received.
// ---------------------------------------------------------------------------
async function consumeSSEStream(res: Response): Promise<string> {
  const parts: string[] = [];
  const reader = res.body?.getReader();
  if (!reader) return "(no stream body)";

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const rpcResp = JSON.parse(line.slice(6)) as JsonRpcResponse;
        if (isErrorResponse(rpcResp)) {
          parts.push(`[Error: ${rpcResp.error.message}]`);
          reader.cancel();
          return parts.join("\n");
        }

        const result = rpcResp.result as Record<string, unknown>;

        if (result.artifactUpdate) {
          const au = result.artifactUpdate as { artifact?: { parts?: Array<{ text?: string }> } };
          for (const p of au.artifact?.parts ?? []) {
            if (p.text) parts.push(p.text);
          }
        }

        if (result.message) {
          const msg = result.message as { parts?: Array<{ text?: string }> };
          for (const p of msg.parts ?? []) {
            if (p.text) parts.push(p.text);
          }
        }

        if (result.statusUpdate) {
          const su = result.statusUpdate as { status?: { state?: string } };
          const state = su.status?.state || "";
          // Terminal states close the stream per spec §3.1.2.
          // Interrupted states (INPUT_REQUIRED / AUTH_REQUIRED) keep the
          // server stream open waiting for follow-up input — but for a
          // one-shot consumer like Brain, the agent has nothing more to
          // emit until we reply, so we treat them as stop signals and
          // surface what the agent asked for.
          const TERMINAL = [
            "TASK_STATE_COMPLETED",
            "TASK_STATE_FAILED",
            "TASK_STATE_CANCELED",
            "TASK_STATE_REJECTED",
          ];
          const INTERRUPTED = [
            "TASK_STATE_INPUT_REQUIRED",
            "TASK_STATE_AUTH_REQUIRED",
          ];
          if (TERMINAL.includes(state) || INTERRUPTED.includes(state)) {
            reader.cancel();
            if (state !== "TASK_STATE_COMPLETED") parts.push(`[Task ${state}]`);
            return parts.join("\n");
          }
        }
      } catch { /* skip malformed SSE data */ }
    }
  }

  return parts.join("\n") || "(no output from agent)";
}

// ---------------------------------------------------------------------------
// a2a_call tool handler — used by ToolRouter
// ---------------------------------------------------------------------------
export async function handleA2ACall(input: Record<string, unknown>, bearerToken?: string): Promise<string> {
  const agent = input.agent as string;
  const message = input.message as string;
  const mode = (input.mode as string) || "stream";
  const metadata = (input.metadata as Record<string, unknown>) || undefined;
  const taskId = (input.task_id as string) || undefined;
  const token = bearerToken || undefined;

  if (!agent) return "Error: 'agent' is required";
  if (!message) return "Error: 'message' is required";

  try {
    const url = resolveAgentUrl(agent);

    if (mode === "discover") {
      const card = await discoverAgent(url);
      return JSON.stringify(card, null, 2);
    }

    if (mode === "fire_and_forget") {
      const task = await sendMessage(url, message, { returnImmediately: true, metadata, taskId, bearerToken: token });
      return `Task created: ${task.id} (state: ${task.status.state})`;
    }

    // Default: streaming
    return await sendStreamingMessage(url, message, { metadata, taskId, bearerToken: token });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ agent, err: msg }, "a2a_call failed");
    return `A2A call to "${agent}" failed: ${msg}`;
  }
}
