// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { typedAnswerText } from "../locales/typed-answer.js";
import { decimalBigInt } from "../text/py-text.js";
import { ALL, ALLOW, CLAUSE_END, DENY, FILLER, PULL, QUESTION, WEAK, WORD, has } from "./patterns.js";
import { withoutModes } from "./mode.js";

/** A pull request waiting for the person: (repository `owner/name`, number). */
export type Pending = readonly [repo: string, number: number];
export type Choice = "allow" | "deny";

/**
 * What a message answers: (pull request, choice) for each, in the order written; or `question`, the one thing to ask
 * back when the rules cannot settle it (nothing is decided then).
 */
export interface TypedAnswer {
  readonly decisions: ReadonlyArray<readonly [Pending, Choice]>;
  readonly question: string;
}

const decided = (decisions: ReadonlyArray<readonly [Pending, Choice]>): TypedAnswer => ({ decisions, question: "" });
const ask = (question: string): TypedAnswer => ({ decisions: [], question });

/** One pull request written in the message: where, the repository as written ("" none), the number. */
interface Written {
  readonly start: number;
  readonly end: number;
  readonly repo: string;
  /** Python's `int()` of the digits written: no bound (a number past 2^53 is still read, and said back as written). */
  readonly number: bigint;
}

interface Target {
  readonly start: number;
  readonly end: number;
  readonly pull: Pending;
}

const keyOf = (pull: Pending): string => `${pull[0]}\u0000${String(pull[1])}`;

/** `pulls` without repeats, in first-seen order (`dict.fromkeys`). */
function unique<T extends Pending>(pulls: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const pull of pulls) if (!seen.has(keyOf(pull))) seen.set(keyOf(pull), pull);
  return [...seen.values()];
}

/** `int(digits)` of digits of any script (the pattern matched only digits). */
const intOf = (digits: string | undefined): bigint => decimalBigInt(digits ?? "0") ?? 0n;

function written(text: string): Written[] {
  return [...text.matchAll(PULL)].map((m) => {
    const g = m.groups ?? {};
    const start = m.index;
    const end = start + m[0].length;
    if (g["lnum"]) return { start, end, repo: `${g["lo"] ?? ""}/${g["ln"] ?? ""}`, number: intOf(g["lnum"]) };
    if (g["rnum"]) {
      const repo = g["owner"] ? `${g["owner"]}/${g["name"] ?? ""}` : (g["name"] ?? "");
      return { start, end, repo, number: intOf(g["rnum"]) };
    }
    return { start, end, repo: "", number: intOf(g["num"] ?? g["bare"]) };
  });
}

function matches(repo: string, writtenRepo: string): boolean {
  if (!writtenRepo) return true;
  const w = writtenRepo.toLowerCase();
  const r = repo.toLowerCase();
  return r === w || r.slice(r.lastIndexOf("/") + 1) === w;
}

function kinds(span: string): Set<Choice> {
  const out = new Set<Choice>(has(DENY, span) ? ["deny"] : []);
  if (has(ALLOW, span.replace(DENY, " "))) out.add("allow");
  return out;
}

const only = (set: Set<Choice>): Choice => [...set][0] ?? "allow";

function listing(pending: readonly Pending[]): string {
  return unique(pending)
    .map(([repo, pr]) => `${repo}#${String(pr)}`)
    .join("、");
}

function which(pending: readonly Pending[]): string {
  return typedAnswerText.which({ listing: listing(pending), first: pending[0]?.[1] ?? 0 });
}

/** Nothing but the answer is written: the words of an answer, the pull requests, and a few filler words. */
function onlyAnAnswer(rest: string): boolean {
  const left = [PULL, DENY, ALLOW, ALL, FILLER].reduce((text, pattern) => text.replace(pattern, " "), rest);
  return !has(WORD, left);
}

/** Which pending pull request each written one is; a string is the question to ask back, null: not an answer. */
function targetsOf(all: Written[], pending: readonly Pending[], strict: boolean): Target[] | TypedAnswer | null {
  const targets: Target[] = [];
  for (const { start, end, repo, number } of all) {
    const found = unique(pending.filter((p) => BigInt(p[1]) === number && matches(p[0], repo)));
    const name = repo ? `${repo}#${String(number)}` : `#${String(number)}`;
    const first = found[0];
    if (first === undefined) {
      if (strict) return null; // (with no reading, a number that is not waiting may be anything: the message goes on)
      return ask(typedAnswerText.notWaiting({ name, listing: listing(pending) }));
    }
    if (found.length > 1) {
      return ask(
        typedAnswerText.whichRepo({
          name,
          count: found.length,
          listing: listing(found),
          repo: first[0],
          number: first[1],
        }),
      );
    }
    targets.push({ start, end, pull: first });
  }
  return targets;
}

/** Whether `text` reads as an answer at all, before any pull request is looked up. */
function answerShaped(text: string, rest: string, all: Written[], strict: boolean): boolean {
  if (rest !== text && all.length === 0) return false; // a word of the settings and no pull request: about the settings
  if (all.length === 0 && kinds(rest.replace(WEAK, " ")).size === 0) return false; // "好的" / "都可以" alone
  return !strict || onlyAnAnswer(rest);
}

/**
 * What `text` answers among `pending` (each confirmation waiting for this person). null: it is not an answer (the
 * message goes on as chat). With `strict` (no model reading) it counts only when nothing but the answer is written.
 */
export function readTypedAnswer(text: string, pending: readonly Pending[], strict: boolean): TypedAnswer | null {
  if (has(QUESTION, text)) return null;
  const rest = withoutModes(text);
  const said = kinds(rest);
  if (said.size === 0) return null;
  const all = written(rest);
  if (!answerShaped(text, rest, all, strict)) return null;
  if (pending.length === 0) return all.length ? ask(typedAnswerText.nothingWaits) : null;
  const targets = targetsOf(all, pending, strict);
  if (targets === null || !Array.isArray(targets)) return targets;
  if (targets.length === 0) return answerForAll(rest, said, pending);
  if (said.size === 1) return decided(targets.map((t) => [t.pull, only(said)] as const));
  return mixed(rest, targets, pending);
}

/** Nothing named: all of them ("全部确认"), or the one that waits. */
function answerForAll(rest: string, said: Set<Choice>, pending: readonly Pending[]): TypedAnswer {
  if ((has(ALL, rest) || unique(pending).length === 1) && said.size === 1) {
    return decided(unique(pending).map((p) => [p, only(said)] as const));
  }
  return ask(which(pending));
}

/**
 * Both words in one message ("确认 #243，拒绝 #234", "243 可以合，234 先别合"): each pull request takes the answer of
 * its own clause (split at punctuation and line breaks). A clause with both words, or none, is asked back.
 */
function mixed(text: string, targets: readonly Target[], pending: readonly Pending[]): TypedAnswer {
  const answers = new Map<string, readonly [Pending, Choice]>();
  const bounds = [0, ...[...text.matchAll(CLAUSE_END)].map((m) => m.index + m[0].length), text.length + 1];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i] ?? 0;
    const hi = bounds[i + 1] ?? 0;
    const inside = targets.filter((t) => lo <= t.start && t.start < hi);
    if (inside.length === 0) continue;
    // the pull requests are not words of an answer ("#243" never reads as one)
    const span = inside.reduce((s, t) => s.split(text.slice(t.start, t.end)).join(" "), text.slice(lo, hi));
    const said = kinds(span);
    if (said.size !== 1) return ask(which(pending));
    for (const t of inside) {
      const before = answers.get(keyOf(t.pull));
      if (before !== undefined && before[1] !== only(said)) return ask(which(pending));
      answers.set(keyOf(t.pull), [t.pull, only(said)]);
    }
  }
  if (answers.size !== unique(targets.map((t) => t.pull)).length) return ask(which(pending));
  return decided([...answers.values()]);
}
