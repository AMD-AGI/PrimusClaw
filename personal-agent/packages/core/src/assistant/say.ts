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
import type { StorePort } from "../ports/store/index.js";
import type { Citation, OutMessage, View } from "../ports/surface.js";
import { squashSpaces } from "../text/py-text.js";
import { replyParts } from "../turn/answer-parts.js";
import { citationsFromSources } from "./citations.js";
import { assistantDeliveries } from "./deliveries.js";
import { PULL_LINK, confirmActionOf, confirmWriteOf, suggestedRepliesOf } from "./events.js";
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
    let text = workEventText(item, event["text"]);
    if (options.head && text) text = `${options.head}\n\n${text}`;
    const files = assistantDeliveries(event);
    const linked = files.flatMap((f) => {
      const url = options.linkFor?.(f.sessionId, f.delivery.id);
      return url ? [view({ name: "delivery", model: { delivery: f.delivery, url } })] : [];
    });
    if (!text && files.length && !linked.length) {
      text = `Files: ${files.map((f) => shownName(f.delivery.name)).join(", ")}`;
    }
    if (!text) return linked;
    const lang = answerLang(this.deps.store.prefs.getPrefs(userId).lang, this.deps.clientLocale?.() ?? "", text);
    const parts = replyParts(text, options.shown ?? "");
    const said = this.said(event, text, parts);
    const held = item === null ? confirmWriteOf(event) : undefined;
    const confirm = item === null && held === undefined ? confirmActionOf(event, this.deps.exactCommand) : undefined;
    if (!item?.canAccept && held === undefined && confirm === undefined) {
      const last = said.at(-1);
      if (last !== undefined && !linked.length) {
        const own = suggestedRepliesOf(event, text, this.deps.style().suggestedReplies, lang).filter(
          ([t, v]) => !(options.replies ?? []).some(([rt, rv]) => rt === t && rv === v),
        );
        said[said.length - 1] = { ...last, suggestions: toReplies([...(options.replies ?? []), ...own]) };
      }
      return [...said, ...linked];
    }
    // (a card carries the words only when they are all of the reply, fit in it, and the receipt does not show them already)
    const inCard = !options.shown && parts.length === 1 && fitsWorkCard(text) ? text : "";
    const before = inCard ? [] : said;
    if (item?.canAccept) return [...before, this.workCard(userId, item, text, inCard, lang), ...linked];
    if (held !== undefined) {
      const cardId = this.deps.store.assistantButtons.addConfirmCard(
        userId,
        held.confirmationId,
        held.kind,
        held.allowLabel,
      );
      const model = { text: inCard || held.allowLabel, cardId, allowLabel: held.allowLabel, lang };
      return [...before, view({ name: "confirmWrite", model }), ...linked];
    }
    const { channelMessageId, name, args } = confirm as NonNullable<typeof confirm>;
    const command = `/${name} ${args}`.trim();
    const cardId = this.deps.store.assistantButtons.addActionCard(userId, channelMessageId, name, args);
    return [
      ...before,
      view({ name: "actionCard", model: { text: inCard || command, cardId, command, lang } }),
      ...linked,
    ];
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
  private workCard(userId: string, item: WorkItem, text: string, inCard: string, lang: string): OutMessage {
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
