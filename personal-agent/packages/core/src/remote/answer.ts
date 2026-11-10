// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { masked as redactText } from "./inert.js";
import type { Lang } from "../locales/lang.js";
import { ANSWER_CHARS_MAX, ANSWER_MESSAGES_MAX } from "./limits.js";
import { cpLength, cpSlice, pyLstrip, pyRstrip, pyStrip } from "../text/py-text.js";
import { remoteText } from "../locales/remote.js";

/** `text` cut into pieces of at most `limit` characters, at a paragraph break (else a line break) past half the limit. */
export function splitAtParagraphs(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (cpLength(rest) > limit) {
    const window = cpSlice(rest, 0, limit);
    let cut = limit;
    for (const sep of ["\n\n", "\n"]) {
      const index = window.lastIndexOf(sep);
      const at = index < 0 ? -1 : cpLength(window.slice(0, index));
      if (at > Math.floor(limit / 2)) {
        cut = at;
        break;
      }
    }
    chunks.push(pyRstrip(cpSlice(rest, 0, cut)));
    rest = pyLstrip(cpSlice(rest, cut), "\n");
  }
  chunks.push(rest);
  return chunks;
}

/** The messages that carry a remote agent's final text: split at paragraph boundaries, at most ANSWER_MESSAGES_MAX, and what is
 * beyond that cut with a line saying so (the rest is in the session on the machine). Credentials are masked. */
export function answerParts(text: string, lang: Lang = "en"): string[] {
  const body = redactText(pyStrip(text)) || remoteText.in(lang).noTextOutput;
  const chunks = splitAtParagraphs(body, ANSWER_CHARS_MAX);
  if (chunks.length <= ANSWER_MESSAGES_MAX) return chunks;
  const kept = chunks.slice(0, ANSWER_MESSAGES_MAX - 1);
  kept.push(`${chunks[ANSWER_MESSAGES_MAX - 1] ?? ""}${remoteText.in(lang).answerShortened}`);
  return kept;
}

/** The messages for what a remote agent said on its own, between turns: the answer's parts, the first headed with who said it,
 * so it is not read as the reply to the user's last message. `typed`: it answers what was typed at the terminal the chat shares. */
export function unsolicitedParts(label: string, text: string, lang: Lang = "en", typed = false): string[] {
  const parts = answerParts(text, lang);
  const words = remoteText.in(lang);
  const head = (typed ? words.unsolicitedTyped : words.unsolicitedOwn)({ label });
  parts[0] = `${head}\n\n${parts[0] ?? ""}`;
  return parts;
}
