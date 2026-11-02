// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one place a message is accepted onto a session.
 *
 * A session runs one turn at a time, and `claw_sessions.agent_status` is the
 * gate that says so. Accepting a message is therefore a decision made under the
 * session row's lock: while a turn runs the message is parked in
 * `claw_pending_messages` and the turn's completion drains it; otherwise the
 * caller takes the gate and dispatches. That decision used to live inside the
 * `POST /v1/sessions/:id/messages` handler, which left every other caller that
 * wanted to put a message on a session -- one that is not an HTTP request --
 * with two choices: duplicate the lock, the gate and the queue insert, or call
 * the route. This is the extraction, so there is a third.
 *
 * Two modes:
 *
 *   - `dispatch` (the route's): an idle session takes the gate and the message
 *     is dispatched at once; a running one parks it. The answer says which.
 *
 *   - `enqueue`: the message is always written to the queue, and an idle
 *     session is then drained. For callers that need the message durable
 *     before anything runs -- they write it in the same unit of work as their
 *     own state and let the queue carry it -- and for callers that may be
 *     retried, since only a queued message can carry a dedupe key.
 *
 * What the dedupe key buys, and what it does not: it names the queued row, so
 * a second submit of the same key into the same session finds the first and
 * queues nothing. It holds for as long as the row exists. The drain deletes the
 * row when it hands the message to a run, and a retry that arrives after that
 * is a new message; a caller whose retries can outlive the queue needs its own
 * record of what it sent.
 */

import type { PoolClient } from "pg";
import pino from "pino";
import type { EnvironmentTopology } from "@claw/protocol";
import { db, type StatementRunner } from "../infra/db.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { RUN_DOORBELL_DISPATCH } from "../config.js";
import { canAccessSession, isSystemAdmin, type UserInfo } from "../auth/models.js";
import { pendingSecretColumns } from "../tasks/run-secrets.js";
import { releaseSessionGateForTurn, takeSessionGate } from "../tasks/chat-run.js";
import { drainOldestPendingMessage } from "../events/consumer.js";
import { dispatchTaskToBrain, newChatMessageId } from "./dispatch.js";

const logger = pino({ name: "submit-message" });

/**
 * Seam over the drain, which reaches the whole completion path (history,
 * skills, plugin, workspace binding) and so is replaced by a test that asks
 * only whether, and for whom, it was called.
 */
export const submitMessagePorts = {
  drainOldestPendingMessage,
};

/** Longest dedupe key accepted. A key is an identity, not a payload. */
const DEDUPE_KEY_MAX_LENGTH = 256;

interface SubmitSessionMessageBase {
  sessionId: string;
  /** The sender: the owner check, the env snapshot and the queue row all use it. */
  userId: string;
  /** The sender's credentials, frozen onto a queued row for the drain to use. */
  user: UserInfo | null;
  content: string;
  messageType: string;
  toolIds: number[];
  pluginId?: number;
  requestImage?: string;
  requestResource?: Record<string, unknown>;
  requestTimeout?: number;
  workspaceId?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
  topology?: EnvironmentTopology;
  /** The `env` map of the request, already parsed. */
  sessionEnv: Record<string, string>;
  /**
   * Whether whoever is waiting for the answer has gone. Asked once, after the
   * gate is taken and before anything is dispatched, so an abandoned request
   * leaves no turn behind. Only the dispatch path can be abandoned: a queued
   * message is already recorded.
   */
  isCancelled?: () => boolean;
  /**
   * A refusal the caller needs decided under the session's lock, in the same transaction as the gate: a string
   * ends the submit with nothing written and is handed back as `refused`. The caller's own rule about who may put
   * a turn on this session, which has to see the session as the lock holds it and cannot be a check made before.
   */
  refuse?: (client: PoolClient) => Promise<string | null>;
}

/**
 * `dedupeKey` is only representable with `enqueue`. In `dispatch` mode an idle
 * session never writes a row, so there would be nothing for a retry to find
 * while the turn runs -- and the retry would then be parked as a second message.
 */
export type SubmitSessionMessageInput = SubmitSessionMessageBase & (
  | { mode?: "dispatch"; dedupeKey?: undefined }
  | { mode: "enqueue"; dedupeKey?: string }
);

/** What became of the drain for a queued message. */
export type QueuedDrain =
  /** The session was running: the turn in front drains the queue when it ends. */
  | "awaiting_turn"
  /** `enqueue` on an idle session, and the drain returned. */
  | "drained"
  /**
   * `enqueue` on an idle session, and the drain threw. The message is queued; the
   * sweeper's orphan drain picks up a queue row behind an idle session.
   */
  | "drain_failed"
  /** The key was already queued: nothing was written and nothing was drained. */
  | "duplicate";

export type SubmitSessionMessageResult =
  | { kind: "session_not_found" }
  /** Only the session's creator (or an operator of an ownerless one) may send. */
  | { kind: "not_owner" }
  /** The caller's `refuse` said no, under the lock: nothing was written. */
  | { kind: "refused"; error: string }
  /**
   * Written to `claw_pending_messages`. No run exists yet and none is named: the
   * row is opened later by the drain, which may yet refuse it.
   */
  | { kind: "queued"; pendingId: number | null; deduplicated: boolean; drain: QueuedDrain }
  /** `isCancelled` said so after the gate was taken; the gate has been handed back. */
  | { kind: "client_gone" }
  /** Dispatched, or admitted to the run queue: either way a run row exists. */
  | { kind: "dispatched"; messageId: string; runId: string }
  | { kind: "dispatch_failed"; messageId: string; error: Error | undefined }
  | { kind: "admission_rejected"; messageId: string; reason: string };

/** What a queued row freezes of the request, for the drain to dispatch from later. */
export interface PendingMessageRow {
  sessionId: string;
  content: string;
  userId: string;
  pluginId?: number;
  toolIds: number[];
  workspaceId?: string;
  secrets: ReturnType<typeof pendingSecretColumns>;
  image?: string;
  resource?: Record<string, unknown>;
  timeout?: number;
  sessionEnv: Record<string, string>;
  topology?: EnvironmentTopology;
  dedupeKey?: string;
}

/**
 * Write one row to the queue. The only statement in the API that does so for a
 * message a person or an agent sent; exported for a caller that has to write it
 * inside a transaction of its own, which then owes the drain itself.
 *
 * With a key the insert is `ON CONFLICT DO NOTHING` on the unique index, so two
 * submits racing on one key leave one row whichever commits first; without one
 * it is the plain insert it has always been. `id` is the new row's, null when
 * the key was already queued (`deduplicated`).
 */
export async function insertPendingMessage(
  q: StatementRunner,
  row: PendingMessageRow,
): Promise<{ id: number | null; deduplicated: boolean }> {
  const params: unknown[] = [
    row.sessionId,
    row.content,
    row.userId,
    row.pluginId ?? null,
    JSON.stringify(row.toolIds.length ? row.toolIds : []),
    row.workspaceId ?? null,
    row.secrets.platform,
    row.secrets.llm,
    row.secrets.blob,
    row.image ?? null,
    row.resource ? JSON.stringify(row.resource) : null,
    row.timeout ?? null,
    JSON.stringify(row.secrets.userEnv),
    JSON.stringify(row.sessionEnv),
    row.topology ? JSON.stringify(row.topology) : null,
  ];
  const keyed = row.dedupeKey !== undefined;
  if (keyed) params.push(row.dedupeKey);
  const inserted = await q.query(
    "INSERT INTO claw_pending_messages (session_id, content, user_id, plugin_id, tool_ids, workspace_id, platform_key, llm_api_key, credentials_blob, image, resources, timeout, user_env, session_env, topology"
    + (keyed ? ", dedupe_key" : "")
    + ") VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb"
    + (keyed ? ", $16) ON CONFLICT (session_id, dedupe_key) DO NOTHING" : ")")
    + " RETURNING id",
    params,
  );
  const id = (inserted.rows[0] as { id?: number } | undefined)?.id ?? null;
  return { id, deduplicated: keyed && id === null };
}

/**
 * Accept one message onto a session: lock its row, then park it behind the
 * running turn or take the gate and dispatch it.
 *
 * The caller has parsed and validated the request, and handles the message
 * types that are not conversation writes (interrupt, decision). What is here is
 * everything from the lock to the answer.
 */
export async function submitSessionMessage(
  input: SubmitSessionMessageInput,
): Promise<SubmitSessionMessageResult> {
  const {
    sessionId, userId, user, content, messageType, toolIds, pluginId,
    requestImage, requestResource, requestTimeout, workspaceId, mcpServers,
    topology, sessionEnv, dedupeKey,
  } = input;
  const mode = input.mode ?? "dispatch";
  // Caller bugs, not data, so they throw: an empty key would dedupe every
  // message of the session into one, and a key on a mode that cannot honour it
  // would read as protection the retry does not have (see the input type).
  if (dedupeKey !== undefined) {
    if (mode !== "enqueue") throw new Error("a dedupe key needs mode enqueue");
    if (typeof dedupeKey !== "string" || dedupeKey.length === 0 || dedupeKey.length > DEDUPE_KEY_MAX_LENGTH) {
      throw new Error(`dedupe key must be 1..${DEDUPE_KEY_MAX_LENGTH} characters`);
    }
  }

  // Captured inside the transaction (idle path) so the task publish below
  // can inject user_env without re-reading the DB. Queue path freezes it
  // onto claw_pending_messages directly and leaves this map empty.
  let capturedUserEnvSnapshot: Record<string, string> = {};

  // Minted before the gate is taken, so marker and turn are one string.
  const turnMessageId = newChatMessageId();

  let queued: { pendingId: number | null; deduplicated: boolean; wasRunning: boolean } | null = null;

  // Transaction: lock row → check status → queue or dispatch
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const lockResult = await client.query(
      "SELECT agent_status, user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL FOR UPDATE",
      [sessionId],
    );
    if (!lockResult.rows.length) {
      await client.query("ROLLBACK");
      return { kind: "session_not_found" };
    }
    const row = lockResult.rows[0];
    // Owner-only: text/inject messages are conversation writes; only the
    // session creator may extend the conversation. Other ops on this session
    // (read, interrupt, delete-of-own-session) are governed by their own
    // rules, in the route.
    if (!canAccessSession(row.user_id, userId) && !(!row.user_id && user && isSystemAdmin(user))) {
      await client.query("ROLLBACK");
      return { kind: "not_owner" };
    }
    const refusal = await input.refuse?.(client);
    if (refusal) {
      await client.query("ROLLBACK");
      return { kind: "refused", error: refusal };
    }

    const status = lockResult.rows[0].agent_status;
    // Snapshot per-user env at message creation time. Decrypted once here,
    // frozen on the pending_messages row (queue path) or NATS task body
    // (immediate path) so Brain reads plaintext without touching the
    // master key. Same userId source as the SELECT above (req.user).
    // IMPORTANT: reuse the transaction connection `client` here. Using the
    // pool (`db`) would borrow a second connection while this tx still holds
    // the FOR UPDATE row lock; under load that exhausts the pool, leaving
    // connections stuck "idle in transaction" holding claw_sessions locks
    // and blocking ALTER TABLE / reads cluster-wide.
    const userEnvSnapshot = await loadUserEnvSnapshot(client, userId, logger);
    if (status === "running" || mode === "enqueue") {
      const secrets = pendingSecretColumns({
        llmKey: resolveUserLlmKey(user) || "",
        platformKey: user?.platformKey || "",
        userEnv: userEnvSnapshot,
        doorbell: RUN_DOORBELL_DISPATCH,
      });
      const inserted = await insertPendingMessage(client, {
        sessionId,
        content,
        userId,
        pluginId,
        toolIds,
        workspaceId,
        secrets,
        image: requestImage,
        resource: requestResource,
        timeout: requestTimeout,
        sessionEnv,
        topology,
        dedupeKey,
      });
      await client.query("COMMIT");
      queued = { pendingId: inserted.id, deduplicated: inserted.deduplicated, wasRunning: status === "running" };
    } else {
      // Stash the snapshot for the immediate-dispatch path below — building
      // `task` happens outside the transaction so we need it accessible.
      capturedUserEnvSnapshot = userEnvSnapshot;

      await takeSessionGate(sessionId, turnMessageId, client);
      await client.query("COMMIT");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  if (queued) {
    // No run id here, and none invented. What this call accepted is a queued
    // message; the run row is opened later by the drain, once the turn in
    // front of it finishes. An id minted now would answer 404 on `/v1/runs`
    // until then, and would name nothing at all if the replay is later refused
    // a workspace or its admission. The caller polls the session until a run
    // appears -- see docs/run-api.md.
    const { pendingId, deduplicated, wasRunning } = queued;
    if (deduplicated) return { kind: "queued", pendingId, deduplicated, drain: "duplicate" };
    if (wasRunning) return { kind: "queued", pendingId, deduplicated, drain: "awaiting_turn" };
    // `enqueue` on a session nobody holds: nothing will complete to drain this,
    // so it is drained here, after the transaction and on its own connection.
    // This is the drain the completion handler runs, with the caveat it has: a
    // send that takes the gate between the commit above and this call puts a
    // second turn on a live session, which Brain serialises per session.
    //
    // A drain that throws leaves the message queued, which is the state the
    // sweeper's orphan drain exists to find; the answer says so rather than
    // failing a submit whose message is recorded.
    try {
      await submitMessagePorts.drainOldestPendingMessage(sessionId, userId);
    } catch (err) {
      logger.warn({ err, sessionId, pendingId }, "message.enqueue_drain_failed");
      return { kind: "queued", pendingId, deduplicated, drain: "drain_failed" };
    }
    return { kind: "queued", pendingId, deduplicated, drain: "drained" };
  }

  // A3: client already disconnected — don't dispatch; revert to idle so no
  // phantom 'running' spinner is left behind (mirrors the publish-failure
  // rollback below). The transaction above already committed 'running'.
  if (input.isCancelled?.()) {
    await releaseSessionGateForTurn(sessionId, turnMessageId);
    logger.warn({ sessionId, userId }, "message.client_gone_pre_dispatch");
    return { kind: "client_gone" };
  }

  // Outside transaction: hand off to the shared brain-dispatch helper.
  // On JetStream publish failure we MUST flip agent_status back to 'idle'
  // here (the transaction above committed 'running'); otherwise the
  // frontend spinner never stops and the next /messages POST queues into
  // claw_pending_messages waiting for an exec_complete that never arrives.
  const dispatch = await dispatchTaskToBrain(
    {
      sessionId, userId, user,
      content, messageType, toolIds, pluginId,
      requestImage, requestResource, requestTimeout, topology,
      workspaceId, mcpServers,
      capturedUserEnvSnapshot,
      capturedSessionEnv: sessionEnv,
      messageId: turnMessageId,
    },
    async () => {
      await releaseSessionGateForTurn(sessionId, turnMessageId);
    },
  );
  if (dispatch.kind === "publish_failed" || dispatch.kind === "publish_unknown") {
    return { kind: "dispatch_failed", messageId: dispatch.messageId, error: dispatch.error };
  }
  if (dispatch.kind === "rejected") {
    return { kind: "admission_rejected", messageId: dispatch.messageId, reason: dispatch.reason };
  }
  return { kind: "dispatched", messageId: dispatch.messageId, runId: dispatch.runId };
}
