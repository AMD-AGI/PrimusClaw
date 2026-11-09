/**
 * Small text helpers that keep Python's semantics where the routing rules depend on them: `str.split()` (runs of whitespace,
 * no empty words), `str.strip(chars)`, and the value of a decimal digit of any script (`int()` reads `１２` as 12).
 */

/** The words of `text`, as Python's `str.split()` gives them: split on runs of whitespace, no empty words. */
export function words(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word !== "");
}

/** `text` split at the first run of whitespace into at most two parts, after trimming (Python's `str.split(None, 1)`). */
export function splitOnce(text: string): string[] {
  const trimmed = text.replace(/^\s+/u, "");
  if (trimmed === "") return [];
  const match = /\s+/u.exec(trimmed);
  if (match === null) return [trimmed];
  const rest = trimmed.slice(match.index + match[0].length);
  return rest === "" ? [trimmed.slice(0, match.index)] : [trimmed.slice(0, match.index), rest];
}

/** Python's `str.strip(chars)`: every character in `chars` is removed from both ends. */
export function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text.charAt(start))) start += 1;
  while (end > start && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Python's `str.rstrip(chars)`. */
export function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** Python's `str.lstrip(chars)`. */
export function lstripChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text.charAt(start))) start += 1;
  return text.slice(start);
}

const DECIMAL = /^\p{Nd}$/u;

function isDecimal(codePoint: number): boolean {
  return codePoint >= 0 && DECIMAL.test(String.fromCodePoint(codePoint));
}

/** The value of one decimal digit of any script (every run of decimal digits in Unicode is a whole number of 0-9 runs). */
function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  let start = codePoint;
  while (isDecimal(start - 1)) start -= 1;
  return (codePoint - start) % 10;
}

/** Python's `int(text)` for a string of decimal digits (`\d+` as Python's `re` matches it); NaN for anything else. */
export function decimalInt(text: string): number {
  if (text === "" || !/^\p{Nd}+$/u.test(text)) return Number.NaN;
  let value = 0;
  for (const char of text) value = value * 10 + digitValue(char);
  return value;
}

/** Python's `str.isdigit()` for what the routing rules read: every character a decimal digit, and at least one. */
export function isDigits(text: string): boolean {
  return /^\p{Nd}+$/u.test(text);
}

/** Python's `str.isupper()`: at least one cased character, and none in lower case. */
export function isUpper(text: string): boolean {
  return text !== text.toLowerCase() && text === text.toUpperCase();
}

/** Python's `" ".join(text.split())`. */
export function squash(text: string): string {
  return words(text).join(" ");
}
