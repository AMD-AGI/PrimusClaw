// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The agent's output as the window shows it: masked by credential shape before it is cut, so a cut cannot leave half of one. */
import type { Lang } from "../../locales/lang.js";
import { remoteWindowText } from "../../locales/remote-window.js";
import { length, lstripChars, rstrip, slice, strip } from "../../remote-view/py-text.js";
import { redactText } from "../../security/redact.js";
import type { SentFrom, WindowMode } from "./view.js";

/** One message of "完整输出". */
export const FULL_PART_CHARS = 3000;
export const FULL_PARTS_MAX = 12;

export function masked(text: string): string {
  return redactText(text).text;
}

/**
 * The last `lines` lines of `text` that fit in `chars` characters (masked first), and whether anything before them was left out.
 */
export function tailLines(text: string, chars: number, lines: number): { lines: string[]; cut: boolean } {
  const body = rstrip(masked(text));
  if (!body) return { lines: [], cut: false };
  const picked: string[] = [];
  let size = 0;
  const raw = body.split("\n");
  for (const line of [...raw].reverse()) {
    if (picked.length >= lines || (size + length(line) > chars && picked.length > 0)) break;
    picked.push(length(line) > chars ? slice(line, -chars) : line);
    size += length(line) + 1;
  }
  picked.reverse();
  return { lines: picked, cut: picked.length < raw.length || length(raw[0] ?? "") > chars };
}

/**
 * "完整输出": the whole output kept, masked, in messages of FULL_PART_CHARS at most, cut at line ends where it can; the last
 * FULL_PARTS_MAX of them (what came before is on the machine).
 */
export function fullParts(text: string): string[] {
  let rest = strip(masked(text));
  const parts: string[] = [];
  while (rest) {
    if (length(rest) <= FULL_PART_CHARS) {
      parts.push(rest);
      break;
    }
    const window = slice(rest, 0, FULL_PART_CHARS);
    const at = window.lastIndexOf("\n");
    const cutAt = at < 0 ? -1 : length(window.slice(0, at));
    const cut = cutAt > Math.floor(FULL_PART_CHARS / 2) ? cutAt : FULL_PART_CHARS;
    parts.push(rstrip(slice(rest, 0, cut)));
    rest = lstripChars(slice(rest, cut), "\n");
  }
  return parts.slice(-FULL_PARTS_MAX);
}

/** The line over what was last sent to the session, by where it was typed. */
export function sentLabel(source: SentFrom, lang: Lang): string {
  const words = remoteWindowText.in(lang);
  if (source === "quote") return words.sentFromQuote;
  if (source === "chat") return words.sentFromChat;
  return words.sentFromCard;
}

/**
 * Where what is typed goes, said on the card (and by /help): the chat box to the assistant, the card's box to the session; or, in
 * `chat` mode, everything to the session but what starts with @ the assistant. `bot`: the assistant's display name.
 */
export function chatBoxLine(window: string, lang: Lang, bot: string): string {
  const words = remoteWindowText.in(lang);
  return window === "card" ? words.chatBoxCard({ bot }) : words.chatBoxChat({ bot });
}

/** What `/agent mode card|chat` answers. */
export function modeSetLine(window: WindowMode, lang: Lang, attached: boolean, bot: string): string {
  const words = remoteWindowText.in(lang);
  const now = attached ? words.thisChatToo : "";
  return window === "card" ? words.modeSetCard({ bot, now }) : words.modeSetChat({ bot, now });
}
