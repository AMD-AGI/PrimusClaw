// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ─────────────────────────────────────────────────────────────────
// Anthropic Managed Agents SDK compatibility layer.
//
// Exposes `/anthropic/v1/*` so `@anthropic-ai/sdk` clients pointed at
// `baseURL: "<primus-claw-api>/anthropic"` can run the Managed Agents
// TypeScript Quickstart (create agent/environment/session, send a
// user.message event, stream agent.message/agent.tool_use/
// session.status_idle) against PrimusClaw.
//
// Design: see primus-claw-anthropic-managed-agents-sdk-compat-design.html.
// No new tables — Agent/Environment are compat views over existing
// plugins/resources; Session is a normal `claw_sessions` row whose
// Anthropic binding is snapshotted into `config.primus_anthropic_compat`.
// Both this route file and routes/sessions.ts dispatch through the same
// `dispatchTaskToBrain()` (../session-dispatch.js) — no duplicated
// plugin/resource/MCP resolution logic between entry points.
// ─────────────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { db, MarketplaceDb } from "../infra/db.js";
import { canViewPlugin, ownerOrAdmin, formatPluginRow } from "../marketplace/plugins.js";
import { getUser } from "../auth/middleware.js";
import { anthropicErrorPayload } from "../auth/middleware.js";
import { isAdmin } from "../auth/models.js";
import { asJsonObject, dispatchTaskToBrain } from "../sessions/dispatch.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { RUN_DOORBELL_DISPATCH } from "../config.js";
import { pendingSecretColumns } from "../tasks/run-secrets.js";
import { interruptUnstartedChatRuns } from "../tasks/chat-run.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { createSessionSubscriptionReady, sanitizeSessionEvent } from "../events/store.js";
import { nc } from "../infra/nats.js";
import { teardownSession, TeardownRefused } from "../sessions/teardown.js";
import { interruptSubject } from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "anthropic-managed-agents" });

// CLI-only stream compatibility switch. The `ant` CLI (anthropic-cli) buffers
// every SSE item in memory and only writes them to stdout after its read loop
// ends (ShowJSONIterator in pkg/cmd/cmdutil.go). On a persistent event stream
// that loop never ends, so the CLI hangs with no output. When enabled (default)
// the /events/stream handler closes the connection once the session is idle
// *only for the CLI* (matched by User-Agent / X-Stainless-CLI-Command), letting
// the CLI's loop terminate and flush. SDK/curl clients are never matched and
// keep the long-lived multi-turn stream. Set to "false" to fully disable.
const CLI_STREAM_CLOSE_ON_IDLE = process.env.ANTHROPIC_CLI_STREAM_CLOSE_ON_IDLE !== "false";

// Compat views over `resources` rows (design doc §9.5.2). Distinguishes
// Anthropic Environment rows from real Primus resource templates so the
// native `GET /v1/resources` picker can default-exclude them (see
// routes/plugins.ts, MarketplaceDb.listResourcesRepo `excludeType`).
const ANTHROPIC_ENV_RESOURCE_TYPE = "anthropic_env";

/** `models.list()`/`models.retrieve()` compat view (design doc §9.5 model
 *  matrix — deferred at P0 since every call site here hardcodes
 *  `claude-opus-4-6` and nothing exercised a model selector; static single-
 *  entry list is enough now that a caller needs it. */
const ANTHROPIC_COMPAT_MODEL = {
  type: "model",
  id: "claude-opus-4-6",
  display_name: "Claude Opus 4.6",
  created_at: "2026-01-01T00:00:00Z",
};

function sendError(reply: FastifyReply, status: number, type: string, message: string): FastifyReply {
  return reply.status(status).send(anthropicErrorPayload(type, message));
}

/** Opaque list-cursor: base64 JSON of the last row's sort key + id tie-breaker (design doc §9.5.3/§9.5.4). */
function encodeCursor(sortValue: string, id: string | number): string {
  return Buffer.from(JSON.stringify([sortValue, id]), "utf8").toString("base64url");
}
function decodeCursor(cursor: unknown): [string, string | number] | null {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) return parsed as [string, string | number];
    return null;
  } catch {
    return null;
  }
}

/** `agents.list()`/`agents.retrieve()` compat view built from a `plugins` row. */
function formatAgentFromPlugin(row: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(row.tools) ? row.tools : [];
  return {
    id: `plugin_${row.id}`,
    type: "agent",
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" && row.description ? row.description : null,
    model: { id: "claude-opus-4-6" },
    system: null,
    tools,
    skills: [],
    mcp_servers: [],
    metadata: {},
    version: Number(row.anthropic_agent_version) || 1,
    archived_at: row.status === "archived" ? (row.updated_at as Date | null) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stateless `agent_default` view — same shape emitted by POST /anthropic/v1/agents. */
function defaultAgentView(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "agent_default", type: "agent", name: "Primus default runtime", description: null,
    model: { id: "claude-opus-4-6" }, system: null, tools: [], skills: [], mcp_servers: [],
    metadata: {}, version: 1, archived_at: null, created_at: now, updated_at: now,
  };
}

/** `environments.list()`/`environments.retrieve()` compat view built from a `resources` row (type=anthropic_env). */
function formatEnvironmentFromResource(row: Record<string, unknown>): Record<string, unknown> {
  const stored = asJsonObject(asJsonObject(row.resource)?.anthropic_env) ?? {};
  return {
    id: `resource_${row.id}`,
    type: "environment",
    name: typeof row.name === "string" ? row.name : "",
    description: typeof stored.description === "string" ? stored.description : "",
    config: {
      type: "cloud",
      networking: asJsonObject(stored.networking) ?? { type: "unrestricted" },
      packages: asJsonObject(stored.packages) ?? { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    },
    metadata: asJsonObject(stored.metadata) ?? {},
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stateless `env_default` view — same shape emitted by POST /anthropic/v1/environments. */
function defaultEnvironmentView(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "env_default", type: "environment", name: "Primus default runtime", description: "",
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
    metadata: {}, archived_at: null, created_at: now, updated_at: now,
  };
}

/** Response-side `model` is always an object per BetaManagedAgentsModelConfig; request-side may be a bare string. */
function normalizeModelForResponse(model: unknown): Record<string, unknown> {
  if (typeof model === "string") return { id: model };
  const obj = asJsonObject(model);
  if (obj && typeof obj.id === "string") {
    return obj.speed !== undefined ? { id: obj.id, speed: obj.speed } : { id: obj.id };
  }
  return { id: "claude-opus-4-6" };
}

interface PrimusClawAgentHint {
  plugin_id?: number;
  workspace_id?: string;
}

/**
 * `metadata.primus_claw` must be a JSON.stringify()-encoded string (real
 * `AgentCreateParams.metadata` type is `{[key:string]:string}`, 512-char
 * value cap) — see design doc §6.3/§12. Returns null on missing/unparseable
 * input; callers must treat that as "no hint", not an error.
 */
function parsePrimusClawMetadata(metadata: unknown): PrimusClawAgentHint | null {
  const obj = asJsonObject(metadata);
  const raw = obj?.primus_claw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hint: PrimusClawAgentHint = {};
    const pid = parsed.plugin_id;
    if (typeof pid === "number" && Number.isFinite(pid)) hint.plugin_id = pid;
    else if (typeof pid === "string" && Number.isFinite(Number(pid))) hint.plugin_id = Number(pid);
    if (typeof parsed.workspace_id === "string" && parsed.workspace_id.trim()) {
      hint.workspace_id = parsed.workspace_id.trim();
    }
    return hint;
  } catch {
    return null;
  }
}

/**
 * True if `pluginId` exists, is visible to the acting user, and may be used
 * to CREATE a new agent/session reference. Deliberately rejects
 * `status === 'archived'` — this is the only place that check happens.
 * `dispatchTaskToBrain()` (sessions/dispatch.ts) resolves plugins for an
 * EXISTING session's dispatch via a separate `canViewPlugin()` call that does
 * NOT check `status`, so archiving an agent only blocks new
 * agents.create()/sessions.create() references, never breaks a session that
 * already exists — see design doc §9.5.1 v0.16 addendum.
 */
async function canUsePlugin(pluginId: number, userId: string, admin: boolean): Promise<boolean> {
  const row = await MarketplaceDb.pluginGetById(pluginId, false);
  return !!row && row.status !== "archived" && canViewPlugin(row, userId, admin);
}

/** Best-effort resolved-agent echo for a Session response (agents.create() is stateless — no table to read back from). */
function buildSessionAgentEcho(agentId: string, pluginId: number | undefined): Record<string, unknown> {
  return {
    id: agentId,
    type: "agent",
    description: null,
    mcp_servers: [],
    model: { id: "claude-opus-4-6" },
    name: pluginId !== undefined ? `plugin_${pluginId}` : "Primus default runtime",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  };
}

/** Deep-ish record accessor used for reading `claw_sessions.config.primus_anthropic_compat.primus_claw`. */
function readPrimusClawConfig(sessionConfig: unknown): {
  pluginId: number | undefined;
  workspaceId: string | undefined;
  mcpServers: Record<string, Record<string, unknown>> | undefined;
  resources: Record<string, unknown> | undefined;
  sessionEnv: Record<string, string>;
  mcpToolPrefixes: string[];
  resourceMounts: Array<Record<string, unknown>>;
} {
  const compat = asJsonObject(asJsonObject(sessionConfig)?.primus_anthropic_compat);
  const primusClaw = asJsonObject(compat?.primus_claw) ?? {};
  const pluginId = typeof primusClaw.plugin_id === "number" ? primusClaw.plugin_id : undefined;
  const workspaceId = typeof primusClaw.workspace_id === "string" ? primusClaw.workspace_id : undefined;
  const mcpServersRaw = asJsonObject(primusClaw.mcp_servers) as Record<string, Record<string, unknown>> | undefined;
  const mcpServers = mcpServersRaw && Object.keys(mcpServersRaw).length > 0 ? mcpServersRaw : undefined;
  // dispatchTaskToBrain does `requestResource || ... || defaultResource`, and
  // `{}` is truthy in JS — an empty placeholder here would permanently mask
  // the seeded default resource/image. Must normalize empty -> undefined so
  // the fallback chain actually reaches defaultResource when nothing was
  // explicitly configured on this session.
  const resourcesRaw = asJsonObject(primusClaw.resources);
  const resources = resourcesRaw && Object.keys(resourcesRaw).length > 0 ? resourcesRaw : undefined;
  const sessionEnv = (asJsonObject(primusClaw.session_env) as Record<string, string> | undefined) ?? {};
  // Design doc §7.1.1: derived from `mcp_servers` keys at config-write time,
  // not passed separately — every MCP-sourced tool name is prefixed
  // `mcp__<server>__` (confirmed against real Brain traffic, v0.13 changelog).
  const mcpToolPrefixes = Array.isArray(primusClaw.mcp_tool_prefixes)
    ? (primusClaw.mcp_tool_prefixes as unknown[]).filter((p): p is string => typeof p === "string")
    : (mcpServers ? Object.keys(mcpServers).map((name) => `mcp__${name}__`) : []);
  const resourceMounts = Array.isArray(primusClaw.resource_mounts)
    ? (primusClaw.resource_mounts as unknown[]).filter((m): m is Record<string, unknown> => !!asJsonObject(m)) as Record<string, unknown>[]
    : [];
  return { pluginId, workspaceId, mcpServers, resources, sessionEnv, mcpToolPrefixes, resourceMounts };
}

/**
 * Real MCP server names configured on a plugin (design doc §7.1.1). A
 * plugin's `tools` column only stores `[{id, type:"mcp"}]` refs — the actual
 * server name lives in the referenced `tools` row's `config.mcpServers` keys
 * (confirmed against real DB content, not the OpenAPI-generated shape).
 * Returns `mcp__<name>__` prefixes ready to match against `toolUsed.tool`.
 */
async function resolveMcpToolPrefixesForPlugin(pluginId: number): Promise<string[]> {
  try {
    const pluginRow = await MarketplaceDb.pluginGetById(pluginId, false);
    if (!pluginRow) return [];
    const formatted = await formatPluginRow(pluginRow, true);
    const tools = Array.isArray(formatted.tools) ? formatted.tools : [];
    const prefixes: string[] = [];
    for (const t of tools) {
      const tObj = asJsonObject(t);
      if (tObj?.type !== "mcp") continue;
      const mcpServers = asJsonObject(asJsonObject(tObj.config)?.mcpServers);
      if (mcpServers) for (const name of Object.keys(mcpServers)) prefixes.push(`mcp__${name}__`);
    }
    return prefixes;
  } catch (err) {
    logger.warn({ err, pluginId }, "anthropic.mcp_tool_prefixes.resolve_failed");
    return [];
  }
}

/** Atomic top-level-key merge into `claw_sessions.config.primus_anthropic_compat` (design doc §9.4/§9.5.3 — jsonb `||`, no read-modify-write race). */
async function mergeSessionCompatConfig(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE claw_sessions
     SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
           'primus_anthropic_compat',
           COALESCE(config->'primus_anthropic_compat', '{}'::jsonb) || $2::jsonb
         ),
         updated_at = NOW()
     WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId, JSON.stringify(patch)],
  );
}

/** `sessions.retrieve()`/`sessions.list()` compat view built from a `claw_sessions` row. */
function formatSessionFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const compat = asJsonObject(asJsonObject(row.config)?.primus_anthropic_compat);
  const primusClaw = asJsonObject(compat?.primus_claw) ?? {};
  const agentId = typeof compat?.agent_id === "string" ? compat.agent_id : "agent_default";
  const environmentId = typeof compat?.environment_id === "string" ? compat.environment_id : "env_default";
  const pluginId = typeof primusClaw.plugin_id === "number" ? primusClaw.plugin_id : undefined;
  const metadata = asJsonObject(compat?.metadata) ?? {};
  return {
    id: row.session_id,
    type: "session",
    agent: buildSessionAgentEcho(agentId, pluginId),
    environment_id: environmentId,
    title: typeof row.name === "string" && row.name ? row.name : null,
    status: mapAgentStatusToSessionStatus(row.agent_status, row.status),
    metadata,
    resources: [],
    stats: {},
    usage: {},
    vault_ids: [],
    archived_at: row.status === "archived" ? (row.updated_at as Date | null) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `claw_sessions.agent_status`/`status` -> Anthropic `SessionStatus` enum (design doc §9.5.3). */
function mapAgentStatusToSessionStatus(agentStatus: unknown, status: unknown): string {
  if (status === "archived" || status === "deleted") return "terminated";
  if (agentStatus === "running") return "running";
  return "idle";
}

/**
 * Map one Primus-native event (as stored in `claw_session_events.data` /
 * yielded by the JetStream subscription) to zero or more Anthropic Managed
 * Agents stream events. Returns [] for event types not forwarded — the SSE
 * caller must skip those, not emit a placeholder.
 *
 * `mcpToolPrefixes` (design doc §7.1.1, v0.14/v0.15/v0.16): every MCP-sourced
 * tool name is prefixed `mcp__<server>__` — confirmed against real Brain
 * traffic (v0.13 changelog). A tool name matching one of these prefixes maps
 * to `agent.mcp_tool_use`/`agent.mcp_tool_result` (with `mcp_server_name`
 * extracted from the prefix); everything else maps to the generic
 * `agent.tool_use`/`agent.tool_result`. This is a naming-convention heuristic,
 * not a Brain-native source tag — see design doc §12 risk table.
 */
function mapPrimusEventToAnthropic(
  evt: Record<string, unknown>,
  fallbackId: string,
  mcpToolPrefixes: string[] = [],
): Record<string, unknown>[] {
  const type = evt.type;
  const processedAt = new Date().toISOString();

  if (type === "AnthropicSessionRunning") {
    return [{ id: fallbackId, type: "session.status_running", processed_at: processedAt }];
  }

  if (type === "AssistantMessage") {
    const content = asJsonObject(evt.data)?.content;
    const blocks = Array.isArray(content)
      ? content
          .filter((b: unknown) => asJsonObject(b)?.type === "text" && typeof asJsonObject(b)?.text === "string")
          .map((b: unknown) => ({ type: "text", text: (b as Record<string, unknown>).text as string }))
      : [];
    if (!blocks.length) return [];
    return [{ id: fallbackId, type: "agent.message", content: blocks, processed_at: processedAt }];
  }

  if (type === "toolUsed") {
    const tool = typeof evt.tool === "string" ? evt.tool : "unknown_tool";
    const id = typeof evt.actionId === "string" ? evt.actionId : fallbackId;
    const mcpPrefix = mcpToolPrefixes.find((p) => tool.startsWith(p));
    const mcpServerName = mcpPrefix ? mcpPrefix.slice("mcp__".length, -2) : undefined;

    if (evt.status === "start") {
      const argsDetail = asJsonObject(evt.argumentsDetail);
      const input = (argsDetail && asJsonObject(argsDetail[tool])) || {};
      return mcpServerName
        ? [{ id, type: "agent.mcp_tool_use", name: tool, input, mcp_server_name: mcpServerName, processed_at: processedAt }]
        : [{ id, type: "agent.tool_use", name: tool, input, processed_at: processedAt }];
    }

    if (evt.status === "success" || evt.status === "error") {
      const resultText = typeof evt.result === "string" ? evt.result : (typeof evt.brief === "string" ? evt.brief : "");
      const content = resultText ? [{ type: "text", text: resultText }] : [];
      const isError = evt.status === "error";
      return mcpServerName
        ? [{ id: fallbackId, type: "agent.mcp_tool_result", mcp_tool_use_id: id, content, is_error: isError, processed_at: processedAt }]
        : [{ id: fallbackId, type: "agent.tool_result", tool_use_id: id, content, is_error: isError, processed_at: processedAt }];
    }
    return [];
  }

  if (type === "exec_complete") {
    const failed = evt.failed === true;
    if (!failed) {
      return [{ id: fallbackId, type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: processedAt }];
    }
    // v0.14/v0.16: Primus failures are recoverable (agent_status='failed' still
    // accepts new messages) — closer to Anthropic's "exhausted retry budget,
    // ready for a new prompt" than to a permanent session.status_terminated.
    // Emit session.error first (so SDK users can inspect the failure), then
    // session.status_idle (not status_terminated) so `for await` resolves and
    // the session remains usable — see design doc §7.1.
    const message = typeof evt.failure_reason === "string" && evt.failure_reason
      ? evt.failure_reason
      : (typeof evt.error_message === "string" && evt.error_message ? evt.error_message : "task execution failed");
    return [
      {
        id: `${fallbackId}-error`, type: "session.error", processed_at: processedAt,
        error: { type: "unknown_error", message, retry_status: { type: "exhausted" } },
      },
      { id: fallbackId, type: "session.status_idle", stop_reason: { type: "retries_exhausted" }, processed_at: processedAt },
    ];
  }

  return [];
}

export async function registerAnthropicManagedAgentsRoutes(app: FastifyInstance): Promise<void> {

  // --- List Models / Retrieve Model (static compat view, see ANTHROPIC_COMPAT_MODEL) ---
  app.get("/anthropic/v1/models", async (_req, reply) => {
    return reply.send({
      data: [ANTHROPIC_COMPAT_MODEL],
      has_more: false,
      first_id: ANTHROPIC_COMPAT_MODEL.id,
      last_id: ANTHROPIC_COMPAT_MODEL.id,
    });
  });

  app.get<{ Params: { id: string } }>("/anthropic/v1/models/:id", async (req, reply) => {
    if (req.params.id !== ANTHROPIC_COMPAT_MODEL.id) {
      return sendError(reply, 404, "not_found_error", `model ${req.params.id} not found`);
    }
    return reply.send(ANTHROPIC_COMPAT_MODEL);
  });

  // --- Create Agent (compat view over existing plugins / default runtime) ---
  app.post("/anthropic/v1/agents", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const body = (req.body as Record<string, unknown>) ?? {};

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return sendError(reply, 400, "invalid_request_error", "name is required");
    if (body.model === undefined || body.model === null) {
      return sendError(reply, 400, "invalid_request_error", "model is required");
    }
    const system = typeof body.system === "string" ? body.system : null;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const metadataIn = asJsonObject(body.metadata) as Record<string, string> | undefined;
    const metadata = metadataIn ?? {};

    let id = "agent_default";
    if (metadataIn?.primus_claw !== undefined) {
      const hint = parsePrimusClawMetadata(metadataIn);
      if (hint === null) {
        logger.warn({ userId }, "anthropic.agents.metadata_primus_claw_unparseable");
      } else if (hint.plugin_id !== undefined) {
        if (!(await canUsePlugin(hint.plugin_id, userId, admin))) {
          return sendError(reply, 404, "not_found_error", `plugin ${hint.plugin_id} not found`);
        }
        id = `plugin_${hint.plugin_id}`;
      }
    }

    return reply.send({
      id,
      type: "agent",
      name,
      model: normalizeModelForResponse(body.model),
      system,
      tools,
      metadata,
      version: 1,
      created_at: new Date().toISOString(),
    });
  });

  // --- List Agents (P1, design doc §9.5.1) ---
  app.get("/anthropic/v1/agents", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const query = (req.query as Record<string, string | undefined>) ?? {};
    const includeArchived = query.include_archived === "true";
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const cursor = decodeCursor(query.page);
    const offset = cursor && typeof cursor[1] === "number" ? cursor[1] : 0;

    const { rows } = await MarketplaceDb.listPluginsRepo({
      viewerUserId: userId, isAdmin: admin, includeDeleted: false,
      latestPerName: false, sortField: "created_at", sortOrder: "desc",
      offset, limit,
    });
    const filtered = includeArchived ? rows : rows.filter((r) => r.status !== "archived");
    const data = offset === 0 ? [defaultAgentView(), ...filtered.map(formatAgentFromPlugin)] : filtered.map(formatAgentFromPlugin);
    const nextPage = rows.length === limit ? encodeCursor("", offset + limit) : null;
    return reply.send({ data, next_page: nextPage });
  });

  // --- Retrieve Agent (P1) ---
  app.get<{ Params: { id: string } }>("/anthropic/v1/agents/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const agentId = req.params.id;

    if (agentId === "agent_default") return reply.send(defaultAgentView());
    if (!agentId.startsWith("plugin_")) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    const n = Number(agentId.slice("plugin_".length));
    if (!Number.isFinite(n)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    const row = await MarketplaceDb.pluginGetById(n, false);
    if (!row || !canViewPlugin(row, userId, admin)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    return reply.send(formatAgentFromPlugin(row));
  });

  // --- Update Agent (P2, design doc §9.5.1 — atomic optimistic lock on anthropic_agent_version) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/agents/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const agentId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    if (agentId === "agent_default" || !agentId.startsWith("plugin_")) {
      return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    }
    const n = Number(agentId.slice("plugin_".length));
    if (!Number.isFinite(n)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    const existing = await MarketplaceDb.pluginGetById(n, false);
    if (!existing || !canViewPlugin(existing, userId, admin)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    if (!ownerOrAdmin(existing, userId, admin)) return sendError(reply, 403, "permission_error", "only the owner may update this agent");

    const expectedVersion = Number(body.version);
    if (!Number.isFinite(expectedVersion)) return sendError(reply, 400, "invalid_request_error", "version is required");

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string" || body.description === null) patch.description = body.description ?? "";
    if (Array.isArray(body.tools)) patch.tools = body.tools;
    const updated = await MarketplaceDb.pluginUpdateWithVersionCheck(n, expectedVersion, patch);
    if (!updated) {
      return sendError(reply, 409, "invalid_request_error", `version conflict: agent ${agentId} is not at version ${expectedVersion}`);
    }
    return reply.send(formatAgentFromPlugin(updated));
  });

  // --- Archive Agent (P2, design doc §9.5.1 — only blocks NEW agent/session creation, not existing sessions) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/agents/:id/archive", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const agentId = req.params.id;

    if (agentId === "agent_default" || !agentId.startsWith("plugin_")) {
      return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    }
    const n = Number(agentId.slice("plugin_".length));
    if (!Number.isFinite(n)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    const existing = await MarketplaceDb.pluginGetById(n, false);
    if (!existing || !canViewPlugin(existing, userId, admin)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    if (!ownerOrAdmin(existing, userId, admin)) return sendError(reply, 403, "permission_error", "only the owner may archive this agent");

    // status='archived' (NOT pluginSoftDelete/deleted_at) so canUsePlugin()
    // checks made by existing sessions during dispatch keep succeeding —
    // archive only blocks NEW agents.create()/sessions.create() references,
    // see canUsePlugin() below and design doc §9.5.1 v0.16 addendum.
    const updated = await MarketplaceDb.pluginUpdate(n, { status: "archived" });
    if (!updated) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    return reply.send(formatAgentFromPlugin(updated));
  });

  // --- List Agent Versions (P2 — single-version compat: only the current anthropic_agent_version) ---
  app.get<{ Params: { id: string } }>("/anthropic/v1/agents/:id/versions", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const agentId = req.params.id;

    if (agentId === "agent_default") return reply.send({ data: [defaultAgentView()], next_page: null });
    if (!agentId.startsWith("plugin_")) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    const n = Number(agentId.slice("plugin_".length));
    const row = Number.isFinite(n) ? await MarketplaceDb.pluginGetById(n, false) : null;
    if (!row || !canViewPlugin(row, userId, admin)) return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    return reply.send({ data: [formatAgentFromPlugin(row)], next_page: null });
  });

  // --- Create Environment (P0 stateless env_default view kept for backward
  // compat with the already-verified Quickstart flow; P1/P2 addendum: also
  // persist a real `resources` row, design doc §9.5.2, so list/retrieve/
  // update/delete/archive have something real to operate on. The env_default
  // response shape is UNCHANGED from P0 -- only reachable via that literal id;
  // this create call additionally returns a real resource_<id> going forward
  // is NOT what P0 tested, so we keep returning env_default here and let
  // callers who want a persisted environment use the same call -- see below. ---
  app.post("/anthropic/v1/environments", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return sendError(reply, 400, "invalid_request_error", "name is required");

    const cfgIn = asJsonObject(body.config) ?? {};
    const networking = asJsonObject(cfgIn.networking) ?? { type: "unrestricted" };
    const packages = asJsonObject(cfgIn.packages) ?? { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] };
    const description = typeof body.description === "string" ? body.description : "";
    const metadata = (asJsonObject(body.metadata) as Record<string, string> | undefined) ?? {};

    const inserted = await MarketplaceDb.resourceInsert({
      name, type: ANTHROPIC_ENV_RESOURCE_TYPE, image: "",
      resource: { anthropic_env: { description, networking, packages, metadata } },
      owner_user_id: userId,
    });
    return reply.send(formatEnvironmentFromResource(inserted));
  });

  // --- List Environments (P1, design doc §9.5.2) ---
  app.get("/anthropic/v1/environments", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const query = (req.query as Record<string, string | undefined>) ?? {};
    const includeArchived = query.include_archived === "true";
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const cursor = decodeCursor(query.page);
    const offset = cursor && typeof cursor[1] === "number" ? cursor[1] : 0;

    // Tenant isolation (align with List Agents): non-admin callers only see
    // environments they own; admins see all.
    const { rows } = await MarketplaceDb.listResourcesRepo({
      includeDeleted: false, type: ANTHROPIC_ENV_RESOURCE_TYPE, offset, limit,
      ownerUserId: userId, isAdmin: admin,
    });
    const filtered = includeArchived ? rows : rows.filter((r) => !r.archived_at);
    const data = offset === 0 ? [defaultEnvironmentView(), ...filtered.map(formatEnvironmentFromResource)] : filtered.map(formatEnvironmentFromResource);
    const nextPage = rows.length === limit ? encodeCursor("", offset + limit) : null;
    return reply.send({ data, next_page: nextPage });
  });

  // --- Retrieve Environment (P1) ---
  app.get<{ Params: { id: string } }>("/anthropic/v1/environments/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const envId = req.params.id;

    if (envId === "env_default") return reply.send(defaultEnvironmentView());
    if (!envId.startsWith("resource_")) return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    const n = Number(envId.slice("resource_".length));
    if (!Number.isFinite(n)) return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    const row = await MarketplaceDb.resourceGetById(n, false);
    if (!row || row.type !== ANTHROPIC_ENV_RESOURCE_TYPE || !ownerOrAdmin(row, userId, admin)) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    return reply.send(formatEnvironmentFromResource(row));
  });

  // --- Update Environment (P2) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/environments/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const envId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    if (envId === "env_default" || !envId.startsWith("resource_")) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    const n = Number(envId.slice("resource_".length));
    if (!Number.isFinite(n)) return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    const existing = await MarketplaceDb.resourceGetById(n, false);
    if (!existing || existing.type !== ANTHROPIC_ENV_RESOURCE_TYPE || !ownerOrAdmin(existing, userId, admin)) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    const stored = asJsonObject(asJsonObject(existing.resource)?.anthropic_env) ?? {};
    const nextStored: Record<string, unknown> = { ...stored };
    if (typeof body.name === "string") { /* environments.update() name goes to resources.name, not the JSONB */ }
    if (typeof body.description === "string" || body.description === null) nextStored.description = body.description ?? "";
    const cfgIn = asJsonObject(body.config);
    if (cfgIn?.networking !== undefined) nextStored.networking = cfgIn.networking;
    if (cfgIn?.packages !== undefined) nextStored.packages = cfgIn.packages;
    if (body.metadata !== undefined) nextStored.metadata = asJsonObject(body.metadata) ?? {};

    const patch: Record<string, unknown> = { resource: { ...asJsonObject(existing.resource), anthropic_env: nextStored } };
    if (typeof body.name === "string") patch.name = body.name;
    const updated = await MarketplaceDb.resourceUpdate(n, patch);
    if (!updated) return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    return reply.send(formatEnvironmentFromResource(updated));
  });

  // --- Delete Environment (P2 — permanent, distinct from archive) ---
  app.delete<{ Params: { id: string } }>("/anthropic/v1/environments/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const envId = req.params.id;

    if (envId === "env_default" || !envId.startsWith("resource_")) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    const n = Number(envId.slice("resource_".length));
    const existing = Number.isFinite(n) ? await MarketplaceDb.resourceGetById(n, false) : null;
    if (!existing || existing.type !== ANTHROPIC_ENV_RESOURCE_TYPE || !ownerOrAdmin(existing, userId, admin)) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    await MarketplaceDb.resourceSoftDelete(n);
    return reply.send({ id: envId, type: "environment_deleted" });
  });

  // --- Archive Environment (P2 — reversible, distinct from delete; new `resources.archived_at` column) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/environments/:id/archive", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const envId = req.params.id;

    if (envId === "env_default" || !envId.startsWith("resource_")) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    const n = Number(envId.slice("resource_".length));
    const existing = Number.isFinite(n) ? await MarketplaceDb.resourceGetById(n, false) : null;
    if (!existing || existing.type !== ANTHROPIC_ENV_RESOURCE_TYPE || !ownerOrAdmin(existing, userId, admin)) {
      return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    }
    const updated = await MarketplaceDb.resourceUpdate(n, { archived_at: new Date() });
    if (!updated) return sendError(reply, 404, "not_found_error", `environment ${envId} not found`);
    return reply.send(formatEnvironmentFromResource(updated));
  });

  // --- Create Session (real claw_sessions row; Anthropic binding snapshotted into config) ---
  app.post("/anthropic/v1/sessions", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const admin = user ? isAdmin(user) : false;
    const body = (req.body as Record<string, unknown>) ?? {};

    const agentRaw = body.agent;
    let agentId: string | undefined;
    if (typeof agentRaw === "string") agentId = agentRaw;
    else {
      const obj = asJsonObject(agentRaw);
      if (obj && typeof obj.id === "string") agentId = obj.id;
    }
    if (!agentId) return sendError(reply, 400, "invalid_request_error", "agent is required");

    const environmentId = typeof body.environment_id === "string" ? body.environment_id : undefined;
    if (!environmentId) return sendError(reply, 400, "invalid_request_error", "environment_id is required");

    let pluginId: number | undefined;
    if (agentId === "agent_default") {
      // default runtime, nothing to resolve
    } else if (agentId.startsWith("plugin_")) {
      const n = Number(agentId.slice("plugin_".length));
      if (!Number.isFinite(n) || !(await canUsePlugin(n, userId, admin))) {
        return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
      }
      pluginId = n;
    } else {
      return sendError(reply, 404, "not_found_error", `agent ${agentId} not found`);
    }

    if (environmentId !== "env_default") {
      if (!environmentId.startsWith("resource_")) {
        return sendError(reply, 404, "not_found_error", `environment ${environmentId} not found`);
      }
      const envN = Number(environmentId.slice("resource_".length));
      const envRow = Number.isFinite(envN) ? await MarketplaceDb.resourceGetById(envN, false) : null;
      if (!envRow || envRow.type !== ANTHROPIC_ENV_RESOURCE_TYPE || envRow.archived_at || !ownerOrAdmin(envRow, userId, admin)) {
        return sendError(reply, 404, "not_found_error", `environment ${environmentId} not found`);
      }
    }

    const title = typeof body.title === "string" ? body.title : null;
    const sessionId = crypto.randomUUID();

    // Optional SaFE workspace pin (== sandbox K8s namespace for Brain dispatch),
    // read from metadata.primus_claw.workspace_id mirroring the agents.create
    // hint convention. Absent/unparseable metadata yields undefined, so the
    // Brain keeps falling back to its default namespace (prior behavior).
    const workspaceId = parsePrimusClawMetadata(body.metadata)?.workspace_id;

    const primusAnthropicCompat = {
      agent_id: agentId,
      environment_id: environmentId,
      primus_claw: {
        plugin_id: pluginId,
        tool_ids: [] as number[],
        mcp_servers: {} as Record<string, unknown>,
        workspace_id: workspaceId,
        resources: {} as Record<string, unknown>,
        session_env: {} as Record<string, string>,
      },
    };

    await db.query(
      `INSERT INTO claw_sessions
       (session_id, name, user_id, mode, agent_status, agent_id, system_prompt, status, config, created_at, updated_at)
       VALUES ($1, $2, $3, 'claw', 'idle', 'agent_default', '', 'active', $4::jsonb, NOW(), NOW())`,
      [
        sessionId,
        (title || "Anthropic session").slice(0, 255),
        userId,
        JSON.stringify({ primus_anthropic_compat: primusAnthropicCompat }),
      ],
    );

    return reply.send({
      id: sessionId,
      type: "session",
      agent: buildSessionAgentEcho(agentId, pluginId),
      environment_id: environmentId,
      title,
      created_at: new Date().toISOString(),
    });
  });

  // --- List Sessions (P1, design doc §9.5.3 — real cursor over claw_sessions, not offset-encoded) ---
  app.get("/anthropic/v1/sessions", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const query = (req.query as Record<string, string | undefined>) ?? {};
    const includeArchived = query.include_archived === "true";
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const order = query.order === "asc" ? "ASC" : "DESC";
    const cursor = decodeCursor(query.page);

    const conds: string[] = ["user_id = $1", "deleted_at IS NULL"];
    const args: unknown[] = [userId];
    if (!includeArchived) conds.push("status != 'archived'");
    const gte = query["created_at[gte]"], gt = query["created_at[gt]"];
    const lte = query["created_at[lte]"], lt = query["created_at[lt]"];
    if (gte) { args.push(gte); conds.push(`created_at >= $${args.length}`); }
    if (gt) { args.push(gt); conds.push(`created_at > $${args.length}`); }
    if (lte) { args.push(lte); conds.push(`created_at <= $${args.length}`); }
    if (lt) { args.push(lt); conds.push(`created_at < $${args.length}`); }
    if (cursor) {
      const cmp = order === "DESC" ? "<" : ">";
      args.push(cursor[0], cursor[1]);
      conds.push(`(created_at, session_id) ${cmp} ($${args.length - 1}::timestamptz, $${args.length})`);
    }
    args.push(limit);
    const rows = (await db.query(
      `SELECT * FROM claw_sessions WHERE ${conds.join(" AND ")} ORDER BY created_at ${order}, session_id ${order} LIMIT $${args.length}`,
      args,
    )).rows;
    const last = rows[rows.length - 1];
    const nextPage = rows.length === limit && last ? encodeCursor(new Date(last.created_at).toISOString(), last.session_id) : null;
    return reply.send({ data: rows.map(formatSessionFromRow), next_page: nextPage });
  });

  // --- Retrieve Session (P1) ---
  app.get<{ Params: { id: string } }>("/anthropic/v1/sessions/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const row = (await db.query(
      "SELECT * FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [req.params.id],
    )).rows[0];
    if (!row || row.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    return reply.send(formatSessionFromRow(row));
  });

  // --- Update Session (P2 — title -> name column, metadata -> config sub-key, no new column) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/sessions/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    const existing = (await db.query(
      "SELECT * FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");

    if (typeof body.title === "string") {
      await db.query("UPDATE claw_sessions SET name = $1, updated_at = NOW() WHERE session_id = $2", [body.title.slice(0, 255), sessionId]);
    }
    if (body.metadata !== undefined) {
      const existingCompat = asJsonObject(asJsonObject(existing.config)?.primus_anthropic_compat) ?? {};
      const existingMeta = asJsonObject(existingCompat.metadata) ?? {};
      const patchMeta = asJsonObject(body.metadata) ?? {};
      // Merge via Map to avoid dynamic property writes with user-controlled
      // keys (property injection / prototype pollution). Object.fromEntries
      // creates own properties, so keys like "__proto__" cannot pollute.
      const mergedMap = new Map<string, unknown>(Object.entries(existingMeta));
      for (const [k, v] of Object.entries(patchMeta)) {
        if (v === null) mergedMap.delete(k); else mergedMap.set(k, v);
      }
      const mergedMeta = Object.fromEntries(mergedMap);
      await mergeSessionCompatConfig(sessionId, { metadata: mergedMeta });
    }
    const updated = (await db.query("SELECT * FROM claw_sessions WHERE session_id = $1", [sessionId])).rows[0];
    return reply.send(formatSessionFromRow(updated));
  });

  // --- Delete Session (P2 — permanent; interrupts running task + drops queued messages, design doc §9.5.3) ---
  app.delete<{ Params: { id: string } }>("/anthropic/v1/sessions/:id", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const existing = (await db.query(
      "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");

    // The same deletion the standard endpoint runs. This used to publish a bare
    // interrupt and soft-delete the row, which stops the task but leaves the
    // tombstone, the KV lock, the parked sandbox handle, the event purge, the
    // S3 workspace and the soft delete of turns/summaries/events undone -- so a
    // session deleted here kept its content and could still be dispatched to.
    try {
      await teardownSession({
        sessionId,
        // As the column holds it. Resolving a blank owner belongs with the
        // prefix builder in `workspace/prefix.ts`, which is the thing it has to
        // agree with, rather than being done once per caller.
        ownerId: existing.user_id,
        platformKey: user?.platformKey || "",
      });
    } catch (err) {
      // A refusal means the commit was not confirmed, so this request run again
      // is what finishes it -- or answers 404, if the commit landed after all.
      // That is a 503; a 500 would tell the caller to stop.
      if (!(err instanceof TeardownRefused)) throw err;
      logger.error({ sessionId, err: err.message }, "session.delete_refused");
      return sendError(reply, 503, "api_error", err.message);
    }
    // The deletion is committed either way, and what the cleanup did not finish
    // is the sweeper's. See the standard endpoint for why none of that reaches
    // the response.
    return reply.send({ id: sessionId, type: "session_deleted" });
  });

  // --- Archive Session (P2 — reversible; also interrupts + clears queue, same as delete, design doc §9.5.3) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/archive", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const existing = (await db.query(
      "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");

    try { nc.publish(interruptSubject(sessionId)); } catch { /* best effort */ }
    await interruptUnstartedChatRuns(sessionId);
    await db.query("DELETE FROM claw_pending_messages WHERE session_id = $1", [sessionId]);
    await db.query("UPDATE claw_sessions SET status = 'archived', updated_at = NOW() WHERE session_id = $1", [sessionId]);
    const updated = (await db.query("SELECT * FROM claw_sessions WHERE session_id = $1", [sessionId])).rows[0];
    return reply.send(formatSessionFromRow(updated));
  });

  // --- List Session Events (P1, design doc §9.5.4 — shares mapPrimusEventToAnthropic with the SSE stream route) ---
  app.get<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/events", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const query = (req.query as Record<string, string | undefined>) ?? {};
    const order = query.order === "desc" ? "DESC" : "ASC";
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

    const session = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!session || session.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    const { mcpToolPrefixes } = readPrimusClawConfig(session.config);

    const cursor = decodeCursor(query.page);
    const cursorId = cursor && typeof cursor[1] === "number" ? cursor[1] : (order === "DESC" ? Number.MAX_SAFE_INTEGER : 0);
    const cmp = order === "DESC" ? "<" : ">";
    const rows = (await db.query(
      `SELECT id, event_id, data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND id ${cmp} $2 ORDER BY id ${order} LIMIT $3`,
      [sessionId, cursorId, limit],
    )).rows;

    const data: Record<string, unknown>[] = [];
    for (const row of rows) {
      // Same masking the SSE stream applies. Stored events keep the raw text
      // for audit; anything leaving over the API goes through redaction.
      const rowData = sanitizeSessionEvent(
        (typeof row.data === "object" && row.data) ? row.data as Record<string, unknown> : {},
      );
      data.push(...mapPrimusEventToAnthropic(rowData, row.event_id as string, mcpToolPrefixes));
    }
    const lastRow = rows[rows.length - 1];
    const nextPage = rows.length === limit && lastRow ? encodeCursor("", lastRow.id) : null;
    return reply.send({ data, next_page: nextPage });
  });

  // --- Session Resources: Add/List/Retrieve/Update/Delete (P2, design doc §9.5.5 —
  // config-only CRUD; real mount-into-sandbox effect is deferred, Brain work) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/resources", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    const existing = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");

    const type = body.type;
    if (type !== "github_repository" && type !== "file") {
      return sendError(reply, 400, "invalid_request_error", "resources.add type must be github_repository or file");
    }
    const now = new Date().toISOString();
    const mount: Record<string, unknown> = { ...body, id: `sesrsc_${crypto.randomUUID()}`, created_at: now, updated_at: now };
    const { resourceMounts } = readPrimusClawConfig(existing.config);
    const rawPrimusClaw = asJsonObject(asJsonObject(asJsonObject(existing.config)?.primus_anthropic_compat)?.primus_claw) ?? {};
    await mergeSessionCompatConfig(sessionId, { primus_claw: { ...rawPrimusClaw, resource_mounts: [...resourceMounts, mount] } });
    return reply.send(mount);
  });

  app.get<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/resources", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const row = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [req.params.id],
    )).rows[0];
    if (!row || row.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    const { resourceMounts } = readPrimusClawConfig(row.config);
    return reply.send({ data: resourceMounts, next_page: null });
  });

  app.get<{ Params: { id: string; resourceId: string } }>("/anthropic/v1/sessions/:id/resources/:resourceId", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const row = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [req.params.id],
    )).rows[0];
    if (!row || row.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    const { resourceMounts } = readPrimusClawConfig(row.config);
    const mount = resourceMounts.find((m) => m.id === req.params.resourceId);
    if (!mount) return sendError(reply, 404, "not_found_error", "session resource not found");
    return reply.send(mount);
  });

  app.post<{ Params: { id: string; resourceId: string } }>("/anthropic/v1/sessions/:id/resources/:resourceId", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    const existing = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    const { resourceMounts } = readPrimusClawConfig(existing.config);
    const idx = resourceMounts.findIndex((m) => m.id === req.params.resourceId);
    if (idx === -1) return sendError(reply, 404, "not_found_error", "session resource not found");

    const updatedMount = { ...resourceMounts[idx], ...body, id: req.params.resourceId, updated_at: new Date().toISOString() };
    const nextMounts = [...resourceMounts];
    nextMounts[idx] = updatedMount;
    const rawPrimusClaw = asJsonObject(asJsonObject(asJsonObject(existing.config)?.primus_anthropic_compat)?.primus_claw) ?? {};
    await mergeSessionCompatConfig(sessionId, { primus_claw: { ...rawPrimusClaw, resource_mounts: nextMounts } });
    return reply.send(updatedMount);
  });

  app.delete<{ Params: { id: string; resourceId: string } }>("/anthropic/v1/sessions/:id/resources/:resourceId", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;

    const existing = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!existing || existing.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
    const { resourceMounts } = readPrimusClawConfig(existing.config);
    if (!resourceMounts.some((m) => m.id === req.params.resourceId)) return sendError(reply, 404, "not_found_error", "session resource not found");

    const nextMounts = resourceMounts.filter((m) => m.id !== req.params.resourceId);
    const rawPrimusClaw = asJsonObject(asJsonObject(asJsonObject(existing.config)?.primus_anthropic_compat)?.primus_claw) ?? {};
    await mergeSessionCompatConfig(sessionId, { primus_claw: { ...rawPrimusClaw, resource_mounts: nextMounts } });
    return reply.send({ id: req.params.resourceId, type: "resource_deleted" });
  });

  // --- Send Session Events (user.message -> shared Brain dispatch) ---
  app.post<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/events", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;
    const body = (req.body as Record<string, unknown>) ?? {};

    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return sendError(reply, 400, "invalid_request_error", "events must be a non-empty array");

    // --- user.interrupt (P1, design doc §10): reuse the existing native
    // interrupt.<sessionId> NATS channel — no new Brain capability needed. ---
    if (events.length === 1 && asJsonObject(events[0])?.type === "user.interrupt") {
      const row = (await db.query(
        "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
        [sessionId],
      )).rows[0];
      if (!row || row.user_id !== userId) return sendError(reply, 404, "not_found_error", "session not found");
      try { nc.publish(interruptSubject(sessionId)); } catch { /* best effort, mirrors routes/sessions.ts */ }
      await interruptUnstartedChatRuns(sessionId);
      const evt = { id: `evt_${Date.now()}`, type: "user.interrupt", processed_at: new Date().toISOString() };
      return reply.send({ data: [evt] });
    }

    const textParts: string[] = [];
    for (const ev of events) {
      const evObj = asJsonObject(ev);
      if (!evObj || evObj.type !== "user.message") {
        return sendError(reply, 400, "invalid_request_error", "only user.message events are supported in P0");
      }
      const content = evObj.content;
      if (!Array.isArray(content) || !content.length) {
        return sendError(reply, 400, "invalid_request_error", "user.message.content must be a non-empty array");
      }
      for (const block of content) {
        const blockObj = asJsonObject(block);
        if (!blockObj || blockObj.type !== "text" || typeof blockObj.text !== "string") {
          return sendError(reply, 400, "invalid_request_error", "only text content blocks are supported in P0");
        }
        textParts.push(blockObj.text);
      }
    }
    const messageContent = textParts.join("\n");
    if (!messageContent) return sendError(reply, 400, "invalid_request_error", "content required");

    const sessionRow = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!sessionRow || sessionRow.user_id !== userId) {
      return sendError(reply, 404, "not_found_error", "session not found");
    }
    const { pluginId, workspaceId, mcpServers, resources, sessionEnv, mcpToolPrefixes: existingMcpPrefixes } = readPrimusClawConfig(sessionRow.config);

    // Resolve+persist real MCP server name prefixes once per session (design
    // doc §7.1.1) so agent.tool_use vs agent.mcp_tool_use classification in
    // the stream route (which reads session config fresh per request) has
    // real data instead of always falling back to an empty list. Cheap (2
    // indexed SELECTs) and idempotent; skipped once already recorded.
    if (pluginId !== undefined && existingMcpPrefixes.length === 0) {
      const resolvedPrefixes = await resolveMcpToolPrefixesForPlugin(pluginId);
      if (resolvedPrefixes.length) {
        // Merge into the RAW (snake_case) primus_claw sub-object, not the
        // camelCase shape readPrimusClawConfig() returns for internal use.
        const rawPrimusClaw = asJsonObject(asJsonObject(asJsonObject(sessionRow.config)?.primus_anthropic_compat)?.primus_claw) ?? {};
        await mergeSessionCompatConfig(sessionId, { primus_claw: { ...rawPrimusClaw, mcp_tool_prefixes: resolvedPrefixes } });
      }
    }

    // Transaction: lock row -> queue (agent busy) or flip to running (idle).
    // Mirrors the native POST /v1/sessions/:id/messages flow exactly so both
    // entry points share identical queueing semantics.
    const client = await db.pool.connect();
    let queued = false;
    let capturedUserEnvSnapshot: Record<string, string> = {};
    try {
      await client.query("BEGIN");
      const lockResult = await client.query(
        "SELECT agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL FOR UPDATE",
        [sessionId],
      );
      if (!lockResult.rows.length) {
        await client.query("ROLLBACK");
        return sendError(reply, 404, "not_found_error", "session not found");
      }
      const status = lockResult.rows[0].agent_status;
      const userEnvSnapshot = await loadUserEnvSnapshot(client, userId, logger);
      if (status === "running") {
        const secrets = pendingSecretColumns({
          llmKey: resolveUserLlmKey(user) || "",
          platformKey: user?.platformKey || "",
          userEnv: userEnvSnapshot,
          doorbell: RUN_DOORBELL_DISPATCH,
        });
        await client.query(
          "INSERT INTO claw_pending_messages (session_id, content, user_id, plugin_id, tool_ids, workspace_id, platform_key, llm_api_key, credentials_blob, image, resources, timeout, user_env, session_env) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb)",
          [
            sessionId, messageContent, userId,
            pluginId ?? null, JSON.stringify([]), workspaceId ?? null,
            secrets.platform, secrets.llm, secrets.blob,
            null, resources ? JSON.stringify(resources) : null, null,
            JSON.stringify(secrets.userEnv), JSON.stringify(sessionEnv),
          ],
        );
        await client.query("COMMIT");
        queued = true;
      } else {
        capturedUserEnvSnapshot = userEnvSnapshot;
        await client.query(
          "UPDATE claw_sessions SET agent_status = 'running', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL",
          [sessionId],
        );
        await client.query("COMMIT");
      }
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const sentEvent = { id: `evt_${Date.now()}`, type: "user.message", content: [{ type: "text", text: messageContent }], processed_at: new Date().toISOString() };
    if (queued) {
      return reply.send({ data: [sentEvent] });
    }

    // session.status_running (P1, design doc §7.1): no native Brain event
    // exists for "turn started" — synthesize one at the same dispatch moment
    // the DB flips to agent_status='running', persisted+published the same
    // way dispatchTaskToBrain does for UserMessage so history replay and live
    // tailing both see it through the one mapPrimusEventToAnthropic() path.
    try {
      const runningId = `claw-running-${Date.now()}`;
      const runningEvt = { type: "AnthropicSessionRunning", message_id: runningId, data: {} };
      await db.query(
        "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, session_id) DO NOTHING",
        [runningId, sessionId, "AnthropicSessionRunning", runningEvt],
      );
      const { sc: natsCodec, nc: natsConn } = await import("../infra/nats.js");
      const { eventSubject } = await import("@claw/protocol");
      natsConn.publish(`sse.${eventSubject(sessionId)}`, natsCodec.encode(JSON.stringify(runningEvt)));
    } catch (err) {
      logger.warn({ err, sessionId }, "anthropic.session_status_running.publish_failed");
    }

    const dispatch = await dispatchTaskToBrain(
      {
        sessionId, userId, user,
        content: messageContent,
        messageType: "text",
        toolIds: [],
        pluginId,
        requestImage: undefined,
        requestResource: resources,
        requestTimeout: undefined,
        workspaceId,
        mcpServers,
        capturedUserEnvSnapshot,
        capturedSessionEnv: sessionEnv,
      },
      async () => {
        await db.query(
          "UPDATE claw_sessions SET agent_status = 'idle', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL",
          [sessionId],
        );
      },
    );
    if (dispatch.kind === "publish_failed") {
      return sendError(reply, 503, "api_error", "internal dispatch failed");
    }
    if (dispatch.kind === "rejected") {
      return sendError(reply, 429, "rate_limit_error", dispatch.reason);
    }

    return reply.send({ data: [{ ...sentEvent, id: dispatch.messageId }] });
  });

  // --- Stream Session Events (Primus native event -> Anthropic event, over SSE) ---
  // Real path is `/events/stream` (sub-path of the events resource), NOT
  // `/stream` directly on the session — confirmed against actual SDK request
  // traffic; the original design doc had this wrong (fixed in v0.12).
  app.get<{ Params: { id: string } }>("/anthropic/v1/sessions/:id/events/stream", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const sessionId = req.params.id;

    const session = (await db.query(
      "SELECT user_id, config, agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!session || session.user_id !== userId) {
      return sendError(reply, 404, "not_found_error", "session not found");
    }
    const { mcpToolPrefixes } = readPrimusClawConfig(session.config);

    // Detect the anthropic-cli client (never matches the JS/Go SDK or curl) so
    // the idle-close workaround below stays scoped to it alone. See
    // CLI_STREAM_CLOSE_ON_IDLE for why this is needed.
    const userAgent = String(req.headers["user-agent"] ?? "");
    const isCliClient = CLI_STREAM_CLOSE_ON_IDLE &&
      (/Anthropic\/CLI/i.test(userAgent) || "x-stainless-cli-command" in req.headers);
    // A turn is in flight iff agent_status is 'running' (set by events.send,
    // cleared to 'idle' when the turn ends). Decides whether a CLI stream can
    // close right after history replay (already idle) or must stay open until
    // the running turn emits session.status_idle.
    const turnRunningAtConnect = session.agent_status === "running";

    // Eager-ready: the consumer must exist before we resolve the SDK's
    // stream() promise, otherwise an events.send() called immediately after
    // (the documented Quickstart order) can race the lazy consumer and drop
    // the first agent.message. See events/store.ts::createSessionSubscriptionReady.
    const subscription = await createSessionSubscriptionReady(sessionId);
    if (!subscription) {
      return sendError(reply, 503, "api_error", "failed to initialize event stream");
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const sseWrite = (frame: string): boolean => {
      try { res.write(frame); return true; } catch { return false; }
    };

    const seenIds = new Set<string>();

    const historyRows = (await db.query(
      "SELECT event_id, data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL ORDER BY id",
      [sessionId],
    )).rows;
    for (const row of historyRows) {
      const data = sanitizeSessionEvent(
        (typeof row.data === "object" && row.data) ? row.data as Record<string, unknown> : {},
      );
      const eid = row.event_id as string;
      const mappedList = mapPrimusEventToAnthropic(data, eid, mcpToolPrefixes);
      if (!mappedList.length) continue;
      seenIds.add(eid);
      for (const mapped of mappedList) {
        sseWrite(`id: ${mapped.id}\nevent: ${mapped.type}\ndata: ${JSON.stringify(mapped)}\n\n`);
      }
    }

    // Keepalive + cleanup-on-close mirror routes/events.ts exactly (v0.11
    // design fix: without this the eager JetStream consumer above leaks on
    // every stream() call once the client disconnects).
    const keepAlive = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { /* client gone */ }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(keepAlive);
      subscription.close();
    });

    // CLI workaround: if the session is already idle at connect time, the whole
    // turn is in history (just replayed) and nothing live is coming — close now
    // so the CLI's buffered iterator terminates and flushes. SDK/curl are never
    // matched by isCliClient, so they keep the persistent stream.
    if (isCliClient && !turnRunningAtConnect) {
      clearInterval(keepAlive);
      res.end();
      return reply;
    }

    try {
      for await (const item of subscription.eventsWithSeq()) {
        if (!item) continue;
        const { event: evt, seq } = item;
        const liveId = `claw-${seq}`;
        if (seenIds.has(liveId)) continue;
        const mappedList = mapPrimusEventToAnthropic(evt, liveId, mcpToolPrefixes);
        if (!mappedList.length) continue;
        seenIds.add(liveId);
        let ok = true;
        let idleReached = false;
        for (const mapped of mappedList) {
          if (!sseWrite(`id: ${mapped.id}\nevent: ${mapped.type}\ndata: ${JSON.stringify(mapped)}\n\n`)) { ok = false; break; }
          if (isCliClient && mapped.type === "session.status_idle") idleReached = true;
        }
        if (!ok) break;
        // CLI workaround: end the stream once idle is delivered so the CLI
        // flushes and exits instead of blocking on the next event forever.
        if (idleReached) break;
      }
    } catch { /* subscription ended or client disconnected */ }

    clearInterval(keepAlive);
    res.end();
    return reply;
  });
}
