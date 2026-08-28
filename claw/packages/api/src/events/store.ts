// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ConsumerMessages, JsMsg } from "nats";
import { js, jsm, sc, EVENT_STREAM } from "../infra/nats.js";
import { eventSubject } from "@claw/protocol";
import { redactPublicJson } from "./redaction.js";
import pino from "pino";

const logger = pino({ name: "event-store" });

/**
 * Mask credential-bearing fields before a session event leaves this module.
 *
 * Session events carry whatever the agent read or ran: `.env` file contents, a
 * token echoed by `bash`, an `Authorization` header in an HTTP tool call. Four
 * client-facing surfaces read the same events — the SSE route, the two MCP wait
 * tools, and the Anthropic-compatible stream — and redaction used to live in
 * the SSE route alone, so the same session leaked more through MCP than over
 * HTTP. Redacting here makes every consumer inherit it; a new consumer cannot
 * forget.
 *
 * Only credential-shaped values are touched (see events/redaction.ts), so the
 * fields consumers route on — `type`, `tool`, `status`, ids, sequence numbers —
 * pass through unchanged. Persistence is unaffected: events/consumer.ts owns a
 * separate durable consumer and stores the raw event for audit.
 */
export function sanitizeSessionEvent(event: Record<string, unknown>): Record<string, unknown> {
  return redactPublicJson(event) as Record<string, unknown>;
}

/** Publish an event to NATS JetStream for persistence + SSE delivery. */
export async function publishEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const subject = eventSubject(sessionId);
  const payload = sc.encode(JSON.stringify(event));
  await js.publish(subject, payload);
}

// Ephemeral SSE consumer auto-GC threshold. NATS server deletes the consumer
// when no pulls happen for this long; covers abrupt disconnects (kubelet
// kill, network partition) where close() never fires.
const EPHEMERAL_INACTIVE_THRESHOLD_NS = 60 * 1_000_000_000; // 60s

export interface SessionEventWithSeq {
  event: Record<string, unknown>;
  /** JetStream streamSequence — same value used as claw_session_events.event_id suffix. */
  seq: number;
}

export interface SessionSubscription {
  events(): AsyncGenerator<Record<string, unknown> | null>;
  eventsWithSeq(): AsyncGenerator<SessionEventWithSeq | null>;
  /** Force the (otherwise lazy) JetStream consumer to be created now. Resolves `true` once live, `false` on init failure. Idempotent. */
  ready(): Promise<boolean>;
  close(): void;
}

/**
 * SSE subscription via JetStream **ephemeral** consumer.
 *
 * Each SSE connection creates its own ephemeral consumer (no `durable_name`),
 * so consumers do NOT form a queue group — every consumer independently
 * receives every matching message, preserving the broadcast semantics of
 * the previous Core sub design.
 *
 * Why JetStream over Core sub:
 *   - Core sub's `Msg` carries no stream-sequence metadata.
 *   - JetStream's `JsMsg.seq` is the streamSequence assigned by the server
 *     when the message was first stored. The SSE route can therefore emit
 *     `id: claw-${seq}` — identical to the event_id format used by
 *     events/consumer.ts when persisting to claw_session_events. With both
 *     segments using the same id format, `?after=<id>` increments and
 *     seenIds dedup work correctly across history+live boundaries.
 *
 * Persistence is independent (events/consumer.ts owns a separate durable
 * consumer → DB INSERT) and unaffected by SSE subscriptions.
 *
 * Cleanup: explicit close() deletes the consumer; abrupt disconnects are
 * cleaned by NATS after EPHEMERAL_INACTIVE_THRESHOLD_NS of inactivity.
 */
export function createSessionSubscription(sessionId: string): SessionSubscription {
  const subject = eventSubject(sessionId);
  let consumerName: string | undefined;
  let iter: ConsumerMessages | undefined;
  let initialized = false;
  let initFailed = false;
  let closed = false;
  let eventCount = 0;

  // Lazy init keeps the factory synchronous so existing callers (mcp.ts,
  // routes/events.ts) don't need to be made async. The first call to events() /
  // eventsWithSeq() actually creates the consumer.
  async function ensureInit(): Promise<boolean> {
    if (initialized) return !closed;
    if (initFailed || closed) return false;
    try {
      const info = await jsm.consumers.add(EVENT_STREAM, {
        filter_subject: subject,
        deliver_policy: "new" as any,
        ack_policy: "none" as any,
        replay_policy: "instant" as any,
        inactive_threshold: EPHEMERAL_INACTIVE_THRESHOLD_NS,
      } as any);
      consumerName = info.name;
      const consumer = await js.consumers.get(EVENT_STREAM, consumerName);
      iter = await consumer.consume();
      initialized = true;
      logger.info({ sessionId, subject, consumer: consumerName }, "sse.js_subscribed");
      return true;
    } catch (e) {
      initFailed = true;
      logger.warn({ err: (e as Error).message, sessionId }, "sse.js_init_failed");
      return false;
    }
  }

  function decode(msg: JsMsg): Record<string, unknown> | null {
    try {
      const raw = sc.decode(msg.data).replace(/\u0000/g, "");
      return sanitizeSessionEvent(JSON.parse(raw) as Record<string, unknown>);
    } catch (e) {
      logger.warn({ err: (e as Error).message, sessionId }, "sse.js_parse_error");
      return null;
    }
  }

  return {
    ready(): Promise<boolean> {
      return ensureInit();
    },
    async *events(): AsyncGenerator<Record<string, unknown> | null> {
      if (!(await ensureInit()) || !iter) return;
      try {
        for await (const msg of iter) {
          if (closed) break;
          const event = decode(msg);
          if (!event) continue;
          eventCount++;
          yield event;
        }
      } catch (e) {
        if (!closed) logger.warn({ err: (e as Error).message, sessionId }, "sse.js_iter_error");
      }
      logger.info({ sessionId, eventCount }, "sse.js_ended");
    },
    async *eventsWithSeq(): AsyncGenerator<SessionEventWithSeq | null> {
      if (!(await ensureInit()) || !iter) return;
      try {
        for await (const msg of iter) {
          if (closed) break;
          const event = decode(msg);
          if (!event) continue;
          const rawSeq: unknown = (msg as any).seq ?? (msg as any).info?.streamSequence ?? 0;
          const seq = typeof rawSeq === "number" ? rawSeq : Number(rawSeq) || 0;
          eventCount++;
          yield { event, seq };
        }
      } catch (e) {
        if (!closed) logger.warn({ err: (e as Error).message, sessionId }, "sse.js_iter_error");
      }
      logger.info({ sessionId, eventCount }, "sse.js_ended");
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { iter?.stop(); } catch { /* ignore */ }
      // Best-effort delete; NATS auto-GCs via inactive_threshold otherwise
      if (consumerName) {
        jsm.consumers.delete(EVENT_STREAM, consumerName).catch(() => { /* already gone */ });
      }
      logger.info({ sessionId, eventCount, consumer: consumerName }, "sse.js_unsubscribed");
    },
  };
}

/**
 * Same as {@link createSessionSubscription}, but resolves only after the
 * JetStream consumer has actually been created (or definitively failed) —
 * i.e. it forces the otherwise-lazy `ensureInit()` up front.
 *
 * The Anthropic Managed Agents stream compat route needs this: the SDK's
 * documented usage is `stream()` immediately followed by `send()`, and if
 * this route wrote its SSE response headers (which resolves the client's
 * `stream()` promise) before the consumer existed, an `events.send()` fired
 * right after could publish before the subscription is live, silently
 * dropping the first `agent.message`. Returns `null` on init failure so the
 * caller can respond `503` instead of opening a stream that will never
 * receive anything.
 */
export async function createSessionSubscriptionReady(sessionId: string): Promise<SessionSubscription | null> {
  const sub = createSessionSubscription(sessionId);
  const ok = await sub.ready();
  return ok ? sub : null;
}
