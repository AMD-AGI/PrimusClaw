// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rules' reading of a request in a chat: "请 XX 帮我 review 合入 <PR> [<PR> ...]" (or "请 XX 帮我 review <PR>", a review
 * only). `text` is the message with every mention replaced by a marker (⟦i⟧ is mentions[i]) and the address behind each
 * link written after it. A message that merely contains the words is chat, and goes on as chat.
 */

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
} from "./names.js";
import { MARK_CLOSE, type PullRef, pullsIn } from "./pull-ref.js";
import { pyStrip } from "../text/py-text.js";
import { bareName, flat, unique } from "./text/unicode.js";

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
const NAMED_ASK = new RegExp(
  `^\\s*请\\s*(?:让|叫)?\\s*(?<who>.*?)\\s*(?<help>帮(?:我|忙)?(?:一下)?\\s*)?${REVIEW_AND_MERGE}(?<rest>.*)$`,
  "isud",
);
const ASK_AGAIN_SOURCE = `请\\s*(?:让|叫)?\\s*(?<who>[^\\n请]*?)\\s*(?:帮(?:我|忙)?(?:一下)?\\s*)?${REVIEW_AND_MERGE}`;
const REVIEW_MERGE = new RegExp(REVIEW_AND_MERGE, "iu");
const REVIEW_ONLY_ASK = /^\s*请(?!问)\s*(?:让|叫)?\s*(?<who>.*?)\s*帮(?:我|忙)?(?:一下)?\s*review(?<rest>.*)$/isu;
export const MODEL_ID = "[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,99}";
const MODEL_FIELD_SOURCE = `(?<![A-Za-z0-9_])(?:model|模型)\\s*[:：=]\\s*(?<model>${MODEL_ID})`;
const USE_MODEL = new RegExp(`(?:^|(?<=\\s)|(?<=${MARK_CLOSE}))用\\s*(?<model>${MODEL_ID})\\s*$`, "u");

export function modelFieldPattern(): RegExp {
  return new RegExp(MODEL_FIELD_SOURCE, "giu");
}

/** Whether the text says "review 合入" (or "review 并合入", ...). */
export function saysReviewAndMerge(text: string): boolean {
  return REVIEW_MERGE.test(text);
}

function modelsWritten(text: string): string[] {
  return [...text.matchAll(modelFieldPattern())].map((m) => m.groups?.model ?? "");
}

/** A name with the model taken out of it: "model: X" anywhere, or "用 X" at its end. */
function nameAndModel(who: string): { readonly who: string; readonly model: string | undefined } {
  const named = pyStrip(who.replace(modelFieldPattern(), " "));
  const used = USE_MODEL.exec(named);
  if (!used) return { who: named, model: undefined };
  return { who: pyStrip(named.slice(0, used.index)), model: used.groups?.model ?? "" };
}

/** "请 XX 帮我 review ..." that names someone and says nothing of merging. */
export function asksReviewOnly(text: string): RegExpExecArray | undefined {
  const match = REVIEW_ONLY_ASK.exec(text);
  if (!match || REVIEW_MERGE.test(text)) return undefined;
  return bareName((match.groups?.who ?? "").replace(modelFieldPattern(), " ")) ? match : undefined;
}

function reviewOnlyAsk(text: string, mentions: readonly Mention[]): ReviewAsk | undefined {
  const match = asksReviewOnly(text);
  const pulls = match ? pullsIn(match.groups?.rest ?? "") : [];
  if (!match || !pulls.length) return undefined;
  const { who, model } = nameAndModel(match.groups?.who ?? "");
  const models = [...modelsWritten(text), ...(model === undefined ? [] : [model])];
  return reviewAsk({ who, mentions, pulls, models: unique(models), merge: false });
}

/**
 * The request a message makes, or undefined when it is not one. It is one when it says 请 ... 帮我 review 合入, or says
 * "review 合入" and points at a pull request; a review only when it says 请 XX 帮我 review <PR> with no word of merging.
 */
export function parseReviewAsk(text: string, mentions: readonly Mention[]): ReviewAsk | undefined {
  const named = namedAsk(text);
  if (!named && !(REVIEW_MERGE.test(text) && pullsIn(text).length)) {
    return reviewOnlyAsk(text, mentions);
  }
  const pulls = named ? named.pulls : pullsIn(text);
  const models = modelsWritten(text);
  const read = (named ? named.whos : [""]).map((w) => {
    const { who, model } = nameAndModel(w);
    if (model !== undefined) models.push(model);
    return who;
  });
  return reviewAsk({ who: read[0] ?? "", mentions, pulls, models: unique(models), again: read.slice(1) });
}

/**
 * "请 XX [帮我] review 合入 <rest>": who each "请 XX ... review 合入" of the message names, and the pull requests after the
 * first. undefined: not written so. ("请 XX review 并合入 <PR>" without 帮我 is one only with a pull request, so that
 * "请问 review 合入的流程是什么？" stays chat.)
 */
function namedAsk(text: string): { readonly whos: string[]; readonly pulls: PullRef[] } | undefined {
  const named = NAMED_ASK.exec(text);
  if (!named) return undefined;
  const restAt = named.indices?.groups?.rest?.[0] ?? 0;
  const pulls = pullsIn(text.slice(restAt));
  if (!named.groups?.help && !pulls.length) return undefined;
  const whos = [named.groups?.who ?? ""];
  const again = new RegExp(ASK_AGAIN_SOURCE, "giu");
  again.lastIndex = restAt;
  for (let m = again.exec(text); m; m = again.exec(text)) whos.push(m.groups?.who ?? "");
  return { whos, pulls };
}

function personKeys(who: string, mentions: readonly Mention[]): { ids: Set<string>; names: Set<string> } {
  const refs = markerIndexes(who).filter((i) => i < mentions.length);
  const ids = new Set(refs.map((r) => mentionId(mentions[r] as Mention)));
  const names = refs.length
    ? [normName(refs.map((r) => pyStrip(mentions[r]?.name ?? "")).join(" "))]
    : [normName(bareName(withoutMarkers(who)))];
  const keys = new Set<string>();
  // (a name's words in any order, run together or not: "Hui, Rui", "Rui Hui" and "huirui" are one name)
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
