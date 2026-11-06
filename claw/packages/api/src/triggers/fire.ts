// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Start a run for a trigger, as the user who created it.
 *
 * Mirrors `POST /v1/sessions` with a first message: same row insert, same
 * credential stamp, same dispatch. The one difference is where the caller's
 * identity comes from -- there is no request, so it is the credential the
 * trigger saved when its owner created or last resumed it.
 */
import crypto from "node:crypto";
import pino from "pino";
import type { UserInfo } from "../auth/models.js";
import {
  assertSessionCredentialsForDispatch, MissingPlatformKeyError, sessionCredentialPatch,
} from "../auth/session-credentials.js";
import { TRIGGER_RUN_TIME_LIMIT_SECONDS } from "../config.js";
import { decryptUserEnvValue, loadUserEnvSnapshot } from "../crypto/user-env.js";
import { db, inTransaction } from "../infra/db.js";
import { drainSessionIfIdle, queueServerMessage } from "../assistant/messages.js";
import { insertSessionRow } from "../routes/sessions.js";
import { dispatchTaskToBrain, newChatMessageId } from "../sessions/dispatch.js";
import { releaseSessionRefs } from "../workspace/store.js";

const logger = pino({ name: "triggers-fire" });

export interface TriggerRow {
  trigger_id: string;
  owner_user_id: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  credential_enc: string;
  /** Set for a trigger made from a work item's turn: its firings wake that item's worker. */
  item_id: string | null;
}

/**
 * Where a trigger's credentials come from. Phase one decrypts a copy saved on
 * the trigger row; a later phase replaces it with a short-lived token exchange
 * and nothing else here changes.
 */
export const triggerPorts = {
  getCredentialsFor(trigger: Pick<TriggerRow, "owner_user_id" | "credential_enc">): UserInfo | null {
    try {
      const c = JSON.parse(decryptUserEnvValue(trigger.credential_enc)) as Record<string, unknown>;
      return {
        userId: trigger.owner_user_id,
        userName: typeof c.userName === "string" ? c.userName : trigger.owner_user_id,
        // Never an admin: a trigger runs with what an ordinary session of its owner has.
        roles: ["default"],
        platformKey: typeof c.platformKey === "string" ? c.platformKey : "",
        virtualKey: typeof c.virtualKey === "string" ? c.virtualKey : "",
      };
    } catch {
      return null;
    }
  },
  dispatch: dispatchTaskToBrain,
};

export type FireOutcome =
  /** `messageId` is null for a firing queued to an item's worker: the turn it starts is named when it is drained. */
  | { status: "started"; sessionId: string; messageId: string | null }
  | { status: "failed_start"; detail: string; credentialInvalid: boolean }
  /** The item is finished or stopped, so its watch is over; or it is waiting for its user, so this firing is not run. */
  | { status: "item_closed" }
  | { status: "item_waiting" };

export async function fireTrigger(trigger: TriggerRow, plannedAt: Date): Promise<FireOutcome> {
  const user = triggerPorts.getCredentialsFor(trigger);
  if (!user) return { status: "failed_start", detail: "credential_unreadable", credentialInvalid: true };
  const sessionId = crypto.randomUUID();
  try {
    // No fallback to a shared key: a trigger without its owner's key does not run.
    assertSessionCredentialsForDispatch(sessionId, user);
  } catch (err) {
    if (err instanceof MissingPlatformKeyError) {
      return { status: "failed_start", detail: "missing_platform_key", credentialInvalid: true };
    }
    throw err;
  }
  const messageId = newChatMessageId();
  // The session is inserted already `running`, so anything that ends the fire
  // without a run behind it has to take the row away again: left in place it
  // makes `previousRunOpen` true for ever and the trigger silently never fires.
  let inserted = false;
  const rollback = async () => {
    if (await releaseSessionRefs(sessionId) === "failed") {
      logger.error({ sessionId }, "trigger.rollback_ref_release_failed");
    }
    await db.query("DELETE FROM claw_session_events WHERE session_id = $1", [sessionId]);
    await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [sessionId]);
  };
  try {
    await insertSessionRow(db, {
      sessionId,
      name: `${trigger.name} ${plannedAt.toISOString().slice(0, 10)}`.slice(0, 255),
      userId: user.userId,
      mode: "claw",
      agentStatus: "running",
      systemPrompt: "",
      config: { ...sessionCredentialPatch(user), trigger_id: trigger.trigger_id },
      parentSid: null,
      role: "",
      gateMessageId: messageId,
    }, { parentSid: null });
    inserted = true;
    const snapshot = await loadUserEnvSnapshot(db, user.userId, logger);
    const dispatch = await triggerPorts.dispatch(
      {
        sessionId, userId: user.userId, user, messageId,
        content: trigger.prompt,
        messageType: "text",
        toolIds: [],
        pluginId: undefined,
        requestImage: undefined,
        requestResource: undefined,
        requestTimeout: TRIGGER_RUN_TIME_LIMIT_SECONDS,
        workspaceId: undefined,
        mcpServers: undefined,
        capturedUserEnvSnapshot: snapshot,
        capturedSessionEnv: {},
        reconcileAction: "delete_created_session",
      },
      rollback,
    );
    if (dispatch.kind === "dispatched" || dispatch.kind === "queued" || dispatch.kind === "publish_unknown") {
      return { status: "started", sessionId, messageId };
    }
    if (dispatch.kind === "rejected") {
      // Admission said no; the session was created running and nothing will release it.
      await rollback();
      return { status: "failed_start", detail: `admission_rejected: ${dispatch.reason}`.slice(0, 200), credentialInvalid: false };
    }
    // The rollback callback has normally run already; deleting twice is harmless.
    await rollback().catch((err) => logger.error({ err, sessionId }, "trigger.rollback_failed"));
    return { status: "failed_start", detail: "dispatch_failed", credentialInvalid: false };
  } catch (err) {
    logger.error({ err, triggerId: trigger.trigger_id }, "trigger.fire_failed");
    if (inserted) await rollback().catch((e) => logger.error({ err: e, sessionId }, "trigger.rollback_failed"));
    return { status: "failed_start", detail: "internal_error", credentialInvalid: false };
  }
}

/**
 * A firing of a trigger made from a work item's turn: the prompt goes to the item's own worker, the way an
 * instruction the user sends it does, so its result comes back as that item's report and not as a conversation
 * nobody opened. The worker's session holds its owner's credentials already; the trigger's own are not used.
 */
export async function fireIntoItem(trigger: TriggerRow, plannedAt: Date): Promise<FireOutcome> {
  try {
    const queued = await inTransaction(async (query) => {
      const item = (await query(
        `SELECT worker_session_id, board_state, last_report_kind, pending_question FROM claw_work_items
          WHERE item_id = $1 AND user_id = $2 FOR SHARE`,
        [trigger.item_id, trigger.owner_user_id],
      )).rows[0] as {
        worker_session_id: string; board_state: string; last_report_kind: string | null; pending_question: string | null;
      } | undefined;
      if (!item || item.board_state === "done") return { status: "item_closed" as const };
      // Every finished turn leaves its item needing the user (a ready or failed end), so needing them is not
      // waiting on them: only an item whose worker asked the user something, a question or a block, is.
      if (item.pending_question !== null || item.last_report_kind === "blocked") return { status: "item_waiting" as const };
      const r = await queueServerMessage({ query }, {
        sessionId: item.worker_session_id, userId: trigger.owner_user_id,
        content: `Scheduled run of "${trigger.name}" (${plannedAt.toISOString()}):\n\n${trigger.prompt}`,
        dedupeKey: `trigger:${trigger.trigger_id}:${plannedAt.toISOString()}`,
      });
      if (!r.ok) return { status: "failed_start" as const, detail: r.error, credentialInvalid: r.error === "no_credentials" };
      return { status: "started" as const, sessionId: item.worker_session_id, messageId: null };
    });
    if (queued.status === "started") await drainSessionIfIdle(queued.sessionId, trigger.owner_user_id);
    return queued;
  } catch (err) {
    logger.error({ err, triggerId: trigger.trigger_id }, "trigger.fire_into_item_failed");
    return { status: "failed_start", detail: "internal_error", credentialInvalid: false };
  }
}
