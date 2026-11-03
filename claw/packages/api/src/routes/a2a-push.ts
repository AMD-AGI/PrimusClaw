// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// A2A push notifications (spec v1.0.1, 3.1.7-3.1.10 and 4.3.3).
//
// A client registers a webhook for a task; when the task changes state the
// server POSTs a `StreamResponse` to it. What the spec asks of a sender, and
// what this does:
//
//   - The receiver is authenticated with what the CLIENT supplied. The config's
//     `authentication` is sent as `Authorization: <scheme> <credentials>` and
//     its `token` as `X-A2A-Notification-Token`, the header the official SDK's
//     sender uses (spec 4.3.3 and 13.2: "MUST include authentication credentials
//     ... as specified in PushNotificationConfig.authentication"). v1.0.1 names
//     no server-held signing key for notifications (its JWS/JWKS text is about
//     Agent Card signatures), so none is invented here.
//   - A webhook URL is refused if it resolves to loopback, link-local, private
//     or cluster space (13.2 SSRF), unless the operator names the host in
//     CLAW_A2A_PUSH_ALLOWED_HOSTS. The check runs when the config is created
//     and again at every delivery, and the delivery connects to the address
//     that passed (notifications/url-guard.ts, transport.ts), so a name that
//     resolves elsewhere the second time cannot redirect it.
//   - Delivery is at least once, durable (an outbox row per notification) and
//     retried with backoff; a config is dropped with its task's final
//     notification ("MUST persist until task completion or explicit deletion").
//     The final notification is owed to every run that ends, whoever closed
//     it: the completion event writes it when it arrives, and
//     `enqueueFinalForClosedRuns` writes it for a run that was closed without
//     one (the sweeper's budget and unconfirmed-stop closes, a lost event).
//   - A config is the task's: its id is unique within the task, never across
//     callers, so the id a client picks cannot collide with, or reveal, another's.
//
// Credentials are stored encrypted and never returned by Get/List.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import pino from "pino";
import { db } from "../infra/db.js";
import { decryptUserEnvValue, encryptUserEnvValue } from "../crypto/user-env.js";
import { sanitizeSessionEvent } from "../events/store.js";
import { httpTransport, type Transport } from "../notifications/transport.js";
import { guardWebhookUrl, type Resolver } from "../notifications/url-guard.js";
import { a2aPushAllowedHosts, a2aPushEnabled } from "./a2a-flags.js";
import { loadLatestRunOfSession, loadRun, loadRunEvents, loadRunOfSessionMessage } from "./a2a-store.js";
import {
  mapLiveEvent, newStreamState, statusUpdateEvent, taskOf, textArtifactId,
  type RunRecord,
} from "./a2a-task-view.js";
import type { StreamResponse, TaskPushNotificationConfig } from "./a2a-types.js";

const logger = pino({ name: "a2a-push" });

export const MAX_CONFIGS_PER_TASK = 5;
const MAX_TOKEN_CHARS = 512;
const MAX_SCHEME_CHARS = 32;
const MAX_CREDENTIAL_CHARS = 4096;
/** How long a closed run is left to its own completion event before the worker writes its final notification. */
export const FINAL_RECONCILE_GRACE_SECONDS = 15;
const RECONCILE_EVERY_MS = 10_000;
/** Seconds to wait after the Nth failed attempt; the last step repeats. */
export const RETRY_BACKOFF_SECONDS = [1, 5, 30, 300];
/** A notification still undelivered this long after it was written is dropped. */
export const GIVE_UP_AFTER_SECONDS = 3600;
/** Spec 4.3.3 recommends 10-30 s per request. */
export const WEBHOOK_TIMEOUT_MS = 15_000;
const CLAIM_LEASE_SECONDS = 120;
const CLAIM_BATCH = 20;

export const NOTIFICATION_TOKEN_HEADER = "X-A2A-Notification-Token";
export const NOTIFICATION_CONTENT_TYPE = "application/a2a+json";

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

export type PushConfigInput = Omit<TaskPushNotificationConfig, "taskId" | "tenant">;

export type PushValidation =
  | { ok: true; value: { id?: string; url: string; token?: string; scheme?: string; credentials?: string } }
  | { ok: false; error: string };

/** Shape checks only; where the URL points is `guardWebhookUrl`'s question. */
export function validatePushConfig(raw: unknown): PushValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the push notification config must be an object" };
  const c = raw as Record<string, unknown>;
  if (typeof c.url !== "string" || !c.url) return { ok: false, error: "url is required" };
  if (c.id !== undefined && (typeof c.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.id))) {
    return { ok: false, error: "id must be 1-128 characters of [A-Za-z0-9_.:-]" };
  }
  if (c.token !== undefined && (typeof c.token !== "string" || c.token.length > MAX_TOKEN_CHARS)) {
    return { ok: false, error: `token must be a string of at most ${MAX_TOKEN_CHARS} characters` };
  }
  let scheme: string | undefined;
  let credentials: string | undefined;
  if (c.authentication !== undefined) {
    const a = c.authentication as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || typeof a.scheme !== "string" || !/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/.test(a.scheme)
      || a.scheme.length > MAX_SCHEME_CHARS) {
      return { ok: false, error: "authentication.scheme must be an HTTP authentication scheme token" };
    }
    if (a.credentials !== undefined && (typeof a.credentials !== "string" || a.credentials.length > MAX_CREDENTIAL_CHARS
      // The value goes into a header: a line break would add a header of the client's choosing.
      || /[\r\n\u0000]/.test(a.credentials))) {
      return { ok: false, error: "authentication.credentials must be a single-line string" };
    }
    scheme = a.scheme;
    credentials = a.credentials as string | undefined;
  }
  if (typeof c.token === "string" && /[\r\n\u0000]/.test(c.token)) return { ok: false, error: "token must be a single-line string" };
  return {
    ok: true,
    value: {
      id: c.id as string | undefined, url: c.url, token: c.token as string | undefined, scheme, credentials,
    },
  };
}

export type CreateResult =
  | { ok: true; config: TaskPushNotificationConfig }
  | { ok: false; kind: "refused_url" | "too_many" | "duplicate_id"; error: string };

/** The URL check a config must pass before it is stored. */
export async function checkWebhookUrl(
  url: string,
  resolve?: Resolver,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const guarded = await guardWebhookUrl(url, a2aPushAllowedHosts(), resolve);
  return guarded.ok ? { ok: true } : { ok: false, reason: guarded.reason };
}

function wire(row: Record<string, unknown>): TaskPushNotificationConfig {
  return {
    id: String(row.config_id),
    taskId: String(row.task_id),
    url: String(row.url),
    ...(row.auth_scheme ? { authentication: { scheme: String(row.auth_scheme) } } : {}),
  };
}

/**
 * Store a validated config for a task. The caller has already checked the task
 * is the caller's and not finished, and has run {@link checkWebhookUrl}.
 * `client` lets the send path write it on its own transaction.
 */
export async function insertPushConfig(
  run: Pick<RunRecord, "taskId" | "sessionId">,
  ownerId: string,
  value: Extract<PushValidation, { ok: true }>["value"],
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } = db,
): Promise<CreateResult> {
  const count = Number(((await q.query(
    "SELECT COUNT(*)::int AS n FROM claw_a2a_push_configs WHERE task_id = $1", [run.taskId],
  )).rows[0] as { n: number }).n);
  if (count >= MAX_CONFIGS_PER_TASK) {
    return { ok: false, kind: "too_many", error: `a task takes at most ${MAX_CONFIGS_PER_TASK} push notification configs` };
  }
  const configId = value.id ?? randomUUID();
  const inserted = await q.query(
    `INSERT INTO claw_a2a_push_configs
       (config_id, task_id, session_id, owner, url, token_enc, auth_scheme, auth_credentials_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (task_id, config_id) DO NOTHING
     RETURNING config_id, task_id, url, auth_scheme`,
    [
      configId, run.taskId, run.sessionId, ownerId, value.url,
      value.token ? encryptUserEnvValue(value.token) : null,
      value.scheme ?? null,
      value.credentials ? encryptUserEnvValue(value.credentials) : null,
    ],
  );
  // The key is (task, id) and the task is the caller's own, so this names a config of this task only.
  if (!inserted.rows[0]) return { ok: false, kind: "duplicate_id", error: "a push notification config with this id already exists on this task" };
  return { ok: true, config: wire(inserted.rows[0] as Record<string, unknown>) };
}

export async function getPushConfig(
  taskId: string, configId: string, ownerId: string,
): Promise<TaskPushNotificationConfig | null> {
  const r = await db.query(
    `SELECT config_id, task_id, url, auth_scheme FROM claw_a2a_push_configs
      WHERE task_id = $1 AND config_id = $2 AND owner = $3`,
    [taskId, configId, ownerId],
  );
  return r.rows[0] ? wire(r.rows[0] as Record<string, unknown>) : null;
}

export async function listPushConfigs(taskId: string, ownerId: string): Promise<TaskPushNotificationConfig[]> {
  const r = await db.query(
    `SELECT config_id, task_id, url, auth_scheme FROM claw_a2a_push_configs
      WHERE task_id = $1 AND owner = $2 ORDER BY created_at, config_id`,
    [taskId, ownerId],
  );
  return (r.rows as Array<Record<string, unknown>>).map(wire);
}

/** Idempotent, as the spec requires: deleting what is not there is not an error. */
export async function deletePushConfig(taskId: string, configId: string, ownerId: string): Promise<void> {
  await db.query(
    "DELETE FROM claw_a2a_push_configs WHERE task_id = $1 AND config_id = $2 AND owner = $3",
    [taskId, configId, ownerId],
  );
}

// ---------------------------------------------------------------------------
// From session events to notifications
// ---------------------------------------------------------------------------

const TRIGGERS = new Set([
  "statusUpdate", "permissionRequest", "userQuestion", "decisionResult", "toolUsed", "exec_complete",
]);

interface Notification { key: string; payload: StreamResponse; final?: boolean }

/**
 * One statement per task, so the rows of a pass get consecutive ids in the
 * order given (delivery is by id) and two writers racing on the same final pass
 * cannot interleave them. A config deleted since the caller read it is simply
 * not matched.
 */
async function enqueue(taskId: string, configIds: string[], items: Notification[]): Promise<void> {
  if (!configIds.length || !items.length) return;
  await db.query(
    `INSERT INTO claw_a2a_push_outbox (task_id, config_id, dedupe_key, payload, final)
     SELECT c.task_id, c.config_id, i.key, i.payload::jsonb, i.final
       FROM claw_a2a_push_configs c
      CROSS JOIN unnest($3::text[], $4::text[], $5::boolean[]) WITH ORDINALITY AS i(key, payload, final, ord)
      WHERE c.task_id = $1 AND c.config_id = ANY($2::text[])
      ORDER BY c.config_id, i.ord
     ON CONFLICT (task_id, config_id, dedupe_key) DO NOTHING`,
    [taskId, configIds, items.map((i) => i.key), items.map((i) => JSON.stringify(i.payload)), items.map((i) => i.final ?? false)],
  );
  kickWorker();
}

/**
 * The closing notifications of a run, read from its row as it stands: the whole
 * text as one artifact, then the final status. The keys are fixed, so every way
 * of reaching this (the completion event, its redelivery, the worker finding a
 * closed run) records the same two rows once.
 */
async function enqueueFinal(run: RunRecord, configIds: string[]): Promise<void> {
  const settled = await loadRun(run.taskId) ?? run;
  const view = taskOf(settled, await loadRunEvents(settled));
  const text = view.artifacts?.find((a) => a.artifactId === textArtifactId(run.taskId))?.parts[0]?.text;
  const items: Notification[] = [];
  if (text) {
    items.push({
      key: "final:artifact",
      payload: {
        artifactUpdate: {
          taskId: run.taskId,
          contextId: run.contextId,
          artifact: { artifactId: textArtifactId(run.taskId), name: "response", parts: [{ text, mediaType: "text/plain" }] },
          append: false,
          lastChunk: true,
        },
      },
    });
  }
  items.push({ key: "final:status", payload: statusUpdateEvent(settled, view.status.state, view.status.message), final: true });
  await enqueue(run.taskId, configIds, items);
}

/**
 * Write the final notification of every run that has ended without one.
 *
 * The completion event is not the only way a run ends: the sweeper closes one
 * that outlived its budget as `failed`, and one whose stop was never confirmed
 * as `cancelled`, and sends an interrupt, not a completion. A webhook told
 * `WORKING` for a task that is `FAILED` would wait for ever, and its config (with
 * the client's credentials) would never be retired. So this reads the rows, which
 * every close writes, rather than depending on each closer to say so. A run only
 * counts as missed after a grace period, so the event that normally writes the
 * notification is left to; and if both do, the fixed keys make it one.
 */
export async function enqueueFinalForClosedRuns(
  graceSeconds = FINAL_RECONCILE_GRACE_SECONDS,
): Promise<number> {
  const due = (await db.query(
    `SELECT c.task_id, array_agg(c.config_id) AS config_ids
       FROM claw_a2a_push_configs c
       JOIN claw_tasks t ON t.task_id = c.task_id
      WHERE t.status IN ('completed', 'failed', 'cancelled')
        AND (t.completed_at IS NULL OR t.completed_at < NOW() - make_interval(secs => $1))
        AND NOT EXISTS (
          SELECT 1 FROM claw_a2a_push_outbox o
           WHERE o.task_id = c.task_id AND o.config_id = c.config_id AND o.final)
      GROUP BY c.task_id
      LIMIT 50`,
    [graceSeconds],
  )).rows as Array<{ task_id: string; config_ids: string[] }>;
  let n = 0;
  for (const d of due) {
    const run = await loadRun(d.task_id);
    if (!run) continue;
    await enqueueFinal(run, d.config_ids);
    n += d.config_ids.length;
  }
  return n;
}

/**
 * Called by the event consumer after it has stored (and, for a completion,
 * processed) an event. Writes the outbox rows the event owes; sends nothing.
 *
 * Cheap for a session with no configuration, which is nearly all of them: one
 * indexed read. Redelivery of the same event repeats the same keys and so adds
 * nothing.
 */
export async function recordSessionEvent(
  sessionId: string,
  event: Record<string, unknown>,
  eventRowId: number | null,
): Promise<number> {
  if (!a2aPushEnabled()) return 0;
  const type = typeof event.type === "string" ? event.type : "";
  if (!TRIGGERS.has(type)) return 0;
  const configs = (await db.query(
    "SELECT config_id, task_id FROM claw_a2a_push_configs WHERE session_id = $1", [sessionId],
  )).rows as Array<{ config_id: string; task_id: string }>;
  if (!configs.length) return 0;
  // An event that names its turn belongs to that turn's task, even if the caller
  // has started the context's next task since the run was closed; one that does not
  // belongs to the context's newest.
  const named = typeof event.message_id === "string" ? event.message_id : "";
  const run = named ? await loadRunOfSessionMessage(sessionId, named) : await loadLatestRunOfSession(sessionId);
  if (!run) return 0;
  const ids = configs.filter((c) => c.task_id === run.taskId).map((c) => c.config_id);
  if (!ids.length) return 0;
  const safe = sanitizeSessionEvent(event);
  const origin = eventRowId ?? `${type}-${randomUUID()}`;

  if (type === "exec_complete") {
    const messageId = typeof event.message_id === "string" ? event.message_id : "";
    if (messageId && run.messageId && messageId !== run.messageId) return 0;
    // The state is the settled row's, not a reading of the event: the consumer
    // has closed the run before this is called.
    await enqueueFinal(run, ids);
    return ids.length;
  }

  const state = newStreamState();
  // A run already past `running` must not announce WORKING again for the same event type.
  const mapped = mapLiveEvent(run, safe, state);
  if (!mapped) return 0;
  // Chunks of text and the tool log are not pushed: a webhook gets state
  // changes and the finished result, not a request per token.
  const items = mapped.responses
    .filter((response) => "statusUpdate" in response)
    .map((payload, n) => ({ key: `${origin}:${n}`, payload }));
  await enqueue(run.taskId, ids, items);
  return items.length * ids.length;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryDeps {
  transport?: Transport;
  resolve?: Resolver;
  allowedHosts?: Set<string>;
}

interface Claimed {
  id: string;
  task_id: string;
  config_id: string;
  payload: StreamResponse;
  attempts: number;
  final: boolean;
  expired: boolean;
}

async function claimDue(): Promise<Claimed[]> {
  // Per configuration the oldest undelivered row goes first, and only it:
  // notifications for one webhook arrive in the order they were written. A head
  // that is backing off, or leased to another replica, holds its successors.
  return (await db.query(
    `WITH heads AS (
       SELECT DISTINCT ON (task_id, config_id) id
         FROM claw_a2a_push_outbox
        WHERE delivered_at IS NULL AND dropped_at IS NULL
        ORDER BY task_id, config_id, id
     )
     UPDATE claw_a2a_push_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = NOW() + make_interval(secs => $2)
      WHERE o.id IN (
        SELECT id FROM claw_a2a_push_outbox
         WHERE id IN (SELECT id FROM heads) AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.task_id, o.config_id, o.payload, o.attempts, o.final,
                o.created_at < NOW() - make_interval(secs => $3) AS expired`,
    [CLAIM_BATCH, CLAIM_LEASE_SECONDS, GIVE_UP_AFTER_SECONDS],
  )).rows as Claimed[];
}

/** A finished task's configuration goes with its last notification. */
async function retireIfFinal(row: Claimed): Promise<void> {
  if (row.final) {
    await db.query("DELETE FROM claw_a2a_push_configs WHERE task_id = $1 AND config_id = $2", [row.task_id, row.config_id]);
  }
}

async function sendOne(row: Claimed, deps: DeliveryDeps): Promise<boolean> {
  const config = (await db.query(
    `SELECT url, token_enc, auth_scheme, auth_credentials_enc FROM claw_a2a_push_configs
      WHERE task_id = $1 AND config_id = $2`,
    [row.task_id, row.config_id],
  )).rows[0] as Record<string, string | null> | undefined;
  if (!config) {
    await db.query(
      "UPDATE claw_a2a_push_outbox SET dropped_at = NOW(), last_status = 'config_gone' WHERE id = $1", [row.id],
    );
    return false;
  }
  let status: string;
  try {
    const target = await guardWebhookUrl(String(config.url), deps.allowedHosts ?? a2aPushAllowedHosts(), deps.resolve);
    if (!target.ok) {
      status = `refused:${target.reason}`;
    } else {
      const headers: Record<string, string> = { "content-type": NOTIFICATION_CONTENT_TYPE };
      if (config.token_enc) headers[NOTIFICATION_TOKEN_HEADER] = decryptUserEnvValue(config.token_enc);
      if (config.auth_scheme && config.auth_credentials_enc) {
        headers.authorization = `${config.auth_scheme} ${decryptUserEnvValue(config.auth_credentials_enc)}`;
      }
      const code = await (deps.transport ?? httpTransport)({
        target, headers, body: JSON.stringify(row.payload), timeoutMs: WEBHOOK_TIMEOUT_MS,
      });
      if (code >= 200 && code < 300) {
        await db.query(
          "UPDATE claw_a2a_push_outbox SET delivered_at = NOW(), last_status = $2 WHERE id = $1", [row.id, String(code)],
        );
        await retireIfFinal(row);
        return true;
      }
      status = `http_${code}`;
    }
  } catch (err) {
    status = `error:${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`;
  }
  // A name that does not resolve may resolve in a minute; a refused address stays refused.
  if (row.expired || (status.startsWith("refused:") && status !== "refused:unresolvable_host")) {
    // A refused URL stays refused (the host now resolves somewhere private, or
    // the operator took it off the list), so it is not retried.
    await db.query(
      "UPDATE claw_a2a_push_outbox SET dropped_at = NOW(), last_status = $2 WHERE id = $1", [row.id, status],
    );
    logger.warn({ configId: row.config_id, status }, "a2a_push.dropped");
    await retireIfFinal(row);
  } else {
    const wait = RETRY_BACKOFF_SECONDS[Math.min(row.attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
    await db.query(
      `UPDATE claw_a2a_push_outbox SET next_attempt_at = NOW() + make_interval(secs => $2), last_status = $3 WHERE id = $1`,
      [row.id, wait, status],
    );
  }
  return false;
}

/** Deliver every notification that is due. Returns counts, for tests and logs. */
export async function deliverDue(deps: DeliveryDeps = {}): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  // The claim takes one row per configuration, so these are all different receivers.
  await Promise.all((await claimDue()).map(async (row) => {
    if (await sendOne(row, deps)) delivered += 1; else failed += 1;
  }));
  return { delivered, failed };
}

const POLL_MS = 2000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let pending = false;
let lastReconcileAt = 0;

function tick(): void {
  if (inFlight) { pending = true; return; }
  inFlight = true;
  (async () => {
    // Ahead of delivery, so a final notification found here goes out in this pass.
    if (Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS) {
      lastReconcileAt = Date.now();
      await enqueueFinalForClosedRuns().catch((err) => logger.error({ err }, "a2a_push.reconcile_failed"));
    }
    return deliverDue();
  })()
    .then(async (r) => {
      // More rows may be waiting behind the ones just sent (one per receiver per pass).
      if (r.delivered > 0 || pending) { pending = false; setImmediate(tick); }
    })
    .catch((err) => logger.error({ err }, "a2a_push.tick_failed"))
    .finally(() => { inFlight = false; });
}

/** Ask the worker to run now rather than at its next poll. */
function kickWorker(): void {
  if (timer) setImmediate(tick);
}

export function startA2aPushWorker(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  logger.info({ pollMs: POLL_MS }, "a2a-push-worker.started");
}

export function stopA2aPushWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
