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
 * - `quarantineEventDelivery`: an event no retry can store is set aside, with
 *   a durable copy in `claw_event_quarantine`. Only two kinds are: one that is
 *   not a JSON object, and one Postgres refused for its value after it was made
 *   storable (consumer.ts, `UNSTORABLE_PG_CODES`). Both are properties of the
 *   bytes, so the same delivery fails the same way every time. A completion is
 *   never set aside: when Postgres refuses it for nesting too deep to parse
 *   (54001), a depth-bounded copy (`depthBoundedEvent`) is stored and run in
 *   its place, and the original is kept here with reason `bounded`. Nothing is set
 *   aside for how often or how long it has failed: an outage of the database or
 *   of the tombstone bucket fails every event for as long as it lasts, and a
 *   completion is redelivered for as long as its session's lock is held or its
 *   run notice is owed, and each of those must be retried, never dropped.
 *   `eventDeliveryHealth` keeps the run of failures for the gauge.
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

/** Define `key` as an own data field of `out`: an assignment under `__proto__` would set its prototype instead. */
function defineField(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A copy of a parsed JSON value with `storableString` applied to every string
 * and key. Iterative, not recursive: `JSON.parse` takes nesting far deeper than
 * the call stack does (a few thousand levels), and Postgres stores it, so a
 * recursive copy would throw on an event that is otherwise fine. Every key is
 * defined as an own field (`defineField`), so a `__proto__` key in the JSON
 * stays a key of the copy, as it is of the parsed object.
 */
function storableValue(root: unknown, count: { n: number }): unknown {
  const pending: Array<[source: object, copy: object]> = [];
  const copyOf = (v: unknown): unknown => {
    if (typeof v === "string") return storableString(v, count);
    if (!v || typeof v !== "object") return v;
    const copy: object = Array.isArray(v) ? new Array<unknown>(v.length) : {};
    pending.push([v, copy]);
    return copy;
  };
  const out = copyOf(root);
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [source, copy] = next;
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) (copy as unknown[])[i] = copyOf(source[i]);
    } else {
      for (const [key, value] of Object.entries(source)) defineField(copy, storableString(key, count), copyOf(value));
    }
  }
  return out;
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

/**
 * How deep a stored copy of a completion is kept when Postgres refused the
 * whole one (54001, stack depth limit exceeded). Far below where it refuses
 * (about 13,000 levels with the default `max_stack_depth` of 2MB) and far above
 * anything a completion's own fields reach.
 */
export const STORED_DEPTH_LIMIT = 1_000;

/** What stands in for each object or array cut off below `STORED_DEPTH_LIMIT`. */
export const TOO_DEEP_PLACEHOLDER = "[nested too deep to store]";

/**
 * A copy of `event` with every object or array deeper than `limit` levels
 * (the event itself is level 0) replaced by `TOO_DEEP_PLACEHOLDER`. `cut` is
 * how many were replaced; zero means the copy is equal to the input.
 * Iterative for the same reason `storableValue` is, and every key is defined
 * as an own field, so a `__proto__` key stays a key.
 */
export function depthBoundedEvent(
  event: Record<string, unknown>, limit = STORED_DEPTH_LIMIT,
): { event: Record<string, unknown>; cut: number } {
  let cut = 0;
  const pending: Array<[source: object, copy: object, depth: number]> = [];
  const copyOf = (v: unknown, depth: number): unknown => {
    if (!v || typeof v !== "object") return v;
    if (depth > limit) { cut++; return TOO_DEEP_PLACEHOLDER; }
    const copy: object = Array.isArray(v) ? new Array<unknown>(v.length) : {};
    pending.push([v, copy, depth]);
    return copy;
  };
  const out = copyOf(event, 0) as Record<string, unknown>;
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [source, copy, depth] = next;
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) (copy as unknown[])[i] = copyOf(source[i], depth + 1);
    } else {
      for (const [key, value] of Object.entries(source)) defineField(copy, key, copyOf(value, depth + 1));
    }
  }
  return cut ? { event: out, cut } : { event, cut: 0 };
}

/** The same, for one string (a subject's session id). */
export function storableText(s: string): string {
  return storableString(s, { n: 0 });
}

/** How the consumer's last few deliveries went, in this process. */
class EventDeliveryHealth {
  private consecutive = 0;
  private readonly lastError = new Map<number, string>();

  /**
   * An event was written to `claw_session_events`: the signal that the
   * database is taking events. Only a real write counts -- an event acked
   * without one (a streaming preview, a deleted session's) says nothing about
   * whether events can be stored.
   */
  stored(): void {
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
