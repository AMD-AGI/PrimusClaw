// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The language each group chat is answered in, as its members set it (`@bot /lang en|zh|auto`, "这个群用英文", or a pick on the
 * card the bot posts the first time it is @mentioned there). `auto`: each question is answered in the language it is asked in.
 * A chat the card was put to and nobody answered yet is kept as asked (`lang` ""), so it is never asked again. Who set it is
 * never stored: the announcement names them once, in the chat.
 */
export type GroupLanguage = "zh" | "en" | "auto";

export interface GroupLanguageRepository {
  /** The chat's language; "" when it was asked and nobody chose; null when it was never asked nor set. */
  groupLanguage(conversationId: string): GroupLanguage | "" | null;
  /** Sets it (anyone in the chat may). */
  setGroupLanguage(conversationId: string, lang: GroupLanguage): void;
  /**
   * Records that the chat is asked now: true when this call recorded it (it was never asked nor set), false when it was already, in
   * one step, so that two @mentions at once put one card.
   */
  markGroupLanguageAsked(conversationId: string): boolean;
  /** The question could not be put after all: the chat is asked again next time (nothing is undone once somebody chose). */
  unmarkGroupLanguageAsked(conversationId: string): void;
}
