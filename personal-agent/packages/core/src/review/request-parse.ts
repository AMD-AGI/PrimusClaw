// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rules' reading of a request in a chat: "请 XX 帮我 review 合入 <PR> [<PR> ...]" (or "请 XX 帮我 review <PR>", a review
 * only). `text` is the message with every mention replaced by a marker (⟦i⟧ is mentions[i]) and the address behind each
 * link written after it. A message that merely contains the words is chat, and goes on as chat.
 */

import { pyFullmatch, pyRegExp } from "../text/py-regex.js";
import {
  type Mention,
  markerIndexes,
  mentionId,
  normName,
  sortedCp,
  tokens,
  withoutMarkers,
  withoutParens,
  displayName,
} from "../review-text/names.js";
import { MARK_CLOSE, pullsIn } from "../review-text/pull-ref.js";
import type { PullRef } from "../claw/model.js";
import { isPySpace } from "../text/py-chars.js";
import { pyStrip } from "../text/py-text.js";
import { MODEL_ID, asksReviewOnly, modelFieldPattern, saysReviewAndMerge } from "../review-text/asks.js";
import { bareName, flat, unique } from "../review-text/text/unicode.js";

/** What a request says. */
export interface ReviewAsk {
  /** The text between 请 and 帮我, markers kept and the model taken out; '' when nobody was named. */
  readonly who: string;
  readonly mentions: readonly Mention[];
  /** The distinct pull requests it points at, in the order it names them. */
  readonly pulls: readonly PullRef[];
  /** The distinct models it names ("用 X 帮我 review", "model: X"); none: the default. */
  readonly models: readonly string[];
  /** Who each later "请 XX review 合入 ..." of the same message names. */
  readonly again: readonly string[];
  /** The channel ids of everyone the message names or mentions (set once that is checked). */
  readonly named: readonly string[];
  /** The repository bare numbers were read as; '' when none were. */
  readonly repo: string;
  /** Numbers written on their own that were not taken as pull requests: named in the acknowledgement. */
  readonly unread: readonly number[];
  /** False: a review only, never a merge. */
  readonly merge: boolean;
  /** The record Claw kept of a review the assistant handed back; '' for a typed request. */
  readonly handoffId: string;
}

export function reviewAsk(fields: Partial<ReviewAsk> & Pick<ReviewAsk, "who" | "pulls">): ReviewAsk {
  return {
    mentions: [],
    models: [],
    again: [],
    named: [],
    repo: "",
    unread: [],
    merge: true,
    handoffId: "",
    ...fields,
  };
}

const REVIEW_AND_MERGE = "review\\s*(?:(?:并且|并|和|与|、|然后)\\s*)?合入";
const HELP = "帮(?:我|忙)?(?:一下)?\\s*";
/** Where the reviewer's name ends in "请 XX [帮我] review 合入": the help words (optional) and "review 合入". */
const NAMED_END = pyRegExp(`(?:${HELP})?${REVIEW_AND_MERGE}`, "gi");
const isSpace = (ch: string | undefined): boolean => ch !== undefined && isPySpace(ch);

/** A match of "请 <who> <end> <rest>": who (as the text writes it, spaces around it left out), whether help words came, the rest. */
interface Asked {
  readonly who: string;
  readonly help: boolean;
  /** Where the rest starts, and the rest. */
  readonly restAt: number;
  readonly rest: string;
  /** Where the whole match ends ("合入" / "review"). */
  readonly end: number;
}

/** Past "请", spaces, an optional 让 / 叫 and spaces: where the name starts. */
function afterPlease(text: string, at: number): number {
  let i = at;
  while (isSpace(text[i])) i += 1;
  if (text[i] === "让" || text[i] === "叫") i += 1;
  while (isSpace(text[i])) i += 1;
  return i;
}

/**
 * The shortest name that `end` follows (the lazy `(?P<who>.*?)\s*<end>` of the Python worker's patterns), scanned rather
 * than backtracked: the leftmost place `end` matches after the name's start, with the spaces before it left out.
 */
function nameBefore(text: string, start: number, end: RegExp): Asked | undefined {
  end.lastIndex = start;
  const found = end.exec(text);
  if (found === null) return undefined;
  let stop = found.index;
  while (stop > start && isSpace(text[stop - 1])) stop -= 1;
  const restAt = found.index + found[0].length;
  return {
    who: text.slice(start, stop),
    help: text[found.index] === "帮",
    restAt,
    rest: text.slice(restAt),
    end: restAt,
  };
}

/** "请 XX [帮我] review 合入 <rest>" at the start of the text (spaces before 请 allowed). */
function namedAskAt(text: string): Asked | undefined {
  let i = 0;
  while (isSpace(text[i])) i += 1;
  if (text[i] !== "请") return undefined;
  return nameBefore(text, afterPlease(text, i + 1), NAMED_END);
}

/** Who each later "请 XX ... review 合入" of the text names, from `from` on (a name is on one line and has no 请 in it). */
function askedAgain(text: string, from: number): string[] {
  const whos: string[] = [];
  let i = text.indexOf("请", from);
  while (i >= 0) {
    const start = afterPlease(text, i + 1);
    const asked = nameBefore(text, start, NAMED_END);
    if (asked !== undefined && !/[\n请]/u.test(asked.who)) {
      whos.push(asked.who);
      i = text.indexOf("请", asked.end);
    } else {
      i = text.indexOf("请", i + 1);
    }
  }
  return whos;
}

const MODEL_ALONE = pyFullmatch(String.raw`(?:${MODEL_ID})\s*`);

/** "用 X" at the end of a name (after its start, a space or a mention): where 用 is, and the model. */
function useModel(who: string): { readonly at: number; readonly model: string } | undefined {
  for (let at = who.indexOf("用"); at >= 0; at = who.indexOf("用", at + 1)) {
    const before = who[at - 1];
    if (at > 0 && !isSpace(before) && before !== MARK_CLOSE) continue;
    let i = at + 1;
    while (isSpace(who[i])) i += 1;
    const rest = who.slice(i);
    if (MODEL_ALONE.test(rest)) return { at, model: pyStrip(rest) };
  }
  return undefined;
}

function modelsWritten(text: string): string[] {
  return [...text.matchAll(modelFieldPattern())].map((m) => m.groups?.model ?? "");
}

/** A name with the model taken out of it: "model: X" anywhere, or "用 X" at its end. */
function nameAndModel(who: string): { readonly who: string; readonly model: string | undefined } {
  const named = pyStrip(who.replace(modelFieldPattern(), " "));
  const used = useModel(named);
  if (used === undefined) return { who: named, model: undefined };
  return { who: pyStrip(named.slice(0, used.at)), model: used.model };
}

function reviewOnlyAsk(text: string, mentions: readonly Mention[]): ReviewAsk | undefined {
  const match = asksReviewOnly(text);
  const pulls = match ? pullsIn(match.rest) : [];
  if (match === undefined || !pulls.length) return undefined;
  const { who, model } = nameAndModel(match.who);
  const models = [...modelsWritten(text), ...(model === undefined ? [] : [model])];
  return reviewAsk({ who, mentions, pulls, models: unique(models), merge: false });
}

/**
 * The request a message makes, or undefined when it is not one. It is one when it says 请 ... 帮我 review 合入, or says
 * "review 合入" and points at a pull request; a review only when it says 请 XX 帮我 review <PR> with no word of merging.
 */
export function parseReviewAsk(text: string, mentions: readonly Mention[]): ReviewAsk | undefined {
  const named = namedAskAt(text);
  const pulls = pullsIn(named === undefined ? text : named.rest);
  // ("请 XX review 并合入 <PR>" without 帮我 is one only with a pull request, so "请问 review 合入的流程是什么？" stays chat;
  // such a match leaves no pull request for the second reading either)
  const asked = named !== undefined && (named.help || pulls.length) ? named : undefined;
  if (asked === undefined && !(saysReviewAndMerge(text) && pulls.length)) return reviewOnlyAsk(text, mentions);
  const models = modelsWritten(text);
  const whos = asked === undefined ? [""] : [asked.who, ...askedAgain(text, asked.restAt)];
  const read = whos.map((w) => {
    const { who, model } = nameAndModel(w);
    if (model !== undefined) models.push(model);
    return who;
  });
  return reviewAsk({ who: read[0] ?? "", mentions, pulls, models: unique(models), again: read.slice(1) });
}

function personKeys(who: string, mentions: readonly Mention[]): { ids: Set<string>; names: Set<string> } {
  const refs = markerIndexes(who).filter((i) => i < mentions.length);
  const ids = new Set(refs.map((r) => mentionId(mentions[r] as Mention)));
  const names = refs.length
    ? [normName(refs.map((r) => pyStrip(mentions[r]?.name ?? "")).join(" "))]
    : [normName(bareName(withoutMarkers(who)))];
  const keys = new Set<string>();
  // (a name's words in any order, run together or not: "Lin, Mei", "Mei Lin" and "linmei" are one name)
  for (const n of names) {
    for (const v of [n, withoutParens(n)]) if (tokens(v).length) keys.add(sortedCp(tokens(v)).join(""));
  }
  for (const n of names) for (const v of [n, withoutParens(n)]) if (flat(v)) keys.add(flat(v));
  return { ids, names: keys };
}

/**
 * The names a later line of the same message gives that are not the person the first line names (a mention is the person
 * its id says, whatever its display name). A line that names nobody says nothing about it.
 */
export function otherReviewers(ask: ReviewAsk): string[] {
  const first = personKeys(ask.who, ask.mentions);
  const others: string[] = [];
  for (const who of ask.again) {
    if (!bareName(who)) continue;
    const { ids, names } = personKeys(who, ask.mentions);
    const same =
      ids.size && first.ids.size
        ? ids.size === first.ids.size && [...ids].every((i) => first.ids.has(i))
        : [...names].some((n) => first.names.has(n));
    if (same) continue;
    const mentioned = markerIndexes(who)
      .filter((i) => i < ask.mentions.length)
      .map((i) => ask.mentions[i]?.name ?? "")
      .join(" ");
    const shown = mentioned || pyStrip(withoutMarkers(who));
    if (!others.includes(shown)) others.push(displayName(shown) || "?");
  }
  return others;
}
