// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The taps that attach the chat: New session (in a folder the agent reports, or taking over a conversation it offers), Attach,
 * Take over… (its confirmation first, for a conversation a terminal has open). What a tap that attached leaves: one short line
 * saying which session the chat is in now, then the status card as a NEW message under it, and the tapped card deleted.
 */
import { ClawError } from "../claw/errors.js";
import { errorName } from "../errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { textMessage } from "../ports/surface.js";
import { approvalChoice, canTakeOver } from "./agents.js";
import { type Conversation, WATCH_STATE, resumableOf } from "./conversations.js";
import { switchedLine } from "./lines.js";
import { neutral } from "../text/neutral.js";
import type { Shown } from "./board.js";
import { TAKEOVER_CONFIRM_SECONDS } from "./chats.js";
import type { Click, SessionClicks } from "./clicks.js";
import type { CommandParts } from "./commands.js";
import { textOf } from "./fields.js";
import { offlineText, reconnecting } from "./machines.js";
import { type Agent, type Connector, agentById, connectorById } from "./model.js";
import { saidIn } from "./refusals.js";
import { isTransport } from "./state.js";
import { slotOf } from "./targets.js";
import { own } from "../own.js";

export class StartClicks {
  constructor(
    private readonly p: CommandParts,
    private readonly c: SessionClicks,
  ) {}

  private now(): number {
    return this.p.ctx.clock.epochMs() / 1000;
  }

  /** The connector and agent a tap names, from the person's own list as Claw gives it now; null (said) when gone. */
  private async named(click: Click): Promise<{ connector: Connector; agent: Agent } | null> {
    const { connectors } = await this.p.lists.machines(click.key);
    const connector = connectorById(connectors, textOf(click.data["connector_id"]));
    const agent = agentById(connector, textOf(click.data["agent_id"]));
    if (connector === undefined || agent === undefined) {
      await this.c.home(click, saidIn(this.c.lang(click), "agentGone"));
      return null;
    }
    return { connector, agent };
  }

  /** New session: on an agent the person has, in a folder it reports or a conversation it offers. */
  async newSession(click: Click): Promise<void> {
    const lang = this.c.lang(click);
    if (this.p.state.chats.turns.has(click.chatKey)) return this.c.home(click, saidIn(lang, "stopFirst"));
    const named = await this.named(click);
    if (named === null) return;
    const { connector, agent } = named;
    if (!connector.online && !reconnecting(connector, this.now()))
      return this.c.home(click, offlineText(connector, this.now(), lang));
    const where = this.whereTo(click, connector, agent);
    if ("problem" in where) return this.c.home(click, where.problem);
    const { ticket, refusal } = this.p.starts.takeUnattendedStart(click.chatKey, agent);
    if (refusal) return this.c.home(click, refusal);
    const entry = where.entry;
    const takeover = entry !== null && entry.state === WATCH_STATE && Boolean(click.data["takeover"]);
    if (takeover) await this.closeWatchOf(click, entry.ref);
    const sessionId = await this.p.starts.begin(click.chatKey, click.key, {
      connector,
      agent,
      path: where.path,
      resumeRef: entry?.ref,
      takeover,
      conversation: entry?.title ?? "",
      ticket,
    });
    const state = this.p.state.attached(click.chatKey);
    await this.becomeStatus(
      click,
      state ? await this.p.ops.rowCard(click.chatKey, click.key, state, "", agent, "starting") : null,
    );
    const watch = {
      chatKey: click.chatKey,
      sessionId,
      key: click.key,
      provider: click.provider,
      to: click.to,
      want: where.want,
      ticket,
    };
    this.p.watches.spawn(click.chatKey, (signal) => this.p.watches.start(watch, signal));
  }

  /**
   * Where a New session tap starts: the conversation it takes over (where it lives is what the agent reported), or the folder the
   * card names; and the kind of session the card asked for when it is not how the agent starts. Or why not.
   */
  private whereTo(
    click: Click,
    connector: Connector,
    agent: Agent,
  ): { path: string; entry: Conversation | null; want: string | null } | { problem: string } {
    const lang = this.c.lang(click);
    if ("resume" in click.data) {
      const taken = this.p.targets.takeoverOf(click.chatKey, connector, agent, click.data, this.now(), lang);
      return taken.entry === null
        ? { problem: taken.problem }
        : { path: taken.entry.cwd, entry: taken.entry, want: null };
    }
    const folder = this.p.targets.folderOf(click.chatKey, agent, click.data, this.now(), lang);
    if (folder.problem) return { problem: folder.problem };
    const choice = approvalChoice(agent);
    const picked = own(click.data, `appr${String(slotOf(click.data))}`);
    const want = choice && (picked === "ask" || picked === "unattended") && picked !== choice.default ? picked : null;
    return { path: folder.path, entry: null, want };
  }

  /** The watch of this conversation is over: the session that takes it over is the chat's now. */
  private async closeWatchOf(click: Click, ref: string): Promise<void> {
    const was = this.p.state.attached(click.chatKey);
    if (was === null || !this.p.state.watches(click.chatKey, was) || was.conversationRef !== ref) return;
    try {
      await this.p.ctx.claw.command(click.key, was.sessionId ?? "", { type: "close" });
    } catch (error) {
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      this.p.ctx.logger.info("closing the watch before a takeover was not accepted");
    }
  }

  /** Attach: to one of the person's sessions, as the list showed it. */
  async attach(click: Click): Promise<void> {
    const lang = this.c.lang(click);
    if (this.p.state.chats.turns.has(click.chatKey)) return this.c.home(click, saidIn(lang, "stopFirst"));
    const wanted = textOf(click.data["session_id"]);
    const session = (await this.p.lists.sessions(click.key)).sessions.find((s) => s.sessionId === wanted);
    if (session === undefined) return this.c.home(click, saidIn(lang, "sessionNotFound"));
    const hooks = this.p.ops.attachHooks(click.chatKey, click.key, click.provider, click.to);
    const attached = await this.p.starts.attach(click.chatKey, click.key, session, hooks);
    const state = this.p.state.attached(click.chatKey);
    if (!attached.ok || state === null) return this.c.home(click, attached.text);
    const card = await this.p.ops.rowCard(click.chatKey, click.key, state, attached.lead, undefined, attached.phase);
    await this.becomeStatus(click, card);
    await attached.followUp();
  }

  /**
   * Take over… on a conversation a terminal has open: the card becomes the confirmation that says what taking it over does;
   * nothing starts until its Take over is tapped. A conversation the terminal let go of meanwhile needs no confirmation.
   */
  async takeover(click: Click): Promise<void> {
    const lang = this.c.lang(click);
    const named = await this.named(click);
    if (named === null) return;
    const { connector, agent } = named;
    if (!connector.online)
      return this.c.home(click, remoteAgentText.in(lang).offlineTap({ host: neutral(connector.name, 80) }));
    const entry = resumableOf(agent).find((e) => e.ref === textOf(click.data["resume"]));
    if (entry === undefined) return this.c.home(click, saidIn(lang, "conversationGone"));
    if (entry.state !== "live") return this.c.home(click, saidIn(lang, "notInTerminal"));
    if (!canTakeOver(agent)) return this.c.home(click, saidIn(lang, "cannotTakeOver"));
    // a new one-time ticket: only the card shown last can start a takeover
    const ticket = this.p.ctx.random.hexId();
    this.p.state.chats.issueTicket(click.chatKey, {
      connectorId: connector.connectorId,
      agentId: agent.agentId,
      ref: entry.ref,
      ticket,
      until: this.now() + TAKEOVER_CONFIRM_SECONDS,
    });
    await this.c.repost(
      click,
      this.p.ctx.views.takeover(connector, agent, entry, lang, textOf(click.data["view"]), ticket),
    );
  }

  /**
   * What a tap that attached the chat leaves: one line saying which session it is in now, then its status card as a NEW message
   * and the tapped card deleted (a phone does not redraw an edit). Where no new card can be sent, the tapped card becomes the
   * status card in place.
   */
  async becomeStatus(click: Click, card: Shown | null): Promise<void> {
    const lang = this.c.lang(click);
    const state = this.p.state.attached(click.chatKey);
    if (card === null || state === null) return this.c.home(click, saidIn(lang, "sessionUnavailable"));
    const old = this.p.ctx.remoteState.getRemote(click.chatKey)?.statusCard ?? "";
    if (this.p.state.direct(click.chatKey)) {
      // the chat is the window: the line that says where messages go now, and the tapped card goes
      await this.p.board.sayEntered(click.chatKey, click.to, state);
      if (click.tapped) await this.removeTapped(click);
      return;
    }
    if (!click.tapped) return this.p.board.postStatus(click.chatKey, click.to, card); // (nothing to replace)
    await click.to.send(textMessage(switchedLine(state.agentLabel, state.host, lang)));
    const posted = await this.post(click, card);
    if (!posted) return this.inPlace(click, card, old);
    this.p.ctx.remoteState.setRemoteStatusCard(click.chatKey, posted);
    this.p.board.noteWindowShown(click.chatKey, card);
    await this.removeTapped(click);
    if (old && old !== click.tapped && old !== posted) await this.p.board.retireStatus(click.to, old, click.chatKey);
  }

  private async post(click: Click, card: Shown): Promise<string | undefined> {
    try {
      return await click.to.post(card.message);
    } catch (error) {
      this.p.ctx.logger.warn("the status card could not be sent as a new message; replacing the tapped card instead", {
        error: errorName(error),
      });
      return undefined;
    }
  }

  private async inPlace(click: Click, card: Shown, old: string): Promise<void> {
    if (!(await this.c.end(click, card.message, undefined, false))) return;
    this.p.ctx.remoteState.setRemoteStatusCard(click.chatKey, click.tapped);
    this.p.board.noteWindowShown(click.chatKey, card);
    if (old && old !== click.tapped) await this.p.board.retireStatus(click.to, old, click.chatKey);
  }

  private async removeTapped(click: Click): Promise<void> {
    click.to.markSettled(click.tapped); // (settled: nothing may edit a message that is gone)
    if (!(await this.c.deleted(click.to, click.tapped))) {
      await this.c.end(click, remoteAgentText.in(this.c.lang(click)).changedElsewhere, undefined, false);
    }
  }
}
