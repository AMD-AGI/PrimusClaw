// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { BOT_NAME } from "../branding.js";
import { ClawAnswerInvalid, ClawError, ClawUnreachable, errorKind } from "../claw/errors.js";
import type { JsonObject } from "../json.js";
import { OBSERVE_TEXT as T } from "../locales/observe.js";
import { noteMessage } from "../note/note.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { Logger } from "../ports/logger.js";
import type { ClickHandler, ClickRoute, MessageInterceptor, MessageRoute } from "../ports/routing.js";
import type { LinkRepository } from "../ports/store/link.js";
import type { ObserveCard, ObserveRepository } from "../ports/store/observe.js";
import { textMessage, type Conversation, type InboundMessage } from "../ports/surface.js";
import type { Observing } from "../routing/features.js";
import { cpHead, pyStrip } from "../text/py-text.js";
import { parseObserve, scopeOf, type ObserveVerb } from "./command.js";
import { describe } from "./suggestions.js";
import { ObserveBoard } from "./board.js";
import { suggestionButtons } from "./views.js";

/**
 * Observing a group chat for one person: what their assistant would do there, written down and never done.
 *
 * `/observe on`, said in a group by a person on the list (empty: nobody, the feature is off), makes that person's
 * assistant the group's observer: every message of the group not addressed to the bot then goes to Claw with that
 * person's own key, and Claw records what the assistant would do and does nothing. The group is told; anybody in it can
 * turn it off. What it would do comes back on that person's /board as suggestions (`board.ts`), carried out only on
 * Accept and exactly as shown: a reply is posted in the group as the card read, anything else is handed to their
 * assistant as their own request.
 */

/** The longest message Claw hands an observer. */
const CONTENT_MAX = 8000;
/** The group's own words, as background to an accepted suggestion. */
const BACKGROUND_MAX = 1000;

export interface ObserverDeps {
  readonly observe: ObserveRepository;
  readonly links: Pick<LinkRepository, "getKey">;
  readonly assistant: Pick<ClawAssistantPort, "observeScope" | "observe" | "observations" | "session" | "send">;
  /** Who may turn it on (TEAMS_OBSERVE_USERS, any case); empty: nobody. */
  readonly users: readonly string[];
  /** A conversation from the reference the store kept for a group (the channel's `ConversationRef.wire`). */
  readonly conversationOf: (wire: JsonObject) => Conversation;
  /** CLAW_PLUGIN_ID, named on the request an accepted suggestion becomes. */
  readonly pluginId: number | undefined;
  readonly log: Logger;
}

type Finish = (text: string, again?: string) => Promise<void>;

export class Observer implements Observing {
  private readonly users: ReadonlySet<string>;
  private readonly boardReader: ObserveBoard;

  constructor(private readonly deps: ObserverDeps) {
    this.users = new Set(deps.users.map((u) => u.toLowerCase()));
    this.boardReader = new ObserveBoard(deps);
  }

  get enabled(): boolean {
    return this.users.size > 0;
  }

  mayTurnOn(userId: string): boolean {
    return this.users.has(userId.toLowerCase());
  }

  /** `/observe on|off|status` in a group (before the account check: on needs the person's key, off and status none). */
  readonly interceptor: MessageInterceptor = {
    name: "observe",
    intercept: async (route) => {
      const verb = parseObserve(route.text);
      if (verb === undefined) return false;
      await this.command(route, verb);
      return true;
    },
  };

  /** Accept and Dismiss under a suggestion card (1:1, with the person's key). */
  readonly clicks: ClickHandler = {
    verbs: ["observe"],
    withCredential: (click, credential) => this.onClick(click, credential),
  };

  board(userId: string, credential: string, conversation: Conversation): Promise<void> {
    return this.boardReader.show(userId, credential, conversation);
  }

  private async command(route: MessageRoute, verb: ObserveVerb): Promise<void> {
    const { conversation } = route;
    const id = conversation.ref.id;
    const say = (text: string): Promise<void> => conversation.send(textMessage(text));
    if (verb === "usage") await say(T.usage({ bot: BOT_NAME }));
    else if (verb === "status") await say(this.deps.observe.groupObserver(id) ? T.isOn({ bot: BOT_NAME }) : T.notOn);
    else if (verb === "off") {
      // anybody in the group may: it only takes something away
      await say(this.deps.observe.unobserveGroup(id) !== null ? T.noticeOff : T.notOn);
      this.deps.log.info("observe: turned off in a group");
    } else await this.turnOn(route, say);
  }

  private async turnOn(route: MessageRoute, say: (text: string) => Promise<void>): Promise<void> {
    const { sender, conversation } = route;
    if (!this.mayTurnOn(sender.id)) return say(T.notAllowed);
    const scope = scopeOf(conversation.ref.id, conversation.caps.channel);
    if (scope === undefined) return say(T.noScope);
    const key = this.deps.links.getKey(sender.id); // their own key: it is their assistant, on their quota
    if (key === null) return say(T.notLinked);
    try {
      await this.deps.assistant.observeScope(key, scope);
    } catch (err) {
      if (err instanceof ClawError)
        return say(err.status === 404 ? T.clawOff : T.clawFailed({ status: String(err.status) }));
      if (err instanceof ClawUnreachable || err instanceof ClawAnswerInvalid) return say(T.clawFailed({ status: "—" }));
      throw err;
    }
    this.deps.observe.observeGroup(conversation.ref.id, {
      userId: sender.id,
      scope,
      reference: conversation.ref.wire as JsonObject,
      name: route.message.conversationName,
    });
    this.deps.log.info("observe: turned on in a group");
    return say(T.noticeOn({ who: sender.name || T.turnedOnBy, bot: BOT_NAME }));
  }

  /**
   * A group message not addressed to the bot. In a group nobody observes: nothing (not read, kept or logged). In an
   * observed one: to the observer's assistant with the observer's key, as who said it and what.
   */
  async forward(message: InboundMessage): Promise<void> {
    const observer = this.deps.observe.groupObserver(message.conversation.id);
    if (observer === null || !this.mayTurnOn(observer.userId)) return; // (taken off the list since: nothing more goes)
    const text = pyStrip(message.text);
    if (!text) return;
    const key = this.deps.links.getKey(observer.userId);
    if (key === null) return; // (unlinked since: unlinking drops the group too; this only covers a race with it)
    const content = cpHead(`${message.sender.name || "someone"}: ${text}`, CONTENT_MAX);
    try {
      await this.deps.assistant.observe(key, observer.scope, content, message.id || "-");
    } catch (err) {
      if (!(err instanceof ClawError || err instanceof ClawUnreachable)) throw err;
      this.deps.log.warn("observe: a group message was not recorded", { why: errorKind(err) });
    }
  }

  /** A press under a suggestion card: only its own person's, and of two presses one is carried out. */
  private async onClick(click: ClickRoute, credential: string): Promise<void> {
    const finish: Finish = async (text, again) => {
      const card = again === undefined ? text : noteMessage({ text, buttons: suggestionButtons(again) });
      await click.settle(card, again === undefined ? {} : { fallback: text });
    };
    const data = click.action.data;
    const card = this.deps.observe.getObserveCard(typeof data["card"] === "string" ? data["card"] : "");
    const op = data["op"];
    if (card === null || card.userId !== click.sender.id || (op !== "accept" && op !== "dismiss")) {
      return finish(T.cardGone);
    }
    if (!this.deps.observe.moveObserveCard(card.cardId, "busy", "open")) return finish(T.cardUsed);
    if (op === "dismiss") {
      this.deps.observe.moveObserveCard(card.cardId, "dismissed");
      return finish(T.dismissed);
    }
    return card.tool === "say" ? this.postReply(card, click, finish) : this.handOver(card, credential, finish);
  }

  private async postReply(card: ObserveCard, click: ClickRoute, finish: Finish): Promise<void> {
    const reference = this.deps.observe.observedReference(card.conversationId);
    if (reference === null) {
      this.deps.observe.moveObserveCard(card.cardId, "dismissed");
      return finish(T.groupGone);
    }
    const { what } = describe(card.tool, parseArgs(card.args));
    try {
      await this.deps.conversationOf(reference).send(textMessage(what + T.footer({ who: click.sender.name || "?" })));
    } catch (err) {
      // (it may have gone out all the same: never posted twice, so the suggestion is spent)
      this.deps.log.warn("observe: an accepted reply may not have been posted in its group", { why: errorKind(err) });
      this.deps.observe.moveObserveCard(card.cardId, "unsure");
      return finish(T.unsureInGroup);
    }
    this.deps.observe.moveObserveCard(card.cardId, "accepted");
    this.deps.log.info("observe: an accepted reply was posted in its group");
    return finish(T.posted);
  }

  /** Anything but a reply: the person's own request to their own assistant, which answers in their 1:1 chat. */
  private async handOver(card: ObserveCard, key: string, finish: Finish): Promise<void> {
    const { kind, what } = describe(card.tool, parseArgs(card.args));
    const request = T.acceptedRequest({ kind, what, message: cpHead(card.message, BACKGROUND_MAX) });
    const reopen = (): Promise<void> => {
      this.deps.observe.moveObserveCard(card.cardId, "open");
      return finish(T.assistantDown, card.cardId);
    };
    const unsure = (): Promise<void> => {
      this.deps.observe.moveObserveCard(card.cardId, "unsure");
      return finish(T.unsureWithAssistant);
    };
    let sessionId: string;
    try {
      sessionId = (await this.deps.assistant.session(key)).sessionId; // nothing is sent yet: it can be pressed again
    } catch (err) {
      if (!isClawFailure(err)) throw err;
      this.deps.log.warn("observe: the assistant could not be found for an accepted suggestion", {
        why: errorKind(err),
      });
      return reopen();
    }
    try {
      await this.deps.assistant.send(key, sessionId, request, plugin(this.deps.pluginId));
    } catch (err) {
      if (!isClawFailure(err)) throw err;
      this.deps.log.warn("observe: an accepted suggestion was not taken", { why: errorKind(err) });
      // Claw answered below 500 and took nothing: it can be pressed again; a 5xx or no answer may have been taken.
      return err instanceof ClawError && err.status < 500 ? reopen() : unsure();
    }
    this.deps.observe.moveObserveCard(card.cardId, "accepted");
    this.deps.log.info("observe: an accepted suggestion was handed to the assistant");
    return finish(T.handed);
  }
}

function isClawFailure(err: unknown): boolean {
  return err instanceof ClawError || err instanceof ClawUnreachable || err instanceof ClawAnswerInvalid;
}

function plugin(pluginId: number | undefined): { plugin?: number } {
  return pluginId === undefined ? {} : { plugin: pluginId };
}

/** The stored arguments of a suggestion; what does not parse is no arguments. */
function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}
