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
import { stampSessionCredentials } from "../auth/session-credentials.js";
import { buildMessages } from "./context-builder.js";
import { selectSkillsForTask } from "../marketplace/skill-service.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { eventSubject, taskSubject, type EnvironmentTopology } from "@claw/protocol";
import {
  clearDispatchReconcile, failChatRunDispatch, noteRefusedPublish, openChatRun, recordDispatchSeq,
  recordPublishState, SWEEPABLE_RUN_STATUSES,
} from "../tasks/chat-run.js";
import { beginDoorbellDispatch } from "../tasks/doorbell-gate.js";
import { handOffAssembledRun, publishRunMessage } from "../tasks/run-dispatch.js";
import type { PoolClient } from "pg";
import { decideAdmission, withOwnedAdmissionLock } from "../tasks/admission.js";
import { admissionAskFor } from "../tasks/run-dispatch.js";
import { stripRunSecrets } from "../tasks/run-spec.js";
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
  recordPublishState,
  recordDispatchSeq,
  noteRefusedPublish,
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

/**
 * What a caller learns from a dispatch.
 *
 * Both successful kinds carry `runId`, and that is the point of the type: the
 * row is what the turn *is*, and every path that leaves one behind knows its id
 * by the time it returns. Only `queued` used to report it, so a caller told
 * "dispatched" -- the ordinary case -- was handed a message id and left to guess
 * which of a session's many rows was its own.
 *
 * Neither failing kind carries one, also deliberately. `rejected` may be refused
 * before any row exists or after the one it opened was closed again, and
 * `publish_failed` has had its row compensated; a run id on either would name a
 * row that is not going to execute.
 */
export type DispatchResult =
  | { kind: "dispatched"; messageId: string; sandboxImage: string | undefined; runId: string }
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
    // Best-effort, and it has to stay best-effort, because the turn does not
    // depend on it. The stamp is for a reader that arrives after the request is
    // gone -- `platformKeyForSession` in tasks/platform-backfill.ts, which
    // authenticates the terminal-facts read on a run that has already ended.
    // What actually runs this turn is the `platform_key` put on `task` below:
    // the doorbell path seals `credentialsFromTask(task)` onto the row and the
    // fat path publishes it on the wire, so the SaFE workload is created with,
    // and owned by, its submitter whether or not this UPDATE landed. Nothing
    // between here and the publish reads the session row's copy.
    //
    // It used to throw. The throw reached this function's catch, the catch ran
    // `onPublishFailure`, and a dropped connection under one UPDATE therefore
    // refused the user's chat turn: 503 with no UserMessage written and the
    // gate handed back, and on `POST /v1/sessions` the just-created session
    // deleted underneath it. Refusing a conversation turn to protect a
    // diagnostic is the wrong trade in both directions.
    //
    // Not silent either, which is the other half of the trade. This line is
    // what says the row is now stale, and it is not the only trace. A run whose
    // session was never stamped falls back to the `platformKey` Brain writes
    // into its own KV entry for that sandbox -- `ensure-hands.ts` puts the
    // caller's key on both the pending and the ready SaFE payload and calls the
    // field mandatory, and `platformKeyForSandbox` accepts it only when the
    // entry names the same handle, so the fallback cannot pair a newer
    // sandbox's credential with this run. The entry is on a KV TTL, so it does
    // not cover a late sweep; when it is gone the backfill records
    // `missing_platform_key` and leaves `platform_facts_resolved_at` NULL until
    // `drainPendingPlatformFacts` stops selecting the row an hour after it
    // completed. An unstamped run is therefore still queryable afterwards --
    // unresolved facts on a terminal row -- rather than merely lost.
    //
    // The error object is deliberately not logged: a constraint or type failure
    // on `claw_sessions` carries the failing row in `detail`, and that row is
    // the config we are writing credentials into. The driver's code names the
    // class of failure without quoting the row.
    if (user?.platformKey) {
      await stampSessionCredentials(sessionId, user).catch((stampErr: any) => {
        logger.error(
          { sessionId, userId, code: stampErr?.code ?? "", constraint: stampErr?.constraint ?? "" },
          "session.credentials_stamp_failed",
        );
      });
    }

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

    // The delete is the whole rollback. Nothing is announced on purpose:
    // `publishSse` writes to a core-NATS subject no SSE route subscribes to,
    // and announcing through `publishEvent` instead would persist an assistant
    // reply beside the UserMessage this statement removes.
    //
    // Shared with the fat fallback below deliberately. A refusal there used to
    // roll the session back without removing the event, so the transcript kept
    // a user turn the fleet had refused: the next send replayed it as history
    // and the UI showed a message that was never answered and never will be.
    // The refusal is the same refusal, so the rollback is the same rollback.
    const rollbackRefusedTurn = async (): Promise<void> => {
      await db.query(
        "DELETE FROM claw_session_events WHERE event_id = $1 AND session_id = $2 AND event = 'UserMessage'",
        [messageId, sessionId],
      );
      await onPublishFailure();
    };

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
          await rollbackRefusedTurn();
        }
        return result;
      } finally {
        doorbellToken.release();
      }
    }

    // Admission is asked here and not only on the doorbell branch.
    //
    // Every ceiling used to live inside `dispatchByDoorbell`, so the fallback
    // this branch is -- taken whenever `beginDoorbellDispatch` declines, which
    // includes a revoked floor and a KV watch that merely died -- opened and
    // published a run without consulting any of them. A configured ceiling was
    // therefore disabled by a transient failure it has nothing to do with, in
    // silence: no refusal, no counter, no log line. Verified against the
    // cluster at `ADMIT_HARD_RUNS=1` with one run already occupying it: gate
    // open, three turns gave 1x200 and 2x429; gate closed, the same three all
    // returned 200 and ran.
    //
    // Decided and inserted under one lock, for the reason `handOffUncounted`
    // states: creation order and commit order have to be the same order, or two
    // creates that each cleared the check are both admitted against one slot.
    const fatAsk = await admissionAskFor({
      task, sessionId, userId, messageId, prompt: content,
      publish: async () => undefined,
    } as Parameters<typeof admissionAskFor>[0]);
    const fatOpen = await withOwnedAdmissionLock(async (client: PoolClient) => {
      const admission = await sessionDispatchPorts.admit(fatAsk, client);
      if (admission.kind === "reject") return { admission } as const;
      return {
        admission,
        run: await sessionDispatchPorts.openChatRun({
          dispatch: "fat",
          sessionId,
          userId,
          messageId,
          prompt: content,
          workspaceId,
          filesWorkspaceId,
          pluginId: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
          sandboxImage: finalSandboxImage,
          // Forwarded here for the same reason the doorbell branch forwards it,
          // and it was missing here alone. The action is what arms the row:
          // `insertTask` writes `dispatch_reconcile_at` only when
          // `dispatch_reconcile_action` is non-null, so a fat row opened
          // without one is invisible to `reconcileAmbiguousDispatches` for
          // ever. The `publish_unknown` this function can return then settles
          // nothing and asks nobody to: the caller is told not to roll back --
          // that is the whole point of the kind -- and no sweep can finish the
          // cleanup it deferred, so the created session, its `UserMessage` and
          // its `running` gate outlive the 503 with no owner. The fat orphan
          // reaper closes the row hours later and still never runs the action,
          // because the action is the part that deletes the session.
          reconcileAction: input.reconcileAction,
          // Secret-free, and narrower than the doorbell path's spec on purpose:
          // nothing rehydrates a fat row from `input` -- it is published on the
          // wire -- so sealing credentials into it would store a secret no
          // reader wants. What admission does read is `input->'topology'`, and
          // with no spec at all that read returns nothing for the whole life of
          // the run: a fat GPU run counted zero nodes against every later
          // decision, so the GPU ceiling admitted past itself for as long as
          // any fat run was executing.
          spec: { ...stripRunSecrets(task), dispatch: "fat" },
          client,
        }),
      } as const;
    });
    if (fatOpen.admission.kind === "reject") {
      await rollbackRefusedTurn();
      return { kind: "rejected", messageId, reason: fatOpen.admission.reason };
    }
    // A soft ceiling is deliberately not honoured here, and the log line says
    // so rather than the queueing happening silently.
    //
    // Deferring means leaving the row at `queued` unpublished for a claimer to
    // take, and on this path no claimer exists: `peekNextQueued` and
    // `reapExpiredQueuedRuns` both filter `metadata->>'dispatch' = 'doorbell'`,
    // and the session-stuck reaper refuses to reopen a session that still has a
    // `queued` chat row. A deferred fat turn would therefore be run by nobody,
    // reaped by nobody, and hold its session's gate shut forever -- strictly
    // worse than exceeding a threshold whose whole purpose is smoothing. The
    // hard ceiling above still refuses, so the fleet limit is enforced; it is
    // only the queueing threshold that this path cannot implement.
    if (fatOpen.admission.kind === "queue") {
      logger.warn(
        { sessionId, messageId, position: fatOpen.admission.position },
        "message.fat_soft_admission_not_deferred",
      );
    }
    const run = fatOpen.run;
    // Publishing without a row leaves a session `running` with no deadline,
    // no lease, and nothing for a sweeper to reap -- a worse failure than
    // refusing the turn. openChatRun reports insert errors by returning null
    // so this path can still roll the session back.
    if (!run) {
      throw new Error("chat_run.open_failed");
    }
    runTaskId = run.taskId;
    task.task_id = run.taskId;
    task.run_lease = run.lease;

    subject = taskSubject();
    // A gate, not a note: an unrecorded `attempted` leaves a row denying a
    // message already on the stream, so a throw here must stop the publish.
    await sessionDispatchPorts.recordPublishState(run.taskId, "attempted");
    const payload = JSON.stringify(task);
    const seq = await publishRunMessage(
      () => sessionDispatchPorts.publishTask(subject, payload),
    );
    await sessionDispatchPorts.recordDispatchSeq(run.taskId, seq);
    // And handed back the moment the outcome is settled, which is the other
    // half of arming it. A marker left on a row that dispatched cleanly is not
    // inert: `resolveAmbiguousDispatch` reads a fat row as never executed --
    // nothing on this path increments `claim_count`, that is the doorbell
    // claim's counter -- so at the horizon it would run the stored action
    // against a healthy turn and, for a create, delete the session the user is
    // talking in.
    //
    // Which is why a lost fence may not end the attempt here the way it ends
    // it on the doorbell side. `clearDispatchReconcile` answers false for a
    // token some other writer now holds, and on a doorbell row that is a safe
    // answer because the row can still prove what it did: every `takeClaim`
    // increments `claim_count`, so the reconciler reads an executed row and
    // retires the marker without touching the session. A fat row has no such
    // proof and cannot acquire one -- see `releaseDispatchedFatReconcile`.
    if (run.reconcileToken && !await clearDispatchReconcile(run.taskId, run.reconcileToken)) {
      if (!await releaseDispatchedFatReconcile(run.taskId)) {
        logger.error(
          { sessionId, messageId, subject, runTaskId },
          "message.dispatch_unknown_awaiting_reconcile",
        );
        return {
          kind: "publish_unknown",
          messageId,
          error: new Error("task dispatch outcome unknown"),
        };
      }
      // Reported as dispatched, not as unknown, and the difference is not
      // cosmetic: `publish_unknown` is a promise that somebody else will settle
      // this row, and the statement above is what makes that promise false --
      // there is no marker left for a sweep to select on. The publish itself is
      // a banked fact by now, so `dispatched` is also the truthful answer, and
      // it is the one that keeps the caller from rolling back a live turn.
      logger.warn(
        { sessionId, messageId, subject, runTaskId },
        "message.dispatch_reconcile_force_released",
      );
    }
    logger.info({ sessionId, messageId, subject, runTaskId, sandboxImage: finalSandboxImage || null }, "message.dispatched");
    return { kind: "dispatched", messageId, sandboxImage: finalSandboxImage, runId: run.taskId };
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
      await sessionDispatchPorts.noteRefusedPublish(runTaskId);
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
      // The row's id it does know, and this branch reports a turn that is
      // executing -- so the caller gets the same handle it would have got had
      // the publish returned cleanly, rather than a success it cannot name.
      return { kind: "dispatched", messageId, sandboxImage: undefined, runId: runTaskId };
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

/**
 * Retire a fat row's reconcile marker once its message is on the stream,
 * whoever holds the token by then.
 *
 * The fence `clearDispatchReconcile` applies exists to stop a stale publisher
 * taking back a marker the reconciler has adopted, and on the doorbell path
 * losing it costs nothing: a doorbell row that executes says so in
 * `claim_count`, and `resolveAmbiguousDispatch` decides "never executed" from
 * exactly that column. A fat row cannot make the same statement. Nothing on
 * this path increments it, and the only writer that does is `acquireFatLease`
 * -- which a Brain predating the `accept` flag never reaches: its attempt token
 * quotes `claim_count = 0`, that matches `renewRunLease`'s fence, and the row is
 * renewed at zero for the whole turn. During a rolling upgrade -- API first,
 * Brain second, which is the order `deploy/upgrade.sh` uses -- that Brain is the
 * one executing these turns.
 *
 * So an armed marker outliving a successful fat publish is not a deferral, it
 * is a scheduled deletion. While the turn runs, `failChatRunDispatch` refuses to
 * close a row a worker holds and the reconciler merely re-arms; once the turn
 * *completes*, that non-terminal guard is skipped entirely, the stored
 * `delete_created_session` runs against a conversation the user was answered in,
 * and `commitSessionDeletion` tombstones its content and schedules its workspace
 * objects for collection. RUN_FAT_PREPARING_RECONCILE does not gate that arm, so
 * turning the rollout flag off only postpones it to the next tick.
 *
 * Unfenced against the *token* is correct rather than merely expedient:
 * `publishRunMessage` returned a sequence and `recordDispatchSeq` banked it, so
 * the question this marker was armed to answer is already answered and the
 * cleanup it stores is owed to nobody -- there is no contending writer whose
 * decision this could overwrite, only a token that moved. Idempotent for the
 * same reason, so a marker somebody else already retired still reads as
 * released. That last part matters more than it used to: `closeChatRun` now
 * retires the marker in the statement that terminalizes a row a worker reported
 * on, so on a fast turn the marker can legitimately be gone before this runs,
 * and reading that as a failure would answer 503 for a turn that dispatched and
 * has already been answered.
 *
 * There is exactly one writer it is NOT idempotent against, and it is the one
 * whose decision this genuinely would overwrite: the reconciler taking the
 * marker in order to delete the session this create minted. That take stamps
 * `dispatch_reconcile_deleted` on the row in the same statement that clears the
 * marker, and this declines on it. The two then contend on one row's lock, so
 * the ordering is total and observable from both sides -- if this UPDATE gets
 * there first the reconciler's take matches nothing and it abandons the delete,
 * and if the take got there first this matches nothing and the caller answers
 * `publish_unknown` rather than handing back HTTP 200 and a session id that is
 * about to stop existing. Reporting a turn as dispatched into a session being
 * deleted is not a smaller lie than reporting a dispatched turn as unknown.
 *
 * Swallowing the error and returning false is what leaves the old behaviour in
 * place for a disarm that never reached Postgres: the caller falls back to
 * `publish_unknown`, which is the honest answer while a marker is still armed.
 */
async function releaseDispatchedFatReconcile(taskId: string): Promise<boolean> {
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET dispatch_reconcile_at = NULL, dispatch_reconcile_action = NULL,
              metadata = metadata - 'dispatch_reconcile_token'
        WHERE task_id = $1
          AND COALESCE((metadata->>'dispatch_reconcile_deleted')::boolean, false) = false`,
      [taskId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, taskId }, "message.dispatch_reconcile_release_failed");
    return false;
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
  return { kind: "dispatched", messageId: input.messageId, sandboxImage, runId: result.taskId };
}
