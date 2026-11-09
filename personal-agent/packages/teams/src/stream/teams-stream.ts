// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Teams stream in reply to one person's message (Bot Framework REST, "Stream agent messages"): `start`, then any number
 * of `inform` (status) or `emit` (the text so far), then one `final`. Teams' rules are kept here: every request names the
 * stream's id and a sequence number one higher each time, at most one request a second, streamed text only grows, one open
 * stream per conversation. A request Teams did not take throws StreamRefusedError; the stream is then of no further use
 * (`broken`), except that a final can still be tried.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";

import type { JsonObject } from "../cards/json.js";
import { plainDecorations } from "../activity/decorations.js";
import { streamActivity, streamFinal, type StreamKind } from "../activity/stream-activity.js";
import { StreamRefusedError } from "../outbound/outbox.js";
import type { BusyConversations } from "./busy.js";
import { Mutex } from "./mutex.js";

/** Teams takes one request a second per stream. */
export const MIN_INTERVAL_MS = 1000;

/** Sends one request of a stream and returns the id Teams answered with (the stream's id, for the first). */
export type StreamPoster = (activity: JsonObject) => Promise<string | undefined>;

export interface StreamParts {
  readonly post: StreamPoster;
  readonly conversation: string;
  readonly replyTo: string;
  readonly clock: Clock;
  readonly busy: BusyConversations;
  readonly logger?: Logger;
}

export class TeamsStream {
  streamId = "";
  broken = false;
  closed = false;
  /** The text streamed into the bubble so far ("" : only status so far). */
  streamed = "";
  openedAt: number | undefined;
  private sequence = 0;
  private lastAt: number | undefined;
  private readonly lock = new Mutex();
  private readonly logger: Logger;

  constructor(private readonly parts: StreamParts) {
    this.logger = parts.logger ?? silentLogger;
  }

  /** Updates can be sent: it opened, and neither failed nor closed. */
  get open(): boolean {
    return Boolean(this.streamId) && !(this.broken || this.closed);
  }

  /** A final message can still be tried: it opened and is not closed (a refused update leaves it closable). */
  get closable(): boolean {
    return Boolean(this.streamId) && !this.closed;
  }

  get replyTo(): string {
    return this.parts.replyTo;
  }

  /** How long ago it opened, in milliseconds (0 before it opened). */
  age(): number {
    return this.openedAt === undefined ? 0 : this.parts.clock.monotonicMs() - this.openedAt;
  }

  private async send(activity: JsonObject, final = false): Promise<string | undefined> {
    if (this.closed || (this.broken && !final)) throw new StreamRefusedError("the stream is over");
    const wait = this.lastAt === undefined ? 0 : this.lastAt + MIN_INTERVAL_MS - this.parts.clock.monotonicMs();
    if (wait > 0) await this.parts.clock.sleep(wait);
    try {
      return await this.parts.post(activity);
    } catch (error) {
      throw this.refused(error);
    } finally {
      this.lastAt = this.parts.clock.monotonicMs();
    }
  }

  private refused(error: unknown): StreamRefusedError {
    if (error instanceof StreamRefusedError) {
      // (a 429 is a moment's throttling and a 400 a request Teams did not like: the stream itself is still there)
      this.broken ||= error.status !== 400 && error.status !== 429;
      this.logger.warn("teams stream request refused", { status: error.status || "-", code: error.code });
      return error;
    }
    // (a bug or an outbox without streams: the same fallback, never a lost message)
    this.broken = true;
    this.logger.warn("teams stream request failed; falling back", { error: errorName(error) });
    return new StreamRefusedError(errorName(error));
  }

  /** Open the stream with its first informative update (or, `kind` streaming, its first text). */
  start(text: string, kind: StreamKind = "informative"): Promise<void> {
    return this.lock.run(async () => {
      const { conversation, busy, clock } = this.parts;
      if (conversation && busy.isBusy(conversation)) {
        this.broken = true;
        throw new StreamRefusedError("a stream is open in this conversation");
      }
      this.sequence = 1;
      const streamId = await this.send(streamActivity(kind, text, this.parts.replyTo, 1));
      if (!streamId) {
        this.broken = true;
        throw new StreamRefusedError("Teams gave no stream id");
      }
      this.streamId = streamId;
      this.openedAt = clock.monotonicMs();
      if (kind === "streaming") this.streamed = text;
      if (conversation) busy.opened(conversation, this.openedAt);
    });
  }

  /** A new informative update (shown only until text is streamed). */
  inform(text: string): Promise<void> {
    return this.lock.run(async () => {
      this.sequence += 1;
      await this.send(streamActivity("informative", text, this.parts.replyTo, this.sequence, this.streamId));
    });
  }

  /** The streamed text so far. What was streamed before must be its start (Teams refuses anything else). */
  emit(text: string): Promise<void> {
    if (!text.startsWith(this.streamed)) {
      return Promise.reject(new RangeError("streamed text must grow from what was streamed before"));
    }
    return this.lock.run(async () => {
      this.sequence += 1;
      await this.send(streamActivity("streaming", text, this.parts.replyTo, this.sequence, this.streamId));
      this.streamed = text;
    });
  }

  /**
   * Close the stream with `activity`, the message that stays in the chat. A final Teams refuses with 400 while it carries
   * the reply style's extras is sent once more without them, so the status does not spin on until Teams' limit.
   */
  async final(activity: JsonObject): Promise<void> {
    try {
      await this.finalOnce(activity);
    } catch (error) {
      const plain =
        error instanceof StreamRefusedError && error.status === 400 ? plainDecorations(activity) : undefined;
      if (plain === undefined) throw error;
      this.logger.warn(
        "the stream's final message was refused with its AI label or suggested replies; sending it plain",
      );
      await this.finalOnce(plain);
    }
  }

  private finalOnce(activity: JsonObject): Promise<void> {
    return this.lock.run(async () => {
      await this.send(streamFinal(activity, this.parts.replyTo, this.streamId), true);
      this.closed = true;
      if (this.parts.conversation && this.openedAt !== undefined) {
        this.parts.busy.closed(this.parts.conversation, this.openedAt);
      }
    });
  }
}
