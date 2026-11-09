// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One live stream in reply to one user message, as the turn follows it: whether it is open, whether it can still be
 * closed, what was streamed into it, and how old it is. The channel adapter behind `openStream` paces the requests and
 * keeps one stream per conversation; this keeps the turn's view of it (the Python worker's `TeamsStream` state).
 */

import type { Clock } from "../../ports/clock.js";
import type { LiveStream, OutMessage, StreamRefused } from "../../ports/surface.js";
import { err, ok, type Result } from "../../result.js";
import { nowSeconds, type TurnSurface } from "../ports.js";

const OVER: StreamRefused = { kind: "stream_refused", reason: "the stream is over", status: 0, code: "" };

/** A refusal that leaves the stream usable: throttled (429), or this one update not taken (400). */
export function isPassing(refusal: StreamRefused): boolean {
  return refusal.status === 400 || refusal.status === 429;
}

export class StreamHandle {
  private stream: LiveStream | undefined;
  private broken = false;
  private closed = false;
  private openedAt: number | undefined;
  /** The text streamed into the bubble so far ('' : only status so far). */
  streamed = "";

  constructor(
    private readonly surface: TurnSurface,
    private readonly replyTo: string,
    private readonly clock: Clock,
  ) {}

  /** Updates can be sent: it opened, and neither failed nor closed. */
  get open(): boolean {
    return this.stream !== undefined && !(this.broken || this.closed);
  }

  /** A final message can still be tried: it opened and is not closed (a refused update leaves it closable). */
  get closable(): boolean {
    return this.stream !== undefined && !this.closed;
  }

  /** Seconds since it opened. */
  age(): number {
    return this.openedAt === undefined ? 0 : nowSeconds(this.clock) - this.openedAt;
  }

  /** Open it with its first status. */
  async start(status: string): Promise<Result<void, StreamRefused>> {
    const opened = await this.surface.openStream(this.replyTo, status);
    if (!opened.ok) {
      this.broken = true;
      return opened;
    }
    this.stream = opened.value;
    this.openedAt = nowSeconds(this.clock);
    return ok(undefined);
  }

  private refused(result: Result<void, StreamRefused>): Result<void, StreamRefused> {
    if (!result.ok) this.broken = this.broken || !isPassing(result.error);
    return result;
  }

  private usable(final: boolean): LiveStream | undefined {
    return this.closed || (this.broken && !final) ? undefined : this.stream;
  }

  /** A new status (shown only until text is streamed). */
  async inform(status: string): Promise<Result<void, StreamRefused>> {
    const stream = this.usable(false);
    return stream ? this.refused(await stream.inform(status)) : err(OVER);
  }

  /** The streamed text so far: what was streamed before must be the start of it (the channel refuses anything else). */
  async emit(text: string): Promise<Result<void, StreamRefused>> {
    const stream = this.usable(false);
    if (!stream) return err(OVER);
    if (!text.startsWith(this.streamed)) return err({ ...OVER, reason: "streamed text must grow from what was streamed" });
    const sent = this.refused(await stream.emit(text));
    if (sent.ok) this.streamed = text;
    return sent;
  }

  /** Close it with `message`, the message that stays in the chat. */
  async final(message: OutMessage): Promise<Result<void, StreamRefused>> {
    const stream = this.usable(true);
    if (!stream) return err(OVER);
    const sent = await stream.finish(message);
    if (sent.ok) this.closed = true;
    else this.broken = this.broken || !isPassing(sent.error);
    return sent;
  }
}
