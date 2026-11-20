// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether the replies of the sessions on a person's machine are getting through to Claw, and telling them when they are not.
 *
 * The case it exists for: one event Claw could not store was refused with a 500 on every retry, the connector posted the same batch for
 * 15 hours, and every reply behind it waited with it. The machine stayed online, so nothing that watches presence noticed, and
 * the person found out by themselves. Two sides see such a stall, and both are recorded here, one row per connector in
 * `claw_remote_delivery_health`:
 *
 *  - the connector's own report, with every heartbeat (`RemoteOutboxReport`): how many events wait, for how long, in which
 *    sessions, and how many posts in a row failed and how. It sees what Claw cannot -- a proxy or a network that drops the
 *    posts -- and it sees them while the heartbeat still gets through;
 *  - Claw's own answers on `POST .../events` (`noteEventsPost`): a 5xx counted per connector, reset by the next success. It
 *    sees a stall even from a connector too old to report.
 *
 * A sweep, every few seconds on whichever replica takes the lock, holds each connector as `ok` or `stalled`. Stalled: posts
 * have failed for {@link STALL_NOTICE_MS} (2 minutes) on the connector's fresh report while events wait, or Claw has answered
 * its posts with a 5xx for that long and did so recently. On the step to stalled the owner is told once, through their
 * assistant, that the replies are delayed and being retried; when the posts succeed again (positive evidence: a report with no
 * failure and no failing answer of Claw's) they are told once that they get through. A connector that went quiet meanwhile
 * (offline: its report is stale) stays stalled and is told nothing more here -- presence (`presence.ts`) says it went offline.
 *
 * The same rows feed the delivery gauges (`sampleDeliveryHealth`, `infra/metrics.ts`) the alert rules read.
 */
import pino from "pino";
import type { RemoteOutboxReport } from "@claw/protocol";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { DELIVERY_SAMPLE_MAX_CONNECTORS, metrics, type DeliverySample } from "../infra/metrics.js";

const logger = pino({ name: "remote-agents-delivery-health" });

/** How long posts must have failed before the owner is told their replies are delayed. */
export const STALL_NOTICE_MS = 2 * 60 * 1000;
/** A connector's report older than this is not believed: three heartbeats. */
export const REPORT_FRESH_MS = 90 * 1000;
/** Claw's own failing answers count only while the last of them is this recent (the connector retries at least once a minute). */
export const API_FAILURE_FRESH_MS = 3 * 60 * 1000;
/** How often a replica tries to sweep. One sweep at a time across replicas (an advisory lock). */
export const DELIVERY_SWEEP_MS = 15 * 1000;

/** Same namespace as `store.ts`'s and `presence.ts`'s locks, a scope of its own. */
const LOCK_NS = 7_001;
const NAME_MAX = 64;

const clampInt = (n: number): number => Math.max(0, Math.min(2_000_000_000, Math.floor(n)));

/**
 * Record a connector's outbox report (`RemoteOutboxReport`). Null (a connector from before the report, or a malformed one)
 * records nothing. Ages become instants on Claw's clock, so the connector's clock never matters.
 */
export async function recordOutboxReport(connectorId: string, owner: string, report: RemoteOutboxReport | null | undefined): Promise<void> {
  if (!report) return;
  const sessions = report.sessions.map((s) => ({ session_id: s.sessionId, pending: clampInt(s.pending), oldest_age_ms: clampInt(s.oldestAgeMs) }));
  await db.query(
    `INSERT INTO claw_remote_delivery_health AS h
            (connector_id, owner_user_id, reported_at, pending, oldest_since, post_failures, post_failing_since, post_last_error, sessions)
     VALUES ($1, $2, NOW(), $3, CASE WHEN $3 > 0 THEN NOW() - make_interval(secs => $4::float8 / 1000) END,
             $5, CASE WHEN $5 > 0 THEN NOW() - make_interval(secs => $6::float8 / 1000) END, CASE WHEN $5 > 0 THEN $7 END, $8::jsonb)
     ON CONFLICT (connector_id) DO UPDATE SET
       reported_at = EXCLUDED.reported_at, pending = EXCLUDED.pending, oldest_since = EXCLUDED.oldest_since,
       post_failures = EXCLUDED.post_failures, post_failing_since = EXCLUDED.post_failing_since,
       post_last_error = EXCLUDED.post_last_error, sessions = EXCLUDED.sessions`,
    [connectorId, owner, clampInt(report.pending), clampInt(report.oldestAgeMs), clampInt(report.failures), clampInt(report.failingMs),
      report.lastError, JSON.stringify(sessions)],
  );
}

/** What Claw answered a connector's `POST .../events`: `ok`, or the failure (a PostgreSQL error code, or `error`). */
export async function noteEventsPost(connectorId: string, owner: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  if (outcome.ok) {
    // Written only when there is something to clear: every successful batch would otherwise write a row.
    await db.query(
      `UPDATE claw_remote_delivery_health SET api_failures = 0, api_failing_since = NULL, api_last_error = NULL
        WHERE connector_id = $1 AND api_failures <> 0`,
      [connectorId],
    );
    return;
  }
  const error = /^[A-Za-z0-9_]{1,32}$/.test(outcome.error) ? outcome.error : "error";
  await db.query(
    `INSERT INTO claw_remote_delivery_health AS h (connector_id, owner_user_id, api_failures, api_failing_since, api_failed_at, api_last_error)
     VALUES ($1, $2, 1, NOW(), NOW(), $3)
     ON CONFLICT (connector_id) DO UPDATE SET
       api_failures = h.api_failures + 1, api_failing_since = COALESCE(h.api_failing_since, NOW()), api_failed_at = NOW(),
       api_last_error = EXCLUDED.api_last_error`,
    [connectorId, owner, error],
  );
}

/** What one sweep decided to say, said after its transaction commits. */
export interface DeliveryNotice {
  kind: "delayed" | "recovered";
  connectorId: string;
  owner: string;
  name: string;
  episode: number;
  /** For `delayed`: events waiting and how long the oldest has, as the connector reported them (null: no report). */
  pending: number | null;
  oldestMinutes: number | null;
  sessions: number | null;
}

export interface DeliverySweepResult {
  /** False when another replica held the sweep. */
  swept: boolean;
  stalled: number;
  recovered: number;
  notices: DeliveryNotice[];
}

const oneLine = (text: unknown, max: number): string => {
  const t = String(text ?? "").replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export const DELIVERY_WORDS = {
  zh: {
    delayed: (name: string, pending: number | null, minutes: number | null) => pending !== null && minutes !== null
      ? `你的开发环境 ${name} 上的会话回复暂时没能送到（${pending} 条在排队，最早的已等 ${minutes} 分钟），正在自动重试；恢复后会再告诉你。`
      : `你的开发环境 ${name} 上的会话回复暂时没能送到，正在自动重试；恢复后会再告诉你。`,
    recovered: (name: string) => `你的开发环境 ${name} 上的会话回复已恢复送达，排队的回复正在补发。`,
  },
  en: {
    delayed: (name: string, pending: number | null, minutes: number | null) => pending !== null && minutes !== null
      ? `Replies from the sessions on your dev environment ${name} are delayed (${pending} waiting, the oldest for ${minutes} min). They are being retried; you will be told when they get through.`
      : `Replies from the sessions on your dev environment ${name} are delayed. They are being retried; you will be told when they get through.`,
    recovered: (name: string) => `Replies from the sessions on your dev environment ${name} are getting through again; the delayed ones are being delivered now.`,
  },
};

/** The words for a notice, in `lang`. Pure, for the tests. */
export function deliveryNoticeText(n: DeliveryNotice, lang: "zh" | "en"): string {
  const w = DELIVERY_WORDS[lang];
  const name = oneLine(n.name, NAME_MAX) || n.connectorId.slice(0, 8);
  return n.kind === "recovered" ? w.recovered(name) : w.delayed(name, n.pending, n.oldestMinutes);
}

/** The deterministic key of a notice: one per stall episode of a connector, whoever sends it and however often. */
export const deliveryNoticeKey = (n: Pick<DeliveryNotice, "kind" | "connectorId" | "episode">): string =>
  `remote-delivery-${n.kind}:${n.connectorId}:${n.episode}`;

/**
 * One sweep: judge every connector with a delivery row, and decide what to tell. Runs under a transaction-scoped advisory lock,
 * so two replicas never sweep at once; one that finds it held does nothing (`swept: false`).
 */
export async function sweepDeliveryHealth(opts: { stallAfterMs?: number; reportFreshMs?: number; apiFreshMs?: number } = {}): Promise<DeliverySweepResult> {
  const stallAfter = (opts.stallAfterMs ?? STALL_NOTICE_MS) / 1000;
  const fresh = (opts.reportFreshMs ?? REPORT_FRESH_MS) / 1000;
  const apiFresh = (opts.apiFreshMs ?? API_FAILURE_FRESH_MS) / 1000;
  return inTransaction(async (q) => {
    const got = (await q("SELECT pg_try_advisory_xact_lock($1, hashtext('delivery-health')) AS got", [LOCK_NS])).rows[0]?.got;
    if (!got) return { swept: false, stalled: 0, recovered: 0, notices: [] };
    const rows = (await q(
      `SELECT h.connector_id::text AS connector_id, h.owner_user_id, c.name, c.revoked_at, h.stall_state, h.stall_notice, h.stall_episode,
              h.stall_detail,
              -- The connector says its posts have failed for long enough, while events wait.
              (h.reported_at > NOW() - make_interval(secs => $2::float8) AND h.pending > 0 AND h.post_failures > 0
                 AND h.post_failing_since <= NOW() - make_interval(secs => $1::float8)) AS reported_stall,
              -- Claw has answered its posts with a failure for long enough, and still does.
              (h.api_failures > 0 AND h.api_failing_since <= NOW() - make_interval(secs => $1::float8)
                 AND h.api_failed_at > NOW() - make_interval(secs => $3::float8)) AS api_stall,
              -- Positive evidence that they get through: nothing failing on either side.
              (h.post_failures = 0 AND h.api_failures = 0) AS clear,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) THEN h.pending END AS pending,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) AND h.oldest_since IS NOT NULL
                   THEN FLOOR(EXTRACT(EPOCH FROM NOW() - h.oldest_since) / 60)::int END AS oldest_minutes,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) THEN jsonb_array_length(h.sessions) END AS sessions
         FROM claw_remote_delivery_health h
         JOIN claw_remote_connectors c ON c.connector_id = h.connector_id
        WHERE h.stall_state = 'stalled' OR h.stall_notice IN ('pending', 'back_pending')
           OR h.post_failures > 0 OR h.api_failures > 0
        ORDER BY h.connector_id`,
      [stallAfter, fresh, apiFresh],
    )).rows as Array<Record<string, any>>;
    const notices: DeliveryNotice[] = [];
    let stalled = 0;
    let recovered = 0;
    for (const r of rows) {
      const base = { connectorId: r.connector_id as string, owner: r.owner_user_id as string, name: r.name as string };
      const stall = r.reported_stall === true || r.api_stall === true;
      if (r.revoked_at) {
        // Removed by its owner: nothing to retry, nothing to tell.
        if (r.stall_state !== "ok" || r.stall_notice) {
          await q("UPDATE claw_remote_delivery_health SET stall_state = 'ok', stall_since = NULL, stall_notice = NULL WHERE connector_id = $1", [r.connector_id]);
        }
        continue;
      }
      if (r.stall_state === "ok" && stall) {
        stalled += 1;
        const episode = Number(r.stall_episode) + 1;
        const detail = { pending: r.pending ?? null, oldest_minutes: r.oldest_minutes ?? null, sessions: r.sessions ?? null };
        await q(
          `UPDATE claw_remote_delivery_health SET stall_state = 'stalled', stall_since = NOW(), stall_notice = 'sent', stall_episode = $2,
                  stall_detail = $3::jsonb WHERE connector_id = $1`,
          [r.connector_id, episode, JSON.stringify(detail)],
        );
        notices.push({ ...base, kind: "delayed", episode, pending: detail.pending, oldestMinutes: detail.oldest_minutes, sessions: detail.sessions });
        continue;
      }
      if (r.stall_state === "stalled" && !stall && r.clear === true) {
        recovered += 1;
        // "Get through again" only to someone who was told they did not (`back_sent`; back to `back_pending` if it could not be stored).
        const told = r.stall_notice === "sent";
        await q(
          "UPDATE claw_remote_delivery_health SET stall_state = 'ok', stall_since = NULL, stall_notice = $2 WHERE connector_id = $1",
          [r.connector_id, told ? "back_sent" : null],
        );
        if (told) notices.push({ ...base, kind: "recovered", episode: Number(r.stall_episode), pending: null, oldestMinutes: null, sessions: null });
        continue;
      }
      if (r.stall_state === "stalled" && r.stall_notice === "pending") {
        const d = (r.stall_detail ?? {}) as Record<string, number | null>;
        await q("UPDATE claw_remote_delivery_health SET stall_notice = 'sent' WHERE connector_id = $1", [r.connector_id]);
        notices.push({
          ...base, kind: "delayed", episode: Number(r.stall_episode),
          pending: d.pending ?? null, oldestMinutes: d.oldest_minutes ?? null, sessions: d.sessions ?? null,
        });
        continue;
      }
      if (r.stall_state === "ok" && r.stall_notice === "back_pending") {
        await q("UPDATE claw_remote_delivery_health SET stall_notice = 'back_sent' WHERE connector_id = $1", [r.connector_id]);
        notices.push({ ...base, kind: "recovered", episode: Number(r.stall_episode), pending: null, oldestMinutes: null, sessions: null });
      }
    }
    return { swept: true, stalled, recovered, notices };
  });
}

/** The language the owner last wrote to their assistant in, Chinese or (failing that) English. */
async function ownerLanguage(q: Querier, owner: string): Promise<"zh" | "en"> {
  const rows = (await q(
    "SELECT content FROM claw_assistant_messages WHERE user_id = $1 ORDER BY received_at DESC LIMIT 5", [owner],
  )).rows as Array<{ content: string }>;
  for (const r of rows) {
    const t = String(r.content ?? "");
    if (/\p{Script=Han}/u.test(t)) return "zh";
    if (/\p{L}{2,}/u.test(t)) return "en";
  }
  return "en";
}

/** The ports a test stands in for: what reaches the owner. */
export const deliveryPorts: {
  tell: (n: DeliveryNotice) => Promise<boolean>;
} = {
  /**
   * Say the notice through the owner's assistant: a channel of its own (the assistant's notification subscription), not the
   * connector's event route that is failing. False when there is nobody to say it through (no assistant).
   */
  tell: async (n) => {
    if (!CLAW_ASSISTANT_ENABLED) return false;
    const q: Querier = (t, p) => db.query(t, p);
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [n.owner])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return false;
    const { recordSystemNotice } = await import("../assistant/outbound.js");
    await recordSystemNotice({ userId: n.owner, sessionId, text: deliveryNoticeText(n, await ownerLanguage(q, n.owner)), key: deliveryNoticeKey(n) });
    return true;
  },
};

/**
 * One sweep and its notices. A notice that fails to be stored is put back to be tried by the next sweep (its key makes a
 * second attempt say nothing twice), as long as the connector is still in the episode it was about. One owner's failure never
 * holds up the next owner's notice.
 */
export async function runDeliveryHealthSweep(opts: Parameters<typeof sweepDeliveryHealth>[0] = {}): Promise<DeliverySweepResult> {
  const out = await sweepDeliveryHealth(opts);
  for (const n of out.notices) {
    try {
      const told = await deliveryPorts.tell(n);
      metrics.onDeliveryStallNotice(n.kind, told ? "told" : "no_assistant");
      logger.info({ owner: n.owner, connectorId: n.connectorId, kind: n.kind, episode: n.episode, told }, "remote_agents.delivery_notice");
    } catch (err) {
      metrics.onDeliveryStallNotice(n.kind, "failed");
      logger.warn({ err: (err as Error)?.message, connectorId: n.connectorId, kind: n.kind }, "remote_agents.delivery_notice_failed");
      const [from, to] = n.kind === "delayed" ? ["sent", "pending"] : ["back_sent", "back_pending"];
      await db.query(
        "UPDATE claw_remote_delivery_health SET stall_notice = $3 WHERE connector_id = $1 AND stall_episode = $2 AND stall_notice = $4",
        [n.connectorId, n.episode, to, from],
      ).catch((e) => logger.warn({ err: (e as Error)?.message, connectorId: n.connectorId }, "remote_agents.delivery_notice_requeue_failed"));
    }
  }
  if (out.stalled || out.recovered) logger.info({ stalled: out.stalled, recovered: out.recovered }, "remote_agents.delivery_swept");
  return out;
}

/**
 * The sweep, every `sweepMs` on this replica, until the returned stop is called. A timer that keeps nothing alive; a failed
 * sweep is logged and the next one tries again.
 */
export function startDeliveryHealthSweep(opts: { sweepMs?: number; stallAfterMs?: number } = {}): () => void {
  const sweepMs = opts.sweepMs ?? DELIVERY_SWEEP_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await runDeliveryHealthSweep({ stallAfterMs: opts.stallAfterMs });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "remote_agents.delivery_sweep_failed");
    }
    if (stopped) return;
    timer = setTimeout(tick, sweepMs);
    timer.unref();
  };
  timer = setTimeout(tick, sweepMs);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}

/**
 * The numbers behind the delivery gauges (`infra/metrics.ts`), read from the database: the connectors' reported backlog (fresh
 * reports only), each connector behind or failing now, and -- with notifications on -- the notification outbox and its failing
 * subscriptions. `onlineWindowMs`: a report counts while it is this fresh.
 */
export async function sampleDeliveryHealth(onlineWindowMs: number = REPORT_FRESH_MS): Promise<DeliverySample> {
  const fresh = onlineWindowMs / 1000;
  // Each part only where its table exists: remote agents and notifications are each switched on by their own setting.
  const have = (await db.query(
    "SELECT to_regclass('claw_remote_delivery_health') IS NOT NULL AS remote, to_regclass('claw_notification_outbox') IS NOT NULL AS outbox",
  )).rows[0] ?? {};
  const sample: DeliverySample = { backlog: [], connectors: [], stalled: 0, subscriptions: null };
  if (have.remote === true) await sampleRemote(sample, fresh);
  if (have.outbox === true) await sampleOutbox(sample);
  return sample;
}

async function sampleRemote(sample: DeliverySample, fresh: number): Promise<void> {
  const remote = (await db.query(
    `SELECT COALESCE(SUM(pending), 0)::bigint AS size,
            COALESCE(MAX(EXTRACT(EPOCH FROM NOW() - oldest_since)) FILTER (WHERE pending > 0), 0)::float8 AS oldest,
            COUNT(*) FILTER (WHERE stall_state = 'stalled')::int AS stalled
       FROM claw_remote_delivery_health WHERE reported_at > NOW() - make_interval(secs => $1::float8) OR stall_state = 'stalled'`,
    [fresh],
  )).rows[0] ?? {};
  const connectors = (await db.query(
    `SELECT connector_id::text AS connector_id,
            CASE WHEN reported_at > NOW() - make_interval(secs => $1::float8) AND pending > 0
                 THEN EXTRACT(EPOCH FROM NOW() - oldest_since) ELSE 0 END::float8 AS age,
            CASE WHEN reported_at > NOW() - make_interval(secs => $1::float8) THEN post_failures ELSE 0 END AS post_failures,
            CASE WHEN api_failed_at > NOW() - make_interval(secs => $2::float8) THEN api_failures ELSE 0 END AS api_failures
       FROM claw_remote_delivery_health
      WHERE (reported_at > NOW() - make_interval(secs => $1::float8)
              AND ((pending > 0 AND oldest_since <= NOW() - interval '1 minute') OR post_failures > 0))
         OR (api_failures > 0 AND api_failed_at > NOW() - make_interval(secs => $2::float8))
      ORDER BY age DESC, connector_id
      LIMIT $3`,
    [fresh, API_FAILURE_FRESH_MS / 1000, DELIVERY_SAMPLE_MAX_CONNECTORS],
  )).rows as Array<Record<string, any>>;
  sample.backlog.push({ queue: "remote_events", oldestAgeSeconds: Math.max(0, Number(remote.oldest) || 0), size: Number(remote.size) || 0 });
  sample.connectors = connectors.map((c) => ({
    connectorId: String(c.connector_id), backlogAgeSeconds: Math.max(0, Number(c.age) || 0),
    postFailures: Number(c.post_failures) || 0, apiFailures: Number(c.api_failures) || 0,
  }));
  sample.stalled = Number(remote.stalled) || 0;
}

/**
 * The notification outbox. Waiting: not delivered, not dropped, with a subscription, and either tried already or due -- a row
 * held on purpose (`say-hold.ts`: not due and never tried) is not late, and one never tried counts from when it fell due.
 */
async function sampleOutbox(sample: DeliverySample): Promise<void> {
  const o = (await db.query(
    `SELECT COUNT(*)::bigint AS size,
            COALESCE(MAX(EXTRACT(EPOCH FROM NOW() - CASE WHEN attempts > 0 THEN created_at ELSE next_attempt_at END)), 0)::float8 AS oldest
       FROM claw_notification_outbox
      WHERE delivered_at IS NULL AND dropped_at IS NULL AND subscription_id IS NOT NULL
        AND (attempts > 0 OR next_attempt_at <= NOW())`,
  )).rows[0] ?? {};
  const s = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE failing_since IS NOT NULL)::int AS failing, COALESCE(MAX(consecutive_failures), 0)::int AS max
       FROM claw_notification_subscriptions WHERE enabled`,
  )).rows[0] ?? {};
  sample.backlog.push({ queue: "notification_outbox", oldestAgeSeconds: Math.max(0, Number(o.oldest) || 0), size: Number(o.size) || 0 });
  sample.subscriptions = { failing: Number(s.failing) || 0, failuresMax: Number(s.max) || 0 };
}
