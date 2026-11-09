// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the follower says what the agent said on its own: the text that waits (folded event by event), when it is due, and how it
 * reaches the chat: into the session card when the chat shows one, else as messages, held in quiet hours or a pause. The cursor
 * it lets the reader write never passes text that has not been delivered.
 */
import {
  OWN_SUFFIX,
  TYPED_SUFFIX,
  agentHead,
  agentReplies,
  continuedHead,
  guardHeads,
  signed,
} from "../../direct-chat/direct-chat.js";
import type { SseEvent } from "../../claw/model.js";
import { errorName } from "../../errors.js";
import type { JsonObject } from "../../json.js";
import type { Lang } from "../../locales/lang.js";
import { remoteAgentText } from "../../locales/remote-agents.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { ConversationRefRepository } from "../../ports/store/people.js";
import type { RemoteState, RemoteStateRepository } from "../../ports/store/remote.js";
import { type Conversation, type OutMessage, richMessage, textMessage } from "../../ports/surface.js";
import {
  type RemoteStep,
  type RemoteTurnState,
  TERMINAL_CLOSED,
  answerParts,
  recoveredLine,
  terminalClosedLine,
  typedLine,
  unsolicitedParts,
} from "../../remote-view/index.js";
import { bareReason } from "../connector/reasons.js";
import { RETRY_MS, type FollowTimings } from "./timings.js";

/** Whether a person may be woken now, and where what they may not be told yet is held (`proactive`). */
export interface FollowReach {
  reachable(chatKey: string): boolean;
  /** "paused" when the person paused proactive messages (`/pause`); anything else is not a pause. */
  muted(chatKey: string): string | null;
  holdRemote(chatKey: string, label: string, text: string): void;
}

/** What the speaker needs: where to say it, whether it may, and how. */
export interface SpeakerDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timings: FollowTimings;
  readonly reach: FollowReach;
  readonly remoteState: RemoteStateRepository;
  readonly references: ConversationRefRepository;
  /** The conversation a stored reference posts to. */
  conversationFor(reference: JsonObject): Conversation;
  showPermission(
    chatKey: string,
    sessionId: string,
    request: Readonly<Record<string, unknown>>,
    to: Conversation,
  ): Promise<void>;
  lang(): Lang;
  /** The chat is the agent's window itself (`direct-chat`): what the agent says is signed with its head. */
  direct(): boolean;
  /** The paragraph that says the session ended and why (the reason a connector gave). */
  describeEnd?: (reason: string) => Promise<string>;
  /** The chat's session card, when it is the window: the text so far (`final` false) or the burst (`final` true); false when
   * the chat shows no window. */
  window?: (text: string, final: boolean) => Promise<boolean>;
  /** The card is told once what the burst came to has been taken in. */
  windowSettled?: () => Promise<void>;
}

/** When the text that waits is due, from what the reader knows. */
export interface DueContext {
  readonly lastEvent: number;
  /** A step this reader saw begin, or a permission request, is open. */
  readonly busy: boolean;
  readonly now: number;
}

export class BurstSpeaker {
  /** The read position before which no text waits: what may be written as the cursor. */
  safe = "";
  private pendingSince: number | null = null; // when the text that waits began
  private lastPush: number | null = null;
  private retryAt = 0;
  private sent: string[] = []; // the parts of the text that waits that were delivered (a failure sends on from there)
  private typedTurn = false; // the text that waits answers a prompt typed at the shared terminal
  private settle = false;

  constructor(
    private readonly chatKey: string,
    private readonly sessionId: string,
    private readonly deps: SpeakerDeps,
    private readonly turn: RemoteTurnState,
  ) {}

  /** Text of the agent's is waiting to be said. */
  get waiting(): boolean {
    return this.turn.answer !== "";
  }

  feed(event: SseEvent): RemoteStep {
    return this.turn.feed(event);
  }

  settleAt(cursor: string): void {
    this.safe = cursor;
  }

  /** Milliseconds until the text that waits is due, 0 when it is, null when none waits (then only an event can matter). */
  dueInMs(at: DueContext): number | null {
    if (!this.turn.answer || this.pendingSince === null) return null;
    const t = this.deps.timings;
    let due = Math.min(at.lastEvent + (at.busy ? t.toolQuietMs : t.quietMs), this.pendingSince + t.maxAgeMs);
    if (this.lastPush !== null) due = Math.max(due, this.lastPush + t.gapMs);
    return Math.max(0, Math.max(due, this.retryAt) - at.now);
  }

  /** A message chunk: the burst began now, and the session card shows the text so far. */
  async noteText(step: RemoteStep, now: number): Promise<void> {
    if (step.chunk?.kind !== "message" || !this.turn.answer) return;
    this.pendingSince ??= now;
    if (this.deps.window === undefined || !this.mayWake()) return;
    try {
      await this.deps.window(this.turn.answer, false); // (an edit, never a message; the burst is delivered when it is over)
    } catch (error) {
      this.deps.logger.info("the session card could not show the agent's text", { error: errorName(error) });
    }
  }

  /**
   * Say the text that waits (held in quiet hours or a pause, unless `force`), and move the safe position to `cursor`. When it
   * cannot be sent: tried again after a while, or (`holdOnFailure`, for a reader being stopped) held for the sweep. True when the
   * safe position moved (the caller writes it).
   */
  async flush(how: { readonly force: boolean; readonly holdOnFailure: boolean }, cursor: string): Promise<boolean> {
    const text = this.turn.answer;
    if (text) {
      if (!(await this.say(text, how.force))) {
        if (!how.holdOnFailure) {
          this.retryAt = this.deps.clock.monotonicMs() + RETRY_MS;
          return false;
        }
        this.hold(text);
      }
      this.lastPush = this.deps.clock.monotonicMs();
      this.typedTurn = false; // (said: what comes after it is the agent's own again)
    }
    this.forget(cursor);
    return true;
  }

  /**
   * The reader was cancelled because it did not stop in time, so a send of its was cut off: what it was saying is held for the
   * sweep (at least once, never lost), and the read position moves past it. The safe position, for the caller to write.
   */
  abandon(cursor: string): string {
    const text = this.turn.answer;
    if (text) this.hold(text);
    this.forget(cursor);
    return this.safe;
  }

  private forget(cursor: string): void {
    this.turn.takeAnswer();
    this.sent = [];
    this.pendingSince = null;
    this.safe = cursor;
  }

  private mayWake(): boolean {
    return this.deps.reach.reachable(this.chatKey);
  }

  /** Deliver `text`; false when it could not be sent (it is kept and tried again). `force` lifts quiet hours, never a pause. */
  private async say(text: string, force: boolean): Promise<boolean> {
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    const reference = this.deps.references.getReference(this.chatKey);
    if (state === null || reference === null) return true; // nobody to tell
    if (this.deps.reach.muted(this.chatKey) === "paused" || (!force && !this.mayWake())) {
      this.hold(text);
      return true;
    }
    const shown = await this.intoWindow(text);
    if (shown !== null) return shown;
    const lang = this.langOr("en");
    const raw = answerParts(text);
    const messages = this.messages(state, text, raw, lang);
    const to = this.deps.conversationFor(reference);
    try {
      for (let i = this.delivered(raw); i < messages.length; i += 1) {
        await to.send(messages[i] ?? textMessage(""));
        this.sent = raw.slice(0, i + 1);
      }
    } catch (error) {
      this.deps.logger.warn("what the remote agent said on its own could not be sent; trying again", {
        error: errorName(error),
      });
      return false;
    }
    return true;
  }

  /** The burst into the session card when it is the window: true shown, false failed, null no window. */
  private async intoWindow(text: string): Promise<boolean | null> {
    if (this.deps.window === undefined) return null;
    try {
      if (!(await this.deps.window(text, true))) return null;
    } catch (error) {
      this.deps.logger.warn("what the remote agent said on its own could not be shown on its card; trying again", {
        error: errorName(error),
      });
      return false;
    }
    this.settle = true; // (the card is refreshed once the reader has let go of the text)
    return true;
  }

  /** One message per part: headed with who said it, or signed with the agent's head in a chat that is its window. */
  private messages(state: RemoteState, text: string, raw: readonly string[], lang: Lang): OutMessage[] {
    const direct = this.signed();
    const parts = direct
      ? raw.map((part, i) =>
          signed(
            i === 0
              ? agentHead(state.agentLabel, state.host) + (this.typedTurn ? TYPED_SUFFIX : OWN_SUFFIX)[lang]
              : continuedHead(state.agentLabel, i + 1, raw.length, lang),
            guardHeads(part),
          ),
        )
      : unsolicitedParts(`${state.agentLabel} on ${state.host}`, text, lang, this.typedTurn);
    return parts.map((part, i) => {
      const message = richMessage(part, { lead: false, aiGenerated: true }); // (what the coding agent wrote)
      if (!direct || i !== parts.length - 1) return message;
      return { ...message, suggestions: agentReplies(lang).map(([title, value]) => ({ title, value })) };
    });
  }

  private signed(): boolean {
    try {
      return this.deps.direct();
    } catch {
      return false;
    }
  }

  private langOr(fallback: Lang): Lang {
    try {
      return this.deps.lang();
    } catch {
      return fallback; // (the head in English is still a head)
    }
  }

  /** How many leading parts of `raw` were delivered already. */
  private delivered(raw: readonly string[]): number {
    let n = 0;
    while (n < raw.length && n < this.sent.length && raw[n] === this.sent[n]) n += 1;
    return n;
  }

  /** Hold what has not been delivered of `text` for the sweep. */
  private hold(text: string): void {
    const raw = answerParts(text);
    const rest = raw.slice(this.delivered(raw)).join("\n\n");
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    if (rest && state !== null) this.deps.reach.holdRemote(this.chatKey, `${state.agentLabel} on ${state.host}`, rest);
  }

  async settleWindow(): Promise<void> {
    if (!this.settle || this.deps.windowSettled === undefined) return;
    this.settle = false;
    try {
      await this.deps.windowSettled();
    } catch (error) {
      this.deps.logger.info("the session card could not be refreshed after the agent's text", {
        error: errorName(error),
      });
    }
  }

  /** A permission request gets its card at once, and none while the person may not be woken. */
  async ask(request: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.mayWake()) {
      this.deps.logger.info("a remote agent asked for permission while the person may not be woken: no card");
      return;
    }
    const reference = this.deps.references.getReference(this.chatKey);
    if (reference === null) return;
    try {
      await this.deps.showPermission(this.chatKey, this.sessionId, request, this.deps.conversationFor(reference));
    } catch (error) {
      this.deps.logger.warn("the permission card of a remote agent could not be shown", { error: errorName(error) });
    }
  }

  /** A prompt typed at the terminal the chat shares: one message, so the reply that follows reads as its answer. */
  async typed(text: string): Promise<void> {
    const to = this.reachable(true);
    if (to !== null) {
      // (the reply is held and says what it answers; a held echo of the question alone helps nobody)
      await this.tell(
        to,
        richMessage(typedLine(text, this.langOr("en"))),
        "a prompt typed at the terminal could not be shown",
      );
    }
    this.typedTurn = true; // (what the agent says next answers it, until that is said)
  }

  /** The connector restarted and this session is back: one line, never to wake anyone. */
  async recovered(interrupted: boolean, continuing: boolean): Promise<void> {
    const to = this.reachable(false);
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    if (to === null || state === null) return;
    const line = recoveredLine(state.agentLabel, state.host, this.langOr("en"), interrupted, continuing);
    await this.tell(to, textMessage(line), "that the remote session is back could not be told");
  }

  /**
   * The session ended while the chat was idle: say so and send the chat's messages to the assistant again. Nothing is said, and
   * nothing changed, for a person who may not be woken: their next message is told that the session has ended.
   */
  async ended(reason: string): Promise<void> {
    if (!this.mayWake()) return;
    const reference = this.deps.references.getReference(this.chatKey);
    if (reference === null) return;
    this.deps.remoteState.detachRemote(this.chatKey);
    const bare = bareReason(reason);
    let text = remoteAgentText.in("en").endedWhileIdle({ reason: bare });
    if (bare === TERMINAL_CLOSED) text = terminalClosedLine(this.langOr("en"));
    else if (this.deps.describeEnd !== undefined) {
      try {
        text = await this.deps.describeEnd(bare);
      } catch (error) {
        this.deps.logger.warn("the end of a remote session could not be described", { error: errorName(error) });
      }
    }
    await this.tell(
      this.deps.conversationFor(reference),
      textMessage(text),
      "the end of a remote session could not be told",
    );
  }

  /** The chat to tell now, or null: nobody to tell, or (`unlessPaused`: also a pause) the person may not be woken. */
  private reachable(unlessPaused: boolean): Conversation | null {
    const state = this.deps.remoteState.attachedRemote(this.chatKey);
    const reference = this.deps.references.getReference(this.chatKey);
    if (state === null || reference === null) return null;
    if (unlessPaused && this.deps.reach.muted(this.chatKey) === "paused") return null;
    return this.mayWake() ? this.deps.conversationFor(reference) : null;
  }

  private async tell(to: Conversation, message: OutMessage, failed: string): Promise<void> {
    try {
      await to.send(message);
    } catch (error) {
      this.deps.logger.warn(failed, { error: errorName(error) });
    }
  }
}
