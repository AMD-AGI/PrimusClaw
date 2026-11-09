// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Chinese typography for card text: half-width , : ; ? ! ( ) next to Chinese become full-width, and the blanks around them go
 * (Chinese puts none there). Inline code, markdown links and bare URLs keep theirs.
 */
import { cpLength, cpSlice, pyRstrip, pyStrip, squashSpaces } from "@primusclaw/personal-agent";

import { pyStr } from "../text/py-extra.js";

/** The CJK ranges the card kit treats as Chinese (CJK ideographs, compatibility ideographs, CJK punctuation, full-width forms). */
export const CJK = "[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]";

const HALF_TO_FULL: Readonly<Record<string, string>> = { ",": "，", ":": "：", ";": "；", "?": "？", "!": "！" };
// (every repetition is bounded or stops at the next delimiter, so no pattern backtracks over a long run of one character)
const AFTER_CJK = new RegExp(`(?<=${CJK}) ?([,:;?!])(?![A-Za-z0-9_/.]{0,40}://) ?`, "g");
const BEFORE_CJK = new RegExp(` ?([,;?!]) ?(?=${CJK})`, "g");
const PARENS = new RegExp(`\\(([^()\\n]*${CJK}[^()\\n]*)\\)`, "g");
const CODE = /(`[^`]*`|\[[^[\]]*\]\([^()\s]*\)|https?:\/\/\S+)/;
const HAS_CJK = new RegExp(CJK);
const BETWEEN_CJK = new RegExp(`(?<=${CJK})(?=${CJK})`, "g");

export function hasCjk(text: unknown): boolean {
  return HAS_CJK.test(pyStr(text));
}

function full(half: string): string {
  return HALF_TO_FULL[half] ?? half;
}

/** `text` with the half-width punctuation next to Chinese made full-width. Text without Chinese is returned as is. */
export function zh(text: unknown): string {
  const value = pyStr(text);
  if (!hasCjk(value)) return value;
  const parts = value.split(CODE);
  for (let i = 0; i < parts.length; i += 2) {
    // (the odd parts are code, links and URLs)
    let part = parts[i] ?? "";
    part = part.replace(AFTER_CJK, (_m, half: string) => full(half));
    part = part.replace(BEFORE_CJK, (_m, half: string) => full(half));
    parts[i] = part.replace(PARENS, (_m, inner: string) => `（${pyStrip(inner)}）`);
  }
  return parts.join("");
}

/** `text` on one line, at most `limit` characters (code points), an ellipsis marking a cut. */
export function clip(text: unknown, limit: number): string {
  const line = squashSpaces(pyStr(text));
  return cpLength(line) <= limit ? line : pyRstrip(cpSlice(line, 0, limit - 1)) + "…";
}

/** A word joiner between Chinese characters, so a FactSet's name column does not break "作者" one character to a line. */
export function unbroken(name: string): string {
  return name.replace(BETWEEN_CJK, "⁠");
}
