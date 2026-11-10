// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The inbound queue: several receivers, each taking the next conversation session that has messages and handling them in
 * order until the session has been quiet for IDLE_MS. A body that is not a JSON object is dead-lettered at once (it can never
 * succeed); a handler failure abandons the message, so the broker redelivers it and, after its maximum delivery count,
 * dead-letters it. Either way the session moves on: one poison message never blocks a conversation. Every message taken
 * gets one line (`inbound message`): its id, what came of it (completed, abandoned, dead_lettered), how long it waited in
 * the queue and how long it took; never its body.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";

import { isObject, type JsonObject } from "../cards/json.js";
import type { BusClient, Received, SessionReceiver } from "./client.js";

/** A session that has had no message for this long is released for the next one. */
export const IDLE_MS = 20_000;
/** After an error of the broker (not the idle timeout), wait this long before trying again. */
export const BACKOFF_MS = 3_000;
/** After finding no session with messages, wait this long before asking again. */
export const NO_SESSION_PAUSE_MS = 1_000;

/** What the handled messages are counted in: how long each waited in the queue and took to handle. */
export interface InboundStats {
  processed(queueLagMs: number | undefined, handleMs: number, ok: boolean): void;
}

/** Whether a broker error is the documented "no session has messages" timeout of acceptNextSession. */
export function isIdleTimeout(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ServiceTimeout" || code === "SessionCannotBeLocked";
}

/**
 * How long `message` waited in the queue before the worker took it: from the broker's enqueue time to the start of
 * handling (now, less `handleMs`). undefined when the broker gave no enqueue time. A growing lag is the queue backing up.
 */
export function queueLagMs(message: Received, nowEpochMs: number, handleMs = 0): number | undefined {
  if (!message.enqueuedAt) return undefined;
  return Math.max(Math.trunc(nowEpochMs - message.enqueuedAt.getTime()) - handleMs, 0);
}

export interface ConsumerParts {
  readonly client: BusClient;
  readonly queue: string;
  readonly handle: (activity: JsonObject) => Promise<void>;
  readonly receivers: number;
  readonly clock: Clock;
  readonly stats?: InboundStats;
  readonly logger?: Logger;
}

function decode(body: Uint8Array): JsonObject {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isObject(parsed)) throw new SyntaxError("body is not a JSON object");
  return parsed;
}

export class InboundConsumer {
  private stopped = false;
  private readonly logger: Logger;

  constructor(private readonly parts: ConsumerParts) {
    this.logger = parts.logger ?? silentLogger;
  }

  /** Run the receivers until `stop`. */
  async run(): Promise<void> {
    await Promise.all(Array.from({ length: this.parts.receivers }, () => this.loop()));
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let receiver: SessionReceiver;
      try {
        receiver = await this.parts.client.acceptNextSession(this.parts.queue);
      } catch (error) {
        await this.pause(error);
        continue;
      }
      try {
        await this.drain(receiver);
      } catch (error) {
        await this.pause(error);
      } finally {
        await receiver.close().catch((error: unknown) => {
          this.logger.info("closing a session receiver failed", { error: errorName(error) });
        });
      }
    }
  }

  private async pause(error: unknown): Promise<void> {
    if (isIdleTimeout(error)) {
      // (documented: accepting the next session times out when no session has messages)
      await this.parts.clock.sleep(NO_SESSION_PAUSE_MS);
      return;
    }
    this.logger.warn("inbound receiver error", { error: errorName(error) });
    await this.parts.clock.sleep(BACKOFF_MS);
  }

  private async drain(receiver: SessionReceiver): Promise<void> {
    for (;;) {
      const messages = await receiver.receive(1, IDLE_MS);
      if (messages.length === 0 || this.stopped) return;
      for (const message of messages) await this.dispatch(receiver, message);
    }
  }

  private async dispatch(receiver: SessionReceiver, message: Received): Promise<void> {
    let body: JsonObject;
    try {
      body = decode(message.body);
    } catch (error) {
      const why = error instanceof Error ? error.message : "undecodable";
      this.logLine(message, "dead_lettered", queueLagMs(message, this.parts.clock.epochMs()), 0);
      await receiver.deadLetter(message, "malformed", Array.from(why).slice(0, 200).join(""));
      return;
    }
    const started = this.parts.clock.monotonicMs();
    try {
      await this.parts.handle(body);
    } catch (error) {
      this.logger.error("handler failed; abandoning for redelivery", { error: errorName(error) });
      this.record(message, started, false);
      await receiver.abandon(message);
      return;
    }
    this.record(message, started, true);
    await receiver.complete(message);
  }

  private record(message: Received, started: number, ok: boolean): void {
    const handleMs = Math.trunc(this.parts.clock.monotonicMs() - started);
    const lag = queueLagMs(message, this.parts.clock.epochMs(), handleMs);
    this.logLine(message, ok ? "completed" : "abandoned", lag, handleMs);
    this.parts.stats?.processed(lag, handleMs, ok);
  }

  /** The one line for a message taken: ids, outcome and times only. */
  private logLine(message: Received, outcome: string, lagMs: number | undefined, handleMs: number): void {
    this.logger.info("inbound message", {
      id: message.messageId,
      delivery: message.deliveryCount,
      outcome,
      lag_ms: lagMs,
      ms: handleMs,
    });
  }
}
