// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What a chat does to the session it is attached to: leave it, switch its mode, close it; and what the status card says of it. */
import { ClawError } from "../claw/errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { remoteText } from "../locales/remote.js";
import type { RemoteState } from "../ports/store/remote.js";
import type { Conversation } from "../ports/surface.js";
import { startsUnattended, withdraws } from "../remote-view/index.js";
import type { StatusPhase } from "../remote-view/status-view.js";
import { neutral } from "../text/neutral.js";
import type { Shown, StatusBoard } from "./board.js";
import type { RemoteContext } from "./context.js";
import type { Provider } from "./ended.js";
import type { AttachHooks } from "./sessions.js";
import type { FollowControl } from "./follow/control.js";
import { type Lists, RemoteOff } from "./lists.js";
import { type Agent, agentById, connectorById } from "./model.js";
import { saidIn } from "./refusals.js";
import { type ChatState, isTransport } from "./state.js";
import type { TurnRunner } from "./turns/runner.js";
import { MODE_ID_MAX } from "./watches.js";

const MODE_ID = /^[\p{L}\p{N}._:-]+$/u;

export class SessionOps {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly lists: Lists,
    private readonly follow: FollowControl,
    private readonly runner: TurnRunner,
    private readonly show: (
      chatKey: string,
      sid: string,
      request: Readonly<Record<string, unknown>>,
      to: Conversation,
    ) => Promise<void>,
  ) {}

  /**
   * What follows an attachment once it is shown. Output after the last `turn_end` is a turn only when this chat sent a prompt that
   * has not ended (the connector never ends what the agent goes on with by itself): that output is the follower's. A permission
   * nobody answered gets its card.
   */
  attachHooks(chatKey: string, key: string, provider: Provider, to: Conversation): AttachHooks {
    return {
      followUp: async ({ sessionId, tail, working, sent }) => {
        if (working && sent) {
          this.ctx.remoteState.setRemoteTurn(chatKey, sessionId, true);
          const state = this.state.attached(chatKey);
          if (state) this.runner.start({ chatKey, key, provider, to, state, replyTo: undefined });
        }
        for (const request of tail.pending) await this.show(chatKey, sessionId, request, to);
        const alone = working && !sent; // (not while a turn is being shown: its end starts the reader)
        this.follow.ensure(chatKey, alone, alone ? tail.steps : [], alone ? tail.asked : []);
      },
    };
  }

  /**
   * Back to the assistant while a turn of this chat's runs (or its message waits for the terminal): the chat stops reading it and
   * nothing is sent to the machine, so a turn running in a terminal goes on there untouched (Stop is what interrupts). A message
   * still waiting for the terminal is taken back where the connector can do that without stopping anything. The sentence for the
   * person ('' when no turn of theirs was running).
   */
  async letGoOfTurn(chatKey: string, key: string, state: RemoteState): Promise<string> {
    const turn = this.state.chats.turns.get(chatKey);
    if (turn === undefined && !state.turnOpen) return "";
    const waiting = turn?.waitsForTerminal ?? false;
    this.runner.cancel(chatKey); // (its reader stops; nothing more of the turn is shown here)
    if (state.sessionId) this.ctx.remoteState.setRemoteTurn(chatKey, state.sessionId, false);
    const words = remoteText.in(this.state.lang(chatKey));
    if (waiting) return (await this.withdraw(key, state)) ? words.leftWithdrawn : words.leftQueued;
    return this.state.typesIntoTerminal(chatKey, state) ? words.leftRunningTerminal : words.leftRunning;
  }

  /** Take back the messages that wait for the session's terminal, where its connector says it can. False when it cannot or did not. */
  private async withdraw(key: string, state: RemoteState): Promise<boolean> {
    if (!withdraws(await this.agentOf(key, state))) return false;
    try {
      await this.ctx.claw.command(key, state.sessionId ?? "", { type: "withdraw" });
    } catch (error) {
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      this.ctx.logger.info("a waiting message could not be taken back");
      return false;
    }
    return true;
  }

  /** The agent (as its machine reports it now) a chat is attached to; null when it cannot be read: what depends on it is not shown. */
  async agentOf(key: string, state: RemoteState): Promise<Agent | null> {
    try {
      const { connectors } = await this.lists.machines(key);
      return agentById(connectorById(connectors, state.connectorId), state.agentId) ?? null;
    } catch (error) {
      if (!(error instanceof RemoteOff) && !(error instanceof ClawError) && !isTransport(error)) throw error;
      this.ctx.logger.info("could not read the agent behind an attached chat");
      return null;
    }
  }

  /**
   * The chat's status card, with a note when the session runs without asking for approval (what the agent's machine reports about
   * its mode, while the session itself has not said).
   */
  async rowCard(
    chatKey: string,
    key: string,
    state: RemoteState,
    lead = "",
    agent?: Agent,
    phase?: StatusPhase,
  ): Promise<Shown> {
    let unattended = state.unattended;
    if (unattended === null) {
      const found = agent ?? (await this.agentOf(key, state));
      unattended = found !== null && startsUnattended(found);
    }
    return this.board.statusOf(chatKey, state, phase ?? this.state.phase(chatKey), lead, unattended);
  }

  /** Why `mode` cannot be asked for on this session, or null when it may be. */
  modeRefusal(chatKey: string, state: RemoteState, mode: string, lang: Lang): string | null {
    const words = remoteAgentText.in("en");
    if (!(mode.length > 0 && mode.length <= MODE_ID_MAX) || !MODE_ID.test(mode)) return words.notAModeId;
    if (state.modes.length > 0 && !state.modes.includes(mode)) {
      const have = state.modes.map((m) => `\`${neutral(m, MODE_ID_MAX)}\``).join(", ");
      return words.notOffered({ mode: neutral(mode, MODE_ID_MAX), have });
    }
    if (this.state.chats.turns.has(chatKey)) return saidIn(lang, "stopFirst");
    return null;
  }

  /**
   * Close session `target` (one of the person's): whether it was, and the sentence (`folder` is named in it when known, and
   * `number`, the number the list showed it under). The session this chat is attached to is left behind with it.
   */
  async close(
    chatKey: string,
    key: string,
    target: string,
    folder = "",
    number = 0,
  ): Promise<{ done: boolean; text: string }> {
    const lang = this.state.lang(chatKey);
    const mine = this.state.attached(chatKey)?.sessionId === target;
    if (mine && this.state.chats.turns.has(chatKey)) return { done: false, text: saidIn(lang, "stopFirst") };
    await this.ctx.claw.command(key, target, { type: "close" });
    if (mine) {
      const watcher = this.state.chats.watchers.get(chatKey);
      this.state.chats.watchers.delete(chatKey);
      watcher?.cancel();
      this.follow.detach(chatKey);
    }
    const words = remoteAgentText.in(lang);
    const where = folder ? words.closedIn({ folder: neutral(folder, 300) }) : "";
    const text =
      (number ? words.closedNumber({ number, where }) : words.closedSession({ where })) +
      (mine ? words.closedBack : "");
    return { done: true, text };
  }
}
