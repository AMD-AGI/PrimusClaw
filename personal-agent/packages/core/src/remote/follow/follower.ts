// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a chat that is attached to a remote agent shows of it BETWEEN turns.
 *
 * A turn is read from the person's message to the agent's `turn_end`, and then nothing reads the session any more. But a coding
 * agent goes on by itself after its turn: a background task finishes, a scheduled job wakes it. The connector posts all of that as
 * events with no prompt open and no `turn_end`. So an attached chat has one `Follower`, a reader that is there whenever no turn and
 * no short watch is reading:
 *
 * - what the agent says with no prompt open is delivered by itself, as new messages. There is no `turn_end` to wait for, so a burst
 *   is over when the stream has been quiet for `quiet` and no step or permission request is still open (`toolQuiet` when one is),
 *   and at the latest `maxAge` after the text began. At most one message per `gap`.
 * - quiet hours and a pause hold it, and it comes when they end; somebody who wrote a moment ago is told at once, in quiet hours but
 *   never in a pause they asked for. A permission request gets its card at once, and none while the person may not be woken.
 * - it never reads while a turn does: it is stopped, with what it has read delivered, before a message goes to the agent, and
 *   started again when the turn has ended, from where the turn ended. The cursor it writes never passes text it has not delivered,
 *   so a worker that restarts delivers what was waiting, once.
 */
import { ClawError } from "../../claw/errors.js";
import type { SseEvent } from "../../claw/model.js";
import { errorName } from "../../errors.js";
import type { RemotePermissionRepository } from "../../ports/store/remote.js";
import { type RemoteStep } from "../events.js";
import { type RemoteTurnState } from "../turn-state.js";
import { actionIdOf, filled } from "../tail.js";
import { Inbox, TIMED_OUT } from "./inbox.js";
import { BurstSpeaker, type SpeakerDeps } from "./speaker.js";
import { noteStep } from "./steps.js";
import { CURSOR_EVERY, STOP_WAIT_MS, reconnectDelayMs } from "./timings.js";

/**
 * What the reader reads with could not be had just now (the identity service is down) and there is no other credential: not the
 * same as having none. The reader waits and asks again; a credential that is null is a person who has none (unlinked), and ends it.
 */
export class CredentialUnavailable extends Error {
  override readonly name = "CredentialUnavailable";
}

export interface FollowerDeps extends SpeakerDeps {
  readonly permissions: RemotePermissionRepository;
  /** The session's events after a cursor, live; ends when the stream ends; throws `ClawError` or a transport error. */
  stream(key: string, sessionId: string, after: string | undefined, signal: AbortSignal): AsyncIterable<SseEvent>;
  /** What to read with (null: nobody to read for; throws `CredentialUnavailable` when it cannot be had just now). */
  credential(): Promise<string | null>;
  newTurn(): RemoteTurnState;
}

const STOP: unique symbol = Symbol("stop");
const ENDED: unique symbol = Symbol("ended");
type Item = SseEvent | typeof STOP | typeof ENDED | { readonly failed: unknown };

type Outcome = "again" | "stop" | "done";

/** The event says something of the session's permission modes. */
export function saysModes(step: RemoteStep): boolean {
  return step.mode !== null || step.modes !== null || step.unattended !== null || step.modeFlags !== null;
}

/** The event is the agent at work (or ending its turn): what makes the follower count it as busy. */
function isActivity(step: RemoteStep): boolean {
  return (
    Boolean(step.chunk ?? step.tool ?? step.plan) || filled(step.permission) || filled(step.resolved) || step.finished
  );
}

/** The reader of one attached chat's session, for as long as no turn reads it. */
export class Follower {
  private readonly speaker: BurstSpeaker;
  private readonly cancel = new AbortController();
  private readonly stopped = new AbortController();
  private flushOnStop = true;
  private doneTurn = false; // the last thing read was the agent ending its turn (`finished`)
  private readonly active = new Map<string, boolean>(); // steps begun and not ended (false: running when the chat attached)
  private readonly asks = new Set<string>(); // permission requests that have not been answered
  private cursor = ""; // the last event handled
  private handled = 0;
  private lastEvent = Number.NEGATIVE_INFINITY;
  private pauseOverAfter = Number.NaN; // the last event whose pause the reader saw end (NaN: none)
  private inbox: Inbox<Item> | null = null;
  private task: Promise<void> | null = null;
  private finished = false;

  constructor(
    readonly chatKey: string,
    readonly sessionId: string,
    private readonly deps: FollowerDeps,
  ) {
    this.speaker = new BurstSpeaker(chatKey, sessionId, deps, deps.newTurn(), this.cancel.signal);
  }

  get alive(): boolean {
    return this.task !== null && !this.finished;
  }

  /**
   * Begin reading. `active`: the agent was at work a moment ago (`busy` says so until `quiet` has passed with no event). `steps`
   * and `asks`: the steps that had begun and the permission requests nobody had answered when the chat attached: `busy` says so
   * until their own end (or answer) is read. They do not hold back the text that comes after.
   */
  start(active = false, steps: Iterable<string> = [], asks: Iterable<string> = []): void {
    if (active) this.lastEvent = this.deps.clock.monotonicMs();
    for (const step of steps) this.active.set(step, false);
    for (const ask of asks) this.asks.add(ask);
    this.task = this.guarded().finally(() => {
      this.finished = true;
    });
  }

  /** Stop reading and forget what was waiting: the chat has left the session. */
  drop(): void {
    this.cancel.abort();
    this.inbox?.push(STOP);
  }

  /**
   * Stop reading, and (`flush`) deliver the text that waits, whoever may be woken: called when the person has just written.
   * Returns when the reader is gone.
   */
  async stop(flush = true): Promise<void> {
    this.flushOnStop = flush;
    this.stopped.abort();
    this.inbox?.push(STOP);
    const task = this.task;
    if (task === null) return;
    const gone = await Promise.race([
      task.then(() => true),
      this.deps.clock.sleep(this.deps.timings.stopWaitMs ?? STOP_WAIT_MS).then(() => false),
    ]);
    if (gone) return;
    this.drop();
    await task; // (the cancel lands, and what the reader was doing is over, before anything is judged)
    this.persist(this.speaker.abandon(this.cursor));
  }

  /** The chat left the session: the reader goes, with nothing more said. */
  private cancelled(): boolean {
    return this.cancel.signal.aborted;
  }

  /** The person wrote: the reader stops, with what it read delivered. */
  private stopping(): boolean {
    return this.stopped.signal.aborted;
  }

  /** The agent is, as far as can be told, working on its own now (what `/stop` should reach). */
  busy(): boolean {
    const recent =
      !this.doneTurn &&
      this.lastEvent !== this.pauseOverAfter &&
      this.deps.clock.monotonicMs() - this.lastEvent < this.deps.timings.quietMs;
    return this.speaker.waiting || this.active.size > 0 || this.asks.size > 0 || recent;
  }

  private async guarded(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      if (!this.cancelled()) this.deps.logger.error("following a remote session failed", { error: errorName(error) });
    } finally {
      this.persist(this.speaker.safe);
    }
  }

  // --- reading ---------------------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    if (state === null || state.sessionId !== this.sessionId) return;
    this.cursor = state.cursor;
    this.speaker.settleAt(state.cursor);
    let failures = 0;
    while (!this.stopping() && !this.cancelled()) {
      const key = await this.readCredential();
      if (key === undefined) {
        failures += 1;
        await this.wait(failures);
        continue;
      }
      if (!key) return; // unlinked, or no credential to read with: nothing may read on without one
      const before = this.handled;
      const outcome = await this.readOnce(key);
      if (outcome === "done" || this.cancelled()) return;
      if (outcome === "stop") break;
      failures = this.handled > before ? 0 : failures + 1;
      await this.wait(failures);
    }
    if (this.flushOnStop && this.stopping() && !this.cancelled()) {
      await this.flush({ force: true, holdOnFailure: true });
    }
  }

  /** The credential; undefined when it cannot be had just now. */
  private async readCredential(): Promise<string | null | undefined> {
    try {
      return await this.deps.credential();
    } catch (error) {
      if (!(error instanceof CredentialUnavailable)) throw error;
      this.deps.logger.warn("no credential to follow a remote session with just now; trying again");
      return undefined;
    }
  }

  /** One stream, read until it ends, the reader is stopped, or there is nothing left to read. */
  private async readOnce(key: string): Promise<Outcome> {
    const inbox = new Inbox<Item>(this.deps.clock);
    this.inbox = inbox;
    if (this.stopping() || this.cancelled()) return "stop";
    const pumping = new AbortController();
    const onCancel = (): void => {
      pumping.abort();
    };
    this.cancel.signal.addEventListener("abort", onCancel);
    const pump = this.pump(key, inbox, pumping.signal);
    try {
      return await this.consume(inbox);
    } finally {
      pumping.abort();
      this.cancel.signal.removeEventListener("abort", onCancel);
      await pump;
      this.inbox = null;
    }
  }

  /** Wait before reading again, longer for each failure in a row, and no longer than it takes to be stopped. */
  private async wait(failures: number): Promise<void> {
    const either = AbortSignal.any([this.stopped.signal, this.cancel.signal]);
    await this.deps.clock.sleep(reconnectDelayMs(this.deps.timings, failures), either).catch(() => undefined);
  }

  /** The session's events into the inbox, so the reader can also wait for the end of a pause. */
  private async pump(key: string, inbox: Inbox<Item>, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.deps.stream(key, this.sessionId, this.cursor || undefined, signal)) {
        if (signal.aborted) return;
        inbox.push(event);
      }
      inbox.push(ENDED);
    } catch (error) {
      if (!signal.aborted) inbox.push({ failed: error });
    }
  }

  /** Events and the ends of pauses, until the stream ends ('again'), the reader is stopped ('stop'), or nothing is left ('done'). */
  private async consume(inbox: Inbox<Item>): Promise<Outcome> {
    for (;;) {
      const at = this.dueContext();
      const due = this.speaker.dueInMs(at);
      const item = await inbox.next(due);
      if (item === TIMED_OUT) {
        // The wait for the end of the pause is over: the agent is not at work any more, whatever the clock reads now (a timer may
        // end a hair before its deadline, and the card refreshed next must not say "working" until the agent's next event).
        if (due !== null && !at.busy && at.lastEvent + this.deps.timings.quietMs <= at.now + due)
          this.pauseOverAfter = at.lastEvent;
        await this.flush({ force: false, holdOnFailure: false });
        await this.speaker.settleWindow();
        continue;
      }
      if (item === STOP) return "stop";
      if (item === ENDED) return "again";
      if ("failed" in item) return this.failure(item.failed);
      if (!(await this.handle(item))) return "done";
    }
  }

  private failure(error: unknown): Outcome {
    if (error instanceof ClawError && [401, 403, 404].includes(error.status)) {
      this.deps.logger.info("the session is no longer readable: not followed any more", { status: error.status });
      return "done";
    }
    if (error instanceof ClawError)
      this.deps.logger.warn("following a remote session: the stream failed", { status: error.status });
    else this.deps.logger.warn("following a remote session: the stream dropped", { error: errorName(error) });
    return "again";
  }

  private dueContext(): { lastEvent: number; busy: boolean; now: number } {
    // (a step that began before the chat attached is no reason to wait longer)
    const busy = [...this.active.values()].some(Boolean) || this.asks.size > 0;
    return { lastEvent: this.lastEvent, busy, now: this.deps.clock.monotonicMs() };
  }

  // --- one event -------------------------------------------------------------------------------------------------------------

  /** Fold one event in. False when the reader has nothing more to do. */
  private async handle(event: SseEvent): Promise<boolean> {
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    if (state === null || state.sessionId !== this.sessionId) return false; // the chat has left this session
    const step = this.speaker.feed(event);
    if (event.id) this.cursor = event.id;
    this.handled += 1;
    const now = this.deps.clock.monotonicMs();
    if (saysModes(step)) this.deps.remoteState.setRemoteModes(this.chatKey, this.sessionId, step);
    if (step.closed !== null) {
      await this.flush({ force: false, holdOnFailure: false }); // (what it said before it ended is not lost)
      await this.speaker.ended(step.closed);
      return false;
    }
    if (isActivity(step)) {
      this.lastEvent = now;
      this.doneTurn = step.finished;
    }
    await this.speaker.noteText(step, now);
    if (step.tool) noteStep(this.active, step.tool);
    await this.askOrResolve(step);
    await this.sayBetween(step);
    if (step.finished) {
      // a connector that does end its turns: the burst is over now
      await this.flush({ force: false, holdOnFailure: false });
      this.active.clear();
      if (state.turnOpen) this.deps.remoteState.setRemoteTurn(this.chatKey, this.sessionId, false);
    }
    this.advance();
    await this.speaker.settleWindow();
    return true;
  }

  private async askOrResolve(step: RemoteStep): Promise<void> {
    if (step.permission !== null) {
      const actionId = actionIdOf(step.permission);
      if (actionId) this.asks.add(actionId);
      await this.speaker.ask(step.permission);
    }
    if (step.resolved !== null) {
      // answered somewhere else, or it ran out on the machine: the card is dead
      const actionId = actionIdOf(step.resolved);
      this.asks.delete(actionId);
      this.deps.permissions.closeRemotePermission(this.sessionId, actionId, "decided");
    }
  }

  /** What is said between two stretches of the agent's text: a prompt typed at the terminal, the connector coming back. */
  private async sayBetween(step: RemoteStep): Promise<void> {
    if (step.typed) {
      // typed at the terminal the chat shares: said after what the agent said before it, so the order holds
      await this.flush({ force: false, holdOnFailure: false });
      await this.speaker.typed(step.typed);
    }
    if (step.recovered !== null) {
      await this.flush({ force: false, holdOnFailure: false });
      await this.speaker.recovered(step.recovered.interrupted, step.recovered.continuing);
    }
  }

  private advance(): void {
    if (this.speaker.waiting) return; // (text waits: what has been read is still needed)
    this.speaker.settleAt(this.cursor);
    if (this.handled % CURSOR_EVERY === 0) this.persist(this.speaker.safe);
  }

  private async flush(how: { force: boolean; holdOnFailure: boolean }): Promise<void> {
    if (await this.speaker.flush(how, this.cursor)) this.persist(this.speaker.safe);
  }

  private persist(safe: string): void {
    if (safe) this.deps.remoteState.setRemoteCursor(this.chatKey, this.sessionId, safe);
  }
}
