# PrimusClaw Agent Server Design Document

## 1. Overview

PrimusClaw Agent Server provides a **persistent, externally-accessible AI agent service** that exposes both a standard **REST API** (OpenAI-compatible) and an **A2A (Agent-to-Agent) protocol** for programmatic consumption by external systems, orchestration platforms, and other AI agents.

### 1.1 Background

The current PrimusClaw V2 architecture consists of three cooperating services:

| Service | Port | Role |
|---------|------|------|
| **API** | 8200 | HTTP gateway, session/event/memory/skill management, A2A routes |
| **Brain** | 8100 | NATS task consumer, LLM engine execution, sandbox lifecycle |
| **Hands** | 9100 | MCP tool server (file I/O, bash, grep, etc.) |

External callers must today go through the full API → NATS → Brain pipeline, which requires NATS, PostgreSQL, and optionally SaFE sandbox infrastructure. This document describes how to add a **standalone Agent Server mode** that bundles API + Brain + Hands into a single process, accepting HTTP requests directly without NATS or PostgreSQL.

### 1.2 Goals

1. **Standalone mode**: single-process agent server, zero external dependencies (no NATS, no PostgreSQL, no SaFE).
2. **REST API**: OpenAI-compatible `/v1/chat/completions` endpoint (streaming + non-streaming).
3. **A2A protocol**: Google A2A v1.0 (JSON-RPC 2.0 binding) — `GET /.well-known/agent-card.json` for discovery, `POST /a2a` for all RPC methods (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`).
4. **SaFE Gateway compatible**: `/invoke` / `/invoke/:skill` for integration with SaFE A2A Gateway.
5. **Configurable auth**: Bearer token / SaFE platform auth / no auth (dev mode).
6. **Configurable sandbox**: SaFE sandbox isolation / local execution (in-process Hands).
7. **Backward compatible**: existing V2 (API + Brain + Hands via NATS) continues to work unchanged.

### 1.3 Non-Goals

- Replacing the existing NATS-based multi-Brain scaling architecture.
- Supporting multi-user session isolation in standalone mode (single-tenant only).
- Building a new frontend.

---

## 2. Architecture

### 2.1 Deployment Modes

```
┌─────────────────────────────────────────────────────────────────┐
│                    Mode A: Distributed (existing)               │
│                                                                 │
│  ┌──────────┐    NATS    ┌──────────┐    MCP    ┌──────────┐  │
│  │   API    │───────────►│  Brain   │──────────►│  Hands   │  │
│  │  :8200   │            │  :8100   │           │  :9100   │  │
│  └──────────┘            └──────────┘           └──────────┘  │
│       │                       │                      │         │
│       ▼                       ▼                      ▼         │
│   PostgreSQL              NATS KV                 Sandbox      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                 Mode B: Standalone Agent Server                  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  Agent Server :8080                       │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────────────────┐ │  │
│  │  │ HTTP Router  │  │  Engine  │  │  Hands (in-proc /  │ │  │
│  │  │ REST + A2A   │  │ (Claude) │  │  sandbox / local)  │ │  │
│  │  │ + Auth       │  │          │  │                    │ │  │
│  │  └──────┬───────┘  └────┬─────┘  └────────┬───────────┘ │  │
│  │         │               │                  │             │  │
│  │         ▼               ▼                  ▼             │  │
│  │    In-Memory       LLM Gateway       Local filesystem    │  │
│  │    Task Store      (Anthropic/       or SaFE Sandbox     │  │
│  │                     OpenAI)                              │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Breakdown

| Component | Standalone Mode | Distributed Mode |
|-----------|----------------|-----------------|
| **HTTP Server** | Fastify, single port (default 8080) | API :8200 (existing) |
| **Task Queue** | In-memory queue + direct dispatch | NATS JetStream (existing) |
| **Session Store** | In-memory Map | PostgreSQL (existing) |
| **Engine** | Reuse existing `Engine` interface | Same, via NATS |
| **Hands (tools)** | In-process MCP or local Hands subprocess | SaFE Sandbox (existing) |
| **Auth** | Configurable (Bearer / SaFE / none) | SaFE middleware (existing) |
| **Event Streaming** | Direct SSE pipe | NATS pub/sub → SSE (existing) |

---

## 3. External API Specification

### 3.1 REST API (OpenAI-Compatible)

#### `POST /v1/chat/completions`

Standard OpenAI chat completions format with agent execution.

**Request:**

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    { "role": "system", "content": "You are a helpful coding assistant." },
    { "role": "user", "content": "Write a Python function to sort a list." }
  ],
  "stream": true,
  "max_turns": 50,
  "tools_enabled": true,
  "skills": ["code-generation"],
  "workspace_path": "/workspace"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | LLM model name (default: `DEFAULT_MODEL` env) |
| `messages` | array | Yes | OpenAI-format message array |
| `stream` | boolean | No | Enable SSE streaming (default: `false`) |
| `max_turns` | integer | No | Agent loop turn budget (default: `MAX_TURNS` env) |
| `tools_enabled` | boolean | No | Enable tool use / Hands (default: `true`) |
| `skills` | string[] | No | Skill IDs to activate |
| `workspace_path` | string | No | Override workspace root for tools |

**Response (non-streaming):**

```json
{
  "id": "task-abc123",
  "object": "chat.completion",
  "model": "claude-sonnet-4-6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Here's a Python function..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 320,
    "total_tokens": 470
  },
  "agent_metadata": {
    "turns": 3,
    "tool_calls": 2,
    "elapsed_ms": 12500,
    "skills_used": { "code-generation": 1 }
  }
}
```

**Response (streaming):**

SSE stream with `data: {...}` lines following the OpenAI streaming format:

```
data: {"id":"task-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Here"},"finish_reason":null}]}

data: {"id":"task-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"'s a"},"finish_reason":null}]}

data: {"id":"task-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...},"agent_metadata":{...}}

data: [DONE]
```

Agent-specific events are interleaved as custom SSE events:

```
event: agent.tool_use
data: {"tool":"bash","status":"running","input":{"command":"python3 sort.py"}}

event: agent.tool_result
data: {"tool":"bash","status":"success","output":"[1, 2, 3, 4, 5]"}

event: agent.status
data: {"status":"running","turn":2,"total_turns":50}
```

#### `GET /v1/models`

List available models.

```json
{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-4-6", "object": "model", "owned_by": "anthropic" },
    { "id": "claude-opus-4-6", "object": "model", "owned_by": "anthropic" }
  ]
}
```

#### `GET /health`

```json
{
  "status": "ok",
  "service": "primus-claw-agent-server",
  "version": "2.0.0",
  "mode": "standalone",
  "engine": "claude",
  "tools": ["bash", "read", "write", "edit", "grep", "glob", "ls", "multi-edit", "notebook-edit", "upload-s3", "download-s3"]
}
```

#### `GET /metrics`

Prometheus-format metrics endpoint.

---

### 3.2 A2A Protocol (Google A2A v1.0)

Implements [Google A2A v1.0](https://a2aproject.github.io/A2A/latest/specification) with the **JSON-RPC 2.0 binding**. The legacy RESTful surface (`/a2a/tasks/send`, `/a2a/tasks/:id/stream`) was removed in the A2A v1.0 migration; clients must migrate to the JSON-RPC endpoint below.

Type definitions live in `claw/packages/api/src/routes/a2a-types.ts` (canonical, follows spec section numbering).

#### Transport summary

| Surface | Path | Purpose |
|---|---|---|
| Agent Card (v1.0) | `GET /.well-known/agent-card.json` | Canonical discovery (spec §8.2) |
| Agent Card (legacy) | `GET /.well-known/agent.json` | Pre-v1.0 fallback (kept for older SaFE scanners) |
| JSON-RPC | `POST /a2a` | Single endpoint for all RPC methods |
| Health | `GET /a2a/health` | K8s probe |
| Legacy invoke | `POST /invoke[/:skill]` | SaFE Gateway backward-compat |

`/a2a/*` is authenticated by `authMiddleware` like the rest of the API. Only agent discovery (`/.well-known/agent-card.json` and its `/a2a/`-prefixed alias, plus the legacy `agent.json`) and `GET /a2a/health` are anonymous, since A2A discovery is unauthenticated by spec.

> Earlier revisions exempted the `/a2a/` prefix and let caller identity fall back to request-supplied material. Neither was live: the JSON-RPC route is `POST /a2a`, which that prefix does not match, so it always authenticated and the fallbacks never ran. But the prefix would have made any route later added under `/a2a/` anonymous by default, and caller identity is the tenant boundary for task reads — see "Caller identity" below.

#### `A2A-Version` header

Every JSON-RPC request **must** carry `A2A-Version: 1.0` (or `?A2A-Version=1.0` query). Missing/mismatching values return a JSON-RPC error with `code = -32009 A2A_VERSION_NOT_SUPPORTED`.

#### Agent Card schema (v1.0)

```json
{
  "name": "PrimusClaw",
  "description": "AI Agent operating system for code generation, debugging, and deployment on AMD infrastructure",
  "version": "2.0.0",
  "provider": { "url": "https://www.amd.com", "organization": "AMD" },
  "supportedInterfaces": [
    { "url": "https://claw.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": false
  },
  "securitySchemes": {
    "bearer": { "httpAuthSecurityScheme": { "scheme": "bearer", "description": "Bearer token authentication" } }
  },
  "securityRequirements": [{ "bearer": [] }],
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    { "id": "code-generation", "name": "Code Generation", "description": "Generate, edit, and refactor code in any language", "tags": ["code", "generation", "refactor"] },
    { "id": "debugging", "name": "Debugging", "description": "Debug code issues with automated root cause analysis", "tags": ["debug", "error", "fix"] },
    { "id": "code-review", "name": "Code Review", "description": "Review code for quality, security, and best practices", "tags": ["review", "security", "quality"] },
    { "id": "optimization", "name": "Performance Optimization", "description": "Optimize code and model inference performance on AMD GPUs", "tags": ["performance", "gpu", "amd"] }
  ]
}
```

The Agent Card public `url` is built from the `CLAW_PUBLIC_URL` env var.

#### JSON-RPC method catalogue

| Method | Streaming? | Status | Notes |
|---|---|---|---|
| `SendMessage` | no | implemented | Blocks until terminal/interrupted state unless `configuration.returnImmediately=true` (default `false` per spec §3.2.2) |
| `SendStreamingMessage` | SSE | implemented | Inline SSE response on the same `POST /a2a` |
| `GetTask` | no | implemented | Caller-scoped |
| `ListTasks` | no | implemented | Keyset pagination via opaque `pageToken` |
| `CancelTask` | no | implemented | NATS `tasks.<id>.cancel` published |
| `SubscribeToTask` | SSE | implemented | Replays current task state then streams events |
| `GetExtendedAgentCard` | no | returns `-32004 UNSUPPORTED_OPERATION` | Not configured |
| `CreateTaskPushNotificationConfig` | — | returns `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` | |
| `GetTaskPushNotificationConfig` | — | returns `-32003` | |
| `ListTaskPushNotificationConfigs` | — | returns `-32003` | |
| `DeleteTaskPushNotificationConfig` | — | returns `-32003` | |

JSON-RPC `id` may be `string | number | null`; `null` is reserved for parse errors per spec.

#### Core types

`Message`, `Part`, `Task`, `TaskStatus`, `Artifact`, `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `AgentCard`, `SendMessageRequest`, `SendMessageConfiguration`, `GetTaskRequest`, `ListTasksRequest`, `ListTasksResponse`, `CancelTaskRequest`, `SubscribeToTaskRequest` — all defined in `routes/a2a-types.ts`. Notable points:

- `Message.messageId` is **required**; servers reject without `-32602 INVALID_PARAMS`.
- `Message.role` is enum `ROLE_USER` / `ROLE_AGENT` / `ROLE_UNSPECIFIED`.
- `Part` carries one of `text` / `data` / `url` / `raw` (no `type` field — discrimination is by which slot is populated, per spec §4.1).
- `Task.id` is the canonical task identifier (server-assigned `a2a-<uuid>`).
- `Task.contextId` groups related tasks (server-assigned `ctx-<uuid>` if not supplied).

#### Task states (spec §4.1)

```
TASK_STATE_UNSPECIFIED
TASK_STATE_SUBMITTED      — initial
TASK_STATE_WORKING        — agent loop running
TASK_STATE_COMPLETED  ┐
TASK_STATE_FAILED     │── terminal (TERMINAL_STATES)
TASK_STATE_CANCELED   │
TASK_STATE_REJECTED   ┘
TASK_STATE_INPUT_REQUIRED — interrupted, awaiting user follow-up
TASK_STATE_AUTH_REQUIRED  — interrupted, awaiting auth
```

Internal `claw_sessions.agent_status` is mapped to/from these via `mapAgentStatusToTaskState` / `taskStateToAgentStatus` (see `a2a.ts`).

#### Streaming wire format

`SendStreamingMessage` and `SubscribeToTask` open an SSE stream on the same `POST /a2a`. Each event is a JSON-RPC success response carrying one `StreamResponse`:

```
data: {"jsonrpc":"2.0","id":<rpc-id>,"result":{"task":{...}}}
data: {"jsonrpc":"2.0","id":<rpc-id>,"result":{"artifactUpdate":{"taskId":"...","contextId":"...","artifact":{"artifactId":"<taskId>-text","parts":[{"text":"chunk"}]},"append":true,"lastChunk":false}}}
data: {"jsonrpc":"2.0","id":<rpc-id>,"result":{"statusUpdate":{"taskId":"...","contextId":"...","status":{"state":"TASK_STATE_COMPLETED","timestamp":"..."}}}}
```

Stable artifact IDs (`<taskId>-text`, `<taskId>-tools`) accumulate via `append=true`; the server emits a final `lastChunk=true` chunk before the terminal `statusUpdate` (spec §4.2.2 append semantics). A `: keepalive` comment is sent every 15 s to defeat proxy idle-timeouts.

#### Example: `SendMessage` (blocking)

Request:

```json
POST /a2a   HTTP/1.1
A2A-Version: 1.0
Authorization: Bearer ak-xxxxxxxxxxxx

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "msg-abc",
      "role": "ROLE_USER",
      "parts": [{ "text": "Write a Python HTTP server with health check" }]
    },
    "configuration": { "historyLength": 0, "returnImmediately": false },
    "metadata": { "plugin_id": 42, "workspace_id": "ws-1" }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "task": {
      "id": "a2a-7f1e...",
      "contextId": "ctx-9a2b...",
      "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "2026-04-29T08:42:11Z" },
      "artifacts": [ { "artifactId": "evt-xxx", "parts": [{ "text": "..." }] } ]
    }
  }
}
```

`returnImmediately=true` returns the task as soon as it is `SUBMITTED`, leaving the caller to poll `GetTask` or open `SubscribeToTask`.

#### Caller identity & session isolation

Caller identity scopes `GetTask` / `ListTasks` / `CancelTask` and rejects sends against tasks owned by a different caller. Because it *is* the tenant boundary, it is derived from exactly one source:

- The validated SaFE `userId` attached by `authMiddleware`, as `user:<userId>`.

There is no fallback. A request without a validated user is rejected with a JSON-RPC `-32600 INVALID_REQUEST` ("authentication required") rather than being assigned a guessable identity. In particular `params.metadata.callerId`, a hash of an unvalidated Bearer token, and the peer IP are **not** accepted as identity — all three are attacker-controlled.

Persistence: `claw_sessions.a2a_caller_id` (TEXT, indexed) is stamped on insert and required on every read query.

#### Internal task payload (NATS `tasks.<id>.execute`)

`SendMessage` and `SendStreamingMessage` publish to NATS for Brain to consume. Payload schema:

```json
{
  "session_id": "a2a-...",
  "message_id": "msg-...",
  "prompt": "<extracted text>",
  "history": [],
  "user_id": "<validated SaFE userId>",
  "platform_key": "...",
  "llm_api_key": "...",
  "workspace_id": "...",
  "parent_session_id": "...",
  "team_role": "...",
  "plugin_id": 42,
  "plugin_tools": [...],
  "sandbox_image": "harbor.example.com/.../runtime:latest",
  "resources": { "cpu": "...", "memory": "...", "gpu": "..." }
}
```

Sandbox image / resources resolution (mirrors `routes/sessions.ts` to keep Brain consumers happy):

```
metadata.sandbox_image / metadata.resources       (highest)
  > plugin row's first usable images[].repo / its resource
  > MarketplaceDb.resourceFirstByType("default")  (lowest)
```

The pre-v1.0 `resource_cpu` / `resource_gpu` split was removed; downstream Brain reads `sandbox_image` + `resources`.

#### Legacy `POST /invoke` / `POST /invoke/:skill`

Kept verbatim for SaFE A2A Gateway clients that have not migrated. Bypasses the JSON-RPC dispatcher; does **not** carry caller scope (legacy sessions are inserted with `a2a_caller_id=''` and are invisible to v1.0 reads). Migrate to JSON-RPC `SendMessage` ASAP.

```json
POST /invoke
{ "question": "Optimize this CUDA kernel for AMD MI355X" }

→
{ "success": true, "result": { "skill_id": "general", "task_id": "a2a-...", "answer": "Task ... submitted." } }
```

---

## 4. Authentication

Three configurable modes via `AUTH_MODE` env:

| Mode | `AUTH_MODE` | Behavior |
|------|-------------|----------|
| **None** | `none` | No authentication (development only) |
| **Bearer** | `bearer` | Validate `Authorization: Bearer <token>` against `AUTH_BEARER_TOKENS` env (comma-separated list) |
| **SaFE** | `safe` | Full SaFE platform authentication (existing `authMiddleware`) |

Configuration:

```env
# Authentication mode
AUTH_MODE=bearer

# Comma-separated valid Bearer tokens (for AUTH_MODE=bearer)
AUTH_BEARER_TOKENS=sk-claw-abc123,sk-claw-def456

# SaFE platform URL (for AUTH_MODE=safe)
SAFE_API_URL=https://cluster.example.com
```

The A2A discovery endpoints (`/.well-known/agent-card.json`, the legacy `/.well-known/agent.json`, and their `/a2a/`-prefixed aliases) and the health checks (`/health`, `/a2a/health`) are always unauthenticated. Every other `/a2a/*` path requires authentication.

---

## 5. Execution Modes (Sandbox Strategy)

### 5.1 Local Execution (default for standalone)

Tools execute directly on the host machine. Hands runs as an in-process module, not a separate MCP server.

```env
EXECUTION_MODE=local
WORKSPACE_PATH=/workspace
```

Behavior:
- `bash` tool executes commands via `child_process.spawn` on the host.
- `read`/`write`/`edit` tools operate on the local filesystem.
- Path guard restricts access to `WORKSPACE_PATH` and its descendants.
- No network overhead for tool calls (in-process function calls).

### 5.2 Local Hands (MCP subprocess)

Hands runs as a separate MCP server process on the same machine. Provides process-level isolation without Kubernetes.

```env
EXECUTION_MODE=local-mcp
HANDS_MCP_URL=http://localhost:9100/mcp
AUTH_INTERNAL_TOKEN=<shared-secret>
```

### 5.3 SaFE Sandbox (production)

Per-session Kubernetes pod via SaFE platform (existing behavior).

```env
EXECUTION_MODE=sandbox
SAFE_API_URL=https://cluster.example.com
SAFE_API_KEY=<key>
SANDBOX_NAMESPACE=default
```

---

## 6. Configuration Reference

### 6.1 Agent Server

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_SERVER_PORT` | `8080` | HTTP listen port |
| `AGENT_SERVER_HOST` | `0.0.0.0` | HTTP listen host |
| `AGENT_SERVER_MODE` | `standalone` | `standalone` (single-process) or `distributed` (existing API+Brain) |
| `AUTH_MODE` | `none` | `none` / `bearer` / `safe` |
| `AUTH_BEARER_TOKENS` | `` | Comma-separated valid tokens |
| `EXECUTION_MODE` | `local` | `local` / `local-mcp` / `sandbox` |
| `WORKSPACE_PATH` | `/workspace` | Root workspace for local execution |
| `CLAW_PUBLIC_URL` | `` | Public URL for A2A agent card |
| `MAX_CONCURRENT_TASKS` | `3` | Max parallel task executions |

### 6.2 LLM Engine

Codex/Pi engines (`engines/codex.ts`, `engines/pi.ts`) and the `ENGINE_TYPE`
switch were removed after security review confirmed they were never enabled
in production and had zero test coverage; Brain now always runs `ClaudeEngine`.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Default LLM model |
| `ANTHROPIC_BASE_URL` | `` | Anthropic API base URL |
| `ANTHROPIC_AUTH_TOKEN` | `` | Anthropic API key |
| `OPENAI_BASE_URL` | `` | OpenAI API base URL |
| `OPENAI_API_KEY` | `` | OpenAI API key |
| `MAX_TURNS` | `2000` | Default agent loop turn budget |

### 6.3 SaFE Sandbox (EXECUTION_MODE=sandbox only)

| Variable | Default | Description |
|----------|---------|-------------|
| `SAFE_API_URL` | `` | SaFE platform URL |
| `SAFE_API_KEY` | `` | SaFE API key |
| `SANDBOX_NAMESPACE` | `default` | Kubernetes namespace |

---

## 7. Implementation Plan

### Phase 1: Standalone Server Entry Point

New file: `packages/brain/src/standalone.ts`

```
standalone.ts
├── Fastify HTTP server (single port)
├── Auth middleware (configurable)
├── Engine initialization (reuse existing createEngine)
├── In-memory task store (Map<taskId, TaskState>)
├── REST routes (/v1/chat/completions, /v1/models, /health)
├── A2A routes (/.well-known/agent.json, /a2a/tasks/*)
├── SaFE invoke routes (/invoke, /invoke/:skill)
└── Hands resolution (local / local-mcp / sandbox)
```

Key design: `standalone.ts` **does not import NATS**. It directly calls `engine.execute()` with an in-process `HandsClient` or local Hands, bypassing the entire NATS task queue.

### Phase 2: In-Process Hands

New file: `packages/brain/src/local-hands.ts`

Wraps the Hands tool implementations from `packages/hands/src/tools/` into a `HandsClient`-compatible interface without HTTP/MCP overhead.

```typescript
class LocalHands implements HandsClientInterface {
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Direct function call to tool implementation
    return tools[name].execute(args);
  }
}
```

### Phase 3: OpenAI-Compatible REST API

New file: `packages/brain/src/routes/completions.ts`

Translates between OpenAI chat format and the internal `ExecuteRequest` / `ExecuteResult` types. Handles both streaming (SSE) and non-streaming responses.

### Phase 4: A2A v1.0 Server

Modified file: `packages/api/src/routes/a2a.ts` (rewritten)
New file:      `packages/api/src/routes/a2a-types.ts` (canonical type defs, ~370 LoC)
New file:      `packages/brain/src/routes/a2a.ts` (standalone-mode A2A — TODO)

Already shipped:
- JSON-RPC 2.0 dispatcher on a single `POST /a2a` endpoint.
- Caller-scoped reads via `claw_sessions.a2a_caller_id` (4-tier identity fallback: SaFE user > metadata > bearer-hash > IP).
- Streaming via stable artifact IDs (`<taskId>-text`, `<taskId>-tools`) with `append`/`lastChunk` semantics.
- `CancelTask` RPC implemented; `Create/Get/List/Delete TaskPushNotificationConfig` return `-32003`; `GetExtendedAgentCard` returns `-32004`.
- A2A error code spec compliance with `google.rpc.ErrorInfo` payloads.

Outstanding items (tracked separately):
- Echo `A2A-Version` in response headers (spec §6.6).
- JSON-RPC batch (spec §9.5).
- Standalone-mode A2A in `packages/brain/src/routes/a2a.ts`.

### Phase 5: Startup Scripts & Dockerfile

| File | Purpose |
|------|---------|
| `start_agent_server.sh` | Launch standalone agent server |
| `Dockerfile` update | Add `RUN_MODE=agent-server` entry point |
| `.env.example` update | Document new env vars |

---

## 8. Data Flow

### 8.1 Standalone Mode — REST Request

```
Client                     Agent Server                    LLM Gateway
  │                             │                              │
  │  POST /v1/chat/completions  │                              │
  │────────────────────────────►│                              │
  │                             │                              │
  │                             │  Auth check                  │
  │                             │  Create in-memory task       │
  │                             │                              │
  │                             │  engine.execute(request)     │
  │                             │  ┌───────────────────────┐   │
  │                             │  │ Agent Loop             │   │
  │                             │  │                        │   │
  │  SSE: delta chunks          │  │  LLM call ────────────┼──►│
  │◄────────────────────────────│  │  ◄── response ────────┼───│
  │                             │  │                        │   │
  │  SSE: agent.tool_use        │  │  tool_use: bash        │   │
  │◄────────────────────────────│  │  → LocalHands.call()   │   │
  │  SSE: agent.tool_result     │  │  ← result              │   │
  │◄────────────────────────────│  │                        │   │
  │                             │  │  LLM call ────────────┼──►│
  │  SSE: delta chunks          │  │  ◄── final response ──┼───│
  │◄────────────────────────────│  │                        │   │
  │                             │  └───────────────────────┘   │
  │  SSE: [DONE]                │                              │
  │◄────────────────────────────│  Task → completed            │
```

### 8.2 Standalone Mode — A2A v1.0 Request

```
External Agent             Agent Server                    LLM Gateway
  │                             │                              │
  │  GET /.well-known/agent-card.json                          │
  │────────────────────────────►│                              │
  │  ◄── AgentCard (v1.0) ─────│                              │
  │                             │                              │
  │  POST /a2a                  │                              │
  │  A2A-Version: 1.0           │                              │
  │  {jsonrpc, id, method:      │                              │
  │   "SendStreamingMessage",   │                              │
  │   params:{message:{...}}}   │                              │
  │────────────────────────────►│                              │
  │                             │  (async) engine.execute()    │
  │  SSE: data: {result:{task:{id,status:SUBMITTED}}}          │
  │◄────────────────────────────│  Agent loop running...       │
  │  SSE: data: {result:{statusUpdate:{state:WORKING}}}        │
  │◄────────────────────────────│                              │
  │  SSE: data: {result:{artifactUpdate:{<taskId>-text,append}}}│
  │◄────────────────────────────│                              │
  │  SSE: data: {result:{artifactUpdate:{<taskId>-tools,append}}}│
  │◄────────────────────────────│                              │
  │  SSE: data: {result:{artifactUpdate:{lastChunk:true}}}     │
  │  SSE: data: {result:{statusUpdate:{state:COMPLETED}}}      │
  │◄────────────────────────────│                              │
```

### 8.3 Distributed Mode (existing, unchanged)

```
Client → API (:8200) → NATS → Brain (:8100) → Sandbox Hands (:9100)
                                    │
                                    └── LLM Gateway
```

---

## 9. In-Memory Task Store (Standalone Mode)

Since standalone mode has no PostgreSQL, tasks are stored in a bounded in-memory map:

```typescript
interface TaskState {
  id: string;
  status: "submitted" | "working" | "completed" | "failed" | "cancelled";
  createdAt: number;
  prompt: string;
  result?: ExecuteResult;
  eventBuffer: Array<Record<string, unknown>>;  // ring buffer for SSE replay
  subscribers: Set<WritableStream>;              // active SSE listeners
  abortController?: AbortController;
}

class InMemoryTaskStore {
  private tasks = new Map<string, TaskState>();
  private maxTasks = 10_000;  // evict oldest when exceeded
}
```

Eviction policy: LRU by `createdAt`, completed/failed tasks evicted first.

---

## 10. Error Handling

| Scenario | REST Response | A2A v1.0 (JSON-RPC) Response |
|----------|---------------|------------------------------|
| Auth failure | `401 Unauthorized` | `401 Unauthorized` from `authMiddleware`; an authenticated request that somehow reaches the handler without a user gets `code:-32600 INVALID_REQUEST` ("authentication required") |
| Malformed JSON | `400 Bad Request` | HTTP `200` + `{error:{code:-32700,message:"Invalid JSON payload"}}` (spec §5.1) |
| Bad request envelope (missing jsonrpc/method/id) | `400 Bad Request` | `code:-32600 INVALID_REQUEST` |
| Unknown method | n/a | `code:-32601 METHOD_NOT_FOUND` |
| Bad params (missing messageId, bad pageSize, …) | `400 Bad Request` | `code:-32602 INVALID_PARAMS` |
| Wrong / missing `A2A-Version` | n/a | `code:-32009 A2A_VERSION_NOT_SUPPORTED` |
| Task not found | `404 Not Found` | `code:-32001 TASK_NOT_FOUND` |
| CancelTask on terminal task | n/a | `code:-32002 TASK_NOT_CANCELABLE` |
| Push-notif methods called | n/a | `code:-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` |
| `GetExtendedAgentCard` / unsupported op | n/a | `code:-32004 UNSUPPORTED_OPERATION` |
| LLM / tool / dispatcher exception | `502 Bad Gateway` | `code:-32603 INTERNAL_ERROR`; for streaming methods, terminal `statusUpdate` with state `TASK_STATE_FAILED` |
| Rate limit (max concurrent) | `429 Too Many Requests` | `code:-32603 INTERNAL_ERROR` (no dedicated A2A code) |
| Server shutdown | Graceful drain, `503` for new requests | Same |

A2A errors carry `data: [google.rpc.ErrorInfo]` with a stable `reason` (`TASK_NOT_FOUND`, `PUSH_NOTIFICATION_NOT_SUPPORTED`, …) and optional `metadata` (e.g. `{taskId, currentState}`). Clients should match on `error.code` first and `data[0].reason` second; do not parse `error.message`.

---

## 11. Security Considerations

1. **Path Guard**: Local execution mode restricts tool access to `WORKSPACE_PATH`. No filesystem access outside the configured workspace root.
2. **Token Rotation**: Bearer tokens should be rotated periodically. The `AUTH_BEARER_TOKENS` env supports multiple tokens for zero-downtime rotation.
3. **Rate Limiting**: `MAX_CONCURRENT_TASKS` prevents resource exhaustion. Additional per-IP rate limiting is recommended at the reverse proxy layer.
4. **No Secrets in Logs**: Task payloads are logged at `info` level with sensitive fields (API keys, tokens) redacted.
5. **CORS**: Configurable via `CORS_ORIGINS` env. Default: deny all cross-origin requests in standalone mode.
6. **TLS**: Agent Server listens on plain HTTP. TLS termination should be handled by a reverse proxy (nginx, Envoy, Higress).

---

## 12. Deployment Examples

### 12.1 Minimal Local Development

```bash
# .env
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-ant-xxx
AUTH_MODE=none
EXECUTION_MODE=local
WORKSPACE_PATH=/tmp/claw-workspace

# Start
npx tsx packages/brain/src/standalone.ts
# → Agent Server ready on http://localhost:8080
```

### 12.2 Production with Bearer Auth

```bash
# .env
ANTHROPIC_BASE_URL=https://gateway.internal/llm
ANTHROPIC_AUTH_TOKEN=xxx
AUTH_MODE=bearer
AUTH_BEARER_TOKENS=sk-claw-prod-001,sk-claw-prod-002
EXECUTION_MODE=sandbox
SAFE_API_URL=https://safe.internal
AGENT_SERVER_PORT=8080
CLAW_PUBLIC_URL=https://claw.example.com
MAX_CONCURRENT_TASKS=10

# Start
node dist/standalone.js
```

### 12.3 Docker

```dockerfile
# In existing Dockerfile, add:
# RUN_MODE=agent-server → standalone entry point
CMD ["sh", "-c", \
  "if [ \"$RUN_MODE\" = 'agent-server' ]; then \
     node packages/brain/dist/standalone.js; \
   elif [ \"$RUN_MODE\" = 'brain' ]; then \
     node packages/brain/dist/index.js; \
   else \
     node packages/api/dist/index.js; \
   fi"]
```

```bash
docker run -p 8080:8080 \
  -e RUN_MODE=agent-server \
  -e ANTHROPIC_AUTH_TOKEN=sk-ant-xxx \
  -e AUTH_MODE=bearer \
  -e AUTH_BEARER_TOKENS=sk-claw-test \
  primus-claw:latest
```

### 12.4 Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claw-agent-server
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: agent-server
        image: harbor.example.com/primussafe/claw:latest
        env:
        - name: RUN_MODE
          value: agent-server
        - name: AUTH_MODE
          value: safe
        - name: EXECUTION_MODE
          value: sandbox
        - name: AGENT_SERVER_PORT
          value: "8080"
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: claw-agent-server
spec:
  ports:
  - port: 8080
    targetPort: 8080
  selector:
    app: claw-agent-server
```

---

## 13. File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/brain/src/standalone.ts` | **New** | Standalone Agent Server entry point |
| `packages/brain/src/local-hands.ts` | **New** | In-process Hands tool execution |
| `packages/brain/src/routes/completions.ts` | **New** | OpenAI-compatible REST API routes |
| `packages/brain/src/routes/a2a-standalone.ts` | **New** | A2A routes for standalone mode |
| `packages/brain/src/task-store.ts` | **New** | In-memory task store |
| `packages/brain/src/auth.ts` | **New** | Configurable auth middleware |
| `packages/api/src/routes/a2a-types.ts` | **New** | Canonical A2A v1.0 type definitions |
| `packages/api/src/routes/a2a.ts` | **Modify** | Rewrite to JSON-RPC 2.0 binding, caller-scoped reads, streaming via stable artifact IDs; align task payload with `sandbox_image` + `resources` |
| `packages/api/src/infra/db.ts` | **Modify** | New columns `context_id`, `a2a_caller_id` + partial indexes |
| `packages/api/src/auth/middleware.ts` | **Modify** | Add the agent-card and `/a2a/health` paths to the anonymous allowlist; authenticate the rest of `/a2a/*` |
| `packages/brain/src/clients/a2a.ts` | **Modify** | Rewrite to v1.0 client (JSON-RPC, well-known fallback, SSE consumer) |
| `packages/brain/src/config.ts` | **Modify** | Add standalone-mode config vars |
| `packages/brain/package.json` | **Modify** | Add standalone entry in scripts |
| `claw/.env.example` | **Modify** | Document new env vars |
| `claw/Dockerfile` | **Modify** | Add agent-server RUN_MODE |
| `start_agent_server.sh` | **New** | Startup script |

Total: 9 new files, 7 modified files.

---

## 14. Testing Strategy

### 14.1 Manual Smoke Test

```bash
# Start agent server
./start_agent_server.sh

# Test health
curl http://localhost:8080/health

# Test A2A v1.0 discovery
curl http://localhost:8080/.well-known/agent-card.json

# Test REST API (non-streaming)
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# Test REST API (streaming)
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write hello.py"}],"stream":true}'

# Test A2A v1.0 task (blocking SendMessage)
TASK_ID=$(curl -s -X POST http://localhost:8080/a2a \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"List files"}]},"configuration":{"returnImmediately":true}}}' \
  | jq -r .result.task.id)

# Stream a task (SSE on the same JSON-RPC endpoint)
curl -N -X POST http://localhost:8080/a2a \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -H "Accept: text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"SubscribeToTask\",\"params\":{\"id\":\"$TASK_ID\"}}"

# Cancel a task
curl -s -X POST http://localhost:8080/a2a \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"CancelTask\",\"params\":{\"id\":\"$TASK_ID\"}}"

# Test SaFE invoke (legacy)
curl -X POST http://localhost:8080/invoke \
  -H "Content-Type: application/json" \
  -d '{"question":"What is 2+2?"}'
```

### 14.2 Integration Test Scenarios

| # | Scenario | Validation |
|---|----------|------------|
| 1 | REST non-streaming with tools | Response contains tool results in content |
| 2 | REST streaming with tools | SSE includes `agent.tool_use` and `agent.tool_result` events |
| 3 | A2A full lifecycle | `submitted` → `working` → `completed` via stream |
| 4 | A2A task cancellation | `CancelTask` RPC → `TASK_STATE_CANCELED`; calling again returns `-32002 TASK_NOT_CANCELABLE` |
| 5 | Bearer auth rejection | `401` on invalid/missing token |
| 6 | Concurrent task limit | `429` when `MAX_CONCURRENT_TASKS` exceeded |
| 7 | Local Hands bash execution | Tool writes file, subsequent read returns content |
| 8 | Sandbox Hands execution | Full SaFE workload lifecycle |
| 9 | Graceful shutdown | In-flight tasks complete, new requests get `503` |
| 10 | Long-running task | 30+ turn agent loop completes correctly |

---

## 15. Migration Path

For existing V2 deployments, Agent Server is **additive** — no changes required to existing API + Brain + Hands deployment. The standalone server is a new entry point that can run alongside or replace the distributed setup.

**Step 1**: Deploy Agent Server alongside existing services (parallel run).
**Step 2**: Route new external/A2A consumers to Agent Server.
**Step 3**: Optionally consolidate to Agent Server for simpler deployments.

---

## Appendix A: Distributed `api/routes/a2a.ts` vs Standalone Agent Server A2A

Both surfaces speak the same A2A v1.0 wire protocol; they differ only in dispatch / persistence:

| Feature | Distributed (`api/routes/a2a.ts`, A2A v1.0) | Standalone Agent Server A2A |
|---|---|---|
| Discovery | ✅ `/.well-known/agent-card.json` (+ legacy `agent.json`) | ✅ Same |
| Endpoint | ✅ `POST /a2a` (JSON-RPC 2.0) | ✅ Same |
| `SendMessage` (blocking + `returnImmediately`) | ✅ via NATS publish + DB poll until terminal | ✅ via direct in-process `engine.execute()` |
| `SendStreamingMessage` (SSE) | ✅ NATS subscribe → SSE on same `POST /a2a` | ✅ Direct event pipe → SSE |
| `SubscribeToTask` (SSE) | ✅ NATS subscribe + initial DB snapshot | ✅ In-memory event buffer + replay |
| `GetTask` / `ListTasks` | ✅ Caller-scoped via `claw_sessions.a2a_caller_id` (keyset pagination) | ✅ In-memory store, caller-scoped |
| `CancelTask` | ✅ Updates DB + publishes `tasks.<id>.cancel` to NATS | ✅ Aborts in-process `AbortController` |
| Push-notification methods | Returns `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` | Same |
| `GetExtendedAgentCard` | Returns `-32004 UNSUPPORTED_OPERATION` | Same |
| Auth (HTTP layer) | `/a2a/*` authenticated (discovery + health anonymous); caller scope is the validated SaFE `userId` only | Configurable Bearer / SaFE / none |
| Legacy `/invoke[/:skill]` | ✅ Kept as backward-compat (no caller scope) | ✅ Same |
| Persistence | PostgreSQL (`claw_sessions`, `claw_session_events`, `claw_conversation_turns`) | In-memory `Map`, evict-on-cap |
| Dependencies | NATS + PostgreSQL | None |

## Appendix B: A2A v1.0 Spec Compliance Matrix

Based on [Google A2A v1.0](https://a2aproject.github.io/A2A/latest/specification). Section numbers reference the spec.

| § | Requirement | Status | Notes |
|---|---|---|---|
| 8.2 | Agent Card at `/.well-known/agent-card.json` | ✅ | Plus legacy `agent.json` for pre-v1.0 clients |
| 8.2 | `GetExtendedAgentCard` RPC | ⚠️ | Method exists, returns `-32004 UNSUPPORTED_OPERATION` (not configured) |
| 9 | JSON-RPC 2.0 binding (`POST /a2a`) | ✅ | Single endpoint dispatcher |
| 9.4 | PascalCase method names | ✅ | `SendMessage`, `GetTask`, … |
| 9.5 | JSON-RPC batch (array request) | ❌ | Not supported; server returns `-32600 INVALID_REQUEST` for arrays |
| 6.x | `A2A-Version` header on every request | ✅ | Required; missing → `-32009` |
| 4.1 | Core types (`Task`, `Message`, `Part`, `Artifact`, `TaskStatus`) | ✅ | `routes/a2a-types.ts` |
| 4.1 | Task states (8 enum values incl. INPUT_REQUIRED / AUTH_REQUIRED / REJECTED) | ✅ | `TaskState` enum |
| 4.2.1 | `TaskStatusUpdateEvent` | ✅ | Emitted at terminal/interrupted states |
| 4.2.2 | `TaskArtifactUpdateEvent` with `append` semantics keyed on `artifactId` | ✅ | Stable IDs `<taskId>-text`, `<taskId>-tools`; final `lastChunk=true` before terminal status |
| 3.2 | `SendMessage` blocking by default; `returnImmediately` override | ✅ | Default `false` per spec §3.2.2 |
| 3.2 | `SendStreamingMessage` SSE | ✅ | |
| 3.2 | `GetTask` / `ListTasks` (with pagination) | ✅ | Keyset pagination via opaque `pageToken` |
| 3.2 | `CancelTask` | ✅ | Idempotent; terminal task → `-32002 TASK_NOT_CANCELABLE` |
| 3.2 | `SubscribeToTask` SSE | ✅ | Replays current task state then streams |
| 3.2 | Push-notification config methods (Create/Get/List/Delete) | ❌ | All return `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` |
| 4.5 | Security schemes in Agent Card (`httpAuthSecurityScheme`) | ✅ | Bearer scheme advertised |
| 5.1 | Standard JSON-RPC error codes (-32700 / -32600 / -32601 / -32602 / -32603) | ✅ | |
| 5.4 | A2A-specific error codes (-32001..-32009) | ✅ | All defined in `routes/a2a-types.ts` |
| 5.4 | `error.data` carries `google.rpc.ErrorInfo` with `reason` / `domain` / `metadata` | ✅ | `domain="a2a-protocol.org"` |
| 6.6 | Echo `A2A-Version` in response headers | ❌ | Not yet implemented (server validates input only) |
| 4.4 | Skill discovery (Agent Card `skills[]`) | ✅ | 4 skills published |
| — | Multi-turn conversation | ✅ | `Message.taskId` continues an existing task; same `contextId` groups related tasks |
| — | Caller-scoped task isolation | ✅ | `claw_sessions.a2a_caller_id` filter on every read |
