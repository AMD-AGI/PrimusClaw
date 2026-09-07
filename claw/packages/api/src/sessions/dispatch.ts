// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ─────────────────────────────────────────────────────────────────
// Shared session/message dispatch helper.
//
// Extracted from routes/sessions.ts so both the native `/v1/sessions`
// family and the Anthropic Managed Agents compatibility routes
// (routes/anthropic-managed-agents.ts) publish tasks to Brain through
// the exact same code path — no duplicated plugin/resource/MCP
// resolution logic between the two entry points.
// ─────────────────────────────────────────────────────────────────

import { db, MarketplaceDb } from "../infra/db.js";
import { canViewPlugin, formatPluginRow, pluginSandboxImage } from "../marketplace/plugins.js";
import { js, sc, nc, publishCertainlyFailed } from "../infra/nats.js";
import { isAdmin, type UserInfo } from "../auth/models.js";
import { buildMessages } from "./context-builder.js";
import { selectSkillsForTask } from "../marketplace/skill-service.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { eventSubject, taskSubject, type EnvironmentTopology } from "@claw/protocol";
import {
  failChatRunDispatch, noteRefusedPublish, openChatRun, recordDispatchSeq, recordPublishState,
  SWEEPABLE_RUN_STATUSES,
} from "../tasks/chat-run.js";
import { beginDoorbellDispatch } from "../tasks/doorbell-gate.js";
import { handOffAssembledRun, publishRunMessage } from "../tasks/run-dispatch.js";
import { decideAdmission } from "../tasks/admission.js";
import { ensureSessionWorkspace, requireWorkspaceBinding } from "../workspace/store.js";
import pino from "pino";

const logger = pino({ name: "session-dispatch" });

/**
 * Seam over the collaborators a test has to replace.
 *
 * `js` / `nc` are live bindings on a frozen module namespace, and `openChatRun`
 * reaches a database this path already talks to for other reasons -- replacing
 * the helpers themselves is how a test can fail the row without standing up
 * either.
 */
export const sessionDispatchPorts = {
  openChatRun,
  failChatRunDispatch,
  doorbellDispatch: beginDoorbellDispatch,
  admit: decideAdmission,
  publishSse(sessionId: string, payload: string): void {
    nc.publish(`sse.${eventSubject(sessionId)}`, sc.encode(payload));
  },
  async publishTask(subject: string, payload: string, msgId?: string): Promise<number> {
    return (await js.publish(subject, sc.encode(payload), msgId ? { msgID: msgId } : undefined)).seq;
  },
};

const SANDBOX_IMAGE_RE = /(?:^|\s)sandboximage:\s*(\S+)/im;

export function asJsonObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

export interface DispatchInput {
  sessionId: string;
  userId: string;
  user: UserInfo | null;
  content: string;
  messageType: string;
  toolIds: number[];
  pluginId: number | undefined;
  requestImage: string | undefined;
  requestResource: Record<string, unknown> | undefined;
  requestTimeout: number | undefined;
  workspaceId: string | undefined;
  mcpServers: Record<string, Record<string, unknown>> | undefined;
  capturedUserEnvSnapshot: Record<string, string>;
  capturedSessionEnv: Record<string, string>;
  /** Supplied by a caller that took the gate, so marker and turn are one string. */
  messageId?: string;
  /** Cleanup owed if a doorbell publish is left for reconciliation. */
  reconcileAction?: "idle_existing_session" | "delete_created_session";
  /**
   * The environment this run declares it needs (node count, per-node shape,
   * backend). Validated by the route, so by the time it reaches here it is
   * either absent or well-formed.
   */
  topology?: EnvironmentTopology;
}

export type DispatchResult =
  | { kind: "dispatched"; messageId: string; sandboxImage: string | undefined }
  | { kind: "queued"; messageId: string; sandboxImage: string | undefined; queuePosition: number; runId: string }
  | { kind: "rejected"; messageId: string; reason: string }
  | { kind: "publish_failed"; messageId: string; error: Error }
  /**
   * Nothing is settled: unlike `publish_failed` no cleanup has run, and the row
   * may still be claimable, so the caller must not idle or delete the session.
   */
  | { kind: "publish_unknown"; messageId: string; error: Error };

/**
 * Brain-dispatch helper shared by native `POST /v1/sessions[/:id/messages]`
 * and the Anthropic-compatible `POST /anthropic/v1/sessions/:id/events`.
 *
 * Caller must parse/validate the body, check ownership, and commit the
 * row-locking transaction (agent_status idle -> running) BEFORE calling this
 * helper. This helper only does the post-commit side effects: bind the
 * workspace, persist + publish the UserMessage event, build history, resolve
 * skills/tools/sandbox/resources, and publish the task to JetStream. On failure
 * before the task is published, it runs the caller-supplied `onPublishFailure`
 * rollback -- which is why the binding is the first thing done and not the
 * last: the rollback cannot take back an event that has already been published
 * to subscribers.
 */
export function newChatMessageId(): string {
  return `claw-${Date.now()}`;
}

export async function dispatchTaskToBrain(
  input: DispatchInput,
  onPublishFailure: () => Promise<void>,
): Promise<DispatchResult> {
  const {
    sessionId, userId, user, content, toolIds, pluginId,
    requestImage, requestResource, requestTimeout, workspaceId,
    mcpServers, capturedUserEnvSnapshot, capturedSessionEnv, topology,
  } = input;

  const messageId = input.messageId ?? newChatMessageId();
  let subject = "";
  // Shadow row for this turn, written before anything is published so a
  // process that dies mid-dispatch leaves a record rather than nothing. Not
  // read by anything yet -- see tasks/chat-run.ts for why it is written first
  // and relied on second.
  let runTaskId: string | null = null;
  try {
    // Bound before anything is written, and bound once.
    //
    // A turn that cannot be bound to a workspace is refused rather than
    // dispatched, because the gate would fall back to a key that lets two runs
    // write one directory (see requireWorkspaceBinding). The refusal has to
    // leave nothing behind, which is why it comes first: this used to run after
    // the UserMessage was persisted and published, and the rollback only
    // returns the session to idle -- so a refused turn stayed in the
    // conversation, answered by nobody, and was handed to the model as history
    // on the next turn.
    //
    // The id is then passed down to openChatRun rather than resolved again
    // there. Two lookups are two chances to disagree, and the reference and
    // writer claim it records have to be on the workspace the gate will
    // actually use.
    const filesWorkspaceId = requireWorkspaceBinding(
      (await ensureSessionWorkspace(sessionId, userId))?.workspace_id,
      { sessionId },
    );

    const userEvent = {
      type: "UserMessage",
      message_id: messageId,
      data: { content: [{ type: "text", text: content }] },
      role: "user",
    };
    // Synchronously persist UserMessage to DB so the SSE history segment
    // includes it even if the consumer hasn't yet subscribed.
    await db.query(
      "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, session_id) DO NOTHING",
      [messageId, sessionId, "UserMessage", userEvent],
    );
    sessionDispatchPorts.publishSse(sessionId, JSON.stringify(userEvent));

    const history = await buildMessages(sessionId, content, userId);

    let localSkills: Record<string, { content: string; enabled: boolean; version?: number; description?: string; files?: Array<{ path: string; content: string; is_binary?: boolean }> }> = {};
    try {
      const activeSkills = await selectSkillsForTask(userId, content);
      for (const [name, bundle] of Object.entries(activeSkills)) {
        localSkills[name] = {
          content: bundle.content,
          description: bundle.description,
          enabled: true,
          version: bundle.version,
          files: bundle.files,
        };
      }
    } catch (err: any) {
      const code = err?.code || "";
      if (code !== "42P01" && code !== "42703") {
        logger.error({ err, userId }, "skill.load_failed");
      }
    }

    const sandboxImageMatch = SANDBOX_IMAGE_RE.exec(content);
    const admin = user ? isAdmin(user) : false;
    let pluginTools: unknown[] | null | undefined;
    let pluginImage: string | undefined;
    let pluginResource: Record<string, unknown> | undefined;

    if (pluginId !== undefined) {
      const pluginRow = await MarketplaceDb.pluginGetById(pluginId, false);
      if (pluginRow && canViewPlugin(pluginRow, userId, admin)) {
        const formatted = await formatPluginRow(pluginRow, true);
        pluginTools = (formatted.tools as unknown[]) ?? [];
        const imageFromPlugin = pluginSandboxImage(formatted.images);
        if (imageFromPlugin) pluginImage = imageFromPlugin;
        const resourceFromPlugin = asJsonObject(formatted.resource);
        // Same empty-object-is-truthy footgun as the session-config resources
        // normalization in routes/anthropic-managed-agents.ts: a plugin
        // created without an explicit `resource` defaults to `{}` (not
        // null/undefined), which would otherwise permanently mask
        // defaultResource below in the `||` fallback chain.
        if (resourceFromPlugin && Object.keys(resourceFromPlugin).length > 0) pluginResource = resourceFromPlugin;
      } else {
        pluginTools = null;
      }
    } else {
      pluginTools = undefined;
    }

    const defaultResourceRow = await MarketplaceDb.resourceFirstByType("default");
    const defaultResource = asJsonObject(defaultResourceRow?.resource);
    const defaultImage = String(defaultResourceRow?.image ?? "").trim() || undefined;

    const finalResources = requestResource || pluginResource || defaultResource || {};
    const finalSandboxImage = requestImage || pluginImage || defaultImage;

    if (finalSandboxImage || sandboxImageMatch?.[1]) {
      await db.query("UPDATE claw_sessions SET mode = 'local', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL", [sessionId]);
    }
    logger.info({ sessionId, messageId, content: content.slice(0, 500), sandboxImage: finalSandboxImage || null }, "message.sandbox_image_parse");

    const task: Record<string, unknown> = {
      session_id: sessionId,
      message_id: messageId,
      prompt: content,
      history,
      user_id: userId,
      llm_api_key: resolveUserLlmKey(user),
      platform_key: user?.platformKey || "",
      tool_ids: toolIds.length ? toolIds : undefined,
      plugin_id: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
      workspace_id: workspaceId,
      mcp_servers: mcpServers,
      skills: Object.keys(localSkills).length ? localSkills : undefined,
      sandbox_image: finalSandboxImage,
      resources: finalResources,
      timeout: requestTimeout,
      user_env: Object.keys(capturedUserEnvSnapshot).length ? capturedUserEnvSnapshot : undefined,
      session_env: Object.keys(capturedSessionEnv).length ? capturedSessionEnv : undefined,
      // Declared rather than parsed out of the prompt. Absent means Brain
      // falls back to reading the Hyperloom flags, which is what every caller
      // did before the field existed.
      topology,
    };
    if (pluginTools !== undefined) {
      task.plugin_tools = pluginTools;
    }
    const sessionMeta = (await db.query(
      "SELECT parent_session_id, team_role FROM claw_sessions WHERE session_id = $1",
      [sessionId],
    )).rows[0];
    if (sessionMeta?.parent_session_id) {
      task.parent_session_id = sessionMeta.parent_session_id;
      task.team_role = sessionMeta.team_role || "";
    }
    // Names collide unhelpfully here: `workspace_id` above is the sandbox
    // namespace, this is the files. Brain gates concurrency on it, which is
    // what makes two runs over one directory queue instead of overwriting
    // each other.
    task.files_workspace_id = filesWorkspaceId;
    task.files_workspace_required = true;

    const doorbellToken = sessionDispatchPorts.doorbellDispatch();
    if (doorbellToken) {
      try {
        const result = await dispatchByDoorbell({
          task,
          sessionId,
          userId,
          messageId,
          prompt: content,
          workspaceId,
          filesWorkspaceId,
          pluginId: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
          sandboxImage: finalSandboxImage,
          reconcileAction: input.reconcileAction,
          rememberTaskId: (taskId) => { runTaskId = taskId; },
        });
        if (result.kind === "rejected") {
          // The delete is the whole rollback. Nothing is announced on purpose:
          // `publishSse` writes to a core-NATS subject no SSE route subscribes
          // to, and announcing through `publishEvent` instead would persist an
          // assistant reply beside the UserMessage this statement removes.
          await db.query(
            "DELETE FROM claw_session_events WHERE event_id = $1 AND session_id = $2 AND event = 'UserMessage'",
            [messageId, sessionId],
          );
          await onPublishFailure();
        }
        return result;
      } finally {
        doorbellToken.release();
      }
    }

    const run = await sessionDispatchPorts.openChatRun({
      dispatch: "fat",
      sessionId,
      userId,
      messageId,
      prompt: content,
      workspaceId,
      filesWorkspaceId,
      pluginId: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
      sandboxImage: finalSandboxImage,
    });
    // Publishing without a row leaves a session `running` with no deadline,
    // no lease, and nothing for a sweeper to reap -- a worse failure than
    // refusing the turn. openChatRun reports insert errors by returning null
    // so this path can still roll the session back.
    if (!run) {
      throw new Error("chat_run.open_failed");
    }
    runTaskId = run.taskId;
    task.run_lease = run.lease;

    subject = taskSubject();
    // A gate, not a note: an unrecorded `attempted` leaves a row denying a
    // message already on the stream, so a throw here must stop the publish.
    await recordPublishState(run.taskId, "attempted");
    const payload = JSON.stringify(task);
    const seq = await publishRunMessage(
      () => sessionDispatchPorts.publishTask(subject, payload),
    );
    await recordDispatchSeq(run.taskId, seq);
    logger.info({ sessionId, messageId, subject, runTaskId, sandboxImage: finalSandboxImage || null }, "message.dispatched");
    return { kind: "dispatched", messageId, sandboxImage: finalSandboxImage };
  } catch (err: any) {
    // Compensate before rolling back, and read the verdict. The order used to
    // be the other way round, which made the answer unusable: the rollback had
    // already run by the time this learned whether the row was still there to
    // close. A publish that times out may have been delivered, and then a
    // worker holds the row and is renewing its lease -- the compensation
    // declines, and rolling back would return the session to idle while a turn
    // is running, so the next message dispatches on top of it. The doorbell
    // path reads this same verdict; leaving the default path deaf to it is the
    // asymmetry, not a different problem.
    if (runTaskId && publishCertainlyFailed(err)) {
      await noteRefusedPublish(runTaskId);
    }
    const verdict = await sessionDispatchPorts.failChatRunDispatch(
      runTaskId,
      String(err?.message ?? err),
      undefined,
      { statuses: SWEEPABLE_RUN_STATUSES },
    );
    // Only a worker actually holding the row earns the silence. A compensation
    // that could not run establishes nothing, and rolling back is the answer
    // that at least hands the session back.
    if (verdict === "held" && runTaskId) {
      logger.warn(
        { err, sessionId, messageId, subject, runTaskId },
        "message.dispatch_failed_row_held",
      );
      // The image the run is actually using is on the row the holder claimed;
      // this path never learns it, and the callers use it only for a log line.
      return { kind: "dispatched", messageId, sandboxImage: undefined };
    }
    // An unknown verdict is not a settled state, so the rollback that a
    // `closed` one earns would delete the user's message out from under a run
    // that may still execute.
    if (verdict === "unknown") {
      logger.error(
        { err, sessionId, messageId, subject, runTaskId },
        "message.dispatch_unknown_awaiting_reconcile",
      );
      return { kind: "publish_unknown", messageId, error: err };
    }
    try {
      await onPublishFailure();
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, sessionId }, "message.dispatch_rollback_failed");
    }
    logger.error({ err, sessionId, messageId, subject }, "message.dispatch_failed");
    return { kind: "publish_failed", messageId, error: err };
  }
}

async function dispatchByDoorbell(input: {
  task: Record<string, unknown>;
  sessionId: string;
  userId: string;
  messageId: string;
  prompt: string;
  workspaceId?: string;
  filesWorkspaceId?: string;
  pluginId?: number;
  sandboxImage: string | undefined;
  reconcileAction?: "idle_existing_session" | "delete_created_session";
  rememberTaskId: (taskId: string) => void;
}): Promise<DispatchResult> {
  const { rememberTaskId, ...handOff } = input;
  const result = await handOffAssembledRun({
    ...handOff,
    path: "chat",
    reconcileAction: input.reconcileAction,
    // The third argument is the dedup id; without it the doorbell has no
    // duplicate-window protection.
    publish: (subject, payload, msgId) =>
      sessionDispatchPorts.publishTask(subject, payload, msgId),
    openRun: sessionDispatchPorts.openChatRun,
    // Forwards the verdict. Swallowing it here would restore the bug one layer
    // up: handOffAssembledRun would read every compensation as successful and
    // roll back turns that are running.
    failRun: async (taskId, reason, failureReason) => {
      if (taskId) rememberTaskId(taskId);
      return sessionDispatchPorts.failChatRunDispatch(
        taskId,
        reason,
        failureReason ?? "dispatch_failed",
        { statuses: SWEEPABLE_RUN_STATUSES },
      );
    },
    admit: sessionDispatchPorts.admit,
  });
  if (result.kind === "dispatched" || result.kind === "queued" || result.kind === "publish_unknown") {
    rememberTaskId(result.taskId);
  }
  if (result.kind === "open_failed") throw new Error("chat_run.open_failed");
  if (result.kind === "rejected") {
    return { kind: "rejected", messageId: input.messageId, reason: result.reason };
  }
  const sandboxImage = input.sandboxImage;
  if (result.kind === "queued") {
    logger.info(
      { sessionId: input.sessionId, messageId: input.messageId, queuePosition: result.queuePosition },
      "message.queued",
    );
    return {
      kind: "queued",
      messageId: input.messageId,
      sandboxImage,
      queuePosition: result.queuePosition,
      runId: result.taskId,
    };
  }
  if (result.kind === "publish_unknown") {
    logger.error(
      { sessionId: input.sessionId, messageId: input.messageId, runTaskId: result.taskId },
      "message.dispatch_unknown_awaiting_reconcile",
    );
    return {
      kind: "publish_unknown",
      messageId: input.messageId,
      error: new Error("task dispatch outcome unknown"),
    };
  }
  logger.info(
    { sessionId: input.sessionId, messageId: input.messageId, runTaskId: result.taskId, sandboxImage: sandboxImage || null },
    "message.dispatched",
  );
  return { kind: "dispatched", messageId: input.messageId, sandboxImage };
}
