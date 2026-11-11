// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message for the agent, and `/stop`. A message reads its own turn: the read position is moved to the end of the session's events
 * first (what the agent said on its own before it is the follower's, said first and apart). A session that only watches a
 * terminal's conversation takes no message. A message sent while the chat's turn still runs goes to the session at once and waits
 * there behind that turn, as Claude Code queues what is typed while it works: the person is told it is queued, and its turn is read
 * right after the one in front (`TurnRunner`). `/stop` stops the running turn and gives up the messages waiting behind it (the
 * machine drops them too).
 */
import { ClawError } from "../claw/errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import type { RemoteState } from "../ports/store/remote.js";
import { type Conversation, textMessage } from "../ports/surface.js";
import { READ_ONLY_REASONS, readOnlyRefused, sessionTitle, terminalClosedLine } from "./lines.js";
import type { StatusBoard } from "./board.js";
import type { RemoteContext } from "./context.js";
import type { Provider } from "./ended.js";
import type { FollowControl } from "./follow/control.js";
import { failureText, idempotencyKey, saidIn } from "./refusals.js";
import type { SessionStarts } from "./sessions.js";
import { QUEUED_PROMPTS_MAX, type QueuedPrompt, type RemoteTurn } from "./chats.js";
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
    if (this.state.chats.turns.has(p.chatKey)) return this.queueBehind(p, first, source);
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
    const sent = await this.send(p, state);
    if (sent) this.started(p, state, source, sent.cmdSeq);
  }

  /**
   * A message while the chat's turn runs: sent to the session now (Claw keeps it in order; the machine runs it once the turn in
   * front has ended), and its turn is read after that one. It is put in the queue before it is sent: the turn in front may end
   * while the send is on its way, and its turn must be read from where that one ended, not by the follower. Refused only past what
   * the machine queues.
   */
  private async queueBehind(p: Prompt, state: RemoteState, source: SentFrom): Promise<void> {
    const text = remoteAgentText.in(this.state.lang(p.chatKey));
    const waiting = this.state.chats.queuedCount(p.chatKey);
    if (waiting >= QUEUED_PROMPTS_MAX) return this.say(p.to, text.queueFull({ n: QUEUED_PROMPTS_MAX }));
    const sid = state.sessionId;
    let cmdSeq: number | undefined = undefined; // (Claw's number of it, once the send has answered)
    let reader: RemoteTurn | undefined;
    const queued: QueuedPrompt = {
      get cmdSeq() {
        return cmdSeq;
      },
      start: () => {
        const now = this.state.attached(p.chatKey);
        if (now?.sessionId !== sid) return false; // (the chat left that session meanwhile)
        this.started(p, now, source, cmdSeq);
        reader = this.state.chats.turns.get(p.chatKey);
        return true;
      },
    };
    this.state.chats.enqueue(p.chatKey, queued);
    const sent = await this.send(p, state);
    if (!sent) {
      // (not sent: it waits no more, and a reader started for it meanwhile would wait for a turn that never comes)
      if (
        !this.state.chats.removeQueued(p.chatKey, queued) &&
        reader &&
        this.state.chats.turns.get(p.chatKey) === reader
      ) {
        this.runner.cancel(p.chatKey);
        this.closeTurn(p.chatKey, state);
      }
      return;
    }
    cmdSeq = sent.cmdSeq;
    if (reader) return; // (the turn in front ended while it was sent: its own turn is read already)
    if (!this.state.chats.isQueued(p.chatKey, queued)) return; // (a /stop or a detach meanwhile gave it up, and said so)
    if (source === "card") this.state.view(p.chatKey, state).draft = ""; // (taken: the card's box is empty again)
    await this.say(p.to, text.queuedBehind({ n: waiting + 1 }));
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

  /** The prompt to Claw, with Claw's number of it; false (and the person told why) when it did not go. */
  private async send(p: Prompt, state: RemoteState): Promise<{ readonly cmdSeq: number | undefined } | false> {
    const lang = this.state.lang(p.chatKey);
    const sid = state.sessionId ?? "";
    try {
      const keys = {
        sha1Hex: (text: string) => this.ctx.digestHex("sha1", text),
        hexId: () => this.ctx.random.hexId(),
      };
      const out = await this.ctx.claw.command(
        p.key,
        sid,
        { type: "prompt", text: p.text },
        idempotencyKey(keys, p.chatKey, p.messageId),
      );
      this.ctx.sessionNames.titleRemoteSession(sid, sessionTitle(p.text)); // (a new session is named by its first words)
      const seq = out["cmd_seq"];
      return { cmdSeq: typeof seq === "number" && Number.isSafeInteger(seq) ? seq : undefined };
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

  private started(p: Prompt, state: RemoteState, source: SentFrom, cmdSeq?: number): void {
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
      cmdSeq,
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
      // asked before and the agent has not ended the turn: stop waiting for it (and for what waits behind it)
      const dropped = this.state.chats.dropQueued(chatKey);
      this.runner.cancel(chatKey);
      this.closeTurn(chatKey, state);
      await this.say(to, saidIn(lang, "stoppedWatching") + this.droppedLine(chatKey, dropped));
      return true;
    }
    if (turn) turn.stopRequested = true;
    else this.closeTurn(chatKey, state); // (nothing reads this turn: nothing would ever end it)
    await this.cancel(chatKey, key, state, to);
    return true;
  }

  /** The Stop card's turn is still the one running for the chat, and the chat is still attached. */
  private stillOn(chatKey: string, turn: RemoteTurn | undefined, only: RemoteTurn): boolean {
    return turn === only && !turn.ended && this.ctx.remoteState.attachedRemote(chatKey) !== null;
  }

  /** What a stop says of the messages it gave up ("" none). */
  private droppedLine(chatKey: string, dropped: number): string {
    return dropped > 0 ? remoteAgentText.in(this.state.lang(chatKey)).queueDropped({ n: dropped }) : "";
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
    // (the machine drops what waits behind the turn it stops: those messages are given up here too, and the person is told)
    const dropped = this.state.chats.dropQueued(chatKey);
    if (out["connector_online"] === false) {
      this.runner.cancel(chatKey);
      this.closeTurn(chatKey, state);
      return this.say(to, saidIn(lang, "stopQueuedOffline") + this.droppedLine(chatKey, dropped));
    }
    await this.say(to, saidIn(lang, "stopping") + this.droppedLine(chatKey, dropped));
  }

  /** A turn nobody reads any more is not open: what the agent says from here on is the follower's. */
  private closeTurn(chatKey: string, state: RemoteState): void {
    this.ctx.remoteState.setRemoteTurn(chatKey, state.sessionId ?? "", false);
    this.follow.ensure(chatKey);
  }
}
