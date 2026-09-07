// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db, MarketplaceDb, type StatementRunner } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { js, sc, nc } from "../infra/nats.js";
import { sanitizeSessionEvent } from "../events/store.js";
import { getUser } from "../auth/middleware.js";
import { canWriteSessionAsOperator, type UserInfo } from "../auth/models.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { formatPluginRow, pluginSandboxImage } from "../marketplace/plugins.js";
import {
  decideAdmission, envAdmitLimits, sessionTreeShape, withOwnedAdmissionLock,
  type AdmissionAsk,
} from "../tasks/admission.js";
import { openChatRun } from "../tasks/chat-run.js";
import { gpuNodesFromSpec, topologyErrors } from "../tasks/run-spec.js";
import type { EnvironmentTopology } from "@claw/protocol";
import { ErrorCode, NatsError } from "nats";
import pino from "pino";
import { randomUUID } from "node:crypto";
import {
  type AgentCard, type AgentSkill, type Task, type Message,
  type Part, type StreamResponse,
  type TaskStatusUpdateEvent, type TaskArtifactUpdateEvent,
  type SendMessageRequest, type GetTaskRequest, type ListTasksRequest,
  type ListTasksResponse, type CancelTaskRequest, type SubscribeToTaskRequest,
  type JsonRpcRequest, type JsonRpcResponse,
  TaskState, Role, TERMINAL_STATES,
  A2A_METHODS,
  JSON_RPC_PARSE_ERROR, JSON_RPC_INVALID_REQUEST, JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INVALID_PARAMS, JSON_RPC_INTERNAL_ERROR,
  makeJsonRpcSuccess, makeJsonRpcError, makeA2AErrorDetail, makeTaskNotFoundError,
  type JsonRpcErrorResponse,
  makeUnsupportedOperationError, makePushNotificationNotSupportedError,
  makeTaskNotCancelableError, makeVersionNotSupportedError,
} from "./a2a-types.js";

const logger = pino({ name: "a2a-server" });
const SUPPORTED_A2A_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Session isolation — the caller identity used to scope SendMessage / GetTask /
// ListTasks / CancelTask so Agent X cannot see Agent Y's sessions.
//
// This is the tenant boundary for the whole A2A surface, so it is derived
// *only* from the validated SaFE user attached by `authMiddleware`. Earlier
// revisions fell back to `metadata.callerId`, a hash of an unvalidated Bearer
// token, and finally the peer IP. Those fallbacks were unreachable in practice
// — `POST /a2a` has always required authentication, so a request that reaches
// this function already has a verified user — but a client-supplied tenant id
// sitting one refactor away from being live is not a boundary worth keeping.
// An unidentified caller is now rejected instead of being assigned a guessable
// identity.
// ---------------------------------------------------------------------------
function extractCallerId(req: FastifyRequest): string | null {
  const user = getUser(req);
  return user?.userId ? `user:${user.userId}` : null;
}

function firstTransportValue(raw: unknown): string | undefined {
  if (Array.isArray(raw)) return firstTransportValue(raw[0]);
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return undefined;
}

function requestedA2AVersion(req: FastifyRequest): string {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const raw = req.headers["a2a-version"] ?? query["A2A-Version"] ?? query["a2a-version"];
  const value = firstTransportValue(raw)?.trim();
  // Per A2A v1.0, an empty version value is interpreted as protocol 0.3.
  return value || "0.3";
}

function validateA2AVersion(req: FastifyRequest, rpcId: string | number | null): JsonRpcResponse | null {
  const version = requestedA2AVersion(req);
  if (version !== SUPPORTED_A2A_VERSION) {
    return makeVersionNotSupportedError(rpcId, version);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent Card — full Google A2A v1.0 spec
// ---------------------------------------------------------------------------
function buildAgentCard(): AgentCard {
  const baseUrl = process.env.CLAW_PUBLIC_URL || "";
  return {
    name: "PrimusClaw",
    description: "AI Agent operating system for code generation, debugging, and deployment on AMD infrastructure",
    version: "2.0.0",
    provider: { url: "https://www.amd.com", organization: "AMD" },
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer", description: "Bearer token authentication" } },
    },
    securityRequirements: [{ bearer: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      { id: "code-generation", name: "Code Generation", description: "Generate, edit, and refactor code in any language", tags: ["code", "generation", "refactor"] },
      { id: "debugging", name: "Debugging", description: "Debug code issues with automated root cause analysis", tags: ["debug", "error", "fix"] },
      { id: "code-review", name: "Code Review", description: "Review code for quality, security, and best practices", tags: ["review", "security", "quality"] },
      { id: "optimization", name: "Performance Optimization", description: "Optimize code and model inference performance on AMD GPUs", tags: ["performance", "gpu", "amd"] },
    ] satisfies AgentSkill[],
    iconUrl: undefined,
  };
}

const AGENT_CARD = buildAgentCard();

// ---------------------------------------------------------------------------
// DB ↔ A2A mapping helpers
// ---------------------------------------------------------------------------
function mapAgentStatusToTaskState(agentStatus: string | null): TaskState {
  switch (agentStatus) {
    case "running": return TaskState.WORKING;
    case "completed": return TaskState.COMPLETED;
    case "failed": return TaskState.FAILED;
    case "cancelled": return TaskState.CANCELED;
    case "pending": return TaskState.SUBMITTED;
    case "idle": return TaskState.COMPLETED;
    case "input_required": return TaskState.INPUT_REQUIRED;
    default: return TaskState.SUBMITTED;
  }
}

function taskStateToAgentStatus(state: TaskState): string {
  switch (state) {
    case TaskState.SUBMITTED: return "pending";
    case TaskState.WORKING: return "running";
    case TaskState.COMPLETED: return "completed";
    case TaskState.FAILED: return "failed";
    case TaskState.CANCELED: return "cancelled";
    case TaskState.INPUT_REQUIRED: return "input_required";
    default: return "pending";
  }
}

function extractTextFromParts(parts: Part[]): string {
  return parts
    .map((p) => p.text ?? (typeof p.data === "string" ? p.data : ""))
    .filter(Boolean)
    .join("\n");
}

async function buildTaskFromDb(
  sessionId: string,
  historyLength?: number,
  includeArtifacts = true,
  callerId?: string,
): Promise<Task | null> {
  const query = callerId
    ? `SELECT session_id, agent_status, context_id, config, created_at, updated_at
       FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL AND a2a_caller_id = $2`
    : `SELECT session_id, agent_status, context_id, config, created_at, updated_at
       FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL`;
  const params = callerId ? [sessionId, callerId] : [sessionId];
  const sessResult = await db.query(query, params);
  if (!sessResult.rows?.length) return null;
  const row = sessResult.rows[0] as Record<string, unknown>;

  const state = mapAgentStatusToTaskState(row.agent_status as string);
  const task: Task = {
    id: sessionId,
    contextId: (row.context_id as string) || undefined,
    status: {
      state,
      timestamp: ((row.updated_at as Date | undefined) ?? (row.created_at as Date | undefined))?.toISOString(),
    },
  };

  if (historyLength !== 0) {
    const limit = historyLength && historyLength > 0 ? historyLength : 50;
    const turnsResult = await db.query(
      `SELECT role, content, created_at FROM claw_conversation_turns
       WHERE session_id = $1 AND deleted_at IS NULL
       ORDER BY turn_index DESC LIMIT $2`,
      [sessionId, limit],
    );
    if (turnsResult.rows?.length) {
      task.history = (turnsResult.rows as Array<Record<string, unknown>>)
        .reverse()
        .map((t) => ({
          messageId: randomUUID(),
          role: (t.role as string) === "assistant" ? Role.AGENT : Role.USER,
          parts: [{ text: t.content as string }],
        }));
    }
  }

  if (includeArtifacts) {
    const eventsResult = await db.query(
      `SELECT event_id, data FROM claw_session_events
       WHERE session_id = $1 AND event = 'ResultMessage' AND deleted_at IS NULL
       ORDER BY id`,
      [sessionId],
    );
    if (eventsResult.rows?.length) {
      task.artifacts = (eventsResult.rows as Array<Record<string, unknown>>).map((e, i) => {
        // A result message repeats whatever the agent produced, so it is masked
        // like every other event that leaves the API.
        const data = e.data
          ? sanitizeSessionEvent(e.data as Record<string, unknown>)
          : undefined;
        const content = (data?.content as string) ?? JSON.stringify(data);
        return {
          artifactId: (e.event_id as string) || `artifact-${i}`,
          parts: [{ text: content }],
        };
      });
    }
  }

  return task;
}

interface SendTarget {
  taskId: string;
  contextId: string;
  created: boolean;
  /**
   * The values {@link TOUCHED_TARGET_COLUMNS} held before this send wrote them.
   *
   * Only for an existing target: a rollback restores them rather than deleting
   * a session the caller has been using.
   */
  preImage?: Record<string, unknown>;
}

/**
 * The columns a send writes on a target that already exists.
 *
 * The pre-image SELECT and the rollback UPDATE are both generated from this
 * list, so a column added to the update below must be added here or the
 * rollback silently stops restoring it.
 */
const TOUCHED_TARGET_COLUMNS = ["agent_status", "context_id", "updated_at"] as const;

function hasUnsupportedPushConfig(configuration: SendMessageRequest["configuration"]): boolean {
  return configuration?.taskPushNotificationConfig !== undefined;
}

async function resolveSendTarget(
  message: Message,
  text: string,
  callerId: string,
  rpcId: string | number,
  q: StatementRunner,
): Promise<{ target?: SendTarget; error?: JsonRpcResponse }> {
  if (message.taskId) {
    const result = await q.query(
      `SELECT session_id, agent_status, context_id, ${TOUCHED_TARGET_COLUMNS.join(", ")}
       FROM claw_sessions
       WHERE session_id = $1 AND deleted_at IS NULL AND a2a_caller_id = $2`,
      [message.taskId, callerId],
    );
    if (!result.rows?.length) {
      return { error: makeTaskNotFoundError(rpcId, message.taskId) };
    }

    const row = result.rows[0] as Record<string, unknown>;
    const state = mapAgentStatusToTaskState(row.agent_status as string);
    if (TERMINAL_STATES.has(state)) {
      return {
        error: makeUnsupportedOperationError(
          rpcId,
          "Messages sent to terminal tasks cannot be accepted",
        ),
      };
    }

    const existingContextId = (row.context_id as string) || "";
    if (message.contextId && existingContextId && message.contextId !== existingContextId) {
      return makeInvalidParams(rpcId, "message.contextId does not match message.taskId");
    }

    const preImage = Object.fromEntries(TOUCHED_TARGET_COLUMNS.map((c) => [c, row[c]]));
    const contextId = existingContextId || message.contextId || `ctx-${randomUUID()}`;
    await q.query(
      `UPDATE claw_sessions
       SET agent_status = 'pending', context_id = $2, updated_at = NOW()
       WHERE session_id = $1 AND deleted_at IS NULL`,
      [message.taskId, contextId],
    );
    return { target: { taskId: message.taskId, contextId, created: false, preImage } };
  }

  const taskId = `a2a-${randomUUID()}`;
  const contextId = message.contextId || `ctx-${randomUUID()}`;
  await q.query(
    `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, text.slice(0, 80), "a2a", "claw", "pending", contextId, callerId],
  );
  return { target: { taskId, contextId, created: true } };
}

function makeInvalidParams(id: string | number, message: string): { error: JsonRpcResponse } {
  return { error: makeJsonRpcError(id, JSON_RPC_INVALID_PARAMS, message) };
}

interface A2AAuthContext {
  userId: string;
  roles: string[];
  platformKey: string;
  virtualKey: string;
}


/**
 * The one resolved definition of an A2A execution.
 *
 * Built before anything is written, so the admission ask, the counted row and
 * the publish payload all derive from the same value and cannot disagree about
 * what the execution will hold. Deriving the ask from raw metadata instead read
 * a sandbox the request had not asked for as none, and never saw a GPU node.
 */
interface A2ARunSpec {
  messageId: string;
  sandboxImage?: string;
  resources?: Record<string, unknown>;
  topology?: EnvironmentTopology;
  pluginId?: number;
  pluginTools?: unknown[];
  workspaceId?: string;
  parentSessionId?: string;
  teamRole?: string;
}

async function resolveA2ARunSpec(
  messageId: string,
  metadata?: Record<string, unknown>,
): Promise<{ spec: A2ARunSpec } | { invalidTopology: string[] }> {
  const invalid = topologyErrors(metadata);
  if (invalid) return { invalidTopology: invalid };

  const rawPluginId = metadata?.plugin_id !== undefined ? Number(metadata.plugin_id) : undefined;
  const pluginId = rawPluginId !== undefined && Number.isFinite(rawPluginId) ? rawPluginId : undefined;
  let pluginTools: unknown[] | undefined;
  let pluginImage: string | undefined;
  let pluginResource: Record<string, unknown> | undefined;
  if (pluginId !== undefined) {
    const pluginRow = await MarketplaceDb.pluginGetById(pluginId, false);
    if (pluginRow) {
      const formatted = await formatPluginRow(pluginRow, true);
      pluginTools = (formatted.tools as unknown[]) ?? [];
      pluginImage = pluginSandboxImage(formatted.images) || undefined;
      pluginResource = asJsonObject(formatted.resource);
    }
  }

  // Sandbox image / resources resolution chain (mirrors routes/sessions.ts):
  // metadata (request body) > plugin row > default workload row.
  const defaultResourceRow = await MarketplaceDb.resourceFirstByType("default");
  const defaultRes = asJsonObject(defaultResourceRow?.resource) || {};
  const defaultImage = String(defaultResourceRow?.image ?? "").trim() || undefined;
  const requestImage = (metadata?.sandbox_image as string | undefined)?.trim() || undefined;
  const resources = asJsonObject(metadata?.resources) || pluginResource || defaultRes;

  return {
    spec: {
      messageId,
      sandboxImage: requestImage || pluginImage || defaultImage,
      resources: Object.keys(resources).length ? resources : undefined,
      topology: metadata?.topology as EnvironmentTopology | undefined,
      pluginId,
      pluginTools,
      workspaceId: (metadata?.workspace_id as string) || undefined,
      parentSessionId: (metadata?.parent_session_id as string) || undefined,
      teamRole: (metadata?.team_role as string) || undefined,
    },
  };
}

/**
 * What an A2A send asks the fleet for, before anything is written.
 *
 * A send is a tree of one as a *run* root and not as a session tree: the
 * parent attachment builds a team tree of any depth, so a request naming a
 * parent is decided on the prospective shape -- one node and one level past it
 * -- and one naming an existing target on that target's own shape.
 */
async function a2aAdmissionAsk(
  targetSessionId: string | null,
  spec: A2ARunSpec,
  client?: StatementRunner,
): Promise<AdmissionAsk> {
  const ask: AdmissionAsk = {
    origin: "a2a",
    newRunRoots: 1,
    sandboxes: spec.sandboxImage ? 1 : 0,
    gpuNodes: gpuNodesFromSpec({ topology: spec.topology }),
  };
  const limits = envAdmitLimits();
  if (limits.treeMaxNodes <= 0 && limits.treeMaxDepth <= 0) return ask;
  if (spec.parentSessionId) {
    const shape = await sessionTreeShape(spec.parentSessionId, client);
    return {
      ...ask,
      treeRootId: shape.rootId,
      treeNodeCount: shape.nodeCount + 1,
      treeDepth: shape.depth + 1,
    };
  }
  if (!targetSessionId) return ask;
  const shape = await sessionTreeShape(targetSessionId, client);
  return { ...ask, treeRootId: shape.rootId, treeNodeCount: shape.nodeCount, treeDepth: shape.depth };
}

/**
 * Open the counted run row for one A2A execution.
 *
 * The identity of an execution is the pair `(session_id, message_id)`, held by
 * `idx_tasks_a2a_execution`: without it a resend of one pair observes the
 * single row the aggregate collapsed it to, clears the ceiling, and executes
 * indefinitely while being counted once.
 *
 * @returns null when the pair already has its execution, so nothing is
 *   published and the request answers with that task's state.
 */
async function openA2ARun(
  target: SendTarget,
  text: string,
  auth: A2AAuthContext,
  spec: A2ARunSpec,
): Promise<string | null> {
  const run = await openChatRun({
    dispatch: "fat",
    origin: "a2a",
    sessionId: target.taskId,
    userId: auth.userId || "a2a",
    messageId: spec.messageId,
    prompt: text,
    status: "preparing",
    issueLease: false,
    recordWorkspaceUse: false,
    sandboxSpec: spec.sandboxImage ? "default" : undefined,
    sandboxImage: spec.sandboxImage,
    workspaceId: spec.workspaceId,
    // The declared topology goes on the row the ceiling counts, or the GPU
    // demand the ask was charged for is invisible to every later admission.
    spec: spec.topology ? { topology: spec.topology } : undefined,
  });
  if (!run) {
    logger.info({ taskId: target.taskId, messageId: spec.messageId }, "a2a.execution_already_counted");
    return null;
  }
  return run.taskId;
}

/**
 * A deferral has no identity a client could poll, so it is an explicit
 * retryable error rather than a task at `SUBMITTED`. Distinct from a refusal,
 * so an operator can tell a full fleet from an over-ceiling request.
 */
function makeAdmissionDeferredError(rpcId: string | number): JsonRpcErrorResponse {
  return makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "admission_deferred", [
    makeA2AErrorDetail("admission_deferred", { retry_after_seconds: A2A_DEFER_RETRY_SECONDS }),
  ]);
}

function makeAdmissionRejectedError(
  rpcId: string | number,
  reason: string,
): JsonRpcErrorResponse {
  return makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "admission_rejected", [
    makeA2AErrorDetail("admission_rejected", { reason }),
  ]);
}

/** How long a deferred A2A caller is told to wait. One scheduler tick is too eager. */
const A2A_DEFER_RETRY_SECONDS = 5;

/** What one admitted-and-materialised send left behind, or why it left nothing. */
type A2AEntry =
  | { kind: "opened"; target: SendTarget; taskId: string }
  | { kind: "duplicate"; target: SendTarget }
  | { kind: "rejected"; reason: string }
  | { kind: "deferred" }
  | { kind: "error"; error: JsonRpcResponse };

/**
 * Decide and materialise one send under a single hold of the admission lock.
 *
 * The tree shape, the decision, the session write and the parent attachment all
 * run on the locked transaction, so two concurrent children of one parent cannot
 * both pass a stale shape and both be admitted.
 *
 * The counted row is written last, and deliberately not on that transaction:
 * `openChatRun` binds the pool, so it commits as it is written. Nothing after it
 * can fail before the lock transaction commits, which is what keeps the pair
 * from separating.
 */
async function admitAndOpenA2ASend(
  message: Message,
  text: string,
  callerId: string,
  rpcId: string | number,
  auth: A2AAuthContext,
  spec: A2ARunSpec,
): Promise<A2AEntry> {
  return await countingCreatedSession(withOwnedAdmissionLock(async (client) => {
    const ask = await a2aAdmissionAsk(message.taskId ?? null, spec, client);
    const decision = await decideAdmission(ask, client);
    if (decision.kind === "reject") return { kind: "rejected", reason: decision.reason };
    if (decision.kind === "queue") return { kind: "deferred" };

    const { target, error } = await resolveSendTarget(message, text, callerId, rpcId, client);
    if (error) return { kind: "error", error };
    if (!target) {
      return {
        kind: "error",
        error: makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to resolve task target"),
      };
    }
    await attachA2AParent(target.taskId, auth, spec, client);
    const taskId = await openA2ARun(target, text, auth, spec);
    return taskId ? { kind: "opened", target, taskId } : { kind: "duplicate", target };
  }));
}

/**
 * Count a session this send minted, once its transaction has committed.
 *
 * Inside the lock the insert is still provisional -- a throw before the commit
 * rolls it back -- so counting there would name sessions no row backs.
 */
async function countingCreatedSession(entry: Promise<A2AEntry>): Promise<A2AEntry> {
  const settled = await entry;
  const created = (settled.kind === "opened" || settled.kind === "duplicate")
    && settled.target.created;
  if (created) metrics.onSessionCreated("ok");
  return settled;
}

/**
 * Attach the request's parent link, once the caller is shown to own the parent.
 *
 * Inside the admission lock and before the counted row: a throw here must leave
 * no row behind, and the tree ceiling was decided against the shape this write
 * produces.
 */
async function attachA2AParent(
  taskId: string,
  auth: A2AAuthContext,
  spec: A2ARunSpec,
  q: StatementRunner,
): Promise<void> {
  if (!spec.parentSessionId) return;
  const parent = (await q.query(
    "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [spec.parentSessionId],
  )).rows[0] as { user_id?: string | null } | undefined;
  const caller: UserInfo = {
    userId: auth.userId,
    userName: auth.userId,
    roles: auth.roles,
    platformKey: auth.platformKey,
    virtualKey: auth.virtualKey,
  };
  if (!parent || !canWriteSessionAsOperator(parent.user_id, caller)) {
    throw new Error("parent_session_access_denied");
  }
  await q.query(
    "UPDATE claw_sessions SET parent_session_id = $1, team_role = $2 WHERE session_id = $3",
    [spec.parentSessionId, spec.teamRole || "", taskId],
  );
}

async function publishA2AExecuteTask(
  taskId: string,
  text: string,
  auth: A2AAuthContext,
  spec: A2ARunSpec,
): Promise<void> {
  const payload: Record<string, unknown> = {
    session_id: taskId,
    message_id: spec.messageId,
    prompt: text,
    history: [],
    user_id: auth.userId || "a2a",
    platform_key: auth.platformKey,
    llm_api_key: auth.virtualKey,
    workspace_id: spec.workspaceId,
    parent_session_id: spec.parentSessionId,
    team_role: spec.teamRole,
  };
  if (spec.pluginId !== undefined) {
    payload.plugin_id = spec.pluginId;
    payload.plugin_tools = spec.pluginTools ?? [];
  }
  if (spec.topology) payload.topology = spec.topology;
  // Brain ensureHands requires `sandbox_image` to create a K8s workload, and
  // reads `request.resources` (top-level) for the workload spec.
  if (spec.sandboxImage) {
    payload.sandbox_image = spec.sandboxImage;
    if (spec.resources) payload.resources = spec.resources;
  }
  await js.publish("tasks.execute", sc.encode(JSON.stringify(payload)));
}

/**
 * Codes that prove the bytes never reached JetStream.
 *
 * Everything else -- a timeout, a closed or draining connection, an unknown
 * code, an error that is not a `NatsError` at all -- is ambiguous: the message
 * may be on the stream with only the `PubAck` lost, so the row is cancelled
 * rather than deleted. Deleting the accounting for work that may be running is
 * bounded by nothing; holding it is bounded by the budget.
 */
const PRE_DELIVERY_ERROR_CODES = new Set<string>([ErrorCode.NoResponders]);

function publishWasPreDelivery(err: unknown): boolean {
  return err instanceof NatsError && PRE_DELIVERY_ERROR_CODES.has(err.code);
}

/**
 * Settle the counted row and the session a failed publish left behind.
 *
 * Without it the row holds its slice of every ceiling until its deadline, which
 * is the stranding this compensation exists to prevent.
 */
async function rollbackA2AAdmission(
  target: SendTarget,
  taskId: string,
  err: unknown,
): Promise<void> {
  try {
    if (!publishWasPreDelivery(err)) {
      await db.query(
        `UPDATE claw_tasks SET status = 'cancelling'
          WHERE task_id = $1 AND origin = 'a2a' AND status IN ('preparing','running')`,
        [taskId],
      );
      await js.publish(
        `tasks.${target.taskId}.cancel`,
        sc.encode(JSON.stringify({ type: "cancel", session_id: target.taskId })),
      ).catch(() => { /* the row's deadline is the backstop */ });
      return;
    }
    await db.query(
      "DELETE FROM claw_tasks WHERE task_id = $1 AND origin = 'a2a' AND status = 'preparing'",
      [taskId],
    );
    if (target.created) {
      await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [target.taskId]);
      return;
    }
    if (!target.preImage) return;
    const assignments = TOUCHED_TARGET_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(", ");
    await db.query(
      `UPDATE claw_sessions SET ${assignments} WHERE session_id = $1`,
      [target.taskId, ...TOUCHED_TARGET_COLUMNS.map((c) => target.preImage![c])],
    );
  } catch (rollbackErr) {
    logger.error({ err: rollbackErr, taskId }, "a2a.publish_rollback_failed");
  }
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (Object.values(TaskState) as string[]).includes(value);
}

// Narrow an unknown value to a plain JSON object (mirrors routes/sessions.ts).
function asJsonObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

interface ListCursor {
  updatedAt: string;
  sessionId: string;
}

function encodePageToken(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodePageToken(pageToken: string): ListCursor | null {
  try {
    const padded = pageToken.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(pageToken.length / 4) * 4, "=");
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Partial<ListCursor>;
    if (typeof decoded.updatedAt === "string" && typeof decoded.sessionId === "string") {
      return { updatedAt: decoded.updatedAt, sessionId: decoded.sessionId };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC method handlers
// ---------------------------------------------------------------------------

async function handleSendMessage(
  params: SendMessageRequest,
  rpcId: string | number,
  callerId: string,
  auth: A2AAuthContext,
): Promise<JsonRpcResponse> {
  const { message, configuration, metadata } = params;
  if (hasUnsupportedPushConfig(configuration)) {
    return makePushNotificationNotSupportedError(rpcId);
  }
  if (!message?.parts?.length) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "message.parts is required and must be non-empty");
  }

  const text = extractTextFromParts(message.parts);
  if (!text) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "No text content found in message parts");
  }

  const resolved = await resolveA2ARunSpec(message.messageId, metadata as Record<string, unknown> | undefined);
  if ("invalidTopology" in resolved) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, resolved.invalidTopology.join("; "));
  }

  try {
    const entry = await admitAndOpenA2ASend(message, text, callerId, rpcId, auth, resolved.spec);
    if (entry.kind === "rejected") return makeAdmissionRejectedError(rpcId, entry.reason);
    if (entry.kind === "deferred") return makeAdmissionDeferredError(rpcId);
    if (entry.kind === "error") return entry.error;
    const target = entry.target;

    if (entry.kind === "opened") {
      try {
        await publishA2AExecuteTask(target.taskId, text, auth, resolved.spec);
      } catch (err) {
        await rollbackA2AAdmission(target, entry.taskId, err);
        throw err;
      }
    }

    logger.info({
      taskId: target.taskId,
      contextId: target.contextId,
      created: target.created,
      textLen: text.length,
      pluginId: metadata?.plugin_id,
    }, "a2a.SendMessage");

    const task: Task = {
      id: target.taskId,
      contextId: target.contextId,
      status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
    };

    // Spec §3.2.2: `returnImmediately` defaults to FALSE — the operation
    // MUST block until the task reaches a terminal or interrupted state.
    // Only return immediately when the client explicitly opts in.
    if (configuration?.returnImmediately === true) {
      return makeJsonRpcSuccess(rpcId, { task });
    }

    // Blocking mode (spec default): poll until terminal/interrupted state
    const maxWait = 120_000;
    const pollInterval = 1_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const built = await buildTaskFromDb(target.taskId, configuration?.historyLength, true, callerId);
      if (!built) break;
      if (TERMINAL_STATES.has(built.status.state) || built.status.state === TaskState.INPUT_REQUIRED || built.status.state === TaskState.AUTH_REQUIRED) {
        return makeJsonRpcSuccess(rpcId, { task: built });
      }
    }

    const finalTask = await buildTaskFromDb(target.taskId, configuration?.historyLength, true, callerId);
    return makeJsonRpcSuccess(rpcId, { task: finalTask ?? task });
  } catch (err: unknown) {
    logger.error({ err, taskId: message?.taskId ?? null }, "a2a.SendMessage.failed");
    return makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task");
  }
}

async function handleGetTask(
  params: GetTaskRequest,
  rpcId: string | number,
  callerId: string,
): Promise<JsonRpcResponse> {
  if (!params.id) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "id is required");
  }
  const task = await buildTaskFromDb(params.id, params.historyLength, true, callerId);
  if (!task) return makeTaskNotFoundError(rpcId, params.id);
  return makeJsonRpcSuccess(rpcId, task);
}

async function handleListTasks(
  params: ListTasksRequest,
  rpcId: string | number,
  callerId: string,
): Promise<JsonRpcResponse> {
  const pageSize = params.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "pageSize must be an integer between 1 and 100");
  }
  if (params.historyLength !== undefined && (!Number.isInteger(params.historyLength) || params.historyLength < 0)) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "historyLength must be a non-negative integer");
  }
  if (params.status !== undefined && !isTaskState(params.status)) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "status must be a valid TaskState");
  }

  let statusTimestampAfter: Date | null = null;
  if (params.statusTimestampAfter) {
    const parsed = new Date(params.statusTimestampAfter);
    if (Number.isNaN(parsed.getTime())) {
      return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "statusTimestampAfter must be an ISO 8601 timestamp");
    }
    statusTimestampAfter = parsed;
  }

  let cursor: ListCursor | null = null;
  if (params.pageToken) {
    cursor = decodePageToken(params.pageToken);
    if (!cursor || Number.isNaN(new Date(cursor.updatedAt).getTime())) {
      return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "pageToken is invalid");
    }
  }

  const conditions: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  let paramIdx = 1;

  // Scope to caller's own sessions
  conditions.push(`a2a_caller_id = $${paramIdx++}`);
  values.push(callerId);

  if (params.contextId) {
    conditions.push(`context_id = $${paramIdx++}`);
    values.push(params.contextId);
  }
  if (params.status !== undefined) {
    if (params.status === TaskState.COMPLETED) {
      conditions.push(`agent_status IN ($${paramIdx++}, $${paramIdx++})`);
      values.push("completed", "idle");
    } else {
      const agentStatus = taskStateToAgentStatus(params.status);
      conditions.push(`agent_status = $${paramIdx++}`);
      values.push(agentStatus);
    }
  }
  if (statusTimestampAfter) {
    conditions.push(`updated_at >= $${paramIdx++}`);
    values.push(statusTimestampAfter);
  }

  const where = conditions.join(" AND ");
  const countValues = [...values];

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM claw_sessions WHERE ${where}`,
    countValues,
  );
  const totalSize = parseInt((countResult.rows[0] as Record<string, unknown>).total as string, 10) || 0;

  let dataWhere = where;
  if (cursor) {
    dataWhere = `${dataWhere} AND (updated_at < $${paramIdx++} OR (updated_at = $${paramIdx++} AND session_id < $${paramIdx++}))`;
    values.push(new Date(cursor.updatedAt), new Date(cursor.updatedAt), cursor.sessionId);
  }

  values.push(pageSize + 1);
  const dataResult = await db.query(
    `SELECT session_id, updated_at
     FROM claw_sessions WHERE ${dataWhere}
     ORDER BY updated_at DESC, session_id DESC
     LIMIT $${paramIdx++}`,
    values,
  );

  const rows = dataResult.rows as Array<Record<string, unknown>>;
  const pageRows = rows.slice(0, pageSize);
  const tasks = (await Promise.all(
    pageRows.map((row) => buildTaskFromDb(
      row.session_id as string,
      params.historyLength,
      params.includeArtifacts === true,
      callerId,
    )),
  )).filter((task): task is Task => task !== null);

  const lastRow = pageRows[pageRows.length - 1];
  const response: ListTasksResponse = {
    tasks,
    nextPageToken: rows.length > pageSize && lastRow
      ? encodePageToken({
        updatedAt: (lastRow.updated_at as Date).toISOString(),
        sessionId: lastRow.session_id as string,
      })
      : "",
    pageSize,
    totalSize,
  };

  return makeJsonRpcSuccess(rpcId, response);
}

async function handleCancelTask(
  params: CancelTaskRequest,
  rpcId: string | number,
  callerId: string,
): Promise<JsonRpcResponse> {
  if (!params.id) {
    return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "id is required");
  }

  const result = await db.query(
    "SELECT session_id, agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL AND a2a_caller_id = $2",
    [params.id, callerId],
  );
  if (!result.rows?.length) return makeTaskNotFoundError(rpcId, params.id);

  const currentStatus = (result.rows[0] as Record<string, unknown>).agent_status as string;
  const currentState = mapAgentStatusToTaskState(currentStatus);
  if (TERMINAL_STATES.has(currentState)) {
    return makeTaskNotCancelableError(rpcId, params.id, currentState);
  }

  await db.query(
    "UPDATE claw_sessions SET agent_status = 'cancelled', updated_at = NOW() WHERE session_id = $1",
    [params.id],
  );
  // `cancelling` rather than a terminal state: the execution may be live off
  // JetStream with no lease to prove it, and the state is in both counted sets,
  // so the slot is held exactly as long as the work is.
  await db.query(
    `UPDATE claw_tasks SET status = 'cancelling'
      WHERE session_id = $1 AND origin = 'a2a' AND status IN ('preparing','running')`,
    [params.id],
  );

  try {
    const cancelPayload = { type: "cancel", session_id: params.id };
    await js.publish(`tasks.${params.id}.cancel`, sc.encode(JSON.stringify(cancelPayload)));
  } catch (err) {
    logger.warn({ err, taskId: params.id }, "a2a.CancelTask.nats_publish_failed");
  }

  logger.info({ taskId: params.id }, "a2a.CancelTask");

  const task: Task = {
    id: params.id,
    status: { state: TaskState.CANCELED, timestamp: new Date().toISOString() },
  };
  return makeJsonRpcSuccess(rpcId, task);
}

// ---------------------------------------------------------------------------
// SSE streaming helpers
// ---------------------------------------------------------------------------

function sseWrite(raw: FastifyReply["raw"], rpcId: string | number, response: StreamResponse): void {
  const payload = makeJsonRpcSuccess(rpcId, response);
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

interface MappedStreamEvent {
  responses: StreamResponse[];
  terminal: boolean;
}

// Stable artifact IDs per task. With these, every chunk emitted with
// `append: true` accumulates into the same Artifact on the client side,
// matching A2A spec §4.2.2 (append is keyed on artifactId).
function textArtifactId(taskId: string): string {
  return `${taskId}-text`;
}
function toolArtifactId(taskId: string): string {
  return `${taskId}-tools`;
}

interface StreamingState {
  textStarted: boolean;
  toolsStarted: boolean;
}

function makeTerminalStream(
  taskId: string,
  contextId: string,
  state: TaskState,
  s: StreamingState,
): StreamResponse[] {
  const out: StreamResponse[] = [];
  const ts = new Date().toISOString();
  // Close any artifact streams we opened, so clients know they're complete.
  if (s.textStarted) {
    out.push({
      artifactUpdate: {
        taskId,
        contextId,
        artifact: { artifactId: textArtifactId(taskId), parts: [{ text: "" }] },
        append: true,
        lastChunk: true,
      } satisfies TaskArtifactUpdateEvent,
    });
  }
  if (s.toolsStarted) {
    out.push({
      artifactUpdate: {
        taskId,
        contextId,
        artifact: { artifactId: toolArtifactId(taskId), parts: [{ text: "" }] },
        append: true,
        lastChunk: true,
      } satisfies TaskArtifactUpdateEvent,
    });
  }
  out.push({
    statusUpdate: {
      taskId,
      contextId,
      status: { state, timestamp: ts },
    } satisfies TaskStatusUpdateEvent,
  });
  return out;
}

function mapInternalEventToStream(
  taskId: string,
  contextId: string,
  event: Record<string, unknown>,
  s: StreamingState,
): MappedStreamEvent | null {
  const type = event.type as string;
  switch (type) {
    case "AssistantMessage":
    case "chat":
    case "chatDelta": {
      const data = event.data as Record<string, unknown> | undefined;
      const arr = data?.content as Array<Record<string, unknown>> | undefined;
      const text = (arr?.[0]?.text as string) || (event.content as string) || "";
      if (!text) return null;
      s.textStarted = true;
      const artifactUpdate: TaskArtifactUpdateEvent = {
        taskId,
        contextId,
        artifact: {
          artifactId: textArtifactId(taskId),
          parts: [{ text }],
        },
        append: true,
        lastChunk: false,
      };
      return { responses: [{ artifactUpdate }], terminal: false };
    }
    case "ResultMessage": {
      const subtype = (event.data as Record<string, unknown>)?.subtype;
      const state = subtype === "success" ? TaskState.COMPLETED : TaskState.FAILED;
      return { responses: makeTerminalStream(taskId, contextId, state, s), terminal: true };
    }
    case "toolUsed": {
      if ((event.status as string) === "success") {
        const text = `[Tool: ${event.tool}] ${((event.description as string) || "").slice(0, 500)}`;
        s.toolsStarted = true;
        const artifactUpdate: TaskArtifactUpdateEvent = {
          taskId,
          contextId,
          artifact: {
            artifactId: toolArtifactId(taskId),
            parts: [{ text }],
          },
          append: true,
          lastChunk: false,
        };
        return { responses: [{ artifactUpdate }], terminal: false };
      }
      return null;
    }
    case "statusUpdate": {
      if ((event.agentStatus as string) === "stopped") {
        return {
          responses: makeTerminalStream(taskId, contextId, TaskState.COMPLETED, s),
          terminal: true,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

async function handleSendStreamingMessage(
  params: SendMessageRequest,
  rpcId: string | number,
  reply: FastifyReply,
  callerId: string,
  auth: A2AAuthContext,
): Promise<void> {
  const { message, configuration, metadata } = params;
  if (hasUnsupportedPushConfig(configuration)) {
    reply.send(makePushNotificationNotSupportedError(rpcId));
    return;
  }
  if (!message?.parts?.length) {
    reply.status(400).send(makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "message.parts is required"));
    return;
  }

  const text = extractTextFromParts(message.parts);
  if (!text) {
    reply.status(400).send(makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "No text content"));
    return;
  }

  const resolved = await resolveA2ARunSpec(message.messageId, metadata as Record<string, unknown> | undefined);
  if ("invalidTopology" in resolved) {
    reply.status(400).send(
      makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, resolved.invalidTopology.join("; ")),
    );
    return;
  }

  let entry: A2AEntry;
  try {
    entry = await admitAndOpenA2ASend(message, text, callerId, rpcId, auth, resolved.spec);
  } catch (err: unknown) {
    logger.error({ err, taskId: message.taskId ?? null }, "a2a.SendStreamingMessage.resolve_failed");
    reply.status(500).send(makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task"));
    return;
  }
  // Answered over the ordinary JSON-RPC reply, before any subscription or SSE
  // header: suppressing only the publish leaves a socket that never receives an
  // event and never closes, and opening the stream to write one deferral event
  // and close it reads to an SSE client as a completed task.
  if (entry.kind === "rejected") {
    reply.send(makeAdmissionRejectedError(rpcId, entry.reason));
    return;
  }
  if (entry.kind === "deferred") {
    reply.send(makeAdmissionDeferredError(rpcId));
    return;
  }
  if (entry.kind === "error") {
    reply.send(entry.error);
    return;
  }
  const target = entry.target;

  // Subscribe before publishing. Core NATS does not replay, so any event
  // emitted between publish and subscribe would otherwise be silently lost.
  // NB: Brain publishes to `events.{sessionId}` (no sub-tokens), so we must
  // subscribe to the exact subject, not `events.{id}.>` which requires ≥1
  // sub-token and would never match.
  const sub = nc.subscribe(`events.${target.taskId}`);

  if (entry.kind === "opened") {
    try {
      await publishA2AExecuteTask(target.taskId, text, auth, resolved.spec);
    } catch (err: unknown) {
      await rollbackA2AAdmission(target, entry.taskId, err);
      logger.error({ err, taskId: target.taskId }, "a2a.SendStreamingMessage.failed");
      sub.unsubscribe();
      reply.status(500).send(makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task"));
      return;
    }
  }
  logger.info({
    taskId: target.taskId,
    contextId: target.contextId,
    created: target.created,
    pluginId: metadata?.plugin_id,
  }, "a2a.SendStreamingMessage");

  const keepalive = openA2AStream(reply, rpcId, target, sub);
  await pumpA2AStream(sub, reply, rpcId, target, keepalive);
}

/** The stream's opening frame and its keepalive, armed together with the close handler. */
function openA2AStream(
  reply: FastifyReply,
  rpcId: string | number,
  target: SendTarget,
  sub: ReturnType<typeof nc.subscribe>,
): StreamLifetime {
  sseHeaders(reply);
  const initialTask: Task = {
    id: target.taskId,
    contextId: target.contextId,
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  };
  sseWrite(reply.raw, rpcId, { task: initialTask });

  const lifetime: StreamLifetime = { closed: false, timer: null };
  lifetime.timer = setInterval(() => {
    if (lifetime.closed) return;
    reply.raw.write(": keepalive\n\n");
  }, 15_000);
  reply.raw.on("close", () => {
    lifetime.closed = true;
    if (lifetime.timer) clearInterval(lifetime.timer);
    sub.unsubscribe();
  });
  return lifetime;
}

interface StreamLifetime {
  closed: boolean;
  timer: NodeJS.Timeout | null;
}

async function pumpA2AStream(
  sub: ReturnType<typeof nc.subscribe>,
  reply: FastifyReply,
  rpcId: string | number,
  target: SendTarget,
  lifetime: StreamLifetime,
): Promise<void> {
  const streamState: StreamingState = { textStarted: false, toolsStarted: false };
  try {
    for await (const msg of sub) {
      if (lifetime.closed) break;
      try {
        const event = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
        const mapped = mapInternalEventToStream(target.taskId, target.contextId, event, streamState);
        if (!mapped) continue;
        for (const resp of mapped.responses) sseWrite(reply.raw, rpcId, resp);
        if (mapped.terminal) {
          lifetime.closed = true;
          if (lifetime.timer) clearInterval(lifetime.timer);
          reply.raw.end();
          sub.unsubscribe();
          break;
        }
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    logger.warn({ err, taskId: target.taskId }, "a2a.stream_error");
    if (lifetime.closed) return;
    const errStatus: TaskStatusUpdateEvent = {
      taskId: target.taskId,
      contextId: target.contextId,
      status: { state: TaskState.FAILED, message: { messageId: randomUUID(), role: Role.AGENT, parts: [{ text: "Stream error" }] }, timestamp: new Date().toISOString() },
    };
    sseWrite(reply.raw, rpcId, { statusUpdate: errStatus });
    reply.raw.end();
  }
}

async function handleSubscribeToTask(
  params: SubscribeToTaskRequest,
  rpcId: string | number,
  reply: FastifyReply,
  callerId: string,
): Promise<void> {
  if (!params.id) {
    reply.status(400).send(makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, "id is required"));
    return;
  }

  const task = await buildTaskFromDb(params.id, undefined, true, callerId);
  if (!task) {
    reply.status(404).send(makeTaskNotFoundError(rpcId, params.id));
    return;
  }

  if (TERMINAL_STATES.has(task.status.state)) {
    reply.send(makeUnsupportedOperationError(rpcId, "Task is already in a terminal state"));
    return;
  }

  const sub = nc.subscribe(`events.${params.id}`);
  sseHeaders(reply);
  sseWrite(reply.raw, rpcId, { task });

  const contextId = task.contextId || "";
  let closed = false;
  const keepalive = setInterval(() => {
    if (closed) return;
    reply.raw.write(": keepalive\n\n");
  }, 15_000);

  reply.raw.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    sub.unsubscribe();
  });

  const streamState: StreamingState = { textStarted: false, toolsStarted: false };
  try {
    for await (const msg of sub) {
      if (closed) break;
      try {
        const event = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
        const mapped = mapInternalEventToStream(params.id, contextId, event, streamState);
        if (mapped) {
          for (const resp of mapped.responses) sseWrite(reply.raw, rpcId, resp);
          if (mapped.terminal) {
            closed = true;
            clearInterval(keepalive);
            reply.raw.end();
            sub.unsubscribe();
            break;
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    logger.warn({ err, taskId: params.id }, "a2a.subscribe_error");
    if (!closed) reply.raw.end();
  } finally {
    clearInterval(keepalive);
    sub.unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher
// ---------------------------------------------------------------------------

const PUSH_NOTIFICATION_METHODS: Set<string> = new Set([
  A2A_METHODS.CreateTaskPushNotificationConfig,
  A2A_METHODS.GetTaskPushNotificationConfig,
  A2A_METHODS.ListTaskPushNotificationConfigs,
  A2A_METHODS.DeleteTaskPushNotificationConfig,
]);

async function dispatch(
  rpc: JsonRpcRequest,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<JsonRpcResponse | null> {
  const { method, params, id } = rpc;
  const p = (params ?? {}) as Record<string, unknown>;
  const callerId = extractCallerId(req);
  if (!callerId) {
    return makeJsonRpcError(id, JSON_RPC_INVALID_REQUEST, "authentication required");
  }

  if (PUSH_NOTIFICATION_METHODS.has(method)) {
    return makePushNotificationNotSupportedError(id);
  }

  const user = getUser(req);
  const auth: A2AAuthContext = {
    userId: user?.userId || "a2a",
    roles: user?.roles ?? [],
    platformKey: user?.platformKey || "",
    virtualKey: resolveUserLlmKey(user),
  };

  switch (method) {
    case A2A_METHODS.SendMessage:
      return handleSendMessage(p as unknown as SendMessageRequest, id, callerId, auth);

    case A2A_METHODS.SendStreamingMessage:
      await handleSendStreamingMessage(p as unknown as SendMessageRequest, id, reply, callerId, auth);
      return null; // SSE handled inline

    case A2A_METHODS.GetTask:
      return handleGetTask(p as unknown as GetTaskRequest, id, callerId);

    case A2A_METHODS.ListTasks:
      return handleListTasks(p as unknown as ListTasksRequest, id, callerId);

    case A2A_METHODS.CancelTask:
      return handleCancelTask(p as unknown as CancelTaskRequest, id, callerId);

    case A2A_METHODS.SubscribeToTask:
      await handleSubscribeToTask(p as unknown as SubscribeToTaskRequest, id, reply, callerId);
      return null;

    case A2A_METHODS.GetExtendedAgentCard:
      return makeUnsupportedOperationError(id, "Extended agent card is not supported");

    default:
      return makeJsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerA2ARoutes(app: FastifyInstance): Promise<void> {

  // === Agent Card (public, unauthenticated) ===
  // Spec §8.2: the canonical well-known URI in v1.0 is
  // `/.well-known/agent-card.json`. The plain `agent.json` paths are kept
  // for v0.x clients (e.g. older SaFE Gateway scanners) during transition.
  const serveAgentCard = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    return AGENT_CARD;
  };
  app.get("/.well-known/agent-card.json", serveAgentCard);
  app.get("/a2a/.well-known/agent-card.json", serveAgentCard);
  app.get("/.well-known/agent.json", serveAgentCard); // legacy v0.x
  app.get("/a2a/.well-known/agent.json", serveAgentCard); // legacy v0.x

  // === Health (for SaFE K8s scanner) ===
  app.get("/a2a/health", async () => ({ status: "ok", service: "claw-a2a" }));

  // === JSON-RPC 2.0 endpoint ===
  // Encapsulated in its own Fastify scope so a JSON-body parse failure
  // (FST_ERR_CTP_INVALID_JSON_BODY) is converted to a spec-compliant
  // JSON-RPC -32700 response instead of Fastify's default 400 envelope.
  await app.register(async (rpcScope) => {
    rpcScope.setErrorHandler((err, _req, reply) => {
      const e = err as { code?: string; statusCode?: number; message?: string };
      const isParseError =
        e.code === "FST_ERR_CTP_INVALID_JSON_BODY"
        || e.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
        || (e.statusCode === 400 && /JSON|parse/i.test(e.message ?? ""));
      if (isParseError) {
        reply.status(200).send(
          makeJsonRpcError(null, JSON_RPC_PARSE_ERROR, "Invalid JSON payload"),
        );
        return;
      }
      reply.send(err);
    });

    rpcScope.post("/a2a", async (req: FastifyRequest, reply: FastifyReply) => {
      const rpc = req.body as JsonRpcRequest | undefined;
      if (
        !rpc
        || rpc.jsonrpc !== "2.0"
        || !rpc.method
        || rpc.id === undefined
        || (typeof rpc.id !== "string" && typeof rpc.id !== "number" && rpc.id !== null)
      ) {
        return makeJsonRpcError(
          (rpc?.id ?? null) as string | number | null,
          JSON_RPC_INVALID_REQUEST,
          "Request payload validation error: must include jsonrpc='2.0', method, and id",
        );
      }

      const versionError = validateA2AVersion(req, rpc.id);
      if (versionError) return versionError;

      try {
        const result = await dispatch(rpc, req, reply);
        if (result === null) return; // SSE streaming handled inline
        return result;
      } catch (err: unknown) {
        logger.error({ err, method: rpc.method }, "a2a.dispatch.unhandled");
        return makeJsonRpcError(rpc.id, JSON_RPC_INTERNAL_ERROR, "Internal error");
      }
    });
  });

  // === SaFE Gateway backward-compatible endpoints ===
  app.post<{ Params: { skill?: string } }>("/invoke/:skill", async (req, reply) => {
    return handleLegacyInvoke(req.body as Record<string, unknown>, req.params.skill, reply);
  });
  app.post("/invoke", async (req, reply) => {
    return handleLegacyInvoke(req.body as Record<string, unknown>, undefined, reply);
  });
}

/** The identity a legacy invoke executes under: it carries no authenticated caller. */
const LEGACY_INVOKE_AUTH: A2AAuthContext = {
  userId: "a2a", roles: [], platformKey: "", virtualKey: "",
};

async function handleLegacyInvoke(
  body: Record<string, unknown>,
  skill: string | undefined,
  reply: FastifyReply,
): Promise<unknown> {
  const question = (body.question as string) || "";
  const msgParts = (body.message as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
  const text = question
    || (Array.isArray(msgParts) ? msgParts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n") : "")
    || "";

  if (!text) {
    reply.status(400);
    return { success: false, error: "question is required" };
  }

  // This path declares nothing: no sandbox image, no topology and no parent, so
  // the spec that reaches the ask and the row is the empty one rather than the
  // resolved chain a `message/send` gets.
  const spec: A2ARunSpec = { messageId: randomUUID() };
  const target: SendTarget = { taskId: `a2a-${randomUUID()}`, contextId: "", created: true };

  let entry: A2AEntry;
  try {
    entry = await admitLegacyInvoke(target, text, spec);
  } catch (err: unknown) {
    logger.error({ err, taskId: target.taskId }, "a2a.legacy_invoke.failed");
    reply.status(500);
    return { success: false, error: "Failed to process request" };
  }
  if (entry.kind === "rejected") {
    reply.status(429);
    return { success: false, error: "admission_rejected", reason: entry.reason };
  }
  if (entry.kind === "deferred") {
    reply.status(429).header("Retry-After", String(A2A_DEFER_RETRY_SECONDS));
    return { success: false, error: "admission_deferred" };
  }

  try {
    const payload = { session_id: target.taskId, prompt: text, history: [], user_id: "a2a" };
    await js.publish("tasks.execute", sc.encode(JSON.stringify(payload)));
  } catch (err: unknown) {
    if (entry.kind === "opened") await rollbackA2AAdmission(target, entry.taskId, err);
    logger.error({ err, taskId: target.taskId }, "a2a.legacy_invoke.failed");
    reply.status(500);
    return { success: false, error: "Failed to process request" };
  }

  logger.info({ taskId: target.taskId, skill, textLen: text.length }, "a2a.legacy_invoke");
  return {
    success: true,
    result: {
      skill_id: skill || "general",
      task_id: target.taskId,
      answer: `Task ${target.taskId} submitted.`,
    },
  };
}

/** The legacy path's half of {@link admitAndOpenA2ASend}: it mints its own session. */
async function admitLegacyInvoke(
  target: SendTarget,
  text: string,
  spec: A2ARunSpec,
): Promise<A2AEntry> {
  return await countingCreatedSession(withOwnedAdmissionLock(async (client) => {
    const decision = await decideAdmission(await a2aAdmissionAsk(null, spec, client), client);
    if (decision.kind === "reject") return { kind: "rejected", reason: decision.reason };
    if (decision.kind === "queue") return { kind: "deferred" };
    await client.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [target.taskId, text.slice(0, 80), "a2a", "claw", "pending"],
    );
    const taskId = await openA2ARun(target, text, LEGACY_INVOKE_AUTH, spec);
    return taskId ? { kind: "opened", target, taskId } : { kind: "duplicate", target };
  }));
}
