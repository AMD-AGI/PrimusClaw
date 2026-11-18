// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Character references in HTML text: `unescape` turns `&amp;`, `&#39;`, `&#x1F600;`, `&nbsp` ... into the characters they
 * stand for, with the rules of Python's `html.unescape` (which `HTMLParser(convert_charrefs=True)` applies to text and to
 * attribute values): numeric references exactly (the Windows-1252 remapping of 0x80-0x9F, U+FFFD for 0, surrogates and
 * values past U+10FFFF, nothing for the code points HTML calls invalid), every HTML5 name (`html5-entities.ts`, Python's
 * own table), and Python's "longest known prefix" rule for the names that may go without a semicolon (`&ampx` is "&x").
 */
import { HTML5_ENTITIES } from "./html5-entities.js";

function buildTables(): { legacy: ReadonlyMap<string, string>; named: ReadonlyMap<string, string> } {
  const named = new Map<string, string>();
  const legacy = new Map<string, string>();
  for (const entry of HTML5_ENTITIES.split("|")) {
    const [name = "", hex = ""] = entry.split("=");
    const value = hex
      .split(",")
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join("");
    named.set(name, value);
    if (!name.endsWith(";")) legacy.set(name, value);
  }
  return { legacy, named };
}

const { legacy: LEGACY, named: NAMED } = buildTables();

/** Python's `html._invalid_charrefs`: what 0, CR and the Windows-1252 range 0x80-0x9F stand for. */
const WINDOWS_1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f" + "\x90‘’“”•–—˜™š›œ\x9džŸ";

/** Python's `html._invalid_codepoints` (0x80-0x9F are remapped before this is asked). */
function isInvalidCodePoint(num: number): boolean {
  return (
    (num >= 0x1 && num <= 0x8) ||
    num === 0xb ||
    (num >= 0xe && num <= 0x1f) ||
    (num >= 0x7f && num <= 0x9f) ||
    (num >= 0xfdd0 && num <= 0xfdef) ||
    (num & 0xfffe) === 0xfffe
  );
}

const MAX_DIGITS = 8;

function numericRef(digits: string, radix: number): string {
  const trimmed = digits.replace(/^0+/, "");
  // More digits than U+10FFFF has (in either radix) is past it; parseInt would lose precision long before.
  const num = trimmed.length > MAX_DIGITS ? Infinity : trimmed === "" ? 0 : parseInt(trimmed, radix);
  if (num === 0) return "�";
  if (num === 0x0d) return "\r";
  if (num >= 0x80 && num <= 0x9f) return WINDOWS_1252[num - 0x80] ?? "";
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
  if (isInvalidCodePoint(num)) return "";
  return String.fromCodePoint(num);
}

function namedRef(name: string): string {
  const whole = NAMED.get(name);
  if (whole !== undefined) return whole;
  // The longest name that may go without a semicolon and starts the text, the rest kept: `&ampx` is "&x".
  const points = Array.from(name);
  for (let x = points.length - 1; x > 1; x--) {
    const value = LEGACY.get(points.slice(0, x).join(""));
    if (value !== undefined) return value + points.slice(x).join("");
  }
  return `&${name}`;
}

/** Python's `html._charref`: linear (each alternative is bounded or consumes what it reads). */
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/** `html.unescape(text)`. */
export function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (_whole, ref: string) => {
    if (!ref.startsWith("#")) return namedRef(ref);
    const hex = ref[1] === "x" || ref[1] === "X";
    const digits = ref.slice(hex ? 2 : 1).replace(/;$/, "");
    return numericRef(digits, hex ? 16 : 10);
  });
}
