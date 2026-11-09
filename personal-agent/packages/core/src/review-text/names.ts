// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pyCasefold, pyIsAlnum } from "../text/py-regex.js";

/**
 * How a person's name is found in what someone wrote (github_review.py's name reading, shared by the review request
 * reader and the assistant's channel context). A person is a JSON object as the channel gives it: `name`, and, when
 * known, `givenName`, `surname`, `email`, `userPrincipalName`.
 */
export type PersonRecord = Readonly<Record<string, unknown>>;

/** `str(value or "")`. */
export function textOf(value: unknown): string {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return "";
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

/** A bracketed part of a display name ("Lin Mei (Shanghai)"). */
export const PAREN = /[(（][^)）]*[)）]/gu;
/** A Chinese character. */
export const CJK = /[一-鿿]/u;

/** A word ends where Chinese meets anything else ("帮我请linmei" is two words). */
const SCRIPT_RUN = /[一-鿿]+|[^一-鿿]+/gu;
const NOT_WORD = /[^\p{L}\p{N}_]+|_/u;

/** The words of a text, case left out: split at spaces, punctuation and "_", and where Chinese meets a letter or digit. */
export function tokens(text: string): string[] {
  return pyCasefold(text)
    .split(NOT_WORD)
    .flatMap((part) => part.match(SCRIPT_RUN) ?? [])
    .filter((t) => t !== "");
}

/** Text as a name is compared in it: case, spaces and punctuation left out. */
export function flat(text: string): string {
  return Array.from(pyCasefold(text))
    .filter((ch) => pyIsAlnum(ch))
    .join("");
}

const sortedKey = (words: readonly string[]): string => [...words].sort().join("\u0000");

/**
 * Every way a person's name may be written, flattened: the display name with or without its bracketed part, its words
 * in either order, given name and surname, and the account name of their address with or without its digits.
 */
export function memberKeys(member: PersonRecord): Set<string> {
  const keys = new Set<string>();
  const name = textOf(member["name"]);
  for (const variant of new Set([name, name.replace(PAREN, "")])) {
    const words = tokens(variant);
    if (words.length)
      for (const k of [words.join(""), [...words].reverse().join(""), [...words].sort().join("")]) keys.add(k);
  }
  const given = flat(textOf(member["givenName"]));
  const family = flat(textOf(member["surname"]));
  if (given && family) {
    keys.add(given + family);
    keys.add(family + given);
  }
  for (const address of [member["email"], member["userPrincipalName"]]) {
    const local = flat(textOf(address).split("@")[0] ?? "");
    if (local) {
      keys.add(local);
      keys.add(local.replace(/[0-9]+$/u, ""));
    }
  }
  keys.delete("");
  return keys;
}

/**
 * The words of `name` stand next to each other in `text`, in any order, or `name` written run together as one word of
 * it. Whole words only. A Chinese name runs into the words around it, so one is found inside a word with Chinese in it.
 */
export function writtenIn(name: string, text: string): boolean {
  const want = tokens(name);
  const words = tokens(text);
  if (want.length === 0) return false;
  const key = sortedKey(want);
  for (let i = 0; i + want.length <= words.length; i++)
    if (sortedKey(words.slice(i, i + want.length)) === key) return true;
  const joined = want.length === 1 ? want.join("") : flat(name);
  if (words.includes(joined)) return true;
  return CJK.test(joined) && Array.from(joined).length >= 2 && words.some((w) => CJK.test(w) && w.includes(joined));
}

/** Letters `start..end` of word `i`, as positions. */
function lettersOf(i: number, start: number, end: number, at: Set<string>): void {
  for (let c = start; c < end; c++) at.add(`${String(i)}:${String(c)}`);
}

function nameWordsAt(words: readonly string[], name: readonly string[], at: Set<string>): void {
  const n = name.length;
  const key = sortedKey(name);
  for (let i = 0; i + n <= words.length; i++) {
    if (sortedKey(words.slice(i, i + n)) !== key) continue;
    for (let j = i; j < i + n; j++) lettersOf(j, 0, Array.from(words[j] ?? "").length, at);
  }
}

function chineseNameAt(words: readonly string[], one: string, at: Set<string>): void {
  const size = Array.from(one).length;
  words.forEach((w, i) => {
    if (w === one) return;
    const letters = Array.from(w);
    for (let k = 0; k + size <= letters.length; k++) {
      if (letters.slice(k, k + size).join("") === one) lettersOf(i, k, k + size, at);
    }
  });
}

/**
 * Where in a text of these words the member's name is written, as `word:letter` positions (empty: nowhere): the words
 * of their display name next to each other in any order, or one word that is a way of writing their name run together
 * (at least 4 letters), or a Chinese name inside a word with Chinese in it. A one-word name shorter than 3 letters (2 for
 * a Chinese one) is never taken to be written.
 */
export function namedIn(words: readonly string[], member: PersonRecord): Set<string> {
  const at = new Set<string>();
  const name = tokens(textOf(member["name"]).replace(PAREN, ""));
  const [first] = name;
  if (first !== undefined) {
    const size = Array.from(first).length;
    if (name.length > 1 || size >= 3 || (size >= 2 && CJK.test(first))) {
      nameWordsAt(words, name, at);
      if (name.length === 1 && CJK.test(first)) chineseNameAt(words, first, at);
    }
  }
  const keys = new Set([...memberKeys(member)].filter((k) => Array.from(k).length >= 4));
  words.forEach((w, i) => {
    if (keys.has(w)) lettersOf(i, 0, Array.from(w).length, at);
  });
  return at;
}
