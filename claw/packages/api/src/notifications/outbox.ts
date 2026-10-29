// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The notification outbox: durable, at-least-once webhook delivery.
 *
 * An event becomes one row per matching subscription. `(event_id,
 * subscription_id)` is unique, and `event_id` is derived from what happened
 * rather than generated, so recording the same completion twice -- a redelivered
 * `exec_complete` -- stores it once, and a receiver that sees the same
 * `X-Claw-Event-Id` twice can drop the second.
 *
 * Delivery claims due rows with `FOR UPDATE SKIP LOCKED`, the same shape as the
 * skill-evolution worker, so any number of replicas can run the loop. A claim
 * pushes `next_attempt_at` a lease into the future, which is what makes a
 * replica that dies mid-send hand the row back instead of stranding it.
 */
import { createHash, randomUUID } from "node:crypto";
import pino from "pino";
import { NOTIFY_LINK_BASE, NOTIFY_MIN_RUN_SECONDS, NOTIFY_WEBHOOK_ALLOWED_HOSTS } from "../config.js";
import { decryptUserEnvValue } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { redactPublicJson } from "../events/redaction.js";
import { approvalTarget } from "./approval-target.js";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signPayload } from "./signing.js";
import { httpTransport, type Transport } from "./transport.js";
import { guardWebhookUrl, parseAllowedHosts, type Resolver } from "./url-guard.js";

const logger = pino({ name: "notification-outbox" });

/** Seconds to wait after the Nth failed attempt; the last step repeats. */
export const RETRY_BACKOFF_SECONDS = [1, 5, 30, 300];
/** A row that has not been delivered this long after it was created is dropped. */
export const GIVE_UP_AFTER_HOURS = 24;
/**
 * A subscription that has not had a single delivery succeed for this long is
 * disabled. Measured in time rather than attempts: attempts pile up quickly
 * across queued events, and the retry window is what promises a receiver that is
 * down for a few hours loses nothing.
 */
export const SUBSCRIPTION_DISABLE_AFTER_HOURS = GIVE_UP_AFTER_HOURS;
/** Longer than the slowest group of sequential sends in one claimed batch. */
const CLAIM_LEASE_SECONDS = 120;
const CLAIM_BATCH = 10;
const SUMMARY_MAX = 500;

export type NotificationEventType = "run.completed" | "run.failed" | "approval.requested";

/** The part of an `approval.requested` payload that says what is being asked. */
export interface ApprovalInfo {
  tool_use_id: string;
  tool: string;
  /** Redacted and clipped to 300 characters; see approval-target.ts. */
  target: string;
  /** ISO-8601 with an offset: when Brain stops waiting, after which the request is refused. */
  expires_at: string;
}

export interface NotificationPayload {
  event_id: string;
  type: NotificationEventType;
  occurred_at: string;
  user_id: string;
  session_id: string;
  task_id: string;
  trigger_id: string | null;
  title: string;
  summary: string;
  link: string;
  /** Present on `approval.requested` only. */
  approval?: ApprovalInfo;
}

/** Same inputs, same id: the receiver's dedup key. */
export function deterministicEventId(type: string, sessionId: string, taskId: string): string {
  const h = createHash("sha256").update(`${type}\u0000${sessionId}\u0000${taskId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function clipSummary(text: string): string {
  const redacted = String(redactPublicJson(text) ?? "");
  return redacted.length > SUMMARY_MAX ? `${redacted.slice(0, SUMMARY_MAX - 1)}…` : redacted;
}

export interface RunFinished {
  sessionId: string;
  taskIds: string[];
  outcome: "completed" | "failed";
  failureReason?: string;
}

/**
 * Record notifications for runs that just finished.
 *
 * Which runs: those started by a trigger (the session carries `trigger_id`),
 * and those in a session that opted in with `config.notify_on_finish === true`
 * and ran at least `NOTIFY_MIN_RUN_SECONDS`. A short interactive turn is not
 * announced, or every chat message would push one, and a session that did not
 * opt in is never announced as a long run, or every API-created session of a
 * shared account would.
 *
 * Returns how many outbox rows were newly written.
 */
export async function recordRunFinished(input: RunFinished): Promise<number> {
  if (!input.taskIds.length) return 0;
  const rows = (await db.query(
    `SELECT t.task_id, s.user_id, s.name, s.config->>'trigger_id' AS trigger_id,
            (s.config->'notify_on_finish' = 'true'::jsonb) AS notify_on_finish,
            COALESCE(t.completed_at, NOW()) AS finished_at,
            EXTRACT(EPOCH FROM (COALESCE(t.completed_at, NOW()) - COALESCE(t.started_at, t.created_at))) AS seconds
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.session_id = $1 AND t.task_id = ANY($2)`,
    [input.sessionId, input.taskIds],
  )).rows;
  const type: NotificationEventType = input.outcome === "failed" ? "run.failed" : "run.completed";
  let written = 0;
  for (const row of rows) {
    if (!row.user_id || row.user_id === "default") continue;
    const sources: string[] = [];
    if (row.trigger_id) sources.push("trigger");
    if (row.notify_on_finish === true && Number(row.seconds) >= NOTIFY_MIN_RUN_SECONDS) sources.push("long_run");
    if (!sources.length) continue;
    const subs = (await db.query(
      `SELECT subscription_id FROM claw_notification_subscriptions
        WHERE owner_user_id = $1 AND enabled AND $2 = ANY(event_types) AND sources && $3::text[]`,
      [row.user_id, type, sources],
    )).rows;
    if (!subs.length) continue;
    const eventId = deterministicEventId(type, input.sessionId, row.task_id);
    const name = String(row.name || "").trim();
    const payload: NotificationPayload = {
      event_id: eventId,
      type,
      occurred_at: new Date(row.finished_at).toISOString(),
      user_id: row.user_id,
      session_id: input.sessionId,
      task_id: row.task_id,
      trigger_id: row.trigger_id ?? null,
      title: `${type === "run.failed" ? "Run failed" : "Run completed"}${name ? `: ${name}` : ""}`.slice(0, 200),
      summary: type === "run.failed" ? clipSummary(input.failureReason ?? "") : "",
      link: `${NOTIFY_LINK_BASE}/sessions/${input.sessionId}`,
    };
    written += await enqueue(eventId, subs, payload);
  }
  return written;
}

/** One outbox row per subscription; a row that already exists (same event, same subscription) is left alone. */
async function enqueue(
  eventId: string,
  subs: Array<{ subscription_id: string }>,
  payload: NotificationPayload,
): Promise<number> {
  let written = 0;
  for (const sub of subs) {
    const r = await db.query(
      `INSERT INTO claw_notification_outbox (event_id, subscription_id, payload)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id, subscription_id) DO NOTHING`,
      [eventId, sub.subscription_id, JSON.stringify(payload)],
    );
    written += r.rowCount ?? 0;
  }
  return written;
}

/** How long Brain waits for a decision when the request does not say (HITL_DECISION_TIMEOUT_MS's default). */
const APPROVAL_DEFAULT_WAIT_MS = 300_000;
/** A decision window longer than this is not believed. */
const APPROVAL_MAX_WAIT_MS = 24 * 3_600_000;
/** Brain's clock may differ from this one's; further apart than this, its timestamp is not used. */
const APPROVAL_MAX_CLOCK_SKEW_MS = 10 * 60_000;
const TITLE_MAX = 200;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Record a notification for a tool call that is held for a person's decision.
 *
 * Fed by the `permissionRequest` event Brain emits when it starts waiting. The
 * same opt-in as run notifications -- a session started by a trigger, or one
 * created with `config.notify_on_finish: true` -- and the same subscriptions,
 * except that a subscription must also list `approval.requested` in its
 * `event_types` (the default is still the two run events, so an existing receiver
 * is not sent a type it never asked for). `NOTIFY_MIN_RUN_SECONDS` does not apply:
 * a person who is not looking at the run is the very case an approval push is for,
 * and a short run can be the one that is waiting.
 *
 * Idempotent: the event id is derived from (type, session, tool_use_id), so the
 * same request seen twice -- a redelivered event, a run resumed after a restart,
 * a sub-agent re-asking -- is one row per subscription.
 *
 * Returns how many outbox rows were newly written.
 */
export async function recordApprovalRequested(
  input: { sessionId: string; event: Record<string, unknown> },
  now: () => number = Date.now,
): Promise<number> {
  const { sessionId, event } = input;
  const toolUseId = text(event.tool_use_id) || text(event.actionId);
  const tool = text(event.tool);
  if (!toolUseId || !tool) {
    logger.warn({ sessionId, hasToolUseId: !!toolUseId, hasTool: !!tool }, "notification.approval_malformed_skipped");
    return 0;
  }
  const session = (await db.query(
    `SELECT user_id, name, config->>'trigger_id' AS trigger_id,
            (config->'notify_on_finish' = 'true'::jsonb) AS notify_on_finish
       FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId],
  )).rows[0];
  if (!session || !session.user_id || session.user_id === "default") return 0;
  const sources: string[] = [];
  if (session.trigger_id) sources.push("trigger");
  if (session.notify_on_finish === true) sources.push("long_run");
  if (!sources.length) return 0;
  const subs = (await db.query(
    `SELECT subscription_id FROM claw_notification_subscriptions
      WHERE owner_user_id = $1 AND enabled AND 'approval.requested' = ANY(event_types) AND sources && $2::text[]`,
    [session.user_id, sources],
  )).rows;
  if (!subs.length) return 0;

  const clock = now();
  const emittedAt = Number(event.ts);
  const startedAt = Number.isFinite(emittedAt) && Math.abs(emittedAt - clock) <= APPROVAL_MAX_CLOCK_SKEW_MS ? emittedAt : clock;
  const waitMs = Number(event.timeout_ms);
  const waitWindowMs = Number.isFinite(waitMs) && waitMs > 0 && waitMs <= APPROVAL_MAX_WAIT_MS ? waitMs : APPROVAL_DEFAULT_WAIT_MS;

  // The run this request belongs to: Brain stamps every event with the message id of the turn.
  const messageId = text(event.message_id);
  const taskId = messageId
    ? (await db.query(
      `SELECT task_id FROM claw_tasks WHERE session_id = $1 AND metadata->>'message_id' = $2 ORDER BY created_at DESC LIMIT 1`,
      [sessionId, messageId],
    )).rows[0]?.task_id ?? messageId
    : "";

  const eventId = deterministicEventId("approval.requested", sessionId, toolUseId);
  const name = String(session.name || "").trim();
  const payload: NotificationPayload = {
    event_id: eventId,
    type: "approval.requested",
    occurred_at: new Date(startedAt).toISOString(),
    user_id: session.user_id,
    session_id: sessionId,
    task_id: taskId,
    trigger_id: session.trigger_id ?? null,
    title: `Approval needed: ${tool}${name ? ` (${name})` : ""}`.slice(0, TITLE_MAX),
    summary: clipSummary(text(event.summary) || text(event.approval_label)),
    link: `${NOTIFY_LINK_BASE}/sessions/${sessionId}`,
    approval: {
      tool_use_id: toolUseId.slice(0, 200),
      tool: tool.slice(0, 200),
      target: approvalTarget(tool, event.input),
      expires_at: new Date(startedAt + waitWindowMs).toISOString(),
    },
  };
  return enqueue(eventId, subs, payload);
}

export interface DeliveryDeps {
  transport?: Transport;
  resolve?: Resolver;
  allowedHosts?: Set<string>;
  now?: () => number;
}

interface Claimed {
  id: string;
  event_id: string;
  subscription_id: string;
  payload: NotificationPayload;
  attempts: number;
  expired: boolean;
}

async function claimDue(): Promise<Claimed[]> {
  return (await db.query(
    `UPDATE claw_notification_outbox
        SET attempts = attempts + 1,
            next_attempt_at = NOW() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM claw_notification_outbox
         WHERE delivered_at IS NULL AND dropped_at IS NULL AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, event_id, subscription_id, payload, attempts,
                created_at < NOW() - make_interval(hours => $3) AS expired`,
    [CLAIM_BATCH, CLAIM_LEASE_SECONDS, GIVE_UP_AFTER_HOURS],
  )).rows;
}

async function recordFailure(row: Claimed, status: string): Promise<void> {
  if (row.expired) {
    await db.query(
      `UPDATE claw_notification_outbox SET dropped_at = NOW(), last_status = $2 WHERE id = $1`,
      [row.id, status],
    );
    logger.warn({ eventId: row.event_id, subscriptionId: row.subscription_id, status }, "notification.dropped_after_retries");
  } else {
    const wait = RETRY_BACKOFF_SECONDS[Math.min(row.attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
    await db.query(
      `UPDATE claw_notification_outbox
          SET next_attempt_at = NOW() + make_interval(secs => $2), last_status = $3
        WHERE id = $1`,
      [row.id, wait, status],
    );
  }
  const sub = (await db.query(
    `UPDATE claw_notification_subscriptions
        SET consecutive_failures = consecutive_failures + 1,
            failing_since = COALESCE(failing_since, NOW()),
            enabled = enabled AND COALESCE(failing_since, NOW()) > NOW() - make_interval(hours => $2),
            -- Remember that it was the failure path that turned it off, so a
            -- delivery already in flight on another replica can turn it back on.
            auto_disabled = auto_disabled
              OR (enabled AND NOT (COALESCE(failing_since, NOW()) > NOW() - make_interval(hours => $2))),
            updated_at = NOW()
      WHERE subscription_id = $1
      RETURNING enabled`,
    [row.subscription_id, SUBSCRIPTION_DISABLE_AFTER_HOURS],
  )).rows[0];
  if (sub && !sub.enabled) {
    logger.warn({ subscriptionId: row.subscription_id }, "notification.subscription_disabled_after_failures");
  }
}

/** Deliver every row that is due. Returns counts, for tests and logs. */
export async function deliverDue(deps: DeliveryDeps = {}): Promise<{ delivered: number; failed: number }> {
  const transport = deps.transport ?? httpTransport;
  const allowed = deps.allowedHosts ?? parseAllowedHosts(NOTIFY_WEBHOOK_ALLOWED_HOSTS);
  const nowSeconds = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let delivered = 0;
  let failed = 0;
  const sendOne = async (row: Claimed): Promise<void> => {
    const sub = (await db.query(
      `SELECT url, secret_enc, enabled FROM claw_notification_subscriptions WHERE subscription_id = $1`,
      [row.subscription_id],
    )).rows[0];
    if (!sub || !sub.enabled) {
      await db.query(
        `UPDATE claw_notification_outbox SET dropped_at = NOW(), last_status = 'subscription_gone' WHERE id = $1`,
        [row.id],
      );
      return;
    }
    let status = "";
    try {
      const target = await guardWebhookUrl(sub.url, allowed, deps.resolve);
      if (!target.ok) {
        status = `refused:${target.reason}`;
      } else {
        const body = JSON.stringify(row.payload);
        const ts = nowSeconds();
        const code = await transport({
          target,
          body,
          headers: {
            [TIMESTAMP_HEADER]: String(ts),
            [SIGNATURE_HEADER]: signPayload(decryptUserEnvValue(sub.secret_enc), ts, body),
            [EVENT_ID_HEADER]: row.event_id,
          },
        });
        if (code >= 200 && code < 300) {
          await db.query(
            `UPDATE claw_notification_outbox SET delivered_at = NOW(), last_status = $2 WHERE id = $1`,
            [row.id, String(code)],
          );
          await db.query(
            `UPDATE claw_notification_subscriptions
                SET consecutive_failures = 0, failing_since = NULL,
                    -- A 2xx proves the receiver works. If another replica's failure
                    -- disabled the subscription while this send was in flight, undo
                    -- that; a subscription the owner disabled is left alone.
                    enabled = enabled OR auto_disabled, auto_disabled = FALSE
              WHERE subscription_id = $1
                AND (consecutive_failures <> 0 OR failing_since IS NOT NULL OR auto_disabled)`,
            [row.subscription_id],
          );
          delivered += 1;
          return;
        }
        status = `http_${code}`;
      }
    } catch (err) {
      status = `error:${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`;
    }
    failed += 1;
    await recordFailure(row, status);
  };
  // One receiver's slowness must not hold up the others: each subscription's rows
  // are sent in order, and the subscriptions run side by side.
  const bySub = new Map<string, Claimed[]>();
  for (const row of await claimDue()) {
    const list = bySub.get(row.subscription_id) ?? [];
    list.push(row);
    bySub.set(row.subscription_id, list);
  }
  await Promise.all([...bySub.values()].map(async (rows) => {
    for (const row of rows) await sendOne(row);
  }));
  return { delivered, failed };
}

export function newSubscriptionId(): string {
  return randomUUID();
}

const POLL_MS = 5000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    deliverDue()
      .catch((err) => logger.error({ err }, "notification.tick_failed"))
      .finally(() => { inFlight = false; });
  }, POLL_MS);
  timer.unref();
  logger.info({ pollMs: POLL_MS }, "notification-worker.started");
}

export function stopNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
