// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The messages for an `assistant.say` or `work_item.needs_you` event, in order (teams_agent/assistant.py `say_activities`).
 *
 * - What was said, whole and once: a long text is split into up to three messages at paragraph breaks, never cut, after what the
 *   receipt already shows of it (`shown`). It is an AI answer: the AI label and the thumbs under it, a citation for each source it
 *   cites as [n], and the replies to tap under the last of its messages when no card follows.
 * - When the event's item holds a result that waits, a card with Accept and Stop; when it holds a write for the person, a card
 *   that lets it through or not; when it puts a command to the person, a card with Run and Cancel (each recorded first, so its
 *   buttons mean something). A card holds the words only when they are short and not shown already.
 * - Then a card for each file the item's worker delivered, with Claw's own download link.
 *
 * Every word of this worker's own is in the person's language, never in that of what was said.
 */
import type { SuggestedReply } from "../direct-chat/direct-chat.js";
import type { WorkItem } from "../claw/model.js";
import { answerLang } from "../language/detect.js";
import type { Lang } from "../locales/lang.js";
import type { StorePort } from "../ports/store/index.js";
import type { Citation, OutMessage, View } from "../ports/surface.js";
import { squashSpaces } from "../text/py-text.js";
import { replyParts } from "../turn/answer-parts.js";
import { citationsFromSources } from "./citations.js";
import { assistantDeliveries } from "../turn/deliveries.js";
import type { JsonObject } from "../json.js";
import { PULL_LINK, SUGGESTIONS_MAX, confirmActionOf, confirmWriteOf, suggestedRepliesOf } from "./events.js";
import { parseWorkItem } from "./item-of.js";
import { fitsWorkCard, workEventText } from "./work-items.js";

export type SayStore = Pick<StorePort, "prefs" | "assistantCards" | "assistantButtons">;

/** (worker session, delivery id) -> Claw's download link, or null. */
export type DeliveryLink = (sessionId: string, deliveryId: string) => string | null;

export interface SayOptions {
  readonly linkFor?: DeliveryLink | undefined;
  /** What the receipt already shows of the words. */
  readonly shown?: string;
  /** The first line of what is said (direct chat: Clawy's head). */
  readonly head?: string;
  /** Suggested replies of the worker's own, before Claw's. */
  readonly replies?: readonly SuggestedReply[];
}

export interface SayDeps {
  readonly store: SayStore;
  /** The router's test of a command typed whole (for a command the assistant puts to the person). */
  readonly exactCommand: (text: string) => boolean;
  /** The reply style's switches: citations and suggested replies under what the assistant said. */
  readonly style: () => { readonly citations: boolean; readonly suggestedReplies: boolean };
  /** The locale of the client the message being handled came from ("" none). */
  readonly clientLocale?: () => string;
}

type Event = Readonly<Record<string, unknown>>;

function view(v: View, fallbackText = ""): OutMessage {
  return { body: { type: "view", view: v, fallbackText } };
}

function toReplies(replies: readonly SuggestedReply[]) {
  return replies.map(([title, value]) => ({ title, value }));
}

export class SayPlanner {
  constructor(private readonly deps: SayDeps) {}

  /** The messages for `event` to `userId`, in order; [] when the event says nothing. */
  messages(userId: string, event: Event, options: SayOptions = {}): OutMessage[] {
    const item = parseWorkItem(event["item"]) ?? null;
    const files = this.fileCards(event, options.linkFor);
    const text = this.words(event, item, options.head ?? "", files);
    if (!text) return files.cards;
    const lang = answerLang(this.deps.store.prefs.getPrefs(userId).lang, this.deps.clientLocale?.() ?? "", text);
    const parts = replyParts(text, options.shown ?? "");
    const said = this.said(event, text, parts);
    const card = this.card(userId, event, item, {
      text,
      lang,
      inCard: !options.shown && parts.length === 1 && fitsWorkCard(text),
    });
    if (card === undefined)
      return [...this.withReplies(said, event, text, lang, options, files.cards.length > 0), ...files.cards];
    // (a card carries the words only when they are all of the reply, fit in it, and the receipt does not show them already)
    return [...(card.holdsWords ? [] : said), card.message, ...files.cards];
  }

  /** What is said: the event's words (or that its item needs the person), under `head`; the files' names when nothing else says. */
  private words(
    event: Event,
    item: WorkItem | null,
    head: string,
    files: { cards: OutMessage[]; names: string[] },
  ): string {
    let text = workEventText(item, event["text"]);
    if (head && text) text = `${head}\n\n${text}`;
    if (!text && files.names.length && !files.cards.length) text = `Files: ${files.names.join(", ")}`;
    return text;
  }

  /** A card for each delivered file Claw gives a link for, and the names of all of them. */
  private fileCards(event: Event, linkFor: DeliveryLink | undefined): { cards: OutMessage[]; names: string[] } {
    const files = assistantDeliveries(event as JsonObject);
    const cards = files.flatMap(([sessionId, delivery]) => {
      const url = linkFor?.(sessionId, delivery.id);
      return url ? [view({ name: "delivery", model: { delivery, url } })] : [];
    });
    return { cards, names: files.map(([, delivery]) => shownName(delivery.name)) };
  }

  /** The replies to tap, under the last of what was said, when no card follows. */
  private withReplies(
    said: OutMessage[],
    event: Event,
    text: string,
    lang: Lang,
    options: SayOptions,
    filesFollow: boolean,
  ): OutMessage[] {
    const last = said.at(-1);
    if (last === undefined || filesFollow) return said;
    const mine = options.replies ?? [];
    const own = suggestedRepliesOf(event, text, this.deps.style().suggestedReplies, lang).filter(
      ([t, v]) => !mine.some(([mt, mv]) => mt === t && mv === v),
    );
    const all = [...mine, ...own];
    return all.length
      ? [...said.slice(0, -1), { ...last, suggestions: toReplies(all.slice(0, SUGGESTIONS_MAX)) }]
      : said;
  }

  /**
   * The card with buttons the event asks for, recorded first: a result that waits, a write Claw holds, or a command put to the
   * person; undefined for none. `holdsWords`: the card shows the words, which are then not said apart.
   */
  private card(
    userId: string,
    event: Event,
    item: WorkItem | null,
    said: { text: string; lang: Lang; inCard: boolean },
  ): { message: OutMessage; holdsWords: boolean } | undefined {
    const inCard = said.inCard ? said.text : "";
    if (item?.canAccept)
      return { message: this.workCard(userId, item, said.text, inCard, said.lang), holdsWords: said.inCard };
    if (item !== null) return undefined;
    const held = confirmWriteOf(event);
    if (held !== undefined) {
      const cardId = this.deps.store.assistantButtons.addConfirmCard(
        userId,
        held.confirmationId,
        held.kind,
        held.allowLabel,
      );
      const model = { text: inCard || held.allowLabel, cardId, allowLabel: held.allowLabel, lang: said.lang };
      return { message: view({ name: "confirmWrite", model }), holdsWords: said.inCard };
    }
    const confirm = confirmActionOf(event, this.deps.exactCommand);
    if (confirm === undefined) return undefined;
    const command = `/${confirm.name} ${confirm.args}`.trim();
    const cardId = this.deps.store.assistantButtons.addActionCard(
      userId,
      confirm.channelMessageId,
      confirm.name,
      confirm.args,
    );
    return {
      message: view({ name: "actionCard", model: { text: inCard || command, cardId, command, lang: said.lang } }),
      holdsWords: said.inCard,
    };
  }

  /** What was said, as AI answers with thumbs, each with the citations its own words cite (when the whole text cites at all). */
  private said(event: Event, text: string, parts: readonly string[]): OutMessage[] {
    const cites =
      this.deps.style().citations &&
      event["type"] === "assistant.say" &&
      citationsFromSources(text, event["sources"]).length > 0;
    return parts.map((part) => {
      const citations: readonly Citation[] = cites ? citationsFromSources(part, event["sources"]) : [];
      return {
        body: { type: "rich", markdown: part, lead: false },
        aiGenerated: true,
        feedback: true,
        ...(citations.length ? { citations } : {}),
      };
    });
  }

  /** A result that waits: Accept and Stop, and (a task whose result names a pull request) auto-reply on or off. */
  private workCard(userId: string, item: WorkItem, text: string, inCard: string, lang: Lang): OutMessage {
    const { assistantCards } = this.deps.store;
    const watching = assistantCards.autoReply(userId, item.itemId) !== null && item.kind === "task";
    const watch = PULL_LINK.test(text) && item.kind === "task" && !watching;
    const cardId = assistantCards.addAssistantCard(userId, item.itemId, item.resultVersion, true);
    return view({ name: "workCard", model: { item, text: inCard, cardId, note: "", watch, watching, lang } });
  }
}

/** A file's name as it is said back in a message: inside a code span, one line, its backticks turned to quotes (inbound.shown_name). */
function shownName(name: string): string {
  const flat = squashSpaces(
    Array.from(name, (ch) => ((ch.codePointAt(0) ?? 0) <= 0x1f || ch === "\u007f" ? " " : ch)).join(""),
  ).replaceAll("`", "'");
  const cut = Array.from(flat).slice(0, SHOWN_NAME_MAX).join("");
  return cut ? `\`${cut}\`` : "a file";
}

const SHOWN_NAME_MAX = 100;
