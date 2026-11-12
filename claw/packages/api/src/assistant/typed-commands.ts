// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The commands a user types back to their assistant, in the language they are answered in.
 *
 * A card the user may answer by typing (`approve #a3f9c2` / `批准 #a3f9c2`, `deny #a3f9c2` / `拒绝 #a3f9c2`) and a memory entry they may
 * take back (`undo #12` / `撤销 #12`) are read in either language (`approvalCommand`, `denialCommand`, `memory_undo`). What the user is
 * told to type must be in the language of the conversation: tool results that spelt it in Chinese only were repeated word for word into
 * English answers ("Say 撤销 #1343 to undo it", "or reply 批准 #5ec155", 2026-11-09). So every such hint is made here, from the turn's
 * reply language (`language.ts`), never written into a tool result or a card by hand.
 */
import { replyLanguageFor, type ChosenLanguage } from "./language.js";

export type TypedCommand = "approve" | "deny" | "undo";
/** Chinese, or English for every other language: the commands are read in these two only. */
export type CommandLanguage = "zh" | "en";

const WORDS: Readonly<Record<TypedCommand, Readonly<Record<CommandLanguage, string>>>> = {
  approve: { zh: "批准", en: "approve" },
  deny: { zh: "拒绝", en: "deny" },
  undo: { zh: "撤销", en: "undo" },
};

/** The commands' language for a reply language as `language.ts` names it ("Chinese", "English", …; null when it cannot be told). */
export function commandLanguage(replyLanguage: string | null | undefined): CommandLanguage {
  return replyLanguage === "Chinese" ? "zh" : "en";
}

/**
 * The commands' language for the message a turn answers: the language the user chose in their channel (`chosen`,
 * `channel_context.reply_language`) when they chose one, else the message's, and failing that (`ok`, `#3`) the user's earlier ones, newest first.
 */
export async function commandLanguageOf(
  message: string, earlier: () => Promise<readonly string[]> | readonly string[] = () => [], chosen: ChosenLanguage | null = null,
): Promise<CommandLanguage> {
  return commandLanguage(await replyLanguageFor(chosen, message, earlier));
}

/** The command exactly as the user types it: `approve #a3f9c2`, `批准 #a3f9c2`, `undo #12`. */
export function typedCommand(command: TypedCommand, ref: string | number, lang: CommandLanguage): string {
  return `${WORDS[command][lang]} #${ref}`;
}

/**
 * The command for a text whose reader's language is not known when it is written (what the router is shown before it answers): the
 * English form, then the Chinese one, for the router to give the one of the language it answers in (`approve #a3f9c2 (批准 #a3f9c2)`).
 */
export function typedCommandEither(command: TypedCommand, ref: string | number): string {
  return `${typedCommand(command, ref, "en")} (${typedCommand(command, ref, "zh")})`;
}

/** How the router is told to give these commands: the same words in every prompt that names one. */
export const TYPED_COMMANDS_RULE = "A command the user types back to you (approve #ref, deny #ref, undo #N) is given to them in the language you answer in: "
  + "批准 #ref, 拒绝 #ref and 撤销 #N in Chinese, approve #ref, deny #ref and undo #N in any other; both forms are read whatever the language, "
  + "so never give an English user the Chinese form.";
