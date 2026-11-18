// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat's status card: sent once when the chat attaches, then only edited in place. When the chat's window is the session card
 * (`/agent mode card`), the status card IS that card: edited for small changes, posted again at the bottom when the change is
 * worth a new message (`window/view.ts`), never edited or removed while the person may be typing into its box unless they acted.
 * A chat that is the agent's window itself (direct chat) has no status card: one line says where its messages go.
 */
import { agentReplies, backReply, enteredLine } from "../direct-chat/direct-chat.js";
import { errorName } from "../errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import type { RemoteState } from "../ports/store/remote.js";
import { type Conversation, type MessageId, type OutMessage, textMessage } from "../ports/surface.js";
import { type ButtonFields } from "./actions.js";
import { switchedLine } from "./lines.js";
import { parseOptions } from "./options.js";
import type { StatusPhase } from "./lines.js";
import { noteCard } from "./views.js";
import { isGroupKey } from "./chat-key.js";
import type { RemoteContext } from "./context.js";
import type { ChatState } from "./state.js";
import { ChatLocks, Task } from "./tasks.js";
import { Signer } from "./turns/signer.js";
import { EDIT_SECONDS, markEdited, markPosted, shouldRepost } from "./window/view.js";

/** A status card, and whether it carries the window's text box. */
export interface Shown {
  readonly message: OutMessage;
  readonly takesInput: boolean;
}

/** How a refresh of the window goes. */
export interface Refresh {
  /** A turn's end is shown. */
  readonly ended?: boolean;
  /** An edit while a turn streams into the card. */
  readonly streaming?: boolean;
  readonly lead?: string;
  /** It answers the person's own act (only then is a card with the text box edited or removed). */
  readonly byPerson?: boolean;
  /** Post it again at the bottom whatever changed. */
  readonly repost?: boolean;
  /** A scheduled edit's: aborted, it does nothing, even when it was already waiting for its turn (Python's task cancel). */
  readonly signal?: AbortSignal;
}

export class StatusBoard {
  private readonly locks = new ChatLocks();
  private readonly edits = new Map<string, Task>();
  private readonly background = new Set<Task>();

  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
  ) {}

  /** The chat's status card in `phase` (the session card when it is the window). */
  statusOf(chatKey: string, state: RemoteState, phase: StatusPhase, lead = "", unattended?: boolean): Shown {
    const lang = this.state.lang(chatKey);
    const unattendedNow = unattended ?? state.unattended ?? this.state.chats.agentUnattended.get(chatKey) ?? false;
    const takeover: ButtonFields | null =
      phase === "watching" && this.state.offersTakeover(chatKey)
        ? { connector_id: state.connectorId, agent_id: state.agentId, resume: state.conversationRef }
        : null;
    const input = {
      label: state.agentLabel,
      host: state.host,
      cwd: state.cwd,
      mode: state.mode,
      sessionId: state.sessionId ?? "",
      phase,
      at: this.ctx.clock.epochMs() / 1000,
      lang,
      hasModes: state.modes.length > 0,
      unattended: unattendedNow,
      lead,
      conversation: state.conversation,
      takeover,
      terminal: this.state.typesIntoTerminal(chatKey, state),
      bot: this.ctx.settings.botName,
    };
    if (state.window === "card" && state.sessionId && phase !== "detached" && phase !== "ended") {
      const approvals = this.state.approvalsOf(chatKey, state).map((p) => ({
        actionId: p.actionId,
        tool: p.tool,
        expiresAt: p.expiresAt,
        buttons: this.ctx.views.optionButtons(parseOptions(p.options), p.sessionId, p.actionId, lang).map((b) => ({
          ...b,
          inWindow: true,
        })),
      }));
      return this.ctx.views.window({
        ...input,
        view: this.state.view(chatKey, state),
        approvals,
        zone: this.state.zone(chatKey),
        group: isGroupKey(chatKey),
      });
    }
    return { message: this.ctx.views.status(input), takesInput: false };
  }

  // --- the session card as the window ---------------------------------------------------------------------------------------

  /**
   * Show the window as it is now: edited in place, or posted again at the bottom (the old one deleted, or closed down to a line
   * where it cannot be) when the change is worth a new message. One at a time per chat. True when a new card was posted.
   */
  refreshWindow(chatKey: string, to: Conversation, how: Refresh = {}): Promise<boolean> {
    return this.locks.with(chatKey, async () => {
      const state = this.state.attached(chatKey);
      const stored = this.ctx.remoteState.getRemote(chatKey);
      if (how.signal?.aborted === true) return false;
      if (state === null || stored === null || state.window !== "card") return false;
      const posted = await this.editOrRepost(chatKey, to, state, stored.statusCard, how);
      if (how.byPerson === true) await this.dropKept(chatKey, to);
      return posted;
    });
  }

  /** The window edited in place when that is enough, else posted again; true when a new card was posted. */
  private async editOrRepost(
    chatKey: string,
    to: Conversation,
    state: RemoteState,
    cardId: string,
    how: Refresh,
  ): Promise<boolean> {
    const view = this.state.view(chatKey, state);
    const ended = how.ended === true || view.ended;
    view.ended = false; // (a turn's end is shown once, by the refresh after its reader let go)
    const approvals = this.state.approvalsOf(chatKey, state).map((p) => p.actionId);
    const card = this.statusOf(chatKey, state, this.state.phase(chatKey), how.lead ?? "");
    const keep = view.boxed && how.byPerson !== true; // (the person may be typing into the card the chat shows now)
    const edit =
      cardId !== "" && !keep && how.repost !== true && !shouldRepost(view, approvals, ended, how.streaming === true);
    if (edit && (await this.editStatus(chatKey, to, card))) {
      markEdited(view);
      return false;
    }
    const posted = await this.repostWindow(chatKey, to, card, keep);
    if (posted) markPosted(view, approvals);
    return posted;
  }

  /**
   * Post the window as a new card at the bottom; the one it replaces is deleted, or, with `keep`, left as it is (it has the text
   * box: `dropKept` removes it at the person's next act). False when no new card came.
   */
  private async repostWindow(chatKey: string, to: Conversation, card: Shown, keep: boolean): Promise<boolean> {
    const old = this.ctx.remoteState.getRemote(chatKey)?.statusCard ?? "";
    const cardId = await to.post(card.message);
    if (!cardId) return false; // (no id came back: it cannot be edited, and the old one is still the one to edit)
    this.ctx.remoteState.setRemoteStatusCard(chatKey, cardId);
    const view = this.state.existingView(chatKey);
    if (view) view.boxed = card.takesInput;
    if (!old || old === cardId) return true;
    this.ctx.remoteState.noteWindowCard(chatKey, old); // (a reply that quotes it still goes to the session)
    if (keep && view) {
      view.kept.push(old);
      return true;
    }
    to.markSettled(old); // (a card tapped just now is settled: the safety net must not edit a message that is gone)
    await this.removeOrRetire(chatKey, to, old);
    return true;
  }

  /** Delete a card of this chat's, or (the channel cannot) close it down to the line that says where the new one is. */
  async removeOrRetire(chatKey: string, to: Conversation, cardId: MessageId): Promise<void> {
    let removed = false;
    try {
      removed = (await to.delete(cardId)).ok;
    } catch (error) {
      this.ctx.logger.info("a card could not be deleted", { error: errorName(error) });
    }
    if (!removed) await this.retireStatus(to, cardId, chatKey);
  }

  /** The person has acted: the older cards with a text box that were kept for them go now. */
  async dropKept(chatKey: string, to: Conversation): Promise<void> {
    const view = this.state.existingView(chatKey);
    if (!view || view.kept.length === 0) return;
    const kept = view.kept;
    view.kept = [];
    for (const cardId of kept) await this.removeOrRetire(chatKey, to, cardId);
  }

  /** An edit of the window EDIT_SECONDS from now, unless one is waiting already (it shows what is newest when it runs). */
  scheduleWindow(chatKey: string, to: Conversation): void {
    if (this.edits.get(chatKey)?.running) return;
    const task = new Task(
      async (signal) => {
        await (this.ctx.paceClock ?? this.ctx.clock).sleep(EDIT_SECONDS * 1000, signal);
        await this.refreshWindow(chatKey, to, { streaming: true, signal });
      },
      this.ctx.logger,
      "the session card could not be refreshed",
    );
    this.edits.set(chatKey, task);
    this.track(task);
  }

  cancelWindowEdit(chatKey: string): void {
    const task = this.edits.get(chatKey);
    this.edits.delete(chatKey);
    task?.cancel();
  }

  private track(task: Task): void {
    this.background.add(task);
    void task.done.then(() => this.background.delete(task));
  }

  /** Wait for what runs in the background (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.background].map((t) => t.done));
  }

  /**
   * What the agent says between turns, into the window: `final`, a burst that is over (shown by `windowSettled`, once the reader
   * has let go of it); else the text so far, shown by a throttled edit. False when the chat shows no window.
   */
  windowSaid(chatKey: string, text: string, final: boolean): boolean {
    const state = this.state.attached(chatKey);
    const reference = this.ctx.references.getReference(chatKey);
    if (state === null || state.window !== "card" || reference === null) return false;
    const view = this.state.view(chatKey, state);
    view.setText(text);
    view.note = "";
    if (final) {
      this.cancelWindowEdit(chatKey);
      view.ended = true;
    } else {
      this.scheduleWindow(chatKey, this.ctx.conversationFor(reference));
    }
    return true;
  }

  /** What the agent said between turns has been taken in by the reader: the window shows it, and the state as it is now. */
  async windowSettled(chatKey: string): Promise<void> {
    const reference = this.ctx.references.getReference(chatKey);
    if (reference === null) return;
    await this.refreshWindow(chatKey, this.ctx.conversationFor(reference));
  }

  // --- the status card -------------------------------------------------------------------------------------------------------

  /**
   * Send the status card as a new message and remember it; the card it replaces is closed down to a line saying where the new one
   * is (it is history now, and its buttons would act on a card that is not the chat's any more).
   */
  async postStatus(chatKey: string, to: Conversation, card: Shown): Promise<void> {
    const old = this.ctx.remoteState.getRemote(chatKey)?.statusCard ?? "";
    const cardId = await to.post(card.message);
    this.ctx.remoteState.setRemoteStatusCard(chatKey, cardId ?? "");
    this.noteWindowShown(chatKey, card);
    if (old && old !== cardId) await this.retireStatus(to, old, chatKey);
  }

  /** A status card was just posted or put in place: when it is the session card, what it shows counts as posted. */
  noteWindowShown(chatKey: string, card: Shown): void {
    const state = this.state.attached(chatKey);
    if (state === null || state.window !== "card") return;
    const view = this.state.view(chatKey, state);
    markPosted(
      view,
      this.state.approvalsOf(chatKey, state).map((p) => p.actionId),
    );
    view.boxed = card.takesInput;
  }

  async retireStatus(to: Conversation, cardId: MessageId, chatKey: string): Promise<void> {
    try {
      await to.update(cardId, noteCard(remoteAgentText.in(this.state.lang(chatKey)).changedElsewhere));
    } catch (error) {
      this.ctx.logger.info("an earlier status card could not be closed down", { error: errorName(error) });
    }
  }

  /**
   * Edit the chat's status card in place: true when there is one and the edit was handed over. Never for a chat that is the
   * agent's window itself: it has no status card, and one it had before is left as it is.
   */
  async editStatus(chatKey: string, to: Conversation, card: Shown): Promise<boolean> {
    const stored = this.ctx.remoteState.getRemote(chatKey);
    if (stored === null || !stored.statusCard || this.state.direct(chatKey)) return false;
    try {
      await to.update(stored.statusCard, card.message);
    } catch (error) {
      this.ctx.logger.info("the status card could not be edited", { error: errorName(error) });
      return false;
    }
    const view = this.state.existingView(chatKey);
    if (view) view.boxed = card.takesInput;
    return true;
  }

  /**
   * The session has started (ready, or found open in a terminal): the status card says so, in place. A session card that is the
   * window is posted again at the bottom instead (the card that said "starting" had no text box). True when the card shows it.
   */
  async settleStatus(
    chatKey: string,
    to: Conversation,
    state: RemoteState,
    phase: StatusPhase,
    lead = "",
  ): Promise<boolean> {
    if (this.state.direct(chatKey)) return false;
    if (state.window === "card" && state.sessionId) return this.refreshWindow(chatKey, to, { lead, repost: true });
    return this.editStatus(chatKey, to, this.statusOf(chatKey, state, phase, lead));
  }

  /**
   * The status card says what the session is doing now (a turn began or ended): edited in the background, never a new message
   * (the window may be posted again when that is due). `state`: the session the card is about when the chat has just left it.
   */
  touchStatus(chatKey: string, to: Conversation, phase?: StatusPhase, state?: RemoteState, byPerson = false): void {
    const about = state ?? this.state.attached(chatKey);
    const stored = this.ctx.remoteState.getRemote(chatKey);
    if (about === null || stored === null || !stored.statusCard || this.state.direct(chatKey)) return;
    const leaving = phase === "detached" || phase === "ended";
    let work: (signal: AbortSignal) => Promise<void>;
    if (about.window === "card" && !leaving && this.state.attached(chatKey) !== null) {
      work = async () => {
        await this.refreshWindow(chatKey, to, { byPerson });
      };
    } else {
      const card = this.statusOf(chatKey, about, phase ?? this.state.phase(chatKey));
      work = async () => {
        await this.editStatus(chatKey, to, card);
      };
    }
    this.track(new Task(work, this.ctx.logger, "the session card could not be refreshed"));
  }

  /**
   * What a chat that has just attached (or switched) by a typed command is shown: entering from the assistant, ONE new status
   * card; switching from another session, the status card edited in place and one short line saying which session it is in now.
   */
  async showEntered(
    chatKey: string,
    to: Conversation,
    was: RemoteState | null,
    phase: StatusPhase,
    lead = "",
    unattended?: boolean,
  ): Promise<void> {
    const state = this.state.attached(chatKey);
    if (state === null) return;
    if (this.state.direct(chatKey)) {
      await this.sayEntered(chatKey, to, state, unattended, lead);
      return;
    }
    const card = this.statusOf(chatKey, state, phase, lead, unattended);
    if (was?.sessionId && (await this.editStatus(chatKey, to, card))) {
      await to.send(textMessage(switchedLine(state.agentLabel, state.host, this.state.lang(chatKey))));
      return;
    }
    await this.postStatus(chatKey, to, card);
  }

  /**
   * A chat that is the agent's window itself has just attached or switched: one line says where its messages go now (with a
   * warning when the session does not ask before it acts), and the way back is the suggested reply under it. The status card it
   * may still have from before is forgotten, so nothing edits it any more.
   */
  async sayEntered(
    chatKey: string,
    to: Conversation,
    state: RemoteState,
    unattended?: boolean,
    lead = "",
  ): Promise<void> {
    const lang = this.state.lang(chatKey);
    const unattendedNow = unattended ?? state.unattended ?? this.state.chats.agentUnattended.get(chatKey) ?? false;
    this.ctx.remoteState.setRemoteStatusCard(chatKey, "");
    const line = enteredLine({
      label: state.agentLabel,
      host: state.host,
      cwd: state.cwd,
      mode: state.mode,
      lang,
      bot: this.ctx.settings.botName,
      unattended: unattendedNow,
      lead,
    });
    const [title, value] = backReply(lang, this.ctx.settings.botName);
    await to.send({ ...textMessage(line), suggestions: [{ title, value }] });
  }

  /**
   * The suggested replies under what the assistant says to a chat that is the agent's window itself: back to the assistant while
   * attached, else back to the agent it last talked to.
   */
  backReplies(chatKey: string): { title: string; value: string }[] {
    if (!this.state.direct(chatKey)) return [];
    const reader = {
      remoteState: (key: string) => {
        const found = this.ctx.remoteState.getRemote(key);
        return found
          ? { sessionId: found.sessionId ?? "", agentLabel: found.agentLabel, host: found.host, agentId: found.agentId }
          : undefined;
      },
    };
    return this.ctx.directChat
      .botExtras(reader, chatKey, this.state.lang(chatKey))
      .replies.map(([title, value]) => ({ title, value }));
  }

  /** How a chat that is the agent's window signs what it wrote: its head, and the way on and back under the last message. */
  signerOf(chatKey: string, state: RemoteState): Signer {
    const lang = this.state.lang(chatKey);
    const replies = agentReplies(lang, this.ctx.settings.botName).map(([title, value]) => ({ title, value }));
    return new Signer(state.agentLabel, state.host, lang, replies);
  }
}
