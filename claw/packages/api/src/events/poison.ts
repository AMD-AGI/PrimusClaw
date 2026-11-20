// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What keeps one bad event from holding up the event consumer.
 *
 * Three pieces, each used by `consumeEventDelivery` (consumer.ts):
 *
 * - `storableEvent`: the write boundary. Postgres refuses two things a
 *   JavaScript string can hold: U+0000 (in `text` and as the `\u0000` escape in
 *   `jsonb`) and a lone UTF-16 surrogate (a `\udXXX` escape `jsonb` will not
 *   parse). Either one used to fail the event's INSERT for every delivery.
 * - `eventDeliveryHealth` with `quarantineEventDelivery`: an event that keeps
 *   failing is set aside, with a durable copy in `claw_event_quarantine`, once
 *   it has had a bounded number of deliveries -- but only while other events are
 *   being stored, so an outage of the database (where every event fails) never
 *   quarantines anything.
 * - `readEventConsumerBacklog`: the consumer's backlog as the server sees it,
 *   for the gauges that show a stall before a user does.
 */

import type { JetStreamManager } from "nats";
import pino from "pino";

import { db } from "../infra/db.js";
import { metrics, type EventQuarantineReason } from "../infra/metrics.js";

const logger = pino({ name: "event-consumer" });

/** The character every unstorable one is replaced with. */
export const REPLACEMENT_CHARACTER = "�";

// NUL, a high surrogate not followed by a low one, or a low surrogate not
// preceded by a high one. No `u` flag: the match has to see code units, which
// is what a lone surrogate is.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSTORABLE_ALL = new RegExp(UNSTORABLE.source, "g");

function storableString(s: string, count: { n: number }): string {
  if (!UNSTORABLE.test(s)) return s;
  return s.replace(UNSTORABLE_ALL, () => { count.n++; return REPLACEMENT_CHARACTER; });
}

function storableValue(v: unknown, count: { n: number }): unknown {
  if (typeof v === "string") return storableString(v, count);
  if (Array.isArray(v)) return v.map((item) => storableValue(item, count));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) out[storableString(key, count)] = storableValue(value, count);
    return out;
  }
  return v;
}

/**
 * A parsed event with every string Postgres cannot store made storable: each
 * NUL and each lone surrogate becomes U+FFFD, in values and in keys, at any
 * depth. `replaced` is how many characters were replaced; zero means `event` is
 * equal to the input.
 *
 * Applied to the event as a whole rather than to the stored copy alone, because
 * a completion writes the same strings again (the turn's text, the run's
 * failure message), and every one of those writes would fail the same way.
 *
 * Applied to the parsed object, not to the JSON text: a publisher's
 * `JSON.stringify` writes both characters as escapes (`\u0000`, `\ud800`), so
 * the wire text never contains the character itself and a replace over it
 * matches nothing.
 */
export function storableEvent(event: Record<string, unknown>): { event: Record<string, unknown>; replaced: number } {
  const count = { n: 0 };
  const out = storableValue(event, count) as Record<string, unknown>;
  return count.n ? { event: out, replaced: count.n } : { event, replaced: 0 };
}

/** The same, for one string (a subject's session id). */
export function storableText(s: string): string {
  return storableString(s, { n: 0 });
}

/**
 * When an event that keeps failing is set aside. All three must hold.
 *
 * - `maxDeliveries`: it has been delivered more than this many times.
 * - `minAgeMs`: it was published at least this long ago. Deliveries alone
 *   are not enough, because a completion that only waits on its session's lock
 *   is redelivered every second; this is the time any one retry loop in the
 *   consumer is given to recover on its own.
 * - `healthyWindowMs`: some other event was stored within this window. This is
 *   what separates a poison event from an outage: when the database or the
 *   tombstone bucket is down, every event fails, nothing else is stored, and
 *   nothing is set aside -- the events wait for the dependency, as before.
 *
 * A field rather than constants so a test can shorten the waits.
 */
export const eventQuarantinePolicy = {
  maxDeliveries: 20,
  minAgeMs: 15 * 60_000,
  healthyWindowMs: 5 * 60_000,
};

/** How the consumer's last few deliveries went, in this process. */
class EventDeliveryHealth {
  private lastStored: { seq: number | undefined; at: number } | null = null;
  private consecutive = 0;
  private readonly lastError = new Map<number, string>();

  /**
   * Whether this delivery should be set aside instead of processed. Asked
   * before processing rather than after a failure, so an event that kills the
   * process on every attempt is caught too: its next delivery, after the
   * restart, is set aside once the events behind it are flowing again.
   */
  shouldQuarantine(d: { seq?: number; deliveries: number; publishedMs?: number }, now = Date.now()): boolean {
    const p = eventQuarantinePolicy;
    if (!(d.deliveries > p.maxDeliveries)) return false;
    if (d.publishedMs !== undefined && now - d.publishedMs < p.minAgeMs) return false;
    const last = this.lastStored;
    return !!last && last.seq !== d.seq && now - last.at <= p.healthyWindowMs;
  }

  /**
   * An event was written to `claw_session_events`: the signal that the
   * database is taking events. Only a real write counts -- an event acked
   * without one (a streaming preview, a deleted session's) says nothing about
   * whether events can be stored.
   */
  stored(seq: number | undefined, now = Date.now()): void {
    this.lastStored = { seq, at: now };
    this.setConsecutive(0);
  }

  /** An event was set aside: the run of failures it caused is over. */
  setAside(seq: number | undefined): void {
    if (seq !== undefined) this.lastError.delete(seq);
    this.setConsecutive(0);
  }

  /**
   * The delivery was answered. A retry extends the run of failures; an ack
   * leaves it as it is, since only a stored event (or one set aside) ends it --
   * an event acked without a write proves nothing about the database.
   */
  answered(seq: number | undefined, answer: "ack" | "nak" | "none"): void {
    if (answer === "ack") {
      if (seq !== undefined) this.lastError.delete(seq);
    } else {
      this.setConsecutive(this.consecutive + 1);
    }
  }

  private setConsecutive(n: number): void {
    this.consecutive = n;
    metrics.setEventConsumerConsecutiveFailures(n);
  }

  /** The reason a delivery failed, kept for its quarantine record: a code and a message, never the event. */
  noteError(seq: number | undefined, err: unknown): void {
    if (seq === undefined) return;
    const e = err as { code?: unknown; message?: unknown } | undefined;
    const code = typeof e?.code === "string" ? e.code : "";
    const message = typeof e?.message === "string" ? e.message : String(err);
    // Bounded: a map entry per failing sequence, dropped when it is stored or set aside.
    if (this.lastError.size >= 1000 && !this.lastError.has(seq)) {
      const oldest = this.lastError.keys().next().value;
      if (oldest !== undefined) this.lastError.delete(oldest);
    }
    this.lastError.set(seq, (code ? `${code}: ` : "") + storableText(message).slice(0, 300));
  }

  takeError(seq: number | undefined): string | null {
    if (seq === undefined) return null;
    const e = this.lastError.get(seq) ?? null;
    this.lastError.delete(seq);
    return e;
  }

  /** For tests: forget everything. */
  reset(): void {
    this.lastStored = null;
    this.lastError.clear();
    this.setConsecutive(0);
  }
}

export const eventDeliveryHealth = new EventDeliveryHealth();

export interface QuarantinedDelivery {
  eventId: string;
  sessionId: string;
  subject: string;
  seq: number | undefined;
  eventType: string | null;
  reason: EventQuarantineReason;
  deliveries: number;
  publishedMs?: number;
  lastError: string | null;
  payload: Uint8Array;
}

/**
 * Keep a durable copy of a delivery that is being set aside, then say so in a
 * log line that carries no content. The copy is the event as the caller makes
 * it storable (sanitised and masked, in a `bytea`, which stores anything), so it
 * can be inspected or replayed later. Throws when the copy cannot be written:
 * the caller then naks, and the event is not dropped.
 */
export async function quarantineEventDelivery(q: QuarantinedDelivery): Promise<void> {
  await db.query(
    `INSERT INTO claw_event_quarantine
       (event_id, session_id, subject, stream_seq, event_type, reason, deliveries, last_error, payload, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (event_id, session_id) DO UPDATE
       SET deliveries = GREATEST(claw_event_quarantine.deliveries, EXCLUDED.deliveries),
           last_error = COALESCE(EXCLUDED.last_error, claw_event_quarantine.last_error)`,
    [
      q.eventId, storableText(q.sessionId), storableText(q.subject), q.seq ?? null,
      q.eventType === null ? null : storableText(q.eventType).slice(0, 200), q.reason, q.deliveries,
      q.lastError, Buffer.from(q.payload),
      q.publishedMs === undefined ? null : new Date(q.publishedMs),
    ],
  );
  metrics.onEventQuarantined(q.reason);
  eventDeliveryHealth.setAside(q.seq);
  logger.error(
    {
      sessionId: q.sessionId, eventId: q.eventId, seq: q.seq, type: q.eventType, reason: q.reason,
      deliveries: q.deliveries, bytes: q.payload.byteLength, lastError: q.lastError,
    },
    "event-consumer.quarantined",
  );
}

/** What the event consumer has not yet had acknowledged, as the server counts it. */
export interface EventConsumerBacklog {
  /** Delivered and not yet acknowledged (including those waiting to be redelivered). */
  ackPending: number;
  /** Not yet delivered. */
  pending: number;
  /** Age of the oldest event not yet acknowledged, in seconds; 0 when there is none. */
  oldestPendingAgeSeconds: number;
}

/**
 * Read the consumer's backlog from the server and publish it as gauges.
 *
 * The oldest unacknowledged event is the first one past the consumer's ack
 * floor. It is fetched with `next_by_subj`, so a range a session deletion
 * purged from the stream is skipped rather than read as a gap.
 */
export async function readEventConsumerBacklog(
  mgr: JetStreamManager, stream: string, consumer: string, now = Date.now(),
): Promise<EventConsumerBacklog> {
  const info = await mgr.consumers.info(stream, consumer);
  const ackPending = info.num_ack_pending;
  const pending = info.num_pending;
  let oldestPendingAgeSeconds = 0;
  if (ackPending + pending > 0) {
    const seq = info.ack_floor.stream_seq + 1;
    const filter = info.config.filter_subject || ">";
    try {
      // `next_by_subj` is honoured by the server's message-get API; the client's type only lists it for direct gets.
      const oldest = await mgr.streams.getMessage(stream, { seq, next_by_subj: filter } as unknown as { seq: number });
      oldestPendingAgeSeconds = Math.max(0, (now - oldest.time.getTime()) / 1000);
    } catch (err) {
      // Nothing at or past the floor (it was acknowledged between the two reads): no age to report.
      logger.debug({ err: (err as Error)?.message, seq }, "event-consumer.backlog_oldest_unreadable");
    }
  }
  const backlog = { ackPending, pending, oldestPendingAgeSeconds };
  metrics.setEventConsumerBacklog(backlog);
  return backlog;
}

/** How often each replica reads the backlog. */
export const EVENT_BACKLOG_POLL_MS = 30_000;

/** Read the backlog every `EVENT_BACKLOG_POLL_MS` for the life of the process. A failed read is logged and retried. */
export function startEventBacklogGauges(mgr: JetStreamManager, stream: string, consumer: string): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await readEventConsumerBacklog(mgr, stream, consumer);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "event-consumer.backlog_read_failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, EVENT_BACKLOG_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
