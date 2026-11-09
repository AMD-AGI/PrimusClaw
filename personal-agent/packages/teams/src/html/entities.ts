// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Character references in HTML text: `unescape` turns `&amp;`, `&#39;`, `&#x1F600;`, `&nbsp` ... into the characters they
 * stand for, with the rules of Python's `html.unescape` (which `HTMLParser(convert_charrefs=True)` applies to text and to
 * attribute values).
 *
 * Numeric references are exact: the Windows-1252 remapping of 0x80-0x9F, U+FFFD for 0, surrogates and values past
 * U+10FFFF, and nothing for the code points HTML calls invalid. Named references cover a subset of HTML5's 2,231 names:
 *  - all 106 names that may be written without a semicolon (the Latin-1 letters and signs, `amp`, `lt`, `gt`, `quot` and
 *    their upper-case aliases), with and without the semicolon, including Python's "longest known prefix" rule
 *    (`&ampx` is "&x", `&notit;` is "¬it;");
 *  - every HTML5 name that starts with one of those (`&notin;`, `&ltri;` ...), so the prefix rule never cuts a name
 *    Python knows whole;
 *  - the common typographic ones (`&apos;`, `&hellip;`, `&mdash;`, quotes, arrows, spaces, ...).
 * Difference from Python: any other HTML5 name (`&alpha;`, `&Sigma;` ...) is left as written instead of being decoded.
 */

/** The names of U+00A0 ... U+00FF, in code point order: each may be written without its semicolon. */
const LATIN1 = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro " +
  "para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil " +
  "Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave " +
  "Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml " +
  "igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute " +
  "thorn yuml"
).split(" ");

/** The other names that may be written without a semicolon. */
const LEGACY_OTHER: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  COPY: "©",
  REG: "®",
};

/** Names that need their semicolon, as "name hex[+hex]" pairs. */
const WITH_SEMICOLON =
  "centerdot B7 copysr 2117 divideontimes 22C7 gtcc 2AA7 gtcir 2A7A gtdot 22D7 gtlPar 2995 gtquest 2A7C gtrapprox 2A86 " +
  "gtrarr 2978 gtrdot 22D7 gtreqless 22DB gtreqqless 2A8C gtrless 2277 gtrsim 2273 ltcc 2AA6 ltcir 2A79 ltdot 22D6 " +
  "lthree 22CB ltimes 22C9 ltlarr 2976 ltquest 2A7B ltri 25C3 ltrie 22B4 ltrif 25C2 ltrPar 2996 notin 2209 " +
  "notindot 22F5+338 notinE 22F9+338 notinva 2209 notinvb 22F7 notinvc 22F6 notni 220C notniva 220C notnivb 22FE " +
  "notnivc 22FD parallel 2225 timesb 22A0 timesbar 2A31 timesd 2A30 apos 27 hellip 2026 mdash 2014 ndash 2013 " +
  "lsquo 2018 rsquo 2019 sbquo 201A ldquo 201C rdquo 201D bdquo 201E bull 2022 trade 2122 euro 20AC larr 2190 " +
  "uarr 2191 rarr 2192 darr 2193 harr 2194 ensp 2002 emsp 2003 thinsp 2009 zwnj 200C zwj 200D lrm 200E rlm 200F " +
  "dagger 2020 Dagger 2021 permil 2030 prime 2032 Prime 2033 oline 203E minus 2212 le 2264 ge 2265 ne 2260 " +
  "infin 221E check 2713 cross 2717 hearts 2665";

function buildTables(): { legacy: ReadonlyMap<string, string>; named: ReadonlyMap<string, string> } {
  const legacy = new Map<string, string>();
  LATIN1.forEach((name, i) => legacy.set(name, String.fromCodePoint(0xa0 + i)));
  for (const [name, value] of Object.entries(LEGACY_OTHER)) legacy.set(name, value);
  const named = new Map<string, string>();
  for (const [name, value] of legacy) {
    named.set(name, value);
    named.set(`${name};`, value);
  }
  const pairs = WITH_SEMICOLON.split(" ");
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const value = (pairs[i + 1] ?? "")
      .split("+")
      .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
      .join("");
    named.set(`${pairs[i] ?? ""};`, value);
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

/** `html.unescape(text)`, for the names listed above. */
export function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (_whole, ref: string) => {
    if (!ref.startsWith("#")) return namedRef(ref);
    const hex = ref[1] === "x" || ref[1] === "X";
    const digits = ref.slice(hex ? 2 : 1).replace(/;$/, "");
    return numericRef(digits, hex ? 16 : 10);
  });
}
