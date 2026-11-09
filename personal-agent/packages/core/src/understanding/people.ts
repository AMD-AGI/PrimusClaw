// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { asksReviewOnly, modelFieldPattern, saysReviewAndMerge } from "../review-text/asks.js";
import { memberKeys, namedIn, tokens, writtenIn } from "../review-text/names.js";
import { prShortPattern, prUrlPattern, pullsIn } from "../review-text/pull-ref.js";
import { flat } from "../review-text/text/unicode.js";
import { rosterOf, textOf, type PersonRecord } from "./record.js";
import { isAsciiAlpha } from "../text/py-regex.js";
import { cpLength, pyCasefold } from "../text/py-text.js";
import { similarity } from "../text/sequence-matcher.js";
import { CONTEXT_ITEMS_MAX, CONTEXT_TEXT_MAX, clip } from "./limits.js";

/** One person the message names, as the channel context carries them. */
export interface NamedPerson {
  readonly name: string;
  /** Their Claw user id as their link recorded it (absent: not linked). */
  readonly user_id?: string;
  readonly email?: string;
  readonly source: "mention" | "known" | "near";
}

/** A channel mention (`{mentioned: {name, aadObjectId, id}}`). */
export type MentionRecord = Readonly<Record<string, unknown>>;

/** The Claw user id of a person by their channel id (null: not linked, or no id recorded). */
export type UserIdOf = (channelUserId: string) => string | null | undefined;

/** A review request that names nobody offers at most this many people it may have meant. */
export const NEAR_MAX = 3;
/** How alike a written word and a way of writing a name must be (difflib's ratio): "linme" and "linmei" are 0.91. */
export const NEAR_RATIO = 0.8;
/** Latin words shorter than this are never taken for a misspelt name. */
const NEAR_WORD_MIN = 4;

/** The text with its pull requests (links, owner/repo#N) and "model: X" fields left out: what may name a person. */
export function withoutRefs(text: string): string {
  return text.replace(prUrlPattern(), " ").replace(prShortPattern(), " ").replace(modelFieldPattern(), " ");
}

class People {
  readonly out: NamedPerson[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly userIdOf: UserIdOf) {}

  add(name: string, aad: string, source: NamedPerson["source"], email = ""): void {
    if (!name || this.seen.has(aad || name)) return;
    this.seen.add(aad || name);
    const userId = aad ? this.userIdOf(aad) : null;
    this.out.push({
      name: clip(name),
      ...(userId && cpLength(userId) <= CONTEXT_TEXT_MAX ? { user_id: userId } : {}),
      ...(email && cpLength(email) <= CONTEXT_TEXT_MAX ? { email } : {}),
      source,
    });
  }
}

const field = (record: unknown, name: string): unknown =>
  record !== null && typeof record === "object" ? (record as Record<string, unknown>)[name] : undefined;

/**
 * Who the message names: the people it @mentions, then the people this worker knows whose name it writes (in any
 * order, run together, or their address), each once; with nobody named, the people a review request may have meant
 * (`nearPeople`). `user_id` only for a linked person. A mention without its Entra id is looked up by its channel id.
 */
export function peopleOf(
  mentions: readonly MentionRecord[],
  text: string,
  known: readonly PersonRecord[],
  userIdOf: UserIdOf,
  aadOf: (channelId: string) => string | null | undefined = () => null,
): NamedPerson[] {
  const people = new People(userIdOf);
  for (const entity of mentions) {
    const who = field(entity, "mentioned") ?? {};
    const aad = textOf(field(who, "aadObjectId")) || textOf(aadOf(textOf(field(who, "id"))));
    people.add(textOf(field(who, "name")), aad, "mention");
  }
  // Pull requests and model names are left out first: an owner in a link is no one asked to review.
  const plain = withoutRefs(text);
  const words = tokens(plain);
  for (const person of known) {
    const name = textOf(person["name"]);
    if (name && (writtenIn(name, plain) || namedIn(words, rosterOf(person)).size > 0)) {
      people.add(name, textOf(person["objectId"]), "known", textOf(person["email"]));
    }
  }
  if (people.out.length === 0) {
    for (const person of nearPeople(text, known, userIdOf)) {
      people.add(textOf(person["name"]), textOf(person["objectId"]), "near", textOf(person["email"]));
    }
  }
  return people.out.slice(0, CONTEXT_ITEMS_MAX);
}

/** The Latin words of a review request that may be a misspelt name. */
function candidateWords(text: string): string[] {
  const left = new Set([...pullsIn(text).map((p) => pyCasefold(p.repo)), "review", "merge", "please", "thanks"]);
  return tokens(withoutRefs(text)).filter((w) => w.length >= NEAR_WORD_MIN && isAsciiAlpha(w) && !left.has(w));
}

/** Something of theirs is written in the message: that is Claw's to read, never offered as a guess. */
function written(person: PersonRecord, keys: ReadonlySet<string>, text: string): boolean {
  const all = new Set(tokens(text));
  const flatText = flat(text);
  const email = flat(textOf(person["email"]));
  return (
    tokens(textOf(person["name"])).some((w) => all.has(w)) ||
    [...keys].some((k) => flatText.includes(k)) ||
    (email !== "" && flatText.includes(email))
  );
}

/**
 * The linked people a review request may have meant when it names nobody known: a Latin word of it is alike one of the
 * ways their name or address is written ("linme" for "linmei"), closest first. One is offered only when nothing of
 * theirs is written in the message. Empty for a message that asks for no review.
 */
export function nearPeople(text: string, known: readonly PersonRecord[], userIdOf: UserIdOf): PersonRecord[] {
  if (!saysReviewAndMerge(text) && asksReviewOnly(text) === undefined) return [];
  const words = candidateWords(text);
  if (words.length === 0) return [];
  const scored: Array<{ best: number; index: number; person: PersonRecord }> = [];
  known.forEach((person, index) => {
    const aad = textOf(person["objectId"]);
    const keys = new Set([...memberKeys(rosterOf(person))].filter((k) => cpLength(k) >= NEAR_WORD_MIN));
    if (keys.size === 0 || !aad || !userIdOf(aad) || written(person, keys, text)) return;
    const best = Math.max(...words.flatMap((w) => [...keys].map((k) => similarity(w, k))));
    if (best >= NEAR_RATIO) scored.push({ best, index, person });
  });
  scored.sort((a, b) => b.best - a.best || a.index - b.index);
  return scored.slice(0, NEAR_MAX).map((s) => s.person);
}
