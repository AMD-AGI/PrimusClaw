// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a chat shows while the turn runs, then the answer (1:1 and group chats alike).
 *
 * With a live stream the turn is shown the way the chat shows its own agents: a floating status under the user's message
 * ("Thinking…", then the step running now), and the answer is the stream's final message, in its place. Without one, or as
 * soon as the chat refuses the stream, it is one message edited in place while the turn runs and retired when the answer
 * goes out as new messages.
 *
 * The progress message shows a readable view of the turn (LiveView), edited at most every LIVE_MIN_INTERVAL seconds;
 * updates in between are coalesced and the newest is sent when the interval is up. Brain's setup steps are not shown as
 * steps: when setup has been running for PREPARING_AFTER_SECONDS the view says "Preparing…" until the first real step.
 * Nothing here can fail the turn: a progress edit that fails is logged and dropped. A stream the chat closes at its limit
 * is closed before that with STILL_WORKING, and the answer comes as a message of its own.
 */

import { errorName } from "../../errors.js";
import { toLang, type Lang } from "../../locales/lang.js";
import { turnEnglish, turnText } from "../../locales/turn.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { OutMessage, StreamRefused } from "../../ports/surface.js";
import type { Result } from "../../result.js";
import { type Integrations, noIntegrations } from "../../plugins/integrations.js";
import { LiveView } from "../live-view.js";
import { nowSeconds, sleepSeconds, type TurnSurface } from "../ports.js";
import type { Step } from "../step.js";
import { detach, Task, unlessAborted } from "../task.js";
import { answerMessages, type FinishOptions, plainMessage } from "./answer-messages.js";
import { defaultStreamFinish, type StatusPolicy, TurnStatusPolicy } from "./status-policy.js";

/** A Claw turn's status options: its view is a LiveView in the turn's language. */
export interface TurnStatusOptions extends Omit<StatusOptions<Step>, "policy"> {
  /** The agent's text is streamed into the answer's bubble. */
  readonly streamText?: boolean;
  /** A deployment's MCP servers, named in progress lines. */
  readonly integrations?: Integrations;
}

/** The status message of a Claw turn (`TurnStatusPolicy`). */
export function turnStatusMessage(surface: TurnSurface, options: TurnStatusOptions): StatusMessage<Step> {
  const view = new LiveView(options.lang ?? "en", options.integrations ?? noIntegrations);
  const policy = new TurnStatusPolicy(view, options.streamText ?? false);
  return new StatusMessage(surface, { ...options, policy });
}
import { statusText } from "./status-text.js";
import { isPassing, StreamHandle } from "./stream-handle.js";

/** The live view is edited at most this often (the chat throttles edits). */
export const LIVE_MIN_INTERVAL = 1.5;
/** Brain's setup shows one "Preparing" line only if it lasts this long. */
export const PREPARING_AFTER_SECONDS = 1.5;
/** The progress message is retired this long after the last progress edit: a late edit must not land on DONE_LINE. */
export const FINAL_SETTLE_SECONDS = 1.0;
/** ... and one that is late anyway is covered by sending DONE_LINE once more this long afterwards. */
export const REASSERT_SECONDS = 6.0;
/** The chat closes a stream this long after it opened; this one is closed by its final message before that. */
export const STREAM_CLOSE_SECONDS = 9 * 60;

export interface StatusOptions<S> {
  readonly clock: Clock;
  readonly log: Logger;
  readonly lang?: string;
  /** What is shown of the turn's steps and words (a Claw turn's: `TurnStatusPolicy`, see `turnStatusMessage`). */
  readonly policy: StatusPolicy<S>;
  /** Shown at the top from the first post on (a review's acknowledgement). */
  readonly lead?: string;
  /** The person's message a live stream answers; undefined: no stream here (the progress message). */
  readonly streamReplyTo?: string | undefined;
  /** Every member sees the floating status: it carries no words of the agent's. */
  readonly group?: boolean;
}

export class StatusMessage<S> {
  private readonly surface: TurnSurface;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly lang: Lang;
  private readonly policy: StatusPolicy<S>;
  private readonly lead: string;
  private readonly group: boolean;
  /** undefined: the progress message (no stream here, or the chat refused it). */
  private stream: StreamHandle | undefined;
  /** The stream itself, kept after a refusal: it is still closed when it can be. */
  private readonly live: StreamHandle | undefined;
  private posted: Task<string | undefined> | undefined;
  private flusher: Task<void> | undefined;
  private opening: Task<void> | undefined;
  private expiry: Task<unknown> | undefined;
  private again: Task<unknown> | undefined;
  /** The stream being closed because a card waits for the person (`awaitingChoice`). */
  private choice: Task<unknown> | undefined;
  private preparingTimer: Task<void> | undefined;
  private lastText = "";
  private lastAt = 0;
  private begunAt = 0;
  private sending = false;
  private closed = false;
  /** When the last live progress edit left. */
  private editedAt: number | undefined;
  /** Brain's setup has started and no real step has followed yet. */
  private preparing = false;
  /** A line shown above the live view (a review's result). */
  private headlineText = "";
  /** The stream is being closed before the chat's limit ... */
  private expiring = false;
  /** ... and has been: the answer comes as a message of its own. */
  private streamOver = false;
  /** The turn was cancelled (`close(true)`). */
  private hard = false;

  constructor(surface: TurnSurface, options: StatusOptions<S>) {
    this.surface = surface;
    this.clock = options.clock;
    this.log = options.log;
    this.lang = toLang(options.lang);
    this.policy = options.policy;
    this.lead = options.lead ?? "";
    this.stream = options.streamReplyTo ? new StreamHandle(surface, options.streamReplyTo, options.clock) : undefined;
    this.live = this.stream;
    this.group = options.group ?? false;
  }

  begin(): void {
    this.begunAt = nowSeconds(this.clock);
    if (this.stream) {
      this.opening = new Task(() => this.openStream());
      return;
    }
    const header = this.policy.view.header;
    const first = this.lead ? `${this.lead}\n\n${header}` : header;
    this.posted = new Task(() => this.surface.post(plainMessage(first))); // no thumbs here
  }

  private async openStream(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    const opened = await stream.start(statusText(this.statusLines()));
    if (!opened.ok) {
      this.fallBack(opened.error);
      return;
    }
    this.lastAt = nowSeconds(this.clock);
    if (this.hard) {
      // (the turn was cancelled while the stream opened: it is closed at once, not left spinning)
      this.streamOver = true;
      await this.interrupt(stream);
      return;
    }
    this.expiry = detach((signal) => this.closeInTime(signal));
  }

  /** The chat did not take the stream: the turn is shown by the progress message from here on. */
  private fallBack(err: StreamRefused): void {
    this.log.warn("live stream not used; showing progress as an edited message", {
      reason: err.reason,
      status: err.status,
    });
    this.stream = undefined;
    if (!this.closed) {
      this.posted = new Task(() => this.surface.post(plainMessage(this.render())));
      this.kick();
    }
  }

  private statusLines(): string[] {
    const lines = this.policy.view.statusLines(!this.group);
    return lines.length ? lines : [turnText.in(this.lang).thinking];
  }

  /** Close the stream with STILL_WORKING before the chat's limit; the answer, whenever it comes, is a message of its own. */
  private async closeInTime(signal: AbortSignal): Promise<void> {
    const live = this.live;
    if (!live) return;
    await sleepSeconds(this.clock, Math.max(STREAM_CLOSE_SECONDS - live.age(), 0), signal);
    await this.closeEarly(live, turnText.in(this.lang).stillWorking, "before the chat's limit", signal);
  }

  /**
   * Close the open stream with `line` (after the agent's words in the bubble) while the turn goes on; the answer, whenever it comes, is
   * a message of its own. Nothing more is sent to the stream once this has begun.
   */
  private async closeEarly(live: StreamHandle, line: string, why: string, signal: AbortSignal): Promise<void> {
    if (this.closed || !live.closable || this.streamOver || this.expiring) return;
    this.expiring = true;
    if (this.stream && this.flusher && !this.flusher.done) await unlessAborted(this.flusher.settled(), signal);
    this.streamOver = true;
    const words = this.streamable() || live.streamed; // (the agent's words not yet streamed go into the bubble too)
    const closed = await live.final(plainMessage(words ? `${words}\n\n${line}` : line));
    if (!closed.ok) this.log.warn(`the turn's stream could not be closed ${why}; the answer follows as a message`);
    this.log.info("the turn's stream was closed; the answer follows as a message of its own", {
      why,
      age: Math.round(live.age()),
    });
  }

  /**
   * A card now waits for the person (a question of the agent): it is their turn, so the floating status must not go on
   * saying "Thinking…" until the chat's limit. An open stream is closed at once with AWAITING_CHOICE, and the answer comes
   * as a message of its own, as after the limit. Without a stream (the progress message) nothing changes: it has no
   * spinner. Never fails the turn.
   */
  awaitingChoice(): void {
    const live = this.live;
    if (this.closed || !live || this.streamOver || this.expiring || this.choice) return;
    this.choice = detach(async (signal) => {
      if (this.opening && !this.opening.done) await unlessAborted(this.opening.settled(), signal);
      if (!this.expiring) this.expiry?.cancel(); // (its close at the limit is not needed any more)
      await this.closeEarly(live, turnText.in(this.lang).awaitingChoice, "while a card waits for the person", signal);
    });
  }

  /**
   * Claw queued the message behind a turn it is still running: `notice` closes the stream at once, so it does not say
   * "Thinking…" for the whole wait. The answer comes as a message of its own, as after the limit. When the stream did not open
   * after all, `notice` is said as a message. False when there is no stream: the caller says it. Never fails the turn.
   */
  queued(notice: string): boolean {
    const live = this.live;
    if (this.closed || !live || this.streamOver || this.expiring || this.choice) return false;
    this.choice = detach(async (signal) => {
      if (this.opening && !this.opening.done) await unlessAborted(this.opening.settled(), signal);
      if (this.closed || !live.closable || this.streamOver || this.expiring) {
        await this.surface.send(plainMessage(notice)); // (refused or already closing: the notice goes on its own)
        return;
      }
      this.expiry?.cancel(); // (its close at the limit is not needed any more)
      await this.closeEarly(live, notice, "while the message waits behind another turn", signal);
    });
    return true;
  }

  /** The chat's id of the posted message; undefined when the post failed or its id never came (nothing is edited then). */
  private async messageId(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.posted) return undefined;
    const outcome = await unlessAborted(this.posted.outcome, signal);
    if (outcome.ok) return outcome.value;
    this.log.warn("posting the status message failed", { error: errorName(outcome.error) });
    return undefined;
  }

  /**
   * Track Brain's setup. The first setup step starts a timer; if no real step has come by the time it fires,
   * "Preparing…" is shown. A real step ends setup and retracts the line. Call it before `progress` for the same step.
   */
  note(step: Step): void {
    if (step.preparation) {
      if (!this.preparing && !this.closed) {
        this.preparing = true;
        this.preparingTimer = new Task((signal) => this.announcePreparing(signal));
      }
      return;
    }
    const real = Boolean(step.narration || step.tool || step.approval || step.question || step.finished);
    if (this.preparing && real) {
      this.preparing = false;
      this.stopPreparingTimer();
      if (this.policy.view.preparing) {
        this.policy.view.preparing = false;
        this.kick();
      }
    }
  }

  private stopPreparingTimer(): void {
    this.preparingTimer?.cancel();
    this.preparingTimer = undefined;
  }

  private async announcePreparing(signal: AbortSignal): Promise<void> {
    await sleepSeconds(this.clock, PREPARING_AFTER_SECONDS, signal);
    if (this.closed) return;
    this.policy.view.preparing = true;
    this.kick();
  }

  /** Make sure the newest live view gets sent. */
  private kick(): void {
    if (!this.closed && (!this.flusher || this.flusher.done)) this.flusher = new Task((signal) => this.flush(signal));
  }

  /** Show `line` above the live view from the next edit on (a review's result the moment the stream shows it). */
  headline(line: string): void {
    if (!this.closed && line && line !== this.headlineText) {
      this.headlineText = line;
      this.kick();
    }
  }

  private render(): string {
    return [this.lead, this.headlineText, this.policy.view.render()].filter((part) => part).join("\n\n");
  }

  /** Fold the step into what is shown and make sure the newest of it gets sent. */
  progress(step: S): void {
    if (this.closed) return;
    if (this.policy.applyStep(step)) this.kick();
  }

  /** The text for the answer's bubble ('' when there is none); what was streamed when it no longer grows from that. */
  private streamable(): string {
    return this.stream ? this.policy.streamable(this.stream.streamed) : "";
  }

  /** Whether the turn is still shown by its stream (a refusal hands it to the progress message). */
  private streaming(): boolean {
    return this.stream !== undefined;
  }

  private async flush(signal: AbortSignal): Promise<void> {
    if (this.opening && !this.opening.done) await unlessAborted(this.opening.settled(), signal);
    if (this.stream) {
      await this.flushStream(signal);
      if (this.streaming()) return; // (else the stream was refused on the way: the progress message took over)
    }
    const messageId = await this.messageId(signal);
    while (messageId && !this.closed) {
      const wait = Math.max(this.lastAt, this.begunAt) + LIVE_MIN_INTERVAL - nowSeconds(this.clock);
      if (wait > 0) {
        await sleepSeconds(this.clock, wait, signal);
        continue; // the view may have changed while waiting, and the status may have been closed
      }
      const text = this.render();
      if (text === this.lastText) return;
      this.lastText = text;
      this.sending = true;
      try {
        await unlessAborted(this.update(messageId, plainMessage(text), signal), signal);
      } finally {
        this.sending = false;
        this.lastAt = this.editedAt = nowSeconds(this.clock); // counted from when the edit left, not from when it began
      }
    }
  }

  /**
   * The newest status (or streamed text) to the stream, at most every LIVE_MIN_INTERVAL seconds. A request the chat
   * refuses with 429 or 400 is skipped (the next one says the newer thing); any other refusal ends the stream.
   */
  private async flushStream(signal: AbortSignal): Promise<void> {
    while (this.stream && this.stream.open && !(this.closed || this.expiring)) {
      const stream = this.stream;
      const wait = Math.max(this.lastAt, this.begunAt) + LIVE_MIN_INTERVAL - nowSeconds(this.clock);
      if (wait > 0) {
        await sleepSeconds(this.clock, wait, signal);
        continue;
      }
      const streamed = this.streamable();
      const text = streamed || statusText(this.statusLines());
      if (text === this.lastText || (streamed && streamed === stream.streamed)) return;
      this.lastText = text;
      this.sending = true;
      let sent: Result<void, StreamRefused>;
      try {
        sent = await unlessAborted(streamed ? stream.emit(text) : stream.inform(text), signal);
      } finally {
        this.sending = false;
        this.lastAt = nowSeconds(this.clock);
      }
      if (sent.ok) continue;
      if (!isPassing(sent.error)) {
        this.fallBack(sent.error);
        return;
      }
      this.log.info("a status update of the turn's stream was not taken; the next one follows", {
        status: sent.error.status,
      });
      this.lastText = ""; // (sent again after the interval)
    }
  }

  private async update(messageId: string, message: OutMessage, signal?: AbortSignal): Promise<void> {
    try {
      await this.surface.update(messageId, message, signal ? { signal } : {});
    } catch (err) {
      this.log.warn("status edit failed; the turn goes on", { error: errorName(err) });
    }
  }

  /**
   * Stop sending progress. A sleeping flusher is cancelled; one that is mid-send finishes that one send, unless the turn
   * itself was cancelled (`hard`). A stream still open when the turn is cancelled is closed with INTERRUPTED, in the
   * background (the floating status must not spin until the chat's limit).
   */
  close(hard = false): void {
    this.closed = true;
    this.hard = this.hard || hard;
    this.stopPreparingTimer();
    if (this.flusher && !this.flusher.done && (hard || !this.sending)) this.flusher.cancel();
    if (hard) for (const task of [this.again, this.expiry, this.choice]) task?.cancel();
    if (hard && this.live?.closable && !this.streamOver) {
      this.streamOver = true;
      const live = this.live;
      detach(() => this.interrupt(live));
    }
  }

  private async interrupt(stream: StreamHandle): Promise<void> {
    const closed = await stream.final(plainMessage(turnText.in(this.lang).interrupted));
    if (!closed.ok)
      this.log.warn("the stream of a cancelled turn could not be closed; the chat closes it at its limit");
  }

  /**
   * The turn is over: the user gets `parts`, in order. With a stream the first part is its final message (in the place
   * of the status) and the others follow; without one they are NEW messages, and the progress message is then retired.
   * The thumbs (`feedback`) and suggested replies go under the LAST part, and nowhere else.
   */
  async finish(parts: readonly string[], options: FinishOptions = {}): Promise<void> {
    await this.quiesce();
    const messages = answerMessages(parts, options);
    if (this.stream && this.stream.open && !this.streamOver) {
      await this.finishStream(this.stream, messages, parts, options);
      return;
    }
    const messageId = await this.messageId(); // the progress message is on screen before the answer, so it stays above it
    let rest: readonly OutMessage[] = messages;
    if (this.live && this.live.closable && !this.streamOver) rest = await this.closeRefusedStream(this.live, messages);
    for (const message of rest) await this.surface.send(message);
    if (messageId) await this.retire(messageId);
  }

  /** Stop the live view and wait for what is still on its way: the stream's opening, the last edit, a closing stream. */
  private async quiesce(): Promise<void> {
    this.close();
    if (this.expiry && !this.expiry.done && !this.expiring) this.expiry.cancel();
    for (const task of [this.opening, this.flusher, this.expiring ? this.expiry : undefined, this.choice]) {
      if (task) await task.settled();
    }
  }

  /**
   * The stream opened and the chat later refused an update of it, so the progress message took over: the stream is still
   * closed, with the first part of the answer when the chat takes that. Returns what is left to send as messages.
   */
  private async closeRefusedStream(
    live: StreamHandle,
    messages: readonly OutMessage[],
  ): Promise<readonly OutMessage[]> {
    let final: OutMessage;
    let rest: readonly OutMessage[];
    const [first, ...others] = messages;
    if (live.streamed) [final, rest] = [plainMessage(live.streamed), messages];
    else if (first) [final, rest] = [first, others];
    else [final, rest] = [plainMessage(turnText.in(this.lang).doneShort), []];
    const closed = await live.final(final);
    if (closed.ok) return rest;
    this.log.warn("the refused stream could not be closed either; the chat closes it at its limit", {
      reason: closed.error.reason,
    });
    return messages;
  }

  /**
   * The stream's final message is the first part of the answer (the chat then draws its AI label and thumbs); the other
   * parts follow as messages. A final the chat refuses is sent as a message of its own, so the answer is never lost.
   */
  private async finishStream(
    stream: StreamHandle,
    messages: readonly OutMessage[],
    parts: readonly string[],
    options: FinishOptions,
  ): Promise<void> {
    let rest: readonly OutMessage[] = messages.slice(1);
    let final = messages[0] ?? plainMessage(turnText.in(this.lang).doneShort);
    if (stream.streamed) {
      const input = { streamed: stream.streamed, streamable: this.streamable(), messages, parts, options };
      ({ final, rest } = this.policy.finishStream?.(input) ?? defaultStreamFinish(input));
    }
    const closed = await stream.final(final);
    if (!closed.ok) {
      this.log.warn("the stream's final message was refused; the answer is sent as a message", {
        reason: closed.error.reason,
      });
      rest = messages;
    }
    for (const message of rest) await this.surface.send(message);
  }

  /** Wait until FINAL_SETTLE_SECONDS have passed since the last progress edit left. */
  private async settle(): Promise<void> {
    if (this.editedAt === undefined) return;
    const wait = this.editedAt + FINAL_SETTLE_SECONDS - nowSeconds(this.clock);
    if (wait > 0) await sleepSeconds(this.clock, wait);
  }

  /**
   * The answer is posted below: delete the progress message. The chat may refuse, and a queue cannot delete; the message
   * is then edited down to one line, so it does not sit above the answer as stale progress. Never fails the turn.
   */
  private async retire(messageId: string): Promise<void> {
    await this.settle();
    let removed: boolean;
    try {
      removed = (await this.surface.delete(messageId)).ok;
    } catch (err) {
      this.log.warn("deleting the progress message failed", { error: errorName(err) });
      removed = false;
    }
    if (removed) return;
    this.log.warn("the progress message was not deleted; leaving it as one line");
    const done = plainMessage(turnEnglish.doneLine);
    await this.update(messageId, done);
    this.reassert(messageId, done);
  }

  /** Live edits went out, so one may still arrive after `message` replaced the progress message: send it once more. */
  private reassert(messageId: string, message: OutMessage): void {
    if (this.editedAt === undefined) return;
    this.again = detach(async (signal) => {
      await sleepSeconds(this.clock, REASSERT_SECONDS, signal);
      await this.update(messageId, message);
    });
  }
}
