// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sending one unasked message (teams_agent/proactive.py `_send` and what it calls): an approval's card (recorded first, one
 * approval one card), what the assistant said (closing the receipt under the person's message when one is open, or added to the
 * message it amends or replaces), what a remote agent said on its own, a lost turn's answer, or a run's card.
 */
import { refreshAutoReply } from "../assistant/auto-reply.js";
import { remoteNoticeOf, type RemoteNotice } from "../assistant/events.js";
import { parseWorkItem } from "../assistant/item-of.js";
import { assistantDeliveries } from "../turn/deliveries.js";
import { messageWords } from "../assistant/receipt.js";
import { workEventText } from "../assistant/work-items.js";
import { QUESTION_TOOL } from "../approvals/questions.js";
import type { JsonObject } from "../json.js";
import { answerLang, pickLang } from "../language/detect.js";
import type { Lang } from "../locales/lang.js";
import { proactiveLines } from "../locales/proactive-lines.js";
import type { Conversation, OutMessage, View } from "../ports/surface.js";
import { ITEM_SOURCE, ASSISTANT_SAID_TYPES } from "../subscriptions/event-types.js";
import { clip } from "../text/plain.js";
import { clientLocaleOf, noRequestScope } from "../ports/request-scope.js";
import { pyRstrip, pyStrip } from "../text/py-text.js";
import { replyParts } from "../turn/answer-parts.js";
import type { ProactiveDeps } from "./deps.js";
import { EXPIRES_KEY, REMOTE_SAID, finishedAt, turnAckOf, type AnsweredInChat } from "./events.js";
import { remoteAskExpiry, zoneOf } from "./quiet.js";
import { noteCard } from "../remote/views.js";
import { parseOptions } from "../remote/options.js";
import { SHOWN_WHOLE } from "../remote/terminal-asks.js";
import { terminalAskView } from "../remote-view/terminal-ask-view.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";

/** What the person asked, as the name of a run in its card and in the line before a lost turn's answer. */
export const PROMPT_TITLE_MAX = 60;

function view(v: View): OutMessage {
  return { body: { type: "view", view: v, fallbackText: "" } };
}

/**
 * What a terminal's question card offers (`terminalAskView`): the options it shows as buttons, as the connector gave them, and the
 * ask marked with whether the card shows the request whole (`SHOWN_WHOLE`), which a click is checked against.
 */
function terminalOffer(
  ask: Readonly<Record<string, unknown>>,
  offered: readonly unknown[],
  remote: RemoteNotice,
  lang: Lang,
): { options: unknown[]; ask: Readonly<Record<string, unknown>> } {
  // (judged on the card as drawn, in the person's language: what is stored is what the buttons offer)
  const view = terminalAskView(
    { ask, options: parseOptions(offered), sessionId: remote.sessionId, machine: remote.machine, agent: remote.agent },
    lang,
  );
  const ids = new Set(view.buttons.map((b) => b.optionId));
  const options = offered.filter((o) => {
    const id = o !== null && typeof o === "object" ? (o as Record<string, unknown>)["optionId"] : undefined;
    return typeof id === "string" && ids.has(id);
  });
  return { options, ask: { ...ask, [SHOWN_WHOLE]: view.complete } };
}

/** A terminal's question names its request by an id the connector made, a uuid: anything else is said as words, no card. */
function cardableIds(ask: Readonly<Record<string, unknown>>, actionId: string, sessionId: string): boolean {
  return ask["origin"] !== "terminal" || (plainId(actionId) && plainId(sessionId));
}

/** An id a card's button may carry: at most 128 characters, no control characters. */
function plainId(id: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return id.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(id);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * A task's own notice: Claw says it in the system's words when one of the person's tasks needs them and nobody said so (no turn
 * of the assistant said it), so it is never the reply to the message a receipt stands under.
 */
const NEEDS_YOU = "work_item.needs_you";

/** How many turns this process remembers that a say of theirs was delivered for (`Deliveries.answered`). */
export const ANSWERED_TURNS_MAX = 512;

export class Deliveries {
  /** Turns a say of which (other than Claw's "on it" line) this process began to deliver, newest last. */
  private readonly answered = new Set<string>();

  constructor(
    private readonly deps: ProactiveDeps,
    private readonly answeredInChat: (event: JsonObject, now: number) => AnsweredInChat,
  ) {}

  /** Send the message for `event`; false when nothing was sent (an approval already in a chat, an event that says nothing). */
  async send(userId: string, reference: JsonObject, event: JsonObject): Promise<boolean> {
    const conversation = this.deps.conversationFor(reference);
    const item = event["item"];
    if (typeof item === "object" && item !== null && typeof (item as JsonObject)["item_id"] === "string") {
      await refreshAutoReply(
        { cards: this.deps.store.assistantCards, claw: this.deps.claw, logger: this.deps.logger },
        { userId, itemId: (item as JsonObject)["item_id"] as string, key: this.deps.store.links.getKey(userId) },
      );
    }
    const type = event["type"];
    if (type === "approval.requested") return this.sendApproval(userId, conversation, event);
    if (typeof type === "string" && ASSISTANT_SAID_TYPES.includes(type))
      return this.sendSaid(userId, conversation, event);
    if (type === REMOTE_SAID) {
      for (const part of this.deps.remote.saidParts(str(event["label"]) || "A remote agent", str(event["text"]))) {
        await conversation.send({ body: { type: "rich", markdown: part, lead: false }, aiGenerated: true });
      }
      return true;
    }
    if (await this.answerLostTurn(userId, conversation, event)) {
      await this.offerChanges(userId, conversation, event);
      return true;
    }
    const shown = this.deps.publicEvent(this.namedByPrompt(event));
    await conversation.send(
      view({ name: "runEvent", model: { event: shown, publicBaseUrl: this.deps.publicBaseUrl } }),
    );
    if (type === "run.completed") await this.offerChanges(userId, conversation, event);
    return true;
  }

  /** An approval's card, recorded BEFORE it goes out (atomically: the turn may show the same approval) and WITH its envelope. */
  private async sendApproval(userId: string, conversation: Conversation, event: JsonObject): Promise<boolean> {
    const { store, publicBaseUrl } = this.deps;
    const approval = event["approval"] as JsonObject;
    const expiresAt = Number(event[EXPIRES_KEY]);
    const sessionId = str(event["session_id"]);
    const toolUseId = str(approval["tool_use_id"]);
    const tool = str(approval["tool"]) || "an action";
    const zone = zoneOf(store.prefs.getPrefs(userId));
    const model = { event, publicBaseUrl, expiresAt, zone };
    const card =
      event["source"] !== ITEM_SOURCE
        ? view({ name: "proactiveApproval", model })
        : tool === QUESTION_TOOL
          ? view({ name: "itemQuestion", model: { event } })
          : view({ name: "itemApproval", model });
    const envelope = conversation.outgoing(card);
    if (!store.approvals.saveApproval({ userId, sessionId, toolUseId, tool, expiresAt, envelope })) return false;
    try {
      await conversation.deliver(envelope);
    } catch (error) {
      store.approvals.forgetApproval(sessionId, toolUseId); // (nobody saw it: the sender's retry must be able to show it)
      throw error;
    }
    store.approvals.approvalSent(sessionId, toolUseId);
    return true;
  }

  /**
   * A development environment session's own card: a request that waits on the person (its card), or the end of a terminal's
   * question (its card edited). Undefined when the message goes on as words.
   */
  private async remoteCard(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
  ): Promise<boolean | undefined> {
    const remote = remoteNoticeOf(event);
    if (remote?.resolved !== undefined) {
      return (await this.endTerminalAsk(userId, conversation, remote.sessionId, remote.resolved)) ? true : undefined;
    }
    if (remote?.kind === "needs_you" && remote.ask !== undefined)
      return this.sendRemoteAsk(userId, conversation, event, remote);
    return undefined;
  }

  /**
   * What the assistant said, then, when its turn was refused something for want of a confirmed identity (`needs_identity`) and
   * this is the person's own chat (a group binding's key has `#`), the card that confirms it. A card that could not be sent never
   * makes the message undelivered.
   */
  private async sendSaid(userId: string, conversation: Conversation, event: JsonObject): Promise<boolean> {
    const sent = await this.sendSaidWords(userId, conversation, event);
    const offer = this.deps.identityAfterRefusal;
    if (
      sent &&
      offer !== undefined &&
      event["type"] === "assistant.say" &&
      event["needs_identity"] === true &&
      !userId.includes("#")
    ) {
      try {
        await offer(userId, conversation, str(event["turn_message_id"]) || str(event["event_id"]));
      } catch (error) {
        this.deps.logger.warn("the identity card after a refused answer could not be sent", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    return sent;
  }

  /**
   * Claw's "on it" line for a turn that has already begun to answer: a say of the turn was delivered (or is being), or the
   * receipt under the person's message is showing the reply's words. The line came late (it was decided before the answer,
   * or the two crossed on the way here): it is dropped, never put in the receipt's place, where it would replace the words of
   * a reply that is being written or close it as if it were the answer (2026-11-11 0.3.0 acceptance: a refusal streamed into
   * the receipt, the line closed it as "收到，我看一下。", and the refusal came as a message of its own).
   */
  private lateTurnAck(conversation: Conversation, event: JsonObject): boolean {
    const turn = turnAckOf(event);
    if (!turn) {
      const own = event["turn_message_id"];
      if (event["type"] === "assistant.say" && typeof own === "string" && own) this.noteAnswered(own);
      return false;
    }
    if (this.answered.has(turn)) return true;
    const receipt = this.deps.receipts.openOf(conversation.ref.id);
    return receipt !== undefined && receipt.answeredBy(turn) && receipt.answering;
  }

  private noteAnswered(turn: string): void {
    this.answered.delete(turn);
    this.answered.add(turn);
    while (this.answered.size > ANSWERED_TURNS_MAX) {
      const oldest = this.answered.values().next();
      if (oldest.done === true) break;
      this.answered.delete(oldest.value);
    }
  }

  /** What the assistant said (or a work item that needs the person and was not said). */
  private async sendSaidWords(userId: string, conversation: Conversation, event: JsonObject): Promise<boolean> {
    if (this.lateTurnAck(conversation, event)) {
      this.deps.logger.info('the turn\'s "on it" line came after the turn began to answer; dropped');
      return false;
    }
    const card = await this.remoteCard(userId, conversation, event);
    if (card !== undefined) return card;
    let words = workEventText(parseWorkItem(event["item"]) ?? null, event["text"]);
    if (!words && assistantDeliveries(event).length === 0) return false;
    const lang = answerLang(this.deps.store.prefs.getPrefs(userId).lang, this.clientLocale(), words);
    const reader = { remoteState: (u: string) => this.attached(u) };
    const { head, replies } = this.deps.directChat.clawyExtras(reader, userId, lang);
    if (words && head) words = `${head}\n\n${words}`;
    // (in a chat that is an agent's window, attached to its session, nothing said earlier is edited: an addition comes as a
    // message of its own; a chat that is not attached edits as any other)
    if (!this.agentsWindow(userId)) {
      const options = { head, replies };
      if (
        (await this.amend(userId, conversation, event, options)) ||
        (await this.replace(userId, conversation, event, options))
      )
        return true;
    }
    await this.closeReceiptWith(userId, conversation, event, { words, head, replies });
    return true;
  }

  /** The client locale of the message being handled ("" for a push or a sweep: Python CLIENT_LOCALE's default). */
  private clientLocale(): string {
    return clientLocaleOf(this.deps.requestScope ?? noRequestScope);
  }

  /** The chat is an agent's window now: direct chat is on for the person and the chat is attached to a session. */
  private agentsWindow(userId: string): boolean {
    return this.deps.directChat.on(userId) && this.deps.store.remoteState.attachedRemote(userId) !== null;
  }

  private attached(userId: string) {
    const state = this.deps.store.remoteState.getRemote(userId);
    return state === null
      ? undefined
      : { sessionId: state.sessionId ?? "", agentLabel: state.agentLabel, host: state.host, agentId: state.agentId };
  }

  /**
   * The first reply closes the receipt under the person's message, in its place (with the words already streamed in it kept);
   * otherwise it is a message of its own. Its other parts, and the files, follow as messages.
   */
  private async closeReceiptWith(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
    said: { words: string; head: string; replies: readonly (readonly [string, string])[] },
  ): Promise<void> {
    // Only the reply of the message's own turn closes its receipt: another turn's (a task's report woke the assistant while the
    // message waited) and a task's own notice (Claw's `work_item.needs_you`, said by no turn) are messages of their own.
    const turn = event["turn_message_id"];
    const receipt = this.deps.receipts.take(conversation.ref.id, undefined, {
      turn: typeof turn === "string" && turn ? turn : undefined,
      foreign: event["type"] === NEEDS_YOU,
    });
    const shown = receipt ? await receipt.shownWords() : "";
    const messages = this.deps.say.messages(userId, event, {
      linkFor: this.deps.deliveryLink,
      shown,
      head: said.head,
      replies: said.replies,
      limits: conversation.caps,
    });
    const [first, ...rest] = messages;
    if (first === undefined) return;
    const words = said.words ? (replyParts(said.words, shown)[0] ?? "") : said.words;
    if (receipt !== undefined && (await receipt.deliver(first, words))) {
      this.deps.said.remember(event, receipt.stream.streamId);
    } else if (this.deps.messageIds) {
      this.deps.said.remember(event, await conversation.post(first));
    } else {
      await conversation.send(first);
    }
    for (const message of rest) await conversation.send(message);
  }

  /** The one text message of `event` as an edit can carry it; undefined when it is more than that (several, or a card). */
  private oneText(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
    options: { head: string; replies: readonly (readonly [string, string])[] },
  ) {
    const said = this.deps.say.messages(userId, event, {
      linkFor: this.deps.deliveryLink,
      ...options,
      limits: conversation.caps,
    });
    const [only] = said;
    return said.length === 1 && only !== undefined && only.body.type !== "view" ? only : undefined;
  }

  /**
   * A say that adds to an earlier one of the same turn (`amends`): that message is edited to hold both. False when it is not
   * one, this process no longer has that message, or the edit was not taken: it is then sent as a message of its own.
   */
  private async amend(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
    options: { head: string; replies: readonly (readonly [string, string])[] },
  ) {
    const amends = event["amends"];
    if (event["type"] !== "assistant.say" || typeof amends !== "string" || !amends) return false;
    const earlier = this.deps.said.get(amends);
    const text = pyStrip(str(event["text"]));
    if (earlier === undefined || !text) return false;
    const both = { ...earlier.event, text: `${pyRstrip(str(earlier.event["text"]))}\n\n${text}` };
    const message = this.oneText(userId, conversation, both, options);
    if (
      message === undefined ||
      !(await this.edit(
        conversation,
        earlier.messageId,
        message,
        "an assistant message could not be added to the one it amends; sent as its own",
      ))
    ) {
      return false;
    }
    this.deps.said.remember(both, earlier.messageId);
    return true;
  }

  /** A say that takes the place of the first one of its turn (`replaces`): that message is edited into this one. */
  private async replace(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
    options: { head: string; replies: readonly (readonly [string, string])[] },
  ) {
    const replaces = event["replaces"];
    if (event["type"] !== "assistant.say" || typeof replaces !== "string" || !replaces) return false;
    const earlier = this.deps.said.get(replaces);
    if (earlier === undefined || !pyStrip(str(event["text"]))) return false;
    const message = this.oneText(userId, conversation, event, options);
    if (
      message === undefined ||
      !(await this.edit(
        conversation,
        earlier.messageId,
        message,
        "an assistant message could not take the place of its turn's first one; sent as its own",
      ))
    ) {
      return false;
    }
    this.deps.said.set(replaces, { messageId: earlier.messageId, event: { ...event, event_id: replaces } });
    return true;
  }

  private async edit(conversation: Conversation, id: string, message: OutMessage, failure: string): Promise<boolean> {
    try {
      await conversation.update(id, message);
      return true;
    } catch (error) {
      this.deps.logger.warn(failure, { error: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  /**
   * The approval card of a pushed permission request: true when sent, false when not needed (a card for it is in a chat already,
   * or it ran out while held), undefined when it offers nothing that can be answered (its words go as they are).
   */
  private async sendRemoteAsk(
    userId: string,
    conversation: Conversation,
    event: JsonObject,
    remote: RemoteNotice,
  ): Promise<boolean | undefined> {
    const { store } = this.deps;
    const ask = remote.ask ?? {};
    const actionId = str(ask["action_id"]);
    const offered = this.deps.remote.options(ask["options"]);
    if (!actionId || offered.length === 0) return undefined;
    if (!cardableIds(ask, actionId, remote.sessionId)) return undefined;
    const now = store.now();
    const expiresAt = remoteAskExpiry(ask, now);
    if (expiresAt <= now) return false;
    const tool = str(ask["tool"]) || "an action";
    // A question a terminal asks keeps its whole ask: the board draws its card again with the content, never buttons alone. Only
    // the options its card offers are kept (what was not shown whole offers only those that turn it down), and whether it was.
    const terminal = ask["origin"] === "terminal";
    const prefs = store.prefs.getPrefs(userId);
    const lang = answerLang(prefs.lang, this.clientLocale(), event["text"]);
    const shown = terminal ? terminalOffer(ask, offered, remote, lang) : { options: offered, ask };
    const options = shown.options;
    if (
      !store.remotePermissions.saveRemotePermission({
        userId,
        sessionId: remote.sessionId,
        actionId,
        tool,
        options,
        expiresAt,
        ...(terminal ? { ask: shown.ask } : {}),
      })
    ) {
      return false; // (one request, one card: the attached chat's reader, or an earlier delivery of this push, showed it)
    }
    const item = parseWorkItem(event["item"]);
    const card = this.deps.remote.askCard({
      ask,
      options,
      sessionId: remote.sessionId,
      machine: remote.machine,
      agent: remote.agent,
      about: item ? `#${String(item.seq)} ${item.title}` : "",
      expiresAt,
      zone: zoneOf(prefs),
      lang,
    });
    try {
      if (terminal) {
        // (its id is kept: when the terminal answers first, this card is edited to say so)
        const messageId = await conversation.post(card);
        if (messageId) store.remotePermissions.setRemotePermissionMessage(remote.sessionId, actionId, messageId);
      } else {
        await conversation.send(card);
      }
    } catch (error) {
      store.remotePermissions.forgetRemotePermission(remote.sessionId, actionId); // (nobody saw it: Claw's retry must show it)
      throw error;
    }
    return true;
  }

  /**
   * A question a terminal asked no longer waits here (`resolved`): answered at the terminal, or given up. Its card is edited in
   * place to say so, without its buttons, and a click on it is told the same. True when that is done (or there is nothing to
   * do: answered here already); false when the card cannot be found or edited, and the notice's own line is said instead.
   */
  private async endTerminalAsk(
    userId: string,
    conversation: Conversation,
    sessionId: string,
    resolved: { readonly actionId: string; readonly by: string },
  ): Promise<boolean> {
    const { store } = this.deps;
    const perm = store.remotePermissions.getRemotePermission(sessionId, resolved.actionId);
    if (perm === null || perm.userId !== userId) return false;
    const state = resolved.by === "terminal" ? "terminal" : "expired";
    if (!store.remotePermissions.closeRemotePermission(sessionId, resolved.actionId, state)) {
      // A click is on its way: the end is kept, so that if the click fails its card says so instead of coming back. If it goes
      // through it answers the card itself. (answered here first: nothing to do)
      store.remotePermissions.closeRemotePermission(sessionId, resolved.actionId, state, { onlyIfState: "sending" });
      return true;
    }
    if (!perm.messageId) return false;
    const lang = answerLang(store.prefs.getPrefs(userId).lang, this.clientLocale(), str(perm.ask?.["tool"]));
    const words = terminalApprovalText.in(lang);
    const ended =
      resolved.by === "terminal"
        ? { title: words.answeredInTerminal, line: words.answeredInTerminalLine }
        : { title: words.noLongerWaiting, line: words.noLongerWaitingLine };
    try {
      await conversation.update(perm.messageId, noteCard(ended.line, ended.title));
      return true;
    } catch {
      return false;
    }
  }

  /** A run started by a chat turn is named by what the person asked there (Claw names it by its session's first message). */
  namedByPrompt(event: JsonObject): JsonObject {
    const { store } = this.deps;
    const prompt = store.turns.turnPrompt(str(event["session_id"]), finishedAt(event, store.now()));
    if (!pyStrip(prompt)) return event;
    const kind = event["type"] === "run.failed" ? "Run failed" : "Run completed";
    return { ...event, title: `${kind}: ${clip(prompt, PROMPT_TITLE_MAX)}` };
  }

  /**
   * The run finished after the chat turn answering it died with its worker: its answer is sent, after one line that says why it
   * comes now. False when it cannot be read: the card is shown instead.
   */
  private async answerLostTurn(userId: string, conversation: Conversation, event: JsonObject): Promise<boolean> {
    const { store, runs } = this.deps;
    const sessionId = str(event["session_id"]);
    const key = store.links.getKey(userId);
    if (event["type"] !== "run.completed" || runs === undefined || !sessionId || key === null) return false;
    if (this.answeredInChat(event, store.now()) !== "lost") return false;
    const prompt = store.turns.turnPrompt(sessionId, finishedAt(event, store.now()));
    const lead = proactiveLines
      .in(pickLang(prompt))
      .lostTurnLead({ bot: this.deps.botName, prompt: clip(prompt, PROMPT_TITLE_MAX) });
    let parts: readonly string[] | undefined;
    try {
      parts = await runs.lostAnswer(key, sessionId, lead);
    } catch (error) {
      this.deps.logger.warn("the answer of a turn lost to a restart could not be read; the card is shown instead", {
        error: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
    if (parts === undefined) return false;
    for (const part of parts)
      await conversation.send({ body: { type: "rich", markdown: part, lead: false }, aiGenerated: true });
    store.turns.turnDelivered(sessionId); // (answered: a retry of the same notification is dropped)
    return true;
  }

  private async offerChanges(userId: string, conversation: Conversation, event: JsonObject): Promise<void> {
    const sessionId = str(event["session_id"]);
    const key = this.deps.store.links.getKey(userId);
    if (this.deps.runs === undefined || !sessionId || key === null) return;
    try {
      await this.deps.runs.offerChanges(key, sessionId, conversation);
    } catch (error) {
      // (best effort: the notification's sender waits for the answer, and the run's card is out already)
      this.deps.logger.warn("the changes card of a finished run could not be shown", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

/** The words of a message (for tests and callers that check what was said). */
export { messageWords };
