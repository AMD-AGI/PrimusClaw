// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Chinese typography for card text: half-width , : ; ? ! ( ) next to Chinese become full-width, and the blanks around them go
 * (Chinese puts none there). Inline code, markdown links and bare URLs keep theirs.
 */
import { cpLength, cpSlice, pyRstrip, pyStr, pyStrip, squashSpaces, own } from "@primusclaw/personal-agent";

/** The CJK ranges the card kit treats as Chinese (CJK ideographs, compatibility ideographs, CJK punctuation, full-width forms). */
export const CJK = "[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]";

const HALF_TO_FULL: Readonly<Record<string, string>> = { ",": "，", ":": "：", ";": "；", "?": "？", "!": "！" };
// (every repetition is bounded or stops at the next delimiter, so no pattern backtracks over a long run of one character)
const AFTER_CJK = new RegExp(`(?<=${CJK}) ?([,:;?!])(?![A-Za-z0-9_/.]{0,40}://) ?`, "g");
const BEFORE_CJK = new RegExp(` ?([,;?!]) ?(?=${CJK})`, "g");
const CODE = /(`[^`]*`|\[[^[\]]*\]\([^()\s]*\)|https?:\/\/\S+)/;
const HAS_CJK = new RegExp(CJK);
const BETWEEN_CJK = new RegExp(`(?<=${CJK})(?=${CJK})`, "g");

export function hasCjk(text: unknown): boolean {
  return HAS_CJK.test(pyStr(text));
}

function full(half: string): string {
  return own(HALF_TO_FULL, half) ?? half;
}

/**
 * `(...)` around text with Chinese in it as `（...）`, its blanks stripped: `\(([^()\n]*CJK[^()\n]*)\)`, as one scan
 * (the regular expression backtracks quadratically on a long run after a "(" that never closes).
 */
function fullWidthParens(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("(", i);
    if (open < 0) break;
    let j = open + 1;
    while (j < text.length && !"()\n".includes(text.charAt(j))) j += 1;
    const inner = text.slice(open + 1, j);
    if (text.charAt(j) === ")" && HAS_CJK.test(inner)) {
      out += `${text.slice(i, open)}（${pyStrip(inner)}）`;
      i = j + 1;
    } else {
      out += text.slice(i, j);
      i = j;
    }
  }
  return out + text.slice(i);
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
    parts[i] = fullWidthParens(part);
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
