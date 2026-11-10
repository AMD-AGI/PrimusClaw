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
import { proactiveLines } from "../locales/proactive-lines.js";
import type { Conversation, OutMessage, View } from "../ports/surface.js";
import { ITEM_SOURCE, ASSISTANT_SAID_TYPES } from "../subscriptions/event-types.js";
import { clip } from "../text/plain.js";
import { clientLocaleOf, noRequestScope } from "../ports/request-scope.js";
import { pyRstrip, pyStrip } from "../text/py-text.js";
import { replyParts } from "../turn/answer-parts.js";
import type { ProactiveDeps } from "./deps.js";
import { EXPIRES_KEY, REMOTE_SAID, finishedAt, type AnsweredInChat } from "./events.js";
import { remoteAskExpiry, zoneOf } from "./quiet.js";

/** What the person asked, as the name of a run in its card and in the line before a lost turn's answer. */
export const PROMPT_TITLE_MAX = 60;

function view(v: View): OutMessage {
  return { body: { type: "view", view: v, fallbackText: "" } };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export class Deliveries {
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

  /** What the assistant said (or a work item that needs the person and was not said). */
  private async sendSaid(userId: string, conversation: Conversation, event: JsonObject): Promise<boolean> {
    const remote = remoteNoticeOf(event);
    if (remote?.kind === "needs_you" && remote.ask !== undefined) {
      const shown = await this.sendRemoteAsk(userId, conversation, event, remote);
      if (shown !== undefined) return shown;
    }
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
    const receipt = this.deps.receipts.take(conversation.ref.id);
    const shown = receipt ? await receipt.shownWords() : "";
    const messages = this.deps.say.messages(userId, event, {
      linkFor: this.deps.deliveryLink,
      shown,
      head: said.head,
      replies: said.replies,
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
    event: JsonObject,
    options: { head: string; replies: readonly (readonly [string, string])[] },
  ) {
    const said = this.deps.say.messages(userId, event, { linkFor: this.deps.deliveryLink, ...options });
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
    const message = this.oneText(userId, both, options);
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
    const message = this.oneText(userId, event, options);
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
    const options = this.deps.remote.options(ask["options"]);
    if (!actionId || options.length === 0) return undefined;
    const now = store.now();
    const expiresAt = remoteAskExpiry(ask, now);
    if (expiresAt <= now) return false;
    const tool = str(ask["tool"]) || "an action";
    if (
      !store.remotePermissions.saveRemotePermission({
        userId,
        sessionId: remote.sessionId,
        actionId,
        tool,
        options,
        expiresAt,
      })
    ) {
      return false; // (one request, one card: the attached chat's reader, or an earlier delivery of this push, showed it)
    }
    const item = parseWorkItem(event["item"]);
    const prefs = store.prefs.getPrefs(userId);
    const card = this.deps.remote.askCard({
      ask,
      options,
      sessionId: remote.sessionId,
      machine: remote.machine,
      agent: remote.agent,
      about: item ? `#${String(item.seq)} ${item.title}` : "",
      expiresAt,
      zone: zoneOf(prefs),
      lang: answerLang(prefs.lang, this.clientLocale(), event["text"]),
    });
    try {
      await conversation.send(card);
    } catch (error) {
      store.remotePermissions.forgetRemotePermission(remote.sessionId, actionId); // (nobody saw it: Claw's retry must show it)
      throw error;
    }
    return true;
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
