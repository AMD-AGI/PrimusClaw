// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The name a client's people call the assistant by (`channel_context.assistant_name`). Claw names no client itself: a name is only
 * ever the client's, and the prompts quote it as a name.
 */

/** The longest assistant name kept, and the most words it may have: a longer one is no name. */
export const ASSISTANT_NAME_MAX = 32;
export const ASSISTANT_NAME_WORDS_MAX = 4;

/**
 * The assistant's name as a client sends it: letters, digits, plain spaces and `_ ' -`, at most ASSISTANT_NAME_MAX characters and
 * ASSISTANT_NAME_WORDS_MAX words once its runs of spaces are one; a tab, line break or any sentence punctuation makes it no name.
 * Anything else is no name (undefined), never a reason to refuse the message. The name goes into the router's system prompt, so it is
 * kept to what a name is: short, one line, no markup, quote or sentence, and the prompt quotes it as a name only (`quotedName`).
 */
export function assistantNameOf(raw: unknown): string | undefined {
  // A line break (or any other control or separator but the plain space) is never part of a name: it is no name.
  if (typeof raw !== "string" || /[^\S ]/u.test(raw)) return undefined;
  const name = raw.replace(/ +/g, " ").trim();
  if (name.length > ASSISTANT_NAME_MAX || name.split(" ").length > ASSISTANT_NAME_WORDS_MAX) return undefined;
  return /^[\p{L}\p{N}](?:[\p{L}\p{N} _'-]*[\p{L}\p{N}])?$/u.test(name) ? name : undefined;
}

/** A client's assistant name as the prompt writes it: quoted, so that it reads as a name and never as an instruction. */
export function quotedName(name: string): string {
  return `"${name}"`;
}
