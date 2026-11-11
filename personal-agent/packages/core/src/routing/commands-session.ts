// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawError, ClawUnreachable } from "../claw/errors.js";
import { parseRepo, type RepoPick } from "../commands/repo.js";
import { commandText } from "../locales/commands.js";
import { routingText } from "../locales/routing.js";
import { CREATE_PR_TEXT, sessionText } from "../locales/sessions.js";
import { SESSION_HISTORY_KEEP, SESSION_LIST } from "../ports/store/policy.js";
import type { HistorySession } from "../ports/store/sessions.js";
import type { InboundAction } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { chatTurnKey, type ActiveTurn } from "./turn-registry.js";
import type { TurnStarter } from "./turn-start.js";
import { whenText, zoneOf } from "./time.js";
import { createPrButton, repoButton } from "./views.js";

/**
 * The chat's session (the Python `Agent._cmd_new`, `_cmd_stop`, `_cmd_sessions`, `_cmd_repo`, `_repo_click`, `_bind_repo`,
 * `_create_pr`): start over, stop what runs, go back to an earlier session, start the next one in a repository.
 */
export class SessionCommands {
  constructor(
    private readonly ctx: RouterContext,
    private readonly starter: TurnStarter,
  ) {}

  async new(chat: Chat, scope = ""): Promise<void> {
    const { remote, store } = this.ctx.deps;
    const userId = chat.sender.id;
    if (!scope && remote.attached(userId)) {
      await chat.say(sessionText.in("en").newWhileAttached);
      return;
    }
    const said = routingText.in(chat.lang());
    if (this.ctx.hasTurn(userId, scope)) {
      await chat.say(said.stopFirst);
      return;
    }
    if (!scope) {
      // (the session being left stays reachable through /sessions; a fresh session is a plain one)
      const current = store.sessions.getSession(userId);
      if (current !== null) store.repoHistory.noteSession(userId, current);
      store.repoHistory.clearPendingRepo(userId);
    }
    store.sessions.clearSession(userId, scope);
    await chat.say(said.newSession);
  }

  async stop(chat: Chat, key: string, scope = ""): Promise<void> {
    const { remote, assistant } = this.ctx.deps;
    if (!scope && (await remote.stop(chat.sender, key, chat.conversation))) return; // (an attached agent is the one to stop)
    if (!scope && assistant.on(chat.sender.id)) {
      await assistant.stop(chat.sender.id, key, chat.conversation, undefined, chat.lang()); // (what the assistant does this moment)
      return;
    }
    await this.stopTurn(chat, key, scope);
  }

  /**
   * `/stop` of the turn on the chat's own session (not a remote agent's, not the assistant's). `only`: stop only while that
   * turn is the one running (a Stop card's turn), checked with no wait before the interrupt goes; false when it is not, and
   * nothing was said or stopped. `/stop` (no `only`) also gives up the messages queued behind the running turn, and says so.
   */
  async stopTurn(chat: Chat, key: string, scope = "", only?: ActiveTurn): Promise<boolean> {
    const { store } = this.ctx.deps;
    const turnKey = chatTurnKey(chat.sender.id, scope);
    const [turn] = this.ctx.turns.of(turnKey);
    const sessionId = store.sessions.getSession(chat.sender.id, scope);
    if (only !== undefined && (turn !== only || only.over || sessionId === null)) return false;
    // (before the interrupt: the running turn's end must not hand over to a message being given up)
    const dropped = only === undefined ? this.ctx.turns.withdrawQueued(turnKey) : 0;
    const droppedLine = dropped > 0 ? routingText.in(chat.lang()).queueDropped({ n: dropped }) : "";
    await this.interrupt(chat, key, sessionId, this.ctx.turns.of(turnKey), droppedLine);
    return true;
  }

  private async interrupt(
    chat: Chat,
    key: string,
    sessionId: string | null,
    turns: readonly ActiveTurn[],
    droppedLine: string,
  ): Promise<void> {
    const { claw } = this.ctx.deps;
    const [turn] = turns;
    const said = routingText.in(chat.lang());
    const say = (line: string): Promise<void> => chat.say(line + droppedLine); // (what was given up is said with every answer)
    if (sessionId === null) {
      await say(said.nothingRunning);
      return;
    }
    if (turn !== undefined) turn.stopRequested = true;
    try {
      // With no turn of mine Claw can still be busy on the session (syncing the workspace after an answer): that is the
      // person's to stop as well.
      if (turn === undefined && !(await claw.sessions.turn(key, sessionId)).running) {
        await say(said.nothingRunning);
        return;
      }
      await claw.sessions.interrupt(key, sessionId);
      if (turn !== undefined) turn.stopConfirmed = true;
    } catch (error) {
      if (!(error instanceof ClawError)) throw error;
      const gone = turn === undefined && error.status === 404; // (the session was deleted in the console)
      await say(gone ? said.nothingRunning : sessionText.in(chat.lang()).stopFailed({ status: error.status }));
      return;
    }
    if (turn === undefined) await say(sessionText.in(chat.lang()).busyStopped);
    else await say(said.stopping);
  }

  /**
   * The five sessions this chat used last, a card each with Show here. No session is shown on the worker's word alone: each
   * is read from Claw with the person's credential, which answers only for their own; one gone or not theirs is forgotten.
   */
  async sessions(chat: Chat, key: string): Promise<void> {
    const { store } = this.ctx.deps;
    const userId = chat.sender.id;
    const current = store.sessions.getSession(userId);
    if (current !== null) store.repoHistory.noteSession(userId, current); // (one from before the list existed)
    const { shown, unreachable } = await this.readable(userId, key);
    const said = routingText.in(chat.lang());
    if (shown.length === 0) {
      await chat.say(unreachable > 0 ? said.sessionsUnreachable : said.noSessions);
      return;
    }
    const zone = zoneOf(store.prefs.getPrefs(userId).timezone);
    const now = store.now();
    const lang = chat.lang();
    await chat.say(said.sessionsLead);
    for (const row of shown) {
      await chat.send(
        this.ctx.views.session({
          sessionId: row.sessionId,
          title: row.title,
          repo: row.repo,
          branch: row.branch,
          when: whenText(row.lastAt, now, zone, lang),
          current: row.sessionId === current,
          lang,
        }),
      );
    }
  }

  private async readable(userId: string, key: string): Promise<{ shown: HistorySession[]; unreachable: number }> {
    const { store, claw } = this.ctx.deps;
    const shown: HistorySession[] = [];
    let unreachable = 0;
    for (const row of store.repoHistory.sessionHistory(userId, SESSION_HISTORY_KEEP)) {
      if (shown.length === SESSION_LIST) break;
      try {
        await claw.sessions.turn(key, row.sessionId);
        shown.push(row);
      } catch (error) {
        if (error instanceof ClawError && (error.status === 403 || error.status === 404)) {
          store.repoHistory.forgetSession(userId, row.sessionId);
        } else if (error instanceof ClawError || error instanceof ClawUnreachable) {
          unreachable += 1;
        } else {
          throw error;
        }
      }
    }
    return { shown, unreachable };
  }

  /** `/repo owner/name [branch]`, or `/repo` alone for the five picked last (each with a button). */
  async repo(chat: Chat, arg: string): Promise<void> {
    const said = sessionText.in(chat.lang());
    const usage = commandText.in(chat.lang()).repoUsage;
    if (arg === "") {
      const recent = this.ctx.deps.store.repoHistory.recentRepos(chat.sender.id);
      if (recent.length === 0) {
        await chat.say(said.noRepoYet({ usage }));
        return;
      }
      await chat.say(said.tapRepo);
      for (const { repo, branch } of recent) await chat.send(this.ctx.views.repo(repo, branch, chat.lang()));
      return;
    }
    const pick = parseRepo(arg);
    if (pick === null) {
      await chat.say(said.notARepo({ usage }));
      return;
    }
    if (this.ctx.hasTurn(chat.sender.id)) {
      await chat.say(said.repoStopFirst);
      return;
    }
    this.bindRepo(chat.sender.id, pick);
    await chat.say(said.repoReady(pick));
  }

  /** A tap on a repository card. The card is not trusted: its text is read like typed text. */
  async repoClick(action: InboundAction, chat: Chat): Promise<void> {
    const said = sessionText.in(chat.lang());
    const pick = parseRepo(`${stringOf(action.data["repo"])} ${stringOf(action.data["branch"])}`);
    if (pick === null) {
      await this.ctx.settle(action, chat, said.repoButtonGone);
    } else if (this.ctx.hasTurn(chat.sender.id)) {
      const text = said.repoClickStopFirst;
      const card = this.ctx.views.note(text, { buttons: [repoButton(pick.repo, pick.branch, chat.lang())] });
      await this.ctx.settle(action, chat, card, { fallback: text });
    } else {
      this.bindRepo(chat.sender.id, pick);
      await this.ctx.settle(action, chat, said.repoReady(pick).replaceAll("**", ""));
    }
  }

  /** The next message starts a new session bound to `pick`; the session in use stays on the /sessions list. */
  private bindRepo(userId: string, pick: RepoPick): void {
    const { store } = this.ctx.deps;
    const current = store.sessions.getSession(userId);
    if (current !== null) store.repoHistory.noteSession(userId, current);
    store.sessions.clearSession(userId);
    store.repoHistory.setPendingRepo(userId, pick);
    store.repoHistory.touchRecentRepo(userId, pick);
  }

  /**
   * Create PR under a changes card: the agent is asked, in this chat's session, to open a pull request. The card is not
   * trusted: its session must be the chat's current one, and the ask is an ordinary message (held for approval as any).
   */
  async createPr(action: InboundAction, chat: Chat, key: string): Promise<void> {
    const { store, config } = this.ctx.deps;
    const said = sessionText.in("en");
    const sessionId = stringOf(action.data["session_id"]);
    if (!sessionId || sessionId !== store.sessions.getSession(chat.sender.id)) {
      await this.ctx.settle(action, chat, said.createPrOther);
    } else if (Boolean(store.sessions.getSessionPlugin(chat.sender.id)) !== Boolean(config.pluginId)) {
      await this.ctx.settle(action, chat, said.createPrStale); // (a new session would be started: not a button's to do)
    } else if (this.ctx.hasTurn(chat.sender.id)) {
      const text = said.createPrBusy;
      const card = this.ctx.views.note(text, {
        buttons: [createPrButton(sessionId)],
      });
      await this.ctx.settle(action, chat, card, { fallback: text });
    } else {
      await this.ctx.settle(action, chat, said.createPrAsking);
      await this.starter.start({
        chat,
        credential: key,
        text: CREATE_PR_TEXT,
        messageId: action.id,
        clientPlatform: action.clientPlatform,
      });
    }
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
