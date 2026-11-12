// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Send on a choice the assistant put to the person (`assistant_choice`): what they picked becomes their next message, exactly as if
 * they had typed it, through the router's whole path (their rate, their chat, the assistant), so the assistant reads it as any
 * other message. The card is not trusted: its button carries only the id of the card this worker recorded, the options are read
 * from the record, and a pick the card never offered is no pick. A press claims the card first ('busy'), so of two presses exactly
 * one sends; it is 'done' only once the router took the message, and only then is the card replaced in place by what was sent (and
 * the same line said as a message: a phone does not redraw an edited card). A send that failed gives the card back to be pressed
 * again; one the worker never finished (it stopped mid-send) may be pressed again after `CHOICE_SEND_SECONDS`, and sends what
 * was claimed, under the same message id. In a group chat the press is the presser's message there.
 */
import { viewMessage } from "../approvals/click.js";
import { errorName } from "../errors.js";
import { assistantCardText } from "../locales/assistant-cards.js";
import type { Lang } from "../locales/lang.js";
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { ChoiceCard } from "../ports/store/assistant.js";
import type { StorePort } from "../ports/store/index.js";
import type { Logger } from "../ports/logger.js";
import type { InboundMessage } from "../ports/surface.js";
import { pyStr } from "../text/py-text.js";
import { finish } from "./finish.js";

export const CHOICE_VERB = "assistant_choice";
/** The id of a choice card's input, whose value is the picked options' places on the card ("0", "0,2"). */
export const CHOICE_INPUT = "choice";
/** How long a press may be sending before another press may take the card over (the first one's worker stopped mid-send). */
export const CHOICE_SEND_SECONDS = 120;

export interface ChoiceClickDeps {
  readonly store: Pick<StorePort, "assistantButtons">;
  /** Handles `message` as the router handles one the person typed (`Router.handle`); throws when it was not handled. */
  readonly deliver: (message: InboundMessage) => Promise<void>;
  readonly logger: Logger;
}

/** The options `value` picks on `card` (each named by its place), in the card's order; a place it never had is no pick. */
export function pickedOn(card: Pick<ChoiceCard, "options">, value: unknown): string[] {
  const places = new Set(
    pyStr(value)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^\d{1,2}$/.test(p))
      .map(Number),
  );
  return card.options.filter((_, i) => places.has(i));
}

/** The message a press sends: the presser's, in the chat it was pressed in, saying `text`, as a typed one is (to the bot, in a group). */
export function typedMessage(click: Pick<ClickRoute, "action" | "sender">, text: string, id: string): InboundMessage {
  const { action } = click;
  return {
    type: "message",
    id,
    sender: click.sender,
    conversation: action.conversation,
    locale: action.locale,
    clientPlatform: action.clientPlatform,
    text,
    mentioned: action.conversation.kind !== "personal",
    targeted: false,
    namesBotFirst: false,
    conversationName: "",
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    unreadableFiles: [],
    provenance: "typed",
  };
}

function langOf(card: ChoiceCard | null, click: ClickRoute): Lang {
  if (card?.lang === "zh" || card?.lang === "en") return card.lang;
  return click.lang();
}

export class AssistantChoiceClicks implements ClickHandler {
  readonly verbs = [CHOICE_VERB] as const;

  constructor(private readonly deps: ChoiceClickDeps) {}

  /** A 1:1 chat: answered with no Claw key (the message it sends is checked as any typed one is). */
  async beforeCredential(click: ClickRoute): Promise<boolean> {
    await this.press(click);
    return true;
  }

  async inGroup(click: ClickRoute): Promise<boolean> {
    await this.press(click);
    return true;
  }

  async press(click: ClickRoute): Promise<void> {
    const buttons = this.deps.store.assistantButtons;
    const card = buttons.getChoiceCard(pyStr(click.action.data["card"]));
    const lang = langOf(card, click);
    const t = assistantCardText.in(lang);
    // (in a 1:1 chat only its person's card; in a group chat whoever presses it answers, as whoever types there does)
    if (card === null || (click.conversation.ref.kind === "personal" && card.userId !== click.sender.id)) {
      await finish(click, t.choiceGone);
      return;
    }
    if (card.state === "done") {
      await this.sent(click, card, card.chosen, lang, false); // (pressed again: what was sent is shown, nothing is sent again)
      return;
    }
    // (a card left 'busy' is a send that never finished: what it claimed is what goes, under the same message id)
    const chosen = card.state === "busy" ? [...card.chosen] : pickedOn(card, click.action.data[CHOICE_INPUT]);
    if (!chosen.length || (!card.multiple && chosen.length > 1)) {
      await this.again(click, card, lang, t.choiceNone);
      return;
    }
    if (!buttons.claimChoiceCard(card.cardId, chosen, CHOICE_SEND_SECONDS)) {
      const now = buttons.getChoiceCard(card.cardId) ?? card; // (a double press loses here)
      if (now.state === "done") await this.sent(click, now, now.chosen, lang, false);
      else await click.settle(t.choiceSending({ answer: now.chosen.join(t.choiceJoin) }), { announce: false });
      return;
    }
    const text = chosen.join(t.choiceJoin);
    try {
      await this.deps.deliver(typedMessage(click, text, `${CHOICE_VERB}:${card.cardId}`));
    } catch (error) {
      buttons.moveChoiceCard(card.cardId, "open", { onlyFrom: "busy" });
      this.deps.logger.warn("a choice could not be sent; its card is given back", { error: errorName(error) });
      await this.again(click, card, lang, t.choiceFailed);
      return;
    }
    buttons.moveChoiceCard(card.cardId, "done", { onlyFrom: "busy" });
    await this.sent(click, card, chosen, lang, true);
  }

  /** The card back, open, with `note` under its options. */
  private async again(click: ClickRoute, card: ChoiceCard, lang: Lang, note: string): Promise<void> {
    const model = { ...this.model(card, lang), note };
    await click.settle(viewMessage({ name: "choiceCard", model }), { announce: false });
  }

  /** The card replaced by what was sent (said as a line too when `announce`). */
  private async sent(
    click: ClickRoute,
    card: ChoiceCard,
    chosen: readonly string[],
    lang: Lang,
    announce: boolean,
  ): Promise<void> {
    const t = assistantCardText.in(lang);
    const view = viewMessage({ name: "choiceChosen", model: { text: card.text, chosen, lang } });
    await click.settle(
      view,
      announce ? { fallback: t.choiceSent({ answer: chosen.join(t.choiceJoin) }) } : { announce: false },
    );
  }

  private model(card: ChoiceCard, lang: Lang) {
    return { text: card.text, cardId: card.cardId, options: card.options, multiple: card.multiple, note: "", lang };
  }
}
