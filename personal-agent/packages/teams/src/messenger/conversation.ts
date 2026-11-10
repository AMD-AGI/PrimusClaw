// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Teams conversation's outbound side (core's `Conversation`, the Python worker's `Messenger`): posting, editing and
 * deleting messages through the outbox, waiting for the id of a queued message, and opening a stream. Every operation
 * leaves one log line (what, how long, whether an ack is awaited; never the text): after a turn it is the only trace of
 * what the worker handed to Teams. In a group chat everything posted is masked first.
 */
import type {
  Clock,
  Conversation,
  ConversationRef,
  DeleteUnsupported,
  Envelope,
  LiveStream,
  Logger,
  MessageId,
  OutMessage,
  Random,
  Result,
  StreamRefused,
  UpdateOptions,
} from "@primusclaw/personal-agent";
import { err, ok, silentLogger } from "@primusclaw/personal-agent";

import { isObject, type JsonObject } from "../cards/json.js";
import { deleteEnvelope, envelope, TYPING } from "../activity/outbound.js";
import {
  DeleteUnsupportedError,
  isDirect,
  type Delivered,
  type Outbox,
  type PublishOptions,
  type TeamsEnvelope,
} from "../outbound/outbox.js";
import { openStream, type StreamContext } from "../stream/live-stream.js";
import type { AckRegistry } from "./acks.js";
import type { Masker } from "./masker.js";
import { activityOf, type RenderContext } from "./render.js";

/**
 * How long a post waits for Teams' id of a message that went through the queue: the relay Function scales to zero, and in
 * the one measured case the ack landed 15-44 s after the post. A shorter wait loses the id, so a progress message could
 * not be edited and would stay beside the answer.
 */
export const ACK_TIMEOUT_MS = 60_000;
/** A publish slower than this is logged: it is time the person waits (a stale connection reopening). */
export const SLOW_PUBLISH_MS = 1000;

export interface ConversationParts {
  readonly ref: ConversationRef;
  readonly outbox: Outbox;
  readonly acks: AckRegistry;
  readonly clock: Clock;
  readonly random: Random;
  readonly render: RenderContext;
  readonly stream: StreamContext;
  readonly ackTimeoutMs?: number;
  readonly logger?: Logger;
}

function reference(ref: ConversationRef): JsonObject {
  return ref.wire as JsonObject;
}

export class TeamsConversation implements Conversation {
  readonly edited = new Set<MessageId>();
  private readonly logger: Logger;

  constructor(private readonly parts: ConversationParts) {
    this.logger = parts.logger ?? silentLogger;
  }

  /** A message the bot removed or replaced elsewhere is settled: an unsettled click on it then leaves it alone. */
  markSettled(id: MessageId): void {
    this.edited.add(id);
  }

  get ref(): ConversationRef {
    return this.parts.ref;
  }

  private get masker(): Masker | undefined {
    return this.parts.render.masker;
  }

  /** The activity as it is posted here: masked in a group chat. */
  private prepare(activity: JsonObject): JsonObject {
    return this.masker ? this.masker.activity(activity) : activity;
  }

  private async publish(body: TeamsEnvelope, options?: PublishOptions): Promise<Delivered | undefined> {
    const activity = body.activity;
    const attachments = activity["attachments"];
    this.logger.info("outbound", {
      operation: body.operation,
      type: kindOf(activity),
      chars: typeof activity["text"] === "string" ? Array.from(activity["text"]).length : 0,
      attachments: Array.isArray(attachments) ? attachments.length : 0,
      ack: Boolean(body.ack),
      activityId: body.activity_id ?? "-",
    });
    const started = this.parts.clock.monotonicMs();
    const result = await this.parts.outbox.publish(body, options);
    const took = this.parts.clock.monotonicMs() - started;
    if (result === undefined && took >= SLOW_PUBLISH_MS) {
      // (a direct send logs its own latency)
      this.logger.warn("outbound took long to hand to the queue", { operation: body.operation, tookMs: took });
    }
    return result;
  }

  async typing(): Promise<void> {
    await this.publish(envelope("send", reference(this.ref), TYPING));
  }

  outgoing(message: OutMessage): Envelope {
    return envelope("send", reference(this.ref), this.prepare(activityOf(message, this.parts.render)));
  }

  async deliver(stored: Envelope): Promise<void> {
    await this.publish(asEnvelope(stored));
  }

  async send(message: OutMessage): Promise<void> {
    await this.deliver(this.outgoing(message));
  }

  /**
   * Send and return Teams' id of the new message; undefined if it never arrives. A direct send returns the id itself; a
   * message that went through the queue is waited for until its ack arrives (best effort: a caller that gets undefined keeps
   * sending new messages instead of editing).
   */
  async post(message: OutMessage): Promise<MessageId | undefined> {
    const ack = this.parts.random.hexId();
    const waiter = this.parts.acks.expect(ack);
    const timeoutMs = this.parts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const started = this.parts.clock.monotonicMs();
    try {
      const activity = this.prepare(activityOf(message, this.parts.render));
      const delivered = await this.publish(envelope("send", reference(this.ref), activity, { ack }));
      if (delivered !== undefined) return delivered.activityId;
      const timer = new AbortController();
      const id = await Promise.race([
        waiter.promise,
        this.parts.clock.sleep(timeoutMs, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT),
      ]);
      timer.abort();
      if (id === TIMED_OUT) {
        this.parts.acks.gaveUp(ack);
        this.logger.warn("outbound ack not received in time: the message cannot be edited and stays as posted", {
          timeoutMs,
        });
        return undefined;
      }
      this.logger.info("outbound ack received", {
        afterMs: this.parts.clock.monotonicMs() - started,
        activityId: id ?? "-",
      });
      return id;
    } finally {
      this.parts.acks.forget(ack);
    }
  }

  /** Replace the message `id`. With `signal`: a caller that was cancelled while it waited sends nothing. */
  async update(id: MessageId, message: OutMessage, options: UpdateOptions = {}): Promise<void> {
    this.edited.add(id);
    const activity = this.prepare(activityOf(message, this.parts.render));
    await this.publish(envelope("update", reference(this.ref), activity, { activityId: id }), options);
  }

  /** Remove a message this bot posted; refused when it could not be removed (the queue cannot delete; Teams may refuse). */
  async delete(id: MessageId): Promise<Result<void, DeleteUnsupported>> {
    try {
      await this.publish(deleteEnvelope(reference(this.ref), id));
      return ok(undefined);
    } catch (error) {
      if (error instanceof DeleteUnsupportedError) return err({ kind: "delete_unsupported", reason: error.message });
      throw error;
    }
  }

  openStream(replyTo: MessageId, status: string): Promise<Result<LiveStream, StreamRefused>> {
    const outbox = this.parts.outbox;
    if (!isDirect(outbox)) return Promise.resolve(err(refusal("this outbox cannot stream")));
    return openStream(this.parts.stream, {
      ref: this.ref,
      replyTo,
      status,
      post: async (activity, signal) => {
        const body = envelope("send", reference(this.ref), this.prepare(activity));
        this.logger.info("outbound stream", { type: kindOf(body.activity), chars: streamChars(body.activity) });
        return (await outbox.publishStream(body, { signal })).activityId;
      },
      render: (message) => activityOf(message, this.parts.render),
    });
  }
}

const TIMED_OUT = Symbol("timed out");

function kindOf(activity: JsonObject): string {
  return typeof activity["type"] === "string" ? activity["type"] : "";
}

function streamChars(activity: JsonObject): number {
  return typeof activity["text"] === "string" ? Array.from(activity["text"]).length : 0;
}

export function refusal(reason: string, status = 0, code = ""): StreamRefused {
  return { kind: "stream_refused", reason, status, code };
}

/** A stored envelope, read back: it must be one this worker built (operation, reference, activity). */
function asEnvelope(stored: Envelope): TeamsEnvelope {
  const { operation, reference: ref, activity } = stored;
  if (
    (operation === "send" || operation === "reply" || operation === "update" || operation === "delete") &&
    isObject(ref) &&
    isObject(activity)
  ) {
    return stored as TeamsEnvelope;
  }
  throw new TypeError("not an outbound envelope");
}
