// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How a final answer is cut into the messages that carry it. */

import { turnEnglish } from "../locales/turn.js";
import { pyLen, pyLstrip, pyRfind, pyRstrip, pySlice, pyStrip } from "../text/python-str.js";

export const MAX_ANSWER_CHARS = 3000;
/** A long answer: at most this many messages (1:1 and group alike), then the link. */
export const MAX_ANSWER_MESSAGES = 3;
export const WHOLE_CUT_NOTE = turnEnglish.wholeCutNote;

/** The web console's page of a session. */
export function deepLink(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl}/primus-claw/${sessionId}`;
}

/** Where `window` is best cut: at its last paragraph (else line) break past its middle that `fits`; else at its end. */
function cutOf(window: string, limit: number, fits: (at: number) => boolean = () => true): number {
  for (const sep of ["\n\n", "\n"]) {
    const at = pyRfind(window, sep);
    if (at > Math.floor(limit / 2) && fits(at)) return at;
  }
  return limit;
}

function splitAtParagraphs(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (pyLen(rest) > limit) {
    const cut = cutOf(pySlice(rest, 0, limit), limit);
    chunks.push(pyRstrip(pySlice(rest, 0, cut)));
    rest = pyLstrip(pySlice(rest, cut), "\n");
  }
  chunks.push(rest);
  return chunks;
}

/**
 * The messages that carry a final answer: the whole answer split at paragraph boundaries, at most MAX_ANSWER_MESSAGES
 * messages, and only what is beyond that is left to the link. In a group the link says that only the asker can open it
 * (it opens the asker's own Claw session). `lead` is one line in front of the answer.
 */
export function answerParts(text: string, link: string, group = false, lead = ""): string[] {
  let whole = pyStrip(text) || turnEnglish.noTextOutput;
  if (lead) whole = `${lead}\n\n${whole}`;
  const chunks = splitAtParagraphs(whole, MAX_ANSWER_CHARS);
  if (chunks.length <= MAX_ANSWER_MESSAGES) return chunks;
  const kept = chunks.slice(0, MAX_ANSWER_MESSAGES - 1);
  const last = chunks[MAX_ANSWER_MESSAGES - 1] ?? "";
  const label = turnEnglish.openFullAnswer + (group ? turnEnglish.onlyTheAsker : "");
  return [...kept, `${last}\n\n${turnEnglish.shortened}\n\n[${label}](${link})`];
}

/**
 * `text` as at most `most` messages of at most `limit` characters, each cut at a paragraph or line break when one is near
 * enough, and never shortened when it fits in `most` messages: a cut is taken only where what is left still fits in the
 * messages after it. Only a longer text has its last message end in a note that the rest was cut.
 */
export function wholeParts(text: string, limit = MAX_ANSWER_CHARS, most = MAX_ANSWER_MESSAGES): string[] {
  const parts: string[] = [];
  let rest = pyStrip(text);
  while (pyLen(rest) > limit && parts.length < most - 1) {
    const roomAfter = limit * (most - 1 - parts.length);
    const length = pyLen(rest);
    const cut = cutOf(pySlice(rest, 0, limit), limit, (at) => length - at <= roomAfter);
    parts.push(pyRstrip(pySlice(rest, 0, cut)));
    rest = pyLstrip(pySlice(rest, cut), "\n");
  }
  if (pyLen(rest) > limit) rest = pyRstrip(pySlice(rest, 0, limit - pyLen(WHOLE_CUT_NOTE))) + WHOLE_CUT_NOTE;
  parts.push(rest);
  const kept = parts.filter((p) => p);
  return kept.length ? kept : [""];
}

/**
 * The messages of the assistant's reply `text` (`wholeParts`), after the words its receipt already shows (`shown`): when
 * they are a longer start of the reply than the first message would be, they are the first message and the rest follows.
 */
export function replyParts(text: string, shown = ""): string[] {
  const parts = wholeParts(text);
  const core = pyRstrip(shown);
  if (core && text.startsWith(core) && pyLen(core) > pyLen(parts[0] ?? "")) {
    const rest = text.slice(core.length);
    return [shown, ...(pyStrip(rest) ? wholeParts(rest) : [])];
  }
  return parts;
}
