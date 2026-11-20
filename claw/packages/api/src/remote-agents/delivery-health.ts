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
 * Both are written off the request path ({@link DeliveryWrites}): a heartbeat or a batch is never held up by its own observation.
 *
 * A sweep, every few seconds on whichever replica takes the lock, holds each connector as `ok` or `stalled`. Stalled: posts
 * have failed for {@link STALL_NOTICE_MS} (2 minutes) on the connector's fresh report while events wait, or Claw has answered
 * its posts with a 5xx for that long and did so recently. On the step to stalled the owner is told once, through their
 * assistant, that the replies are delayed and being retried; when the posts succeed again (positive evidence: a batch Claw stored
 * after the stall began, or a fresh report made after it began with nothing waiting; and no failure reported and no failing
 * answer of Claw's) they are told once that they get through. A notice is marked said only after it was said, and handed out
 * again until it is. A connector that went quiet meanwhile
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

/** How many delivery-health writes run at once on this replica, at most. They are advice and must never crowd out the work. */
export const DELIVERY_WRITE_CONCURRENCY = 4;
/** How many connectors may have a write waiting; a write beyond it is dropped (and counted in a log line), not queued. */
export const DELIVERY_WRITE_MAX_WAITING = 10_000;

/**
 * The delivery-health writes, off the request path: a heartbeat or an events batch is answered without waiting for them, so a
 * slow or locked `claw_remote_delivery_health` never holds up the replies it is there to watch. At most
 * {@link DELIVERY_WRITE_CONCURRENCY} run at once, one at a time per key (so a connector's writes land in the order they were
 * made), and what waits behind a running write is merged into one write (the latest report; the outcomes counted), so a
 * connector that posts faster than the database answers costs one write in flight and one waiting, never a growing queue.
 */
class DeliveryWrites {
  private readonly waiting = new Map<string, { value: unknown; write: (v: unknown) => Promise<void> }>();
  private readonly running = new Set<string>();
  private readonly ready: string[] = [];
  private active = 0;
  private idlers: Array<() => void> = [];
  dropped = 0;

  constructor(readonly limit: number, readonly maxWaiting: number) {}

  enqueue<T>(key: string, next: (prev: T | undefined) => T, write: (v: T) => Promise<void>): void {
    const had = this.waiting.get(key);
    if (!had && this.waiting.size >= this.maxWaiting) {
      if (this.dropped++ % 1000 === 0) logger.warn({ dropped: this.dropped, waiting: this.waiting.size }, "remote_agents.delivery_write_dropped");
      return;
    }
    this.waiting.set(key, { value: next(had?.value as T | undefined), write: write as (v: unknown) => Promise<void> });
    if (!had && !this.running.has(key)) this.ready.push(key);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limit && this.ready.length) {
      const key = this.ready.shift() as string;
      const job = this.waiting.get(key);
      if (!job) continue;
      this.waiting.delete(key);
      this.running.add(key);
      this.active += 1;
      void job.write(job.value)
        .catch((err) => logger.warn({ err: (err as Error)?.message, key }, "remote_agents.delivery_write_failed"))
        .finally(() => {
          this.active -= 1;
          this.running.delete(key);
          if (this.waiting.has(key)) this.ready.push(key);
          this.pump();
          if (this.active === 0 && this.waiting.size === 0) for (const f of this.idlers.splice(0)) f();
        });
    }
  }

  /** Resolves once nothing is running or waiting: for a clean shutdown, and for tests that read what was written. */
  idle(): Promise<void> {
    if (this.active === 0 && this.waiting.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }
}

const writes = new DeliveryWrites(DELIVERY_WRITE_CONCURRENCY, DELIVERY_WRITE_MAX_WAITING);

/** Resolves once every delivery-health write asked for so far has been made (or has failed). */
export const deliveryWritesIdle = (): Promise<void> => writes.idle();

/**
 * Record a connector's outbox report (`RemoteOutboxReport`), off the request path ({@link DeliveryWrites}). Null (a connector
 * from before the report, or a malformed one) records nothing. Ages become instants on Claw's clock, counted from when the report
 * arrived (not from when the write runs), so the connector's clock never matters and neither does a write that waited.
 */
export function recordOutboxReport(connectorId: string, owner: string, report: RemoteOutboxReport | null | undefined): void {
  if (!report) return;
  const at = Date.now();
  writes.enqueue<{ report: RemoteOutboxReport; at: number }>(`report:${connectorId}`, () => ({ report, at }), (v) => writeOutboxReport(connectorId, owner, v.report, v.at));
}

async function writeOutboxReport(connectorId: string, owner: string, report: RemoteOutboxReport, at: number): Promise<void> {
  const waited = clampInt(Date.now() - at);
  const sessions = report.sessions.map((s) => ({ session_id: s.sessionId, pending: clampInt(s.pending), oldest_age_ms: clampInt(s.oldestAgeMs) }));
  await db.query(
    `INSERT INTO claw_remote_delivery_health AS h
            (connector_id, owner_user_id, reported_at, pending, oldest_since, post_failures, post_failing_since, post_last_error, sessions)
     VALUES ($1, $2, NOW() - make_interval(secs => $9::float8 / 1000), $3,
             CASE WHEN $3 > 0 THEN NOW() - make_interval(secs => ($4::float8 + $9::float8) / 1000) END,
             $5, CASE WHEN $5 > 0 THEN NOW() - make_interval(secs => ($6::float8 + $9::float8) / 1000) END, CASE WHEN $5 > 0 THEN $7 END, $8::jsonb)
     ON CONFLICT (connector_id) DO UPDATE SET
       reported_at = EXCLUDED.reported_at, pending = EXCLUDED.pending, oldest_since = EXCLUDED.oldest_since,
       post_failures = EXCLUDED.post_failures, post_failing_since = EXCLUDED.post_failing_since,
       post_last_error = EXCLUDED.post_last_error, sessions = EXCLUDED.sessions`,
    [connectorId, owner, clampInt(report.pending), clampInt(report.oldestAgeMs), clampInt(report.failures), clampInt(report.failingMs),
      report.lastError, JSON.stringify(sessions), waited],
  );
}

/**
 * Claw's answers to one connector's batches not yet written: `reset` when one succeeded (what failed before it is cleared), then
 * the failures after it, and the last of their errors.
 */
interface ApiOutcomes { reset: boolean; failures: number; error: string | null }

/**
 * What Claw answered a connector's `POST .../events` (`ok`, or the failure: a PostgreSQL error code, or `error`), recorded off
 * the request path ({@link DeliveryWrites}), in order per connector.
 */
export function noteEventsPost(connectorId: string, owner: string, outcome: { ok: true } | { ok: false; error: string }): void {
  const error = outcome.ok ? null : /^[A-Za-z0-9_]{1,32}$/.test(outcome.error) ? outcome.error : "error";
  writes.enqueue<ApiOutcomes>(
    `api:${connectorId}`,
    (prev) => outcome.ok ? { reset: true, failures: 0, error: null } : { reset: prev?.reset ?? false, failures: (prev?.failures ?? 0) + 1, error },
    (v) => writeApiOutcomes(connectorId, owner, v),
  );
}

async function writeApiOutcomes(connectorId: string, owner: string, v: ApiOutcomes): Promise<void> {
  if (v.failures === 0) {
    // Written only when there is something to clear or a stall to end: every successful batch would otherwise write a row.
    // `api_ok_at` is the evidence the sweep ends a stall on: a batch got through after it began.
    await db.query(
      `UPDATE claw_remote_delivery_health SET api_failures = 0, api_failing_since = NULL, api_last_error = NULL, api_ok_at = NOW()
        WHERE connector_id = $1 AND (api_failures <> 0 OR stall_state = 'stalled')`,
      [connectorId],
    );
    return;
  }
  await db.query(
    `INSERT INTO claw_remote_delivery_health AS h (connector_id, owner_user_id, api_failures, api_failing_since, api_failed_at, api_last_error, api_ok_at)
     VALUES ($1, $2, $3, NOW(), NOW(), $4, CASE WHEN $5 THEN NOW() END)
     ON CONFLICT (connector_id) DO UPDATE SET
       api_failures = CASE WHEN $5 THEN 0 ELSE h.api_failures END + EXCLUDED.api_failures,
       api_failing_since = CASE WHEN $5 THEN NOW() ELSE COALESCE(h.api_failing_since, NOW()) END, api_failed_at = NOW(),
       api_last_error = EXCLUDED.api_last_error, api_ok_at = CASE WHEN $5 THEN NOW() ELSE h.api_ok_at END`,
    [connectorId, owner, v.failures, v.error, v.reset],
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

/** How long a notice handed out to be said is left to its sender before another sweep says it again (its key says it once). */
export const NOTICE_RETRY_MS = 60 * 1000;

/**
 * One sweep: judge every connector with a delivery row, and decide what to tell. Runs under a transaction-scoped advisory lock,
 * so two replicas never sweep at once; one that finds it held does nothing (`swept: false`).
 *
 * A notice is `pending` (`back_pending`) until it has been said: the sweep hands it out and stamps `stall_notice_at`, and only
 * {@link runDeliveryHealthSweep}, once the owner's assistant has it, marks it `sent` (`back_sent`). One that was not said -- the
 * replica died between, the store failed, there was no assistant to say it through -- is handed out again after
 * `noticeRetryMs`; its deterministic key ({@link deliveryNoticeKey}) makes a second attempt of one that was said say nothing.
 */
export async function sweepDeliveryHealth(opts: { stallAfterMs?: number; reportFreshMs?: number; apiFreshMs?: number; noticeRetryMs?: number } = {}): Promise<DeliverySweepResult> {
  const stallAfter = (opts.stallAfterMs ?? STALL_NOTICE_MS) / 1000;
  const fresh = (opts.reportFreshMs ?? REPORT_FRESH_MS) / 1000;
  const apiFresh = (opts.apiFreshMs ?? API_FAILURE_FRESH_MS) / 1000;
  const retry = (opts.noticeRetryMs ?? NOTICE_RETRY_MS) / 1000;
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
              -- Positive evidence that they get through: a batch Claw stored after the stall began, and nothing failing on either
              -- side since. A clean report alone is not: a connector restarted mid-stall reports no failure (its count is of this
              -- run) while the batch that stalled still waits on its disk. The connector posts its oldest events first, so a batch
              -- that got through is the one that stalled, or one behind it.
              -- Or a fresh report, made after the stall began, with nothing waiting and nothing failing: the backlog drained. The
              -- batch that drained it may have got through before the sweep declared the stall from a report still in hand, so no
              -- batch after it is left to stamp api_ok_at; nothing waiting is evidence enough (a restarted connector still counts
              -- the batch on its disk).
              (h.post_failures = 0 AND h.api_failures = 0
                 AND (h.api_ok_at > h.stall_since
                      OR (h.reported_at > h.stall_since AND h.reported_at > NOW() - make_interval(secs => $2::float8) AND h.pending = 0))) AS clear,
              -- A notice handed out and not marked said yet, whose sender may still be saying it.
              (h.stall_notice_at > NOW() - make_interval(secs => $4::float8)) AS notice_in_flight,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) THEN h.pending END AS pending,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) AND h.oldest_since IS NOT NULL
                   THEN FLOOR(EXTRACT(EPOCH FROM NOW() - h.oldest_since) / 60)::int END AS oldest_minutes,
              CASE WHEN h.reported_at > NOW() - make_interval(secs => $2::float8) THEN jsonb_array_length(h.sessions) END AS sessions
         FROM claw_remote_delivery_health h
         JOIN claw_remote_connectors c ON c.connector_id = h.connector_id
        WHERE h.stall_state = 'stalled' OR h.stall_notice IN ('pending', 'back_pending')
           OR h.post_failures > 0 OR h.api_failures > 0
        ORDER BY h.connector_id`,
      [stallAfter, fresh, apiFresh, retry],
    )).rows as Array<Record<string, any>>;
    const notices: DeliveryNotice[] = [];
    let stalled = 0;
    let recovered = 0;
    const handOut = (connectorId: string) => q("UPDATE claw_remote_delivery_health SET stall_notice_at = NOW() WHERE connector_id = $1", [connectorId]);
    for (const r of rows) {
      const base = { connectorId: r.connector_id as string, owner: r.owner_user_id as string, name: r.name as string };
      const stall = r.reported_stall === true || r.api_stall === true;
      if (r.revoked_at) {
        // Removed by its owner: nothing to retry, nothing to tell.
        if (r.stall_state !== "ok" || r.stall_notice) {
          await q("UPDATE claw_remote_delivery_health SET stall_state = 'ok', stall_since = NULL, stall_notice = NULL, stall_notice_at = NULL WHERE connector_id = $1", [r.connector_id]);
        }
        continue;
      }
      if (r.stall_state === "ok" && stall) {
        stalled += 1;
        const episode = Number(r.stall_episode) + 1;
        const detail = { pending: r.pending ?? null, oldest_minutes: r.oldest_minutes ?? null, sessions: r.sessions ?? null };
        await q(
          `UPDATE claw_remote_delivery_health SET stall_state = 'stalled', stall_since = NOW(), stall_notice = 'pending', stall_notice_at = NOW(),
                  stall_episode = $2, stall_detail = $3::jsonb WHERE connector_id = $1`,
          [r.connector_id, episode, JSON.stringify(detail)],
        );
        notices.push({ ...base, kind: "delayed", episode, pending: detail.pending, oldestMinutes: detail.oldest_minutes, sessions: detail.sessions });
        continue;
      }
      if (r.stall_state === "stalled" && !stall && r.clear === true) {
        recovered += 1;
        // "Get through again" only to someone who was told they did not: said, or being said right now.
        const told = r.stall_notice === "sent" || (r.stall_notice === "pending" && r.notice_in_flight === true);
        await q(
          `UPDATE claw_remote_delivery_health SET stall_state = 'ok', stall_since = NULL, stall_notice = $2,
                  stall_notice_at = CASE WHEN $3 THEN NOW() END WHERE connector_id = $1`,
          [r.connector_id, told ? "back_pending" : null, told],
        );
        if (told) notices.push({ ...base, kind: "recovered", episode: Number(r.stall_episode), pending: null, oldestMinutes: null, sessions: null });
        continue;
      }
      if (r.stall_state === "stalled" && r.stall_notice === "pending" && r.notice_in_flight !== true) {
        const d = (r.stall_detail ?? {}) as Record<string, number | null>;
        await handOut(r.connector_id);
        notices.push({
          ...base, kind: "delayed", episode: Number(r.stall_episode),
          pending: d.pending ?? null, oldestMinutes: d.oldest_minutes ?? null, sessions: d.sessions ?? null,
        });
        continue;
      }
      if (r.stall_state === "ok" && r.stall_notice === "back_pending" && r.notice_in_flight !== true) {
        await handOut(r.connector_id);
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
 * One sweep and its notices. A notice is marked said only once the owner's assistant has it; one that failed, or that found no
 * assistant to say it through, stays pending and is handed out again by a later sweep (`noticeRetryMs`), as long as the
 * connector is still in the episode it was about. One owner's failure never holds up the next owner's notice.
 */
export async function runDeliveryHealthSweep(opts: Parameters<typeof sweepDeliveryHealth>[0] = {}): Promise<DeliverySweepResult> {
  const out = await sweepDeliveryHealth(opts);
  for (const n of out.notices) {
    // Said: marked so. Failed: no longer in flight, tried again by the next sweep. No assistant to say it through: left to
    // `noticeRetryMs` (one may be set up meanwhile).
    let mark: "said" | "failed" | null = null;
    try {
      const told = await deliveryPorts.tell(n);
      mark = told ? "said" : null;
      metrics.onDeliveryStallNotice(n.kind, told ? "told" : "no_assistant");
      logger.info({ owner: n.owner, connectorId: n.connectorId, kind: n.kind, episode: n.episode, told }, "remote_agents.delivery_notice");
    } catch (err) {
      mark = "failed";
      metrics.onDeliveryStallNotice(n.kind, "failed");
      logger.warn({ err: (err as Error)?.message, connectorId: n.connectorId, kind: n.kind }, "remote_agents.delivery_notice_failed");
    }
    if (!mark) continue;
    const [from, to] = n.kind === "delayed" ? ["pending", "sent"] : ["back_pending", "back_sent"];
    await db.query(
      `UPDATE claw_remote_delivery_health SET stall_notice = CASE WHEN $5 THEN $3 ELSE stall_notice END, stall_notice_at = NULL
        WHERE connector_id = $1 AND stall_episode = $2 AND stall_notice = $4`,
      [n.connectorId, n.episode, to, from, mark === "said"],
    ).catch((e) => logger.warn({ err: (e as Error)?.message, connectorId: n.connectorId }, "remote_agents.delivery_notice_mark_failed"));
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
