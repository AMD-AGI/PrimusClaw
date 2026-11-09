// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { redactText } from "./pending-redact.js";
import type { Lang } from "../locales/lang.js";
import { ANSWER_CHARS_MAX, ANSWER_MESSAGES_MAX } from "./limits.js";
import { length, lstripChars, rstrip, slice, strip } from "./py-text.js";
import { remoteText } from "../locales/remote.js";

/** `text` cut into pieces of at most `limit` characters, at a paragraph break (else a line break) past half the limit. */
export function splitAtParagraphs(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (length(rest) > limit) {
    const window = slice(rest, 0, limit);
    let cut = limit;
    for (const sep of ["\n\n", "\n"]) {
      const index = window.lastIndexOf(sep);
      const at = index < 0 ? -1 : length(window.slice(0, index));
      if (at > Math.floor(limit / 2)) {
        cut = at;
        break;
      }
    }
    chunks.push(rstrip(slice(rest, 0, cut)));
    rest = lstripChars(slice(rest, cut), "\n");
  }
  chunks.push(rest);
  return chunks;
}

/** The messages that carry a remote agent's final text: split at paragraph boundaries, at most ANSWER_MESSAGES_MAX, and what is
 * beyond that cut with a line saying so (the rest is in the session on the machine). Credentials are masked. */
export function answerParts(text: string, lang: Lang = "en"): string[] {
  const body = redactText(strip(text)) || remoteText.in(lang).noTextOutput;
  const chunks = splitAtParagraphs(body, ANSWER_CHARS_MAX);
  if (chunks.length <= ANSWER_MESSAGES_MAX) return chunks;
  const kept = chunks.slice(0, ANSWER_MESSAGES_MAX);
  kept[kept.length - 1] += remoteText.in(lang).answerShortened;
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
