// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The delivery probe: a synthetic message that takes the path every person's message takes, so a broken or slow path is
 * seen when nobody is writing, not when somebody's message is lost. The ingress puts a `primusclaw.probe` on the inbound
 * queue every few minutes (its timer, PRIMUSCLAW_PROBE_SCHEDULE) under its own session; the worker's consumer takes it
 * like any message and answers it here, the way it answers a person: one envelope on the outbound queue, as it would put a
 * typing indicator there, with an ack. The relay takes that envelope (operation `probe`), posts nothing to Teams, and acks
 * it back on the inbound queue as it acks a posted message.
 *
 * Two times are measured from when the ingress sent the probe: `feedback`, until the worker had queued its answer (when a
 * person's typing indicator is queued), and `reply`, until the relay's ack came back to the worker (the whole round trip
 * through both queues and the relay). Each probe gets one line, `delivery probe`, and the metrics port the outcome. A probe
 * that gets no ack within PROBE_REPLY_TIMEOUT_MS is counted unanswered. Never touches a conversation, a person or Claw.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";

import { envelope } from "../activity/outbound.js";
import type { JsonObject } from "../cards/json.js";
import type { AckRegistry } from "../messenger/acks.js";
import type { Outbox } from "../outbound/outbox.js";

/** The type of a probe on the inbound queue (the ingress's PROBE_TYPE). */
export const PROBE = "primusclaw.probe";
/** The conversation (and session) a probe and its answer go under; no Teams conversation has this id. */
export const PROBE_CONVERSATION = "primusclaw-probe";
/** How long a probe's ack is waited for before the probe is counted unanswered. */
export const PROBE_REPLY_TIMEOUT_MS = 120_000;

const PROBE_ID = /^[A-Za-z0-9-]{1,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Where a probe's outcome is counted: milliseconds to the answer queued, and to the ack (null: none came in time). */
export interface ProbeStats {
  probed(feedbackMs: number, replyMs: number | null): void;
}

export interface ProbeParts {
  /** The outbound queue (the relay's); none (the release gate's test entry): probes are not answered. */
  readonly outbox: Outbox | undefined;
  readonly acks: AckRegistry;
  readonly clock: Clock;
  readonly stats?: ProbeStats;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

/** Epoch milliseconds of a `sent_at` the ingress wrote (UTC ISO 8601); undefined for anything else. */
function sentAtMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Answers probes; `close` stops waiting for the acks still out (the worker is stopping). */
export class DeliveryProbe {
  private readonly logger: Logger;
  private readonly stopping = new AbortController();
  private readonly waiting = new Set<Promise<void>>();

  constructor(private readonly parts: ProbeParts) {
    this.logger = parts.logger ?? silentLogger;
  }

  /** Whether `body` is a probe (the inbound handler hands it here instead of reading it as an activity). */
  static is(body: JsonObject): boolean {
    return body["type"] === PROBE;
  }

  /**
   * Answer one probe: queue the answer, and wait for its ack in the background (the ack comes on the probe's own session,
   * which the consumer reads only after this returns). A probe that cannot be read is logged and dropped; one whose answer
   * cannot be queued is counted unanswered at once. Never throws: a redelivered probe would measure the redelivery.
   */
  async answer(body: JsonObject): Promise<void> {
    const id = body["id"];
    const sent = sentAtMs(body["sent_at"]);
    if (typeof id !== "string" || !PROBE_ID.test(id) || sent === undefined) {
      this.logger.warn("delivery probe not read", { why: "malformed" });
      return;
    }
    const outbox = this.parts.outbox;
    if (outbox === undefined || this.stopping.signal.aborted) return;
    const ack = `probe-${id}`;
    const waiter = this.parts.acks.expect(ack);
    try {
      await outbox.publish(
        envelope("probe", { conversation: { id: PROBE_CONVERSATION } }, { type: "typing" }, { ack }),
      );
    } catch (error) {
      this.parts.acks.forget(ack);
      const feedbackMs = this.since(sent);
      this.logger.warn("delivery probe", {
        id,
        outcome: "not_queued",
        feedback_ms: feedbackMs,
        error: errorName(error),
      });
      this.parts.stats?.probed(feedbackMs, null);
      return;
    }
    const feedbackMs = this.since(sent);
    const waiting = this.awaitAck(id, ack, waiter.promise, sent, feedbackMs);
    this.waiting.add(waiting);
    void waiting.finally(() => this.waiting.delete(waiting));
  }

  /** Resolves once every probe answered so far has its ack or has timed out (a test waits for it). */
  settled(): Promise<void> {
    return Promise.all([...this.waiting]).then(() => undefined);
  }

  /** Stop waiting for acks: the worker is stopping (the probes still out are neither answered nor counted). */
  close(): void {
    this.stopping.abort(new DOMException("the worker is stopping", "AbortError"));
  }

  private since(sent: number): number {
    return Math.max(Math.trunc(this.parts.clock.epochMs() - sent), 0);
  }

  private async awaitAck(
    id: string,
    ack: string,
    acked: Promise<string | undefined>,
    sent: number,
    feedbackMs: number,
  ): Promise<void> {
    const timer = new AbortController();
    const signal = AbortSignal.any([timer.signal, this.stopping.signal]);
    const timedOut = this.parts.clock.sleep(this.parts.timeoutMs ?? PROBE_REPLY_TIMEOUT_MS, signal).then(
      () => "timeout" as const,
      () => "stopped" as const, // (the ack came first, or the worker is stopping)
    );
    let outcome: "acked" | "timeout" | "stopped";
    try {
      outcome = await Promise.race([acked.then(() => "acked" as const), timedOut]);
    } finally {
      timer.abort();
      this.parts.acks.forget(ack);
    }
    if (outcome === "stopped") return; // (a probe cut short by the stop says nothing about the path)
    if (outcome === "timeout") {
      this.parts.acks.gaveUp(ack); // (an ack that still comes is logged as late)
      this.logger.warn("delivery probe", { id, outcome: "unanswered", feedback_ms: feedbackMs });
      this.parts.stats?.probed(feedbackMs, null);
      return;
    }
    const replyMs = this.since(sent);
    this.logger.info("delivery probe", { id, outcome: "answered", feedback_ms: feedbackMs, reply_ms: replyMs });
    this.parts.stats?.probed(feedbackMs, replyMs);
  }
}
