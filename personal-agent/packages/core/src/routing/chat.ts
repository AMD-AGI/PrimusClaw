// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { answerLang, writtenLang } from "../language/detect.js";
import type { Lang } from "../locales/lang.js";
import type { Logger } from "../ports/logger.js";
import type { SettleOptions } from "../ports/routing.js";
import {
  richMessage,
  textMessage,
  type Conversation,
  type InboundAction,
  type OutMessage,
  type UserRef,
} from "../ports/surface.js";
import { pyLstrip } from "../text/py-text.js";
import type { RouterStore } from "./deps.js";
import type { NoteFactory } from "./features.js";

/**
 * The language a person is answered in (the Python `Agent._lang_of`): what they said (`/lang`), else the language of
 * what they last wrote, else, while nothing they wrote has said it, the language of their client (`locale`).
 */
export function langOf(store: Pick<RouterStore, "prefs">, userId: string, locale: string): Lang {
  return answerLang(userId ? store.prefs.getPrefs(userId).lang : "", locale);
}

/**
 * The person is answered in the language they write in: one message is enough. A typed command says nothing, nor does a
 * word of the menu, a link, a name or a word or two (`writtenLang`); after `/lang` nothing they write changes it.
 */
export function learnLang(store: Pick<RouterStore, "prefs">, userId: string, words: string): void {
  if (pyLstrip(words).startsWith("/")) return;
  const lang = writtenLang(words);
  if (lang !== undefined) store.prefs.learnLang(userId, lang);
}

/**
 * The language help is said in: the person's, unless the words that asked for it are in a language of their own ("你能做什么",
 * "what can you do") and the person did not choose one (`/lang`).
 */
export function helpLang(
  store: Pick<RouterStore, "prefs">,
  userId: string,
  locale: string,
  asked: string | undefined,
): Lang {
  const prefs = store.prefs.getPrefs(userId);
  const written = asked !== undefined && !prefs.langSet ? writtenLang(asked) : undefined;
  return written ?? langOf(store, userId, locale);
}

/** One chat as the router answers in it: who wrote, where to answer, and in which language. */
export class Chat {
  constructor(
    private readonly store: Pick<RouterStore, "prefs">,
    readonly sender: UserRef,
    readonly conversation: Conversation,
    /** "" for the person's 1:1 chat, the conversation id of a group. */
    readonly scope: string,
    /** The client's locale of the event being handled ("" for work that runs on its own). */
    readonly locale: string,
  ) {}

  lang(): Lang {
    return langOf(this.store, this.sender.id, this.locale);
  }

  zh(): boolean {
    return this.lang() === "zh";
  }

  say(text: string): Promise<void> {
    return this.conversation.send(textMessage(text));
  }

  sayRich(markdown: string): Promise<void> {
    return this.conversation.send(richMessage(markdown));
  }

  send(message: OutMessage): Promise<void> {
    return this.conversation.send(message);
  }
}

/**
 * THE way a click ends (the Python `Agent._close_card`): the clicked card is replaced, by `card` or by a note saying it,
 * and the outcome is said in a new message too, because a phone does not redraw an edited message. A click with no line
 * (paging, opening a menu: the new card is the outcome) says nothing new. When there is no card to edit, or the edit
 * failed, the line is said in any case; a failed edit never loses an outcome that was carried out. True when replaced.
 */
export async function settleClick(
  click: { readonly action: InboundAction; readonly conversation: Conversation; readonly note: NoteFactory },
  logger: Logger,
  card: OutMessage | string,
  options: SettleOptions = {},
): Promise<boolean> {
  const fallback = typeof card === "string" ? (options.fallback ?? card) : options.fallback;
  const message = typeof card === "string" ? click.note(card) : card;
  let replaced = false;
  if (click.action.cardMessageId) {
    try {
      await click.conversation.update(click.action.cardMessageId, message);
      replaced = true;
    } catch (error) {
      logger.warn("the clicked card could not be replaced", { verb: click.action.verb, error: errorName(error) });
    }
  }
  if (fallback && ((options.announce ?? true) || !replaced)) {
    try {
      await click.conversation.send(textMessage(fallback));
    } catch (error) {
      if (!replaced) throw error;
      logger.warn("the outcome of the click could not be said as a message", {
        verb: click.action.verb,
        error: errorName(error),
      });
    }
  }
  return replaced;
}
