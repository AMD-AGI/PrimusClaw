// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How long the event consumer has been retrying a message it cannot get past, for `claw_api_event_redelivery_oldest_age_seconds`.
 *
 * A message the consumer naks comes back (JetStream redelivers it after the nak's delay), and one that is naked for ever is
 * a stall: whatever it carries (a completion, a session's status) never lands. The consumer does not block on it -- later
 * messages go on being delivered -- so nothing else shows it. This module remembers, per stream sequence, when a message was
 * first naked on this replica and when it was last seen, and forgets it once it is acknowledged; the gauge is the age of the
 * oldest still being retried. A message no longer seen here for {@link FORGET_AFTER_MS} (another replica took it, or the
 * process lost track of an ack) is forgotten, so the gauge falls back rather than reading as a stall that is not there.
 */
import { metrics } from "../infra/metrics.js";

/** Longer than the longest nak delay the consumer uses (10 s) many times over. */
export const FORGET_AFTER_MS = 2 * 60_000;
/** At most this many messages are remembered; past it the newest are not (the oldest are the ones the gauge is about). */
const MAX_TRACKED = 10_000;

interface Tracked { first: number; last: number }

export class RedeliveryTracker {
  private readonly naked = new Map<number, Tracked>();
  constructor(private readonly now: () => number = Date.now) {}

  /** A message was naked: remembered from the first time. */
  nak(seq: number): void {
    const t = this.now();
    const was = this.naked.get(seq);
    if (was) { was.last = t; return; }
    if (this.naked.size >= MAX_TRACKED) return;
    this.naked.set(seq, { first: t, last: t });
  }

  /** A message was acknowledged: no longer retried. */
  ack(seq: number): void {
    this.naked.delete(seq);
  }

  /** Seconds the oldest message still being retried has been; 0 when none. */
  oldestAgeSeconds(): number {
    const t = this.now();
    let oldest = t;
    for (const [seq, v] of this.naked) {
      if (t - v.last > FORGET_AFTER_MS) { this.naked.delete(seq); continue; }
      oldest = Math.min(oldest, v.first);
    }
    return Math.max(0, (t - oldest) / 1000);
  }

  get size(): number {
    return this.naked.size;
  }
}

export const redeliveries = new RedeliveryTracker();
metrics.setRedeliveryOldestAge(() => redeliveries.oldestAgeSeconds());

/** The JetStream message shape the consumer reads. */
export interface ConsumedMessage {
  subject: string;
  data: Uint8Array;
  seq?: number;
  redelivered?: boolean;
  info?: { streamSequence?: number; redeliveryCount?: number };
  ack: () => void;
  nak: (millis?: number) => void;
}

/**
 * The message, with its ack and nak noted: a redelivery is counted (`claw_api_event_redelivered_total`), and the tracker learns
 * which messages are being retried. A plain object with the fields the consumer reads, read once here.
 */
export function trackDelivery(msg: ConsumedMessage, tracker: RedeliveryTracker = redeliveries): ConsumedMessage {
  const seq = msg.info?.streamSequence ?? msg.seq;
  if (msg.redelivered || (msg.info?.redeliveryCount ?? 1) > 1) metrics.onEventRedelivered();
  const out: ConsumedMessage = {
    subject: msg.subject, data: msg.data, seq: msg.seq, redelivered: msg.redelivered, info: msg.info,
    ack: () => msg.ack(), nak: (millis?: number) => msg.nak(millis),
  };
  if (typeof seq !== "number") return out;
  out.ack = () => { tracker.ack(seq); msg.ack(); };
  out.nak = (millis?: number) => { tracker.nak(seq); msg.nak(millis); };
  return out;
}
