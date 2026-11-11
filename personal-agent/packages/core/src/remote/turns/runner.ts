// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a remote turn: from the person's message to the agent's `turn_end` (or the session's end), at most four hours (a coding
 * agent may work for hours; after that the chat stops watching, and it keeps going). A stream that drops is picked up again from
 * the last event handled. What the agent says is shown as it comes (`TurnDisplay`); a permission request gets its card; the end
 * is said in words (`outcome.ts`). Whatever ends the turn, the follower takes over from where it ended.
 */
import { ClawError, errorKind } from "../../claw/errors.js";
import { errorName } from "../../errors.js";
import { remoteAgentText } from "../../locales/remote-agents.js";
import { remoteLeads } from "../../locales/remote-leads.js";
import type { RemoteState } from "../../ports/store/remote.js";
import { type Conversation, textMessage } from "../../ports/surface.js";
import { type RemoteStep } from "../events.js";
import { queuedLine, recoveredLine } from "../lines.js";
import { RemoteTurnState } from "../turn-state.js";
import type { StatusBoard } from "../board.js";
import { type RemoteTurn, newTurn } from "../chats.js";
import type { RemoteContext } from "../context.js";
import { type EndedWords, type Provider, credentialOf } from "../ended.js";
import { saysModes } from "../follow/follower.js";
import type { FollowControl } from "../follow/control.js";
import { failureText, saidIn } from "../refusals.js";
import { type ChatState, isTransport } from "../state.js";
import { actionIdOf } from "../tail.js";
import { Task } from "../tasks.js";
import type { TurnDisplay } from "./display.js";
import { turnOutcome } from "./outcome.js";
import type { Signer } from "./signer.js";

/** A coding agent may work for hours; after this the chat stops watching (it keeps going). */
export const REMOTE_TURN_DEADLINE_SECONDS = 4 * 3600;
export const RECONNECT_BACKOFF_SECONDS = 1.0;
/** Events between two writes of the read position. */
export const CURSOR_EVERY = 25;
/** A stream that keeps dropping is given up after this many tries in a row. */
export const STREAM_ATTEMPTS = 4;

/** How the turn is shown: in the chat, or in the session card (`window-turn.ts`). */
export type DisplayFor = (request: TurnRequest, signer: Signer | null) => TurnDisplay;

/** The read gave up (the stream kept dropping, or the deadline passed): the person is told the connection was lost. */
class LostConnection extends Error {
  override readonly name = "LostConnection";
}

/** What a turn needs besides the chat: the person's credential, how to show it, and who carries what it asks. */
export interface TurnRequest {
  readonly chatKey: string;
  readonly key: string;
  readonly provider: Provider;
  readonly to: Conversation;
  readonly state: RemoteState;
  /** The person's message the turn answers (a stream answers it); undefined: shown by a progress message. */
  readonly replyTo: string | undefined;
  /** Claw's number of the prompt the turn answers, read as events come (undefined: not known, any turn end ends it). */
  readonly cmdSeq?: (() => number | undefined) | undefined;
}

export class TurnRunner {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly follow: FollowControl,
    private readonly ended: EndedWords,
    private readonly show: (
      chatKey: string,
      sid: string,
      request: Readonly<Record<string, unknown>>,
      to: Conversation,
    ) => Promise<void>,
    private readonly displayFor: DisplayFor,
  ) {}

  /** Watch the turn that is open on the chat's session. */
  start(request: TurnRequest): void {
    const turn = newTurn();
    this.state.chats.turns.set(request.chatKey, turn);
    turn.task = new Task((signal) => this.guarded(request, turn, signal), this.ctx.logger, "a remote turn");
  }

  /** Stop reading the chat's turn; the messages waiting behind it are given up too (nothing will read their turns). */
  cancel(chatKey: string): void {
    this.state.chats.dropQueued(chatKey);
    this.state.chats.turns.get(chatKey)?.task?.cancel();
  }

  /** Stop reading the chat's turn only (it will have none): the turn of the next queued message, if any, is read instead. */
  stopReading(chatKey: string): void {
    this.state.chats.turns.get(chatKey)?.task?.cancel();
  }

  private async guarded(request: TurnRequest, turn: RemoteTurn, signal: AbortSignal): Promise<void> {
    try {
      await this.run(request, turn, signal);
    } catch (error) {
      if (signal.aborted) return;
      const ref = this.ctx.errors.newRef();
      this.ctx.logger.error("remote turn failed", { ref, error: errorName(error) });
      const words = remoteAgentText.in(this.state.lang(request.chatKey));
      await request.to.send(textMessage(words.watchFailed({ ref })));
    } finally {
      if (this.state.chats.turns.get(request.chatKey) === turn) this.state.chats.turns.delete(request.chatKey);
      this.over(request);
    }
  }

  /**
   * The turn is over: the turn of the oldest message sent behind it is read next (it runs on the machine now), or, with none
   * waiting, what the agent says next is followed from where the turn ended.
   */
  private over(request: TurnRequest): void {
    const { chatKey } = request;
    for (let next = this.state.chats.takeQueued(chatKey); next; next = this.state.chats.takeQueued(chatKey)) {
      if (next.start()) return;
    }
    this.follow.ensure(chatKey);
    this.board.touchStatus(chatKey, request.to);
  }

  private display(request: TurnRequest): { display: TurnDisplay; signer: Signer | null } {
    const signer = this.state.direct(request.chatKey) ? this.board.signerOf(request.chatKey, request.state) : null;
    return { display: this.displayFor(request, signer), signer };
  }

  private async run(request: TurnRequest, turn: RemoteTurn, signal: AbortSignal): Promise<void> {
    const { chatKey, to, state } = request;
    const { display, signer } = this.display(request);
    display.begin();
    const fold = new RemoteTurnState(this.ctx.errors, request.cmdSeq);
    const cursor = this.ctx.remoteState.getRemote(chatKey)?.cursor ?? ""; // (read again: a catch-up starts where the chat left off)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(REMOTE_TURN_DEADLINE_SECONDS * 1000)]);
    try {
      await this.read(request, display, fold, cursor, deadline);
    } catch (error) {
      if (signal.aborted) {
        display.close(true); // cancelled (the machine was disconnected, or the stop could not reach it): nothing more is sent
        return;
      }
      await this.failed(request, display, error);
      return;
    }
    const lang = this.state.lang(chatKey);
    if (fold.closed !== null) {
      // (before the answer goes out: a failed send must not leave a turn open that has ended)
      this.follow.detach(chatKey);
      this.board.touchStatus(chatKey, to, "ended", state);
    } else {
      this.ctx.remoteState.setRemoteTurn(chatKey, state.sessionId ?? "", false);
    }
    const outcome = await turnOutcome(
      {
        answer: fold.answer,
        stopReason: fold.stopReason,
        note: fold.note,
        closed: fold.closed,
        stopRequested: turn.stopRequested,
      },
      {
        label: state.agentLabel,
        host: state.host,
        lang,
        splitErrorTail: (text) => this.ctx.errors.splitErrorTail(text),
        withhold: (detail) => this.ctx.errors.withhold("remote_turn_failed", detail, { session: state.sessionId }),
        sessionEnded: (reason) =>
          this.ended.sessionEnded(chatKey, request.key, request.provider, state.connectorId, reason),
        turnIncomplete: (code) =>
          this.ended.said(chatKey, remoteLeads.turnIncomplete, request.key, request.provider, state.connectorId, code),
        ...(signer ? { sign: (parts: string[]) => signer.later(parts) } : {}),
      },
    );
    display.tail = outcome.tail;
    // The answer and nothing under it: the system operations are on the status card, never a card per turn.
    await display.finish(outcome.parts, { ai: outcome.ai, ...(signer ? { replies: signer.replies } : {}) });
    if (this.state.chats.queuedCount(chatKey) > 0) await display.handOver?.(); // (the next turn follows at once)
  }

  /** The turn could not be read to its end: the session is gone, Claw refused, or the connection was lost. */
  private async failed(request: TurnRequest, display: TurnDisplay, error: unknown): Promise<void> {
    const lang = this.state.lang(request.chatKey);
    if (error instanceof ClawError) {
      display.close();
      if (error.status === 404 || error.status === 403) {
        // the session is gone (closed with its machine, or deleted)
        this.follow.detach(request.chatKey);
        await display.finish([saidIn(lang, "sessionGone")], { ai: false });
      } else {
        await display.finish([failureText(error, this.ctx.errors, this.ctx.clock.epochMs() / 1000, lang)], {
          ai: false,
        });
      }
      return;
    }
    if (error instanceof LostConnection || isTransport(error) || isTimeout(error)) {
      await display.finish([remoteAgentText.in(lang).lostConnection], { ai: false });
      return;
    }
    display.close(true);
    throw error;
  }

  /**
   * Read the session's events from the cursor until the turn ends or the session closes; a stream that drops is picked up again
   * from the last event handled (the server replays what is stored after it).
   */
  private async read(
    request: TurnRequest,
    display: TurnDisplay,
    fold: RemoteTurnState,
    from: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sid = request.state.sessionId ?? "";
    const reading = { cursor: from, handled: 0, came: false };
    let failures = 0;
    while (!isOver(fold)) {
      reading.came = false;
      try {
        await this.readStream(request, display, fold, reading, signal);
      } catch (error) {
        if (signal.aborted || !droppable(error)) throw error;
        this.ctx.logger.warn("remote stream dropped", { error: errorKind(error) });
      } finally {
        if (cameIn(reading)) failures = 0; // (an event came: the failures in a row start again)
        if (reading.cursor) this.ctx.remoteState.setRemoteCursor(request.chatKey, sid, reading.cursor);
      }
      if (isOver(fold)) return;
      failures += 1;
      if (failures >= STREAM_ATTEMPTS) throw new LostConnection("stream kept dropping");
      await (this.ctx.paceClock ?? this.ctx.clock).sleep(RECONNECT_BACKOFF_SECONDS * failures * 1000, signal);
    }
  }

  /** One stream, read until it ends or the turn does. */
  private async readStream(
    request: TurnRequest,
    display: TurnDisplay,
    fold: RemoteTurnState,
    reading: { cursor: string; handled: number; came: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const sid = request.state.sessionId ?? "";
    const credential = await credentialOf(request.key, request.provider);
    for await (const event of this.ctx.claw.stream(credential, sid, reading.cursor || undefined, signal)) {
      reading.came = true;
      if (event.id) reading.cursor = event.id;
      await this.apply(request, fold.feed(event), display);
      reading.handled += 1;
      if (event.id && reading.handled % CURSOR_EVERY === 0)
        this.ctx.remoteState.setRemoteCursor(request.chatKey, sid, event.id);
      if (isOver(fold)) break;
    }
  }

  private async apply(request: TurnRequest, step: RemoteStep, display: TurnDisplay): Promise<void> {
    if (step.replay) return;
    const { chatKey, to } = request;
    const sid = request.state.sessionId ?? "";
    noteWaiting(this.state.chats.turns.get(chatKey), step);
    if (step.rejected?.type === "prompt" && step.rejected.cmdSeq !== null) {
      await this.queuedRefused(chatKey, to, step.rejected.cmdSeq, step.rejected.reason);
    }
    // (said in the chat's language, as a line of the turn's live view)
    const shown = step.queued !== null ? { ...step, note: queuedLine(step.queued, this.state.lang(chatKey)) } : step;
    display.progress(shown);
    if (saysModes(step)) this.ctx.remoteState.setRemoteModes(chatKey, sid, step);
    if (step.permission !== null) await this.show(chatKey, sid, step.permission, to);
    // answered somewhere else (or it ran out on the machine): the card is dead
    if (step.resolved !== null) this.ctx.permissions.closeRemotePermission(sid, actionIdOf(step.resolved), "decided");
    if (step.recovered !== null && (step.recovered.continuing || !step.recovered.interrupted)) {
      // (a turn the restart ended says so as its own end, which comes next)
      await this.sayRecovered(chatKey, to, step.recovered.interrupted, step.recovered.continuing);
    }
  }

  /**
   * A message waiting behind this turn was refused on the machine before it ran: it waits no more, and the person is told. One whose
   * send has not answered yet has no number to match: the refusal is kept for that send (`Prompts.queueBehind`).
   */
  private async queuedRefused(chatKey: string, to: Conversation, cmdSeq: number, reason: string): Promise<void> {
    if (this.state.chats.takeQueuedSeq(chatKey, cmdSeq) === undefined) {
      this.state.chats.noteRefusal(chatKey, cmdSeq, reason);
      return;
    }
    try {
      await to.send(textMessage(remoteAgentText.in(this.state.lang(chatKey)).queuedRefused({ reason })));
    } catch (error) {
      this.ctx.logger.warn("that a queued message was refused could not be told", { error: errorName(error) });
    }
  }

  private async sayRecovered(
    chatKey: string,
    to: Conversation,
    interrupted: boolean,
    continuing: boolean,
  ): Promise<void> {
    const state = this.ctx.remoteState.getRemote(chatKey);
    if (!state?.sessionId) return;
    try {
      const line = recoveredLine(state.agentLabel, state.host, this.state.lang(chatKey), interrupted, continuing);
      await to.send(textMessage(line));
    } catch (error) {
      this.ctx.logger.warn("that the remote session is back could not be told", { error: errorName(error) });
    }
  }
}

/** Whether the turn's message still waits for the machine's terminal (for a detach to know). */
function noteWaiting(turn: RemoteTurn | undefined, step: RemoteStep): void {
  if (turn === undefined) return;
  if (step.queued !== null) turn.waitsForTerminal = true;
  else if (step.chunk || step.tool || step.permission || step.finished || step.typed !== null || step.started) {
    turn.waitsForTerminal = false; // (anything of a turn under way: the message is no longer waiting)
  }
}

/** Read through a function: the stream sets it while this waits. */
function cameIn(reading: { readonly came: boolean }): boolean {
  return reading.came;
}

function isOver(fold: RemoteTurnState): boolean {
  return fold.closed !== null || fold.ended;
}

/** A stream that dropped is read again; a refusal that says the session is not readable is not. */
function droppable(error: unknown): boolean {
  if (error instanceof ClawError) return ![401, 403, 404].includes(error.status);
  return isTransport(error);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
