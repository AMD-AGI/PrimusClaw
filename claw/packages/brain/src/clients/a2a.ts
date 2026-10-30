// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";

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
// Peer registry
//
// `a2a_call` reaches only the peers an operator named in A2A_AGENTS. The model
// picks a name; it never supplies a URL, and it never supplies or receives a
// credential. Whatever Authorization a peer gets comes from that peer's own
// entry (`auth_env`), read inside this process; with no `auth_env` nothing is
// sent. The user's LLM key and the platform key are never sent to a peer.
//
// A2A_AGENTS takes either form:
//   name=url,name=url                                  (no credential)
//   [{"name":"ci","url":"https://ci.example.com",
//     "auth_env":"A2A_PEER_TOKEN_CI","allow_local":false}]
//
// `auth_env` must name a variable that starts with A2A_PEER_TOKEN_. The model cannot
// choose it, but an operator's entry could otherwise point at a deployment-wide secret
// (ANTHROPIC_API_KEY, the platform key) and send it to a peer. An entry that names any
// other variable is refused when the registry loads, with a message saying why.
// ---------------------------------------------------------------------------
export interface A2APeer {
  name: string;
  /** Base URL without a trailing slash. */
  url: string;
  /** Name of the env var holding this peer's own bearer token. Unset: no Authorization header. */
  authEnv?: string;
  /** Operator's explicit exception to the loopback / link-local refusal below. */
  allowLocal: boolean;
}

const agentRegistry = new Map<string, A2APeer>();

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The only variables a peer entry may read its token from: ones set aside for peers. */
export const A2A_PEER_TOKEN_PREFIX = "A2A_PEER_TOKEN_";

function toPeer(name: unknown, url: unknown, authEnv: unknown, allowLocal: unknown): A2APeer {
  if (typeof name !== "string" || !PEER_NAME.test(name)) throw new Error(`invalid peer name ${JSON.stringify(name)}`);
  let parsed: URL;
  try { parsed = new URL(String(url)); } catch { throw new Error(`peer "${name}": url is not a URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`peer "${name}": url must be http(s)`);
  if (parsed.username || parsed.password) throw new Error(`peer "${name}": url must not embed credentials (use auth_env)`);
  if (authEnv !== undefined && (typeof authEnv !== "string" || !ENV_NAME.test(authEnv))) {
    throw new Error(`peer "${name}": auth_env must be an environment variable name`);
  }
  if (typeof authEnv === "string" && !authEnv.startsWith(A2A_PEER_TOKEN_PREFIX)) {
    throw new Error(
      `peer "${name}": auth_env ${authEnv} is refused; it must name a variable that starts with `
      + `${A2A_PEER_TOKEN_PREFIX} (for example ${A2A_PEER_TOKEN_PREFIX}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}), `
      + "so a peer can only ever be sent a token set aside for peers, never a deployment-wide secret",
    );
  }
  if (allowLocal !== undefined && typeof allowLocal !== "boolean") throw new Error(`peer "${name}": allow_local must be a boolean`);
  return { name, url: String(url).replace(/\/$/, ""), authEnv: authEnv as string | undefined, allowLocal: allowLocal === true };
}

/** Parses A2A_AGENTS. A bad entry is dropped and reported, never half-applied. */
export function parseA2AAgents(raw: string): { peers: A2APeer[]; errors: string[] } {
  const peers: A2APeer[] = [];
  const errors: string[] = [];
  const text = raw.trim();
  if (!text) return { peers, errors };
  const add = (make: () => A2APeer) => {
    try { peers.push(make()); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  };
  if (text.startsWith("[")) {
    let list: unknown;
    try { list = JSON.parse(text); } catch { return { peers, errors: ["A2A_AGENTS is not valid JSON"] }; }
    if (!Array.isArray(list)) return { peers, errors: ["A2A_AGENTS JSON must be an array of peers"] };
    for (const e of list as Array<Record<string, unknown> | null>) {
      add(() => toPeer(e?.name, e?.url, e?.auth_env ?? undefined, e?.allow_local ?? undefined));
    }
  } else {
    for (const entry of text.split(",")) {
      const eq = entry.indexOf("=");
      if (eq < 0) { if (entry.trim()) errors.push(`entry ${JSON.stringify(entry.trim())} is not name=url`); continue; }
      add(() => toPeer(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim(), undefined, undefined));
    }
  }
  return { peers, errors };
}

export function initA2ARegistry(raw: string | undefined = process.env.A2A_AGENTS): void {
  agentRegistry.clear();
  const { peers, errors } = parseA2AAgents(raw ?? "");
  for (const e of errors) logger.error({ reason: e }, "a2a.registry.entry_refused");
  for (const peer of peers) {
    agentRegistry.set(peer.name, peer);
    logger.info(
      { agent: peer.name, url: peer.url, auth: Boolean(peer.authEnv), allowLocal: peer.allowLocal },
      "a2a.registry.add",
    );
  }
}

export function resolvePeer(name: string): A2APeer {
  const peer = agentRegistry.get(name);
  if (peer) return peer;
  const available = Array.from(agentRegistry.keys()).join(", ") || "(none configured: an operator sets A2A_AGENTS)";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    throw new Error(`a2a_call takes the name of a configured peer, not a URL. Available: ${available}`);
  }
  throw new Error(`Unknown agent "${name}". Available: ${available}`);
}

/** The peer's own credential, or none. A declared but empty one is an error, never a silent downgrade. */
function peerBearer(peer: A2APeer): string | undefined {
  if (!peer.authEnv) return undefined;
  const token = process.env[peer.authEnv]?.trim();
  if (!token) throw new Error(`peer "${peer.name}" names auth_env ${peer.authEnv}, which is empty here; not calling it unauthenticated`);
  return token;
}

// ---------------------------------------------------------------------------
// Where a peer may be: not loopback, link-local (cloud metadata) or unspecified
// unless its entry says allow_local. The address actually connected to is the
// one checked (the lookup runs at connect time), so a name cannot resolve one
// way for the check and another for the request. Private ranges stay allowed:
// an in-cluster peer lives there, and the operator named it.
// ---------------------------------------------------------------------------
const LOCAL_ADDRESSES = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16]] as const) {
  LOCAL_ADDRESSES.addSubnet(net, prefix, "ipv4"); // also matches ::ffff:a.b.c.d
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fe80::", 10],
  // NAT64 embeds an IPv4 address in the address (RFC 6052). Both registered prefixes are decoded:
  // the well-known 64:ff9b::/96 carries it in the low 32 bits, the local-use 64:ff9b:1::/48
  // (RFC 8215) in bits 48-63 and 72-87. An operator's own network-specific prefix cannot be
  // told from any other IPv6 address, so it is judged as the IPv6 address it is.
  ["64:ff9b::", 104], ["64:ff9b::7f00:0", 104], ["64:ff9b::a9fe:0", 112],
  ["64:ff9b:1::", 56], ["64:ff9b:1:7f00::", 56], ["64:ff9b:1:a9fe::", 64],
] as const) LOCAL_ADDRESSES.addSubnet(net, prefix, "ipv6");

export function isLocalAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && LOCAL_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function localRefusal(address: string): Error {
  return new Error(
    `peer address ${address} is loopback or link-local; refused unless its A2A_AGENTS entry sets allow_local`,
  );
}

const GUARDED_AGENT = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const bad = addresses.find((a) => isLocalAddress(a.address));
        if (bad) return callback(localRefusal(bad.address), "", 4);
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});
const OPEN_AGENT = new Agent();

type PeerResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * Every request to a peer goes through here. IP literals never reach the lookup
 * above, so they are judged first. Redirects are refused: a peer that answers 3xx
 * could otherwise send the request, body and all, somewhere the registry never named.
 */
function peerFetch(peer: A2APeer, url: string, init: Parameters<typeof undiciFetch>[1]): Promise<PeerResponse> {
  if (!peer.allowLocal) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isLocalAddress(host)) return Promise.reject(localRefusal(host));
  }
  return undiciFetch(url, {
    ...init,
    redirect: "error",
    dispatcher: peer.allowLocal ? OPEN_AGENT : GUARDED_AGENT,
  });
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
  peer: A2APeer,
  method: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const url = rpcEndpoint(peer.url);
  const id = rpcIdCounter++;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const headers: Record<string, string> = { "Content-Type": "application/json", "A2A-Version": A2A_VERSION };
  const bearer = peerBearer(peer);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await peerFetch(peer, url, {
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
export async function discoverAgent(peer: A2APeer): Promise<AgentCard> {
  const base = peer.url.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/agent-card.json`,
    `${base}/.well-known/agent.json`,
  ];
  const bearer = peerBearer(peer);
  let lastErr: string = "";
  for (const url of candidates) {
    const res = await peerFetch(peer, url, {
      headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
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
  peer: A2APeer,
  text: string,
  opts?: { contextId?: string; taskId?: string; returnImmediately?: boolean; metadata?: Record<string, unknown> },
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

  const result = (await rpcCall(peer, "SendMessage", params)) as { task?: Task };
  if (!result.task) throw new Error("SendMessage did not return a task");
  return result.task;
}

// ---------------------------------------------------------------------------
// SendStreamingMessage — JSON-RPC SSE
// ---------------------------------------------------------------------------
export async function sendStreamingMessage(
  peer: A2APeer,
  text: string,
  opts?: { contextId?: string; taskId?: string; timeoutMs?: number; metadata?: Record<string, unknown> },
): Promise<string> {
  const url = rpcEndpoint(peer.url);
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
  const bearer = peerBearer(peer);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await peerFetch(peer, url, {
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
async function consumeSSEStream(res: PeerResponse): Promise<string> {
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
export async function handleA2ACall(input: Record<string, unknown>): Promise<string> {
  const agent = input.agent as string;
  const message = input.message as string;
  const mode = (input.mode as string) || "stream";
  const metadata = (input.metadata as Record<string, unknown>) || undefined;
  const taskId = (input.task_id as string) || undefined;

  if (!agent) return "Error: 'agent' is required";
  if (!message) return "Error: 'message' is required";

  try {
    const peer = resolvePeer(agent);

    if (mode === "discover") {
      const card = await discoverAgent(peer);
      return JSON.stringify(card, null, 2);
    }

    if (mode === "fire_and_forget") {
      const task = await sendMessage(peer, message, { returnImmediately: true, metadata, taskId });
      return `Task created: ${task.id} (state: ${task.status.state})`;
    }

    // Default: streaming
    return await sendStreamingMessage(peer, message, { metadata, taskId });
  } catch (err: unknown) {
    const msg = describeError(err);
    logger.error({ agent, err: msg }, "a2a_call failed");
    return `A2A call to "${agent}" failed: ${msg}`;
  }
}

/** fetch reports every transport failure as "fetch failed"; the reason is on `cause`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return cause && !err.message.includes(cause) ? `${err.message}: ${cause}` : err.message;
}
