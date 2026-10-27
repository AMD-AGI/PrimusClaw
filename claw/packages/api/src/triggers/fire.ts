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
import { db } from "../infra/db.js";
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
  | { status: "started"; sessionId: string }
  | { status: "failed_start"; detail: string; credentialInvalid: boolean };

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
      async () => {
        if (await releaseSessionRefs(sessionId) === "failed") {
          logger.error({ sessionId }, "trigger.rollback_ref_release_failed");
        }
        await db.query("DELETE FROM claw_session_events WHERE session_id = $1", [sessionId]);
        await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [sessionId]);
      },
    );
    if (dispatch.kind === "dispatched" || dispatch.kind === "queued" || dispatch.kind === "publish_unknown") {
      return { status: "started", sessionId };
    }
    if (dispatch.kind === "rejected") {
      // Admission said no; the session was created running and nothing will release it.
      await db.query(
        "DELETE FROM claw_session_events WHERE session_id = $1", [sessionId]);
      await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [sessionId]);
      return { status: "failed_start", detail: `admission_rejected: ${dispatch.reason}`.slice(0, 200), credentialInvalid: false };
    }
    return { status: "failed_start", detail: "dispatch_failed", credentialInvalid: false };
  } catch (err) {
    logger.error({ err, triggerId: trigger.trigger_id }, "trigger.fire_failed");
    return { status: "failed_start", detail: "internal_error", credentialInvalid: false };
  }
}
