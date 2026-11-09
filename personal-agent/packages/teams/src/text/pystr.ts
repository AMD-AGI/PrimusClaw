/**
 * String operations with Python's semantics, where a port must count and cut text exactly as the Python worker did:
 * lengths and slices in code points (not UTF-16 units), and Python's set of whitespace (`str.isspace`), which differs
 * from JavaScript's `\s` (Python counts U+001C..U+001F and U+0085 as space; JavaScript counts U+FEFF).
 */

const SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python's `str.isspace` for one character. */
export function isSpace(char: string): boolean {
  const code = char.codePointAt(0);
  return code !== undefined && SPACE.has(code);
}

/** The code points of `text` (Python's view of a string). */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Python's `len(text)`. */
export function pyLen(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Python's `text[start:end]` for non-negative bounds, in code points. */
export function pySlice(text: string, start: number, end?: number): string {
  return codePoints(text).slice(start, end).join("");
}

/** Python's `text.split()` (no separator): runs of whitespace separate, and no empty words. */
export function pySplit(text: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const char of text) {
    if (isSpace(char)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

/** `" ".join(text.split())`: whitespace collapsed to single blanks, none at either end. */
export function collapse(text: string): string {
  return pySplit(text).join(" ");
}

/** Python's `text.rstrip()`. */
export function rstrip(text: string): string {
  const chars = codePoints(text);
  let end = chars.length;
  while (end > 0 && isSpace(chars[end - 1] ?? "")) end -= 1;
  return chars.slice(0, end).join("");
}

/** Python's `text.lstrip()`. */
export function lstrip(text: string): string {
  const chars = codePoints(text);
  let start = 0;
  while (start < chars.length && isSpace(chars[start] ?? "")) start += 1;
  return chars.slice(start).join("");
}

/** Python's `text.strip()`. */
export function strip(text: string): string {
  return lstrip(rstrip(text));
}

/** Python's `str(value or "")` for the values a card or a message is built from. */
export function str(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  if (value === true) return "True";
  return String(value);
}
