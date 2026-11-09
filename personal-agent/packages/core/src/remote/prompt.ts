// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message for the agent, and `/stop`. A message reads its own turn: the read position is moved to the end of the session's events
 * first (what the agent said on its own before it is the follower's, said first and apart). A session that only watches a
 * terminal's conversation takes no message; one whose turn is still running takes none until it has answered.
 */
import { ClawError } from "../claw/errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import type { RemoteState } from "../ports/store/remote.js";
import { type Conversation, textMessage } from "../ports/surface.js";
import { READ_ONLY_REASONS, readOnlyRefused, sessionTitle, terminalClosedLine } from "../remote-view/index.js";
import type { StatusBoard } from "./board.js";
import type { RemoteTurn } from "./chats.js";
import type { RemoteContext } from "./context.js";
import type { Provider } from "./ended.js";
import type { FollowControl } from "./follow/control.js";
import { failureText, idempotencyKey, saidIn } from "./refusals.js";
import type { SessionStarts } from "./sessions.js";
import { type ChatState, isTransport } from "./state.js";
import type { TurnRunner } from "./turns/runner.js";
import type { Watches } from "./watches.js";
import type { SentFrom } from "./window/view.js";

/** One message for the agent. */
export interface Prompt {
  readonly chatKey: string;
  readonly key: string;
  readonly to: Conversation;
  readonly provider: Provider;
  readonly text: string;
  /** The channel's id of the message (one key per message: a redelivered one queues one prompt). */
  readonly messageId: string;
  /** Where it was typed (`card`: the session card's box); '' works it out (a reply quoting the card, or the chat box). */
  readonly source: SentFrom;
  /** The message replies quoting this chat's session card. */
  readonly quotesWindow: boolean;
}

export class Prompts {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly follow: FollowControl,
    private readonly starts: SessionStarts,
    private readonly runner: TurnRunner,
    private readonly watches: Watches,
  ) {}

  private say(to: Conversation, text: string): Promise<void> {
    return to.send(textMessage(text));
  }

  /** Plain text from a chat that is attached: it is the agent's, not the assistant's. */
  async prompt(p: Prompt): Promise<void> {
    const lang = this.state.lang(p.chatKey);
    const first = this.state.attached(p.chatKey);
    if (first === null) return;
    const source: SentFrom = p.source || (first.window === "card" && p.quotesWindow ? "quote" : "chat");
    if (this.state.watches(p.chatKey, first)) return this.watched(p, first);
    if (this.state.chats.turns.has(p.chatKey)) return this.say(p.to, saidIn(lang, "stillWorking"));
    this.watches.cancel(p.chatKey);
    const followed = await this.follow.stop(p.chatKey); // what the agent said on its own is said first, apart from this turn
    const state = this.state.attached(p.chatKey) ?? first; // (a turn end it read closed an open turn)
    if (state.turnOpen) {
      // a turn this process lost track of (it restarted): show how it ends, answer included
      await this.say(p.to, saidIn(lang, "lostTrack"));
      this.runner.start({
        chatKey: p.chatKey,
        key: p.key,
        provider: p.provider,
        to: p.to,
        state,
        replyTo: p.messageId || undefined,
      });
      return;
    }
    const refused = followed ? null : await this.skipBacklog(p.chatKey, p.key, state);
    if (refused !== null) {
      this.follow.ensure(p.chatKey); // (nothing was sent)
      return this.say(p.to, refused);
    }
    if (await this.state.knownWatch(p.chatKey, p.key, state)) {
      // (one this process had not read back yet: it restarted)
      this.follow.ensure(p.chatKey);
      this.board.touchStatus(p.chatKey, p.to, "watching");
      return this.say(p.to, readOnlyRefused(lang, this.state.offersTakeover(p.chatKey)));
    }
    if (await this.send(p, state)) this.started(p, state, source);
  }

  /** The terminal is using the session: what is typed here is answered, never sent. */
  private async watched(p: Prompt, state: RemoteState): Promise<void> {
    const lang = this.state.lang(p.chatKey);
    if (await this.state.watchOver(p.key, state)) {
      // (its end came while the chat could not be told: muted hours)
      this.follow.detach(p.chatKey);
      return this.say(p.to, terminalClosedLine(lang));
    }
    await this.say(p.to, readOnlyRefused(lang, this.state.offersTakeover(p.chatKey)));
  }

  /** The prompt to Claw; false (and the person told why) when it did not go. */
  private async send(p: Prompt, state: RemoteState): Promise<boolean> {
    const lang = this.state.lang(p.chatKey);
    const sid = state.sessionId ?? "";
    try {
      const keys = {
        sha1Hex: (text: string) => this.ctx.digestHex("sha1", text),
        hexId: () => this.ctx.random.hexId(),
      };
      await this.ctx.claw.command(
        p.key,
        sid,
        { type: "prompt", text: p.text },
        idempotencyKey(keys, p.chatKey, p.messageId),
      );
      this.ctx.sessionNames.titleRemoteSession(sid, sessionTitle(p.text)); // (a new session is named by its first words)
      return true;
    } catch (error) {
      if (error instanceof ClawError && error.status === 409 && READ_ONLY_REASONS.includes(error.code)) {
        // (a watch this process did not know of: it restarted)
        this.state.chats.markReadOnly(p.chatKey, sid, true);
        this.follow.ensure(p.chatKey);
        this.board.touchStatus(p.chatKey, p.to, "watching");
        await this.say(p.to, readOnlyRefused(lang, this.state.offersTakeover(p.chatKey)));
        return false;
      }
      if (error instanceof ClawError && error.status === 409 && error.code === "session_closed") {
        // A session that has ended takes no prompt, and the chat may not have been told: it leaves the session here.
        this.follow.detach(p.chatKey);
        await this.say(p.to, `${this.failure(error, p.chatKey)} ${saidIn(lang, "backToPrimusclaw")}`);
        return false;
      }
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      this.follow.ensure(p.chatKey); // (nothing was sent: no turn will read the session, so the reader goes on)
      await this.say(p.to, error instanceof ClawError ? this.failure(error, p.chatKey) : saidIn(lang, "unreachable"));
      return false;
    }
  }

  private failure(error: ClawError, chatKey: string): string {
    return failureText(error, this.ctx.errors, this.ctx.clock.epochMs() / 1000, this.state.lang(chatKey));
  }

  private started(p: Prompt, state: RemoteState, source: SentFrom): void {
    this.ctx.remoteState.setRemoteTurn(p.chatKey, state.sessionId ?? "", true);
    const view = this.state.view(p.chatKey, state); // (every message that went to the session is what the card says was sent)
    view.sent = p.text;
    view.sentFrom = source;
    view.note = "";
    if (source === "card") view.draft = ""; // (sent: the box is empty again)
    this.runner.start({
      chatKey: p.chatKey,
      key: p.key,
      provider: p.provider,
      to: p.to,
      state,
      replyTo: p.messageId || undefined,
    });
    this.board.touchStatus(p.chatKey, p.to, "working", undefined, true);
  }

  /**
   * Move the read position to the end of the session's events, so a turn reads its own and nothing the agent wrote before. Null
   * when it was moved; otherwise the sentence for the person (the end could not be read, or the session is gone: the chat leaves it).
   */
  private async skipBacklog(chatKey: string, key: string, state: RemoteState): Promise<string | null> {
    const lang = this.state.lang(chatKey);
    const sid = state.sessionId ?? "";
    try {
      const tail = await this.starts.tail(key, sid);
      if (tail.cursor) this.ctx.remoteState.setRemoteCursor(chatKey, sid, tail.cursor);
      return null;
    } catch (error) {
      if (error instanceof ClawError && (error.status === 404 || error.status === 403)) {
        this.ctx.logger.info("the session is gone: the chat leaves it", { status: error.status });
        this.follow.detach(chatKey);
        return saidIn(lang, "sessionGone");
      }
      if (!(error instanceof ClawError) && !isTransport(error) && !(error instanceof SyntaxError)) throw error;
      this.ctx.logger.info("the end of the session's events could not be read before a message");
      return saidIn(lang, "unreachableTail");
    }
  }

  /**
   * `/stop` for a chat that is attached: the agent is told to cancel. False when the chat is not attached. `only`: cancel only while
   * that turn is the one this worker watches, checked with no wait before the cancel goes (a Stop card's turn); false, with nothing
   * said or sent, when it is not.
   */
  async stop(chatKey: string, key: string, to: Conversation, only?: RemoteTurn): Promise<boolean> {
    const state = this.ctx.settings.enabled ? this.state.attached(chatKey) : null;
    if (state === null) return false;
    const lang = this.state.lang(chatKey);
    if (await this.state.knownWatch(chatKey, key, state)) {
      await this.say(to, remoteAgentText.in(lang).stopReadOnly); // the terminal runs it: only the terminal stops it
      return true;
    }
    const turn = this.state.chats.turns.get(chatKey);
    if (only !== undefined && !this.stillOn(chatKey, turn, only)) return false;
    const busy = this.state.chats.followers.get(chatKey)?.busy() ?? false;
    if (turn === undefined && !state.turnOpen && !busy) {
      await this.say(to, saidIn(lang, "nothingRunning"));
      return true;
    }
    if (turn?.stopRequested === true) {
      // asked before and the agent has not ended the turn: stop waiting for it
      this.runner.cancel(chatKey);
      this.closeTurn(chatKey, state);
      await this.say(to, saidIn(lang, "stoppedWatching"));
      return true;
    }
    if (turn) turn.stopRequested = true;
    else this.closeTurn(chatKey, state); // (nothing reads this turn: nothing would ever end it)
    await this.cancel(chatKey, key, state, to);
    return true;
  }

  /** The Stop card's turn is still the one running for the chat, and the chat is still attached. */
  private stillOn(chatKey: string, turn: RemoteTurn | undefined, only: RemoteTurn): boolean {
    return turn === only && turn.task?.running === true && this.ctx.remoteState.attachedRemote(chatKey) !== null;
  }

  private async cancel(chatKey: string, key: string, state: RemoteState, to: Conversation): Promise<void> {
    const lang = this.state.lang(chatKey);
    let out;
    try {
      out = await this.ctx.claw.command(key, state.sessionId ?? "", { type: "cancel" });
    } catch (error) {
      if (error instanceof ClawError) return this.say(to, this.failure(error, chatKey));
      if (isTransport(error)) return this.say(to, saidIn(lang, "unreachable"));
      throw error;
    }
    if (out["connector_online"] === false) {
      this.runner.cancel(chatKey);
      this.closeTurn(chatKey, state);
      return this.say(to, saidIn(lang, "stopQueuedOffline"));
    }
    await this.say(to, saidIn(lang, "stopping"));
  }

  /** A turn nobody reads any more is not open: what the agent says from here on is the follower's. */
  private closeTurn(chatKey: string, state: RemoteState): void {
    this.ctx.remoteState.setRemoteTurn(chatKey, state.sessionId ?? "", false);
    this.follow.ensure(chatKey);
  }
}
