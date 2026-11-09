// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a review request names people: words of a name in any order, run together or not, a mention by its id, and a group's
 * member list. Only an exact way of writing a member's name ever counts; a resemblance is offered back, never acted on.
 */

import { cpHead, decimalBigInt, squashSpaces } from "../text/py-text.js";
import type { InboundMention, RosterMember } from "../ports/surface.js";
import { MARK_CLOSE, MARK_OPEN } from "./pull-ref.js";
import { withoutBracketed } from "./text/scan.js";
import { casefold, codePoints, flat, unique } from "./text/unicode.js";

/** One person @mentioned in a message: the channel's id for them, their directory id ('' not given) and display name. */
export type Mention = Pick<InboundMention, "channelUserId" | "userId" | "name">;

export type { RosterMember };

export const MAX_CANDIDATES = 5;

const MARKUP = /[`<>*_[\]()#|\\]/gu;
const CJK = /[一-鿿]/u;
const SCRIPT_RUN = /[一-鿿]+|[^一-鿿]+/gu;

export function markerPattern(): RegExp {
  return new RegExp(`${MARK_OPEN}(\\p{Nd}+)${MARK_CLOSE}`, "gu");
}

/** The mention indexes a text's markers name, in order. */
export function markerIndexes(text: string): number[] {
  // (a marker number past what a number holds exactly is no mention's: it is past every list)
  return markerKeys(text).map((k) => (k.length > 15 ? Number.POSITIVE_INFINITY : Number(k)));
}

/** The markers' numbers as exact decimal strings (Python's `int` of each), to compare markers of any length. */
export function markerKeys(text: string): string[] {
  return [...text.matchAll(markerPattern())].map((m) => (decimalBigInt(m[1] ?? "") ?? 0n).toString());
}

export function withoutMarkers(text: string): string {
  return text.replace(markerPattern(), " ");
}

export function withoutParens(text: string): string {
  return withoutBracketed(text);
}

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** A display name as a prompt or a message carries it: one line, no markup, at most 60 characters. */
export function displayName(value: string): string {
  return cpHead(squashSpaces(value.replace(MARKUP, " ")), 60);
}

/** Text that came from outside as one plain line: no markup, at most `limit` characters. */
export function oneLine(value: unknown, limit: number): string {
  return cpHead(squashSpaces(plainText(value).replace(MARKUP, " ")), limit);
}

/** A value from outside as text: a string as it is, a number as written, anything else (or nothing) as ''. */
export function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && value !== 0) return String(value);
  return "";
}

/** A name compared as words: case and runs of space left out. */
export function normName(name: string): string {
  return squashSpaces(casefold(name));
}

/** Strings sorted by code point (Python's `sorted`). */
export function sortedCp(values: readonly string[]): string[] {
  return [...values].sort(compareCp);
}

function compareCp(a: string, b: string): number {
  const x = codePoints(a);
  const y = codePoints(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The words of a text, case left out: split at spaces, punctuation and "_", and where Chinese meets a letter or a digit
 * ("帮我请linmei" is two words, never one that hides the name).
 */
export function tokens(text: string): string[] {
  return casefold(text)
    .split(/[^\p{L}\p{N}_]+|_/u)
    .flatMap((part) => part.match(SCRIPT_RUN) ?? [])
    .filter(Boolean);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  const x = sortedCp(a);
  const y = sortedCp(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

/**
 * The words of `name` stand next to each other in `text`, in any order, or `name` is written run together as one word of
 * it. Whole words only; a Chinese name runs into the words around it, so one is found inside a word that has Chinese.
 */
export function writtenIn(name: string, text: string): boolean {
  const want = tokens(name);
  const words = tokens(text);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= words.length; i += 1) {
    if (sameWords(words.slice(i, i + want.length), want)) return true;
  }
  const joined = want.length === 1 ? want.join("") : flat(name);
  if (words.includes(joined)) return true;
  return hasCjk(joined) && codePoints(joined).length >= 2 && words.some((w) => hasCjk(w) && w.includes(joined));
}

/** A mention's id: the channel's id for the person, else their directory id, else their name. */
export function mentionId(mention: Mention): string {
  return mention.channelUserId || mention.userId || mention.name;
}

function keysOfWho(who: string, mentions: readonly Mention[]): Set<string> {
  const refs = markerIndexes(who).filter((i) => i < mentions.length);
  const named = refs.map((r) => mentions[r]?.name ?? "");
  const names = named.length ? named : [withoutMarkers(who)];
  const keys = new Set(refs.map((r) => `id:${mentionId(mentions[r] as Mention)}`));
  for (const n of names) {
    if (tokens(n).length) keys.add(`w:${sortedCp(tokens(withoutParens(n))).join("")}`);
    if (flat(n)) keys.add(`f:${flat(withoutParens(n))}`);
  }
  return keys;
}

/** Two ways a request names its reviewer (markers of mentions, or typed words) are the same person. */
export function samePerson(a: string, b: string, mentions: readonly Mention[]): boolean {
  const x = keysOfWho(a, mentions);
  return [...keysOfWho(b, mentions)].some((k) => x.has(k));
}

/** The reviewer a reading gives is the one the rules' span names: the same person, or written inside that span. */
export function namedWithin(who: string, span: string, mentions: readonly Mention[]): boolean {
  if (samePerson(span, who, mentions)) return true;
  const refs = markerKeys(who);
  if (refs.length) {
    const inSpan = new Set(markerKeys(span));
    return refs.every((r) => inSpan.has(r));
  }
  return writtenIn(who, withoutMarkers(span));
}

/** Who a reviewer the model wrote is, to tell two people apart: a mention's id (by id or display name), else the name, flat. */
export function personOf(who: string, mentions: readonly Mention[]): string {
  const said = squashSpaces(who);
  for (const m of mentions) {
    if (said === mentionId(m) || flat(said) === flat(m.name)) return `id:${mentionId(m)}`;
  }
  return `name:${flat(said)}`;
}

/**
 * Every way a person's name may be written, flat: the display name with or without its bracketed part, its words in either
 * order, given name and surname, and the account name of their address with or without its digits.
 */
export function memberKeys(member: RosterMember): Set<string> {
  const keys = new Set<string>();
  for (const variant of unique([member.name, withoutParens(member.name)])) {
    const words = tokens(variant);
    if (!words.length) continue;
    keys.add(words.join(""));
    keys.add([...words].reverse().join(""));
    keys.add(sortedCp(words).join(""));
  }
  const given = flat(member.givenName);
  const family = flat(member.surname);
  if (given && family) {
    keys.add(given + family);
    keys.add(family + given);
  }
  for (const address of [member.email, member.userPrincipalName]) {
    const local = flat(address.split("@")[0] ?? "");
    if (local) {
      keys.add(local);
      keys.add(local.replace(/[0-9]+$/u, ""));
    }
  }
  keys.delete("");
  return keys;
}

/** Positions in a text's words, as "word:letter" keys. */
export type Place = ReadonlySet<string>;

function whole(words: readonly string[], i: number): string[] {
  return Array.from({ length: (words[i] ?? "").length }, (_, c) => `${String(i)}:${String(c)}`);
}

function windowPlaces(words: readonly string[], name: readonly string[]): string[] {
  const at: string[] = [];
  for (let i = 0; i + name.length <= words.length; i += 1) {
    if (!sameWords(words.slice(i, i + name.length), name)) continue;
    for (let j = i; j < i + name.length; j += 1) at.push(...whole(words, j));
  }
  return at;
}

function insidePlaces(words: readonly string[], name: string): string[] {
  const at: string[] = [];
  words.forEach((w, i) => {
    if (w === name) return;
    for (let k = w.indexOf(name); k >= 0; k = w.indexOf(name, k + 1)) {
      for (let c = k; c < k + name.length; c += 1) at.push(`${String(i)}:${String(c)}`);
    }
  });
  return at;
}

function writable(name: readonly string[]): boolean {
  const [only = ""] = name;
  const length = codePoints(only).length;
  return name.length > 1 || length >= 3 || (length >= 2 && hasCjk(only));
}

/**
 * Where in a text of these words the member's name is written (empty: nowhere): the words of their display name next to
 * each other in any order, one word that is a way of writing their name run together (at least 4 letters), or a Chinese
 * name inside a word with Chinese in it. Letters, not words, so a name inside a longer one is seen to be part of it.
 */
export function namedIn(words: readonly string[], member: RosterMember): Place {
  const at = new Set<string>();
  const name = tokens(withoutParens(member.name));
  if (name.length && writable(name)) {
    for (const p of windowPlaces(words, name)) at.add(p);
    const [only = ""] = name;
    if (name.length === 1 && hasCjk(only)) for (const p of insidePlaces(words, only)) at.add(p);
  }
  const keys = [...memberKeys(member)].filter((k) => codePoints(k).length >= 4);
  words.forEach((w, i) => {
    if (keys.includes(w)) for (const p of whole(words, i)) at.add(p);
  });
  return at;
}

/** (the members a typed name is, the members it only resembles). */
export function memberMatches(
  typed: string,
  members: readonly RosterMember[],
): { readonly hits: RosterMember[]; readonly near: RosterMember[] } {
  const stripped = tokens(withoutParens(typed));
  const words = stripped.length ? stripped : tokens(typed);
  const wanted = new Set([words.join(""), sortedCp(words).join("")].filter(Boolean));
  const hits = members.filter((m) => [...memberKeys(m)].some((k) => wanted.has(k)));
  const joined = words.join("");
  const near = members.filter(
    (m) =>
      !hits.includes(m) &&
      Boolean(joined) &&
      [...memberKeys(m), ...tokens(m.name)].some(
        (k) => k.includes(joined) || (codePoints(k).length >= 3 && joined.includes(k)),
      ),
  );
  return { hits, near: near.slice(0, MAX_CANDIDATES) };
}

/** The names of up to MAX_CANDIDATES members, as they are offered back. */
export function memberNames(members: readonly RosterMember[]): string {
  return members
    .slice(0, MAX_CANDIDATES)
    .map((m) => displayName(m.name) || "?")
    .join("、");
}
