// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Taps on the buttons of the agents card, the sessions card and the chat's status card (`{"primusclaw": "remote", "op": ...}`).
 * A card is not trusted: what it names (an agent, a folder, a session, a mode) is looked up again in the person's own lists from
 * Claw or in this process's own state, and what is not there is refused. Every tap ends by replacing the card that was tapped:
 * with the list again when the tap was about the list (its first line says what it did), with the status card when it was about
 * the session the chat is attached to. A list card is posted anew and the tapped one deleted (a phone does not redraw an edit).
 */
import { leftLine } from "../direct-chat/direct-chat.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import type { RemoteState } from "../ports/store/remote.js";
import { type Conversation, type OutMessage, richMessage } from "../ports/surface.js";
import { backLine } from "./lines.js";
import { breakLinks } from "./inert.js";
import { DROPPED_BY_RICH_TEXT } from "./links/answer.js";
import { neutral } from "../text/neutral.js";
import { cpSlice, pyStrip } from "../text/py-text.js";
import { own } from "../own.js";
import { type AgentCommands, type CommandParts, refusalOf } from "./commands.js";
import { connectMarkdown } from "./connector/setup.js";
import type { Provider } from "./ended.js";
import { textOf } from "./fields.js";
import type { Settle } from "./permissions.js";
import type { Prompts } from "./prompt.js";
import { saidIn } from "./refusals.js";
import { type Tap, windowCloser } from "./window/closer.js";
import { INPUT_ID, INPUT_MAX, fullParts } from "./window/index.js";
import { MODE_ID_MAX } from "./watches.js";

/** One tap: who, with which credential, on which card, and how it ends. */
export interface Click extends Tap {
  readonly key: string;
  readonly provider: Provider;
  /** The channel's id of the tap (a Send's idempotency). */
  readonly id: string;
  readonly settle: Settle;
}

/** The ops a tap may name; anything else is refused. */
export const CLICK_OPS = [
  "new",
  "attach",
  "detach",
  "close",
  "mode",
  "set_mode",
  "row",
  "list",
  "switch",
  "stop",
  "takeover",
  "send",
  "full",
  "pair",
  "hide",
  "hidden",
  "unhide",
] as const;
export type ClickOp = (typeof CLICK_OPS)[number];

export function isClickOp(op: string): op is ClickOp {
  return (CLICK_OPS as readonly string[]).includes(op);
}

/** The taps that only show something or act on the attached session. */
export class SessionClicks {
  constructor(
    private readonly p: CommandParts,
    private readonly commands: AgentCommands,
    private readonly prompts: Prompts,
  ) {}

  lang(click: Click): Lang {
    return this.p.state.lang(click.chatKey);
  }

  end(click: Click, card: OutMessage | string, fallback?: string, announce = true): Promise<boolean> {
    return click.settle(card, { ...(fallback ? { fallback } : {}), announce });
  }

  /** End a tap with the card it came from again (the sessions card, or the agents card), `lead` on top. */
  async home(click: Click, lead: string): Promise<void> {
    let view: OutMessage | string;
    try {
      if (click.data["view"] === "sessions")
        view = await this.p.lists.sessionsView(click.chatKey, click.key, this.lang(click), lead);
      else {
        const answer = await this.p.lists.agentsView(click.chatKey, click.key, this.lang(click), lead);
        view = answer.kind === "card" ? answer.message : answer.text;
      }
    } catch (error) {
      if (refusalOf(error, this.p.ctx, this.lang(click)) === null) throw error;
      await this.end(click, lead);
      return;
    }
    if (typeof view === "string") await this.end(click, view, lead);
    else await this.repost(click, view, lead);
  }

  /**
   * A tap on the agents card (or the sessions card) that leaves the chat where it is ends with that card again, sent as a NEW
   * message and the tapped one deleted (or closed down to a line pointing at the new one). The chat's status card is never deleted
   * here: a tap that ends on the list from it is answered in place, and so is any tap whose new card could not be sent.
   */
  async repost(click: Click, card: OutMessage, lead = ""): Promise<void> {
    const stored = this.p.ctx.remoteState.getRemote(click.chatKey);
    if (click.tapped && stored?.statusCard === click.tapped) {
      await this.end(click, card, lead || undefined);
      return;
    }
    let posted: string | undefined;
    try {
      posted = await click.to.post(card);
    } catch (error) {
      this.p.ctx.logger.warn(
        "the refreshed list could not be sent as a new message; replacing the tapped card instead",
        {
          error: errorName(error),
        },
      );
    }
    if (!posted) {
      await this.end(click, card, lead || undefined);
      return;
    }
    if (!click.tapped) return; // (a click that came as a message: there is no card to take away)
    click.to.markSettled(click.tapped); // (settled: nothing may edit a message that is gone)
    if (!(await this.deleted(click.to, click.tapped)))
      await this.end(click, remoteAgentText.in(this.lang(click)).listBelow, undefined, false);
  }

  async deleted(to: Conversation, id: string): Promise<boolean> {
    try {
      return (await to.delete(id)).ok;
    } catch (error) {
      this.p.ctx.logger.info("the tapped card could not be deleted; closing it down to a line", {
        error: errorName(error),
      });
      return false;
    }
  }

  /** A tap that did not go through: the status card again when it was one of its buttons and still the chat's, else the list. */
  async back(click: Click, lead: string): Promise<void> {
    const state = this.p.state.attached(click.chatKey);
    const op = textOf(click.data["op"]);
    if (
      state !== null &&
      ["detach", "mode", "set_mode", "row", "stop"].includes(op) &&
      state.sessionId === click.data["session_id"]
    ) {
      await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state, lead)).message, lead);
      return;
    }
    await this.home(click, lead);
  }

  /** The chat's attachment when the tap is about it (the card names the session); else the tap is answered and null. */
  async ownSession(click: Click): Promise<RemoteState | null> {
    const state = this.p.state.attached(click.chatKey);
    const words = remoteAgentText.in(this.lang(click));
    if (state === null) await this.home(click, words.notAttachedCard);
    else if (state.sessionId !== click.data["session_id"]) await this.home(click, words.otherSessionCard);
    else return state;
    return null;
  }

  /** Connect a new machine: the command as a message of its own, then the agents card again under it, pointing up to it. */
  async pair(click: Click): Promise<void> {
    const lang = this.lang(click);
    const words = remoteAgentText.in(lang);
    const head = words.pairHead;
    const text = await this.p.lists.pairView(click.key, lang, head);
    await click.to.send(richMessage(text ?? connectMarkdown((await this.p.lists.setup(click.key)).setup, lang, head)));
    const lead = head + words.pairAbove;
    let answer;
    try {
      answer = await this.p.lists.agentsView(click.chatKey, click.key, lang, lead);
    } catch (error) {
      if (refusalOf(error, this.p.ctx, lang) === null) throw error;
      await this.end(click, lead, undefined, false);
      return;
    }
    if (answer.kind === "card") await this.repost(click, answer.message, lead);
    else await this.end(click, lead, undefined, false); // (no machine any more: the message above is the whole answer)
  }

  async row(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state) await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state)).message);
  }

  /** Switch (and Sessions, Refresh): the card that was tapped becomes the list of every session, with no line in the chat. */
  async switch(click: Click): Promise<void> {
    await this.end(
      click,
      await this.p.lists.sessionsView(click.chatKey, click.key, this.lang(click)),
      undefined,
      false,
    );
  }

  async stop(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state)).message, undefined, false);
    await this.prompts.stop(click.chatKey, click.key, click.to); // (says what it did in one line, as `/stop` does)
  }

  private closer(click: Click): Settle {
    return windowCloser(this.p.ctx, this.p.state, this.p.board, click, click.settle);
  }

  /** Send on the session card: the card's text box goes to the session; the tap ends at once with the window showing it. */
  async send(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    const text = cpSlice(pyStrip(textOf(own(click.data, INPUT_ID))), 0, INPUT_MAX); // (Python's str.strip()[:INPUT_MAX])
    const view = this.p.state.view(click.chatKey, state);
    if (!text) {
      await this.closer(click)(remoteAgentText.in(this.lang(click)).emptySend); // (the card again, at the bottom)
      return;
    }
    // (the words stay in the box until the session has them: a refusal leaves them there to send again)
    view.draft = text;
    view.note = "";
    await this.closer(click)("", { announce: false });
    await this.prompts.prompt({
      chatKey: click.chatKey,
      key: click.key,
      to: click.to,
      provider: click.provider,
      text,
      messageId: click.id,
      source: "card",
      quotesWindow: false,
    });
  }

  /** Full output: the output the window holds, whole (masked), as messages after the card. */
  async full(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    const lang = this.lang(click);
    const words = remoteAgentText.in(lang);
    const parts = fullParts(this.p.state.view(click.chatKey, state).text);
    if (parts.length === 0) {
      await this.closer(click)(words.noOutputYet); // (said as a message too)
      return;
    }
    await this.closer(click)("", { announce: false });
    for (const [i, part] of parts.entries()) {
      const head = words.fullOutputHead({ i: i + 1, n: parts.length, label: state.agentLabel, host: state.host });
      const block = "```\n" + fullBlockText(part) + "\n```";
      await click.to.send(richMessage(`${neutral(head, 160)}\n\n${block}`, { aiGenerated: true }));
    }
  }

  async mode(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    const lang = this.lang(click);
    if (state.modes.length === 0) {
      const text = saidIn(lang, "modesUnknown");
      await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state, text)).message, text);
      return;
    }
    const flagged = new Set(Object.entries(state.modeFlags).flatMap(([m, flag]) => (flag ? [m] : []))); // (the session's own say)
    await this.end(click, this.p.ctx.views.mode(state.sessionId ?? "", state.mode, state.modes, flagged, lang));
  }

  async setMode(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    const mode = textOf(click.data["mode"]);
    const refusal = await this.commands.changeMode(click, mode);
    const lead = refusal ?? remoteAgentText.in(this.lang(click)).askingSwitch({ mode: neutral(mode, MODE_ID_MAX) });
    await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state, lead)).message, lead);
  }

  async detach(click: Click): Promise<void> {
    const state = await this.ownSession(click);
    if (state === null) return;
    const left = await this.p.ops.letGoOfTurn(click.chatKey, click.key, state);
    this.p.watches.cancel(click.chatKey);
    this.p.follow.detach(click.chatKey);
    const lang = this.lang(click);
    const before = this.p.ctx.remoteState.getRemote(click.chatKey);
    if (before?.statusCard && before.statusCard !== click.tapped) {
      await this.p.board.editStatus(click.chatKey, click.to, this.p.board.statusOf(click.chatKey, state, "detached"));
    }
    await this.p.board.dropKept(click.chatKey, click.to);
    const direct = this.p.state.direct(click.chatKey);
    // (and what became of a turn that was running: it goes on there)
    const line = (direct ? leftLine(lang) : backLine(lang)) + (left ? ` ${left}` : "");
    if (click.data["view"] === "agents") return this.home(click, line); // Detach on the list: the list again
    if (direct) {
      await this.end(click, line, undefined, false); // (a status card from before it was on: closed down to the line)
      return;
    }
    const done = await this.end(click, this.p.board.statusOf(click.chatKey, state, "detached").message, line);
    if (done && click.tapped) this.p.ctx.remoteState.setRemoteStatusCard(click.chatKey, click.tapped);
  }

  async close(click: Click): Promise<void> {
    const wanted = textOf(click.data["session_id"]);
    const { sessions } = await this.p.lists.sessions(click.key);
    const session = sessions.find((s) => s.sessionId === wanted);
    if (session === undefined) return this.home(click, saidIn(this.lang(click), "sessionNotFound"));
    const before = this.p.state.attached(click.chatKey);
    const listing = this.p.ctx.remoteState.getRemote(click.chatKey)?.listing ?? [];
    const number = listing.indexOf(wanted) + 1; // (the number the card showed it under)
    const { done, text } = await this.p.ops.close(click.chatKey, click.key, wanted, session.cwd, number);
    if (done && before?.sessionId === wanted) {
      await this.p.board.editStatus(click.chatKey, click.to, this.p.board.statusOf(click.chatKey, before, "ended"));
    }
    const state = this.p.state.attached(click.chatKey);
    if (!done && state?.sessionId === wanted) {
      await this.end(click, (await this.p.ops.rowCard(click.chatKey, click.key, state, text)).message, text);
      return;
    }
    await this.home(click, text);
  }

  async list(click: Click): Promise<void> {
    await this.home(click, "");
  }
}

/** One part of the full output as its fenced block holds it: what the rich text drops taken out first (else `https:\x01//` or a
 * fence split by a bidi override would join once it reads them), every address broken in place, no fence that could close it. */
export function fullBlockText(part: string): string {
  return breakLinks(part.replace(DROPPED_BY_RICH_TEXT, "")).replaceAll("```", "ʼʼʼ");
}
