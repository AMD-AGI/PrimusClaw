// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pull requests written by their number alone ("PR 245", "#245", "PrimusClaw PR #245 #246", "245和246" after PR or #). The word
 * just before may name the repository ("owner/repo" or "repo"). After the first number the list goes on through any separator
 * (和, 、, commas, semicolons, "and", or white space alone), in any mix. A later number that is a count or a time
 * ("PR 248 10 分钟内", "1. 修复") or runs into a word is not one of the list; a number that looks like a pull request's and is
 * not read as one is named back to the asker (`strayNumbers`), never dropped in silence.
 */

import { MARK_CLOSE, MARK_OPEN, prShortPattern, pullsIn, withoutGitSuffix } from "./pull-ref.js";
import { pyRegExp } from "../text/py-regex.js";
import { PY_SPACE, decimalInt } from "../text/py-text.js";
import { hiddenSpans, replaceSpans } from "./text/scan.js";
import { codePoints, isAlnum, unique } from "./text/unicode.js";

const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])";
const SEP = `(?:\\s*(?:和|及|与|以及|、|,|，|;|；|&|(?<![\\p{L}\\p{N}_])and${NOT_WORD_AFTER})\\s*|\\s+)`;
const UNIT =
  "(?:分钟|分|小时|个|次|秒|天|号|年|月|日|周|点|行|条|位|人|楼|%" +
  `|mins?${NOT_WORD_AFTER}|minutes?${NOT_WORD_AFTER}|hours?${NOT_WORD_AFTER}|days?${NOT_WORD_AFTER}` +
  `|h${NOT_WORD_AFTER}|m${NOT_WORD_AFTER}|s${NOT_WORD_AFTER}` +
  "|[.:：)）]\\s*[^\\s\\p{Nd}#,，、;；和及与&])";
// (not 10:30, 11-03, 1.5)
/** White space other than a line break (Python's `[^\S\n]`, written as a class the translator takes). */
const SPACE_NOT_NEWLINE = `[${PY_SPACE.replace("\\n", "")}]`;
const NEXT = `(?!\\p{Nd})(?![.:：/-]\\p{Nd})(?!${SPACE_NOT_NEWLINE}*${UNIT})(?!(?!和|及|与|以及)[A-Za-z\\u3400-\\u9fff])`;
const BARE_PULLS_SOURCE =
  "(?:(?<![A-Za-z0-9_./#-])(?<repo>(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}/)?[A-Za-z][A-Za-z0-9._-]{0,99})\\s*(?:的\\s*)?)?" +
  // (Python's `\s*[:：]?\s*`, written so that one run of white space has one reading: same strings, no backtracking)
  "(?<kw>(?:PRs?|pull\\s*requests?)\\s*(?:[:：]\\s*)?)?" +
  `(?<nums>#?\\s?\\p{Nd}{1,7}(?:${SEP}#?\\s?\\p{Nd}{1,7}${NEXT})*)(?!\\p{Nd})`;
// A number written on its own (not inside a word, a version, a link or owner/repo#N), and not a count or a time.
const LONE_NUMBER_SOURCE = `(?<![A-Za-z0-9_./#:：-])#?\\s?(\\p{Nd}{1,7})${NEXT}`;
const OWNER_REPO_SOURCE =
  "(?<![A-Za-z0-9_./#-])([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})(?![A-Za-z0-9_/#-])";

const NOT_A_REPO = new Set([
  "pr",
  "prs",
  "pull",
  "request",
  "requests",
  "the",
  "and",
  "merge",
  "review",
  "please",
  "pls",
  "issue",
  "at",
  "by",
  "to",
]);

/** The same pattern with match indices (`d`), which the Python-semantics translator does not take as a flag. */
function withIndices(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags}d`);
}

/** Whether a word, lower-cased, is a word of the sentence rather than a repository ("pr", "the", "merge", ...). */
export function isNotARepo(word: string): boolean {
  return NOT_A_REPO.has(word.toLowerCase());
}

/**
 * A word written as a repository's name rather than as a word of the sentence ("PrimusClaw", "fleet-tools", "Primus2", not
 * "my", "this" or "API"): what a name GitHub could not confirm must look like before it is read as one.
 */
export function looksLikeRepo(name: string): boolean {
  const chars = codePoints(name);
  if (isNotARepo(name) || chars.length < 3) return false;
  const camel = chars.some((a, i) => /\p{Ll}/u.test(a) && /\p{Lu}/u.test(chars[i + 1] ?? ""));
  return camel || chars.some((c) => /\p{Nd}/u.test(c) || "-_.".includes(c));
}

/** Pull requests one place of a message names by number alone. */
export interface BareGroup {
  /** Where each number is, in the text it was read from (UTF-16 offsets). */
  readonly spans: readonly (readonly [number, number])[];
  readonly numbers: readonly number[];
  /** The repository word written just before the numbers ('' when none). */
  readonly repo: string;
  /** Written after "PR" or "#": a pull request whatever comes before it. */
  readonly explicit: boolean;
}

/** The text with its links, tags, entities and mention markers blanked (the places stay where they are). */
function hidden(text: string): string {
  return replaceSpans(text, hiddenSpans(text, MARK_OPEN, MARK_CLOSE), (m) => " ".repeat(m.length));
}

function blanked(text: string): string {
  return hidden(text).replace(prShortPattern(), (m) => " ".repeat(m.length));
}

function isAsciiWordish(ch: string): boolean {
  return ch.length === 1 && ch.charCodeAt(0) < 128 && (isAlnum(ch) || "._-/".includes(ch));
}

interface Lead {
  readonly repo: string;
  readonly kw: string;
}

/** The repository word and the keyword before the numbers, as they are read ("合入PR 245": the word is the keyword). */
function leadOf(match: RegExpExecArray): Lead {
  const repo = match.groups?.repo ?? "";
  const kw = match.groups?.kw ?? "";
  if ((repo.toLowerCase() === "pr" || repo.toLowerCase() === "prs") && !kw) return { repo: "", kw: repo };
  return { repo: isNotARepo(repo) ? "" : repo, kw };
}

/** Whether the numbers at `start` are no pull requests: no keyword and no repository, or a word and a number run together. */
function notPulls(blank: string, lead: Lead, start: number, repoEnd: number | undefined): boolean {
  const explicit = Boolean(lead.kw) || blank[start] === "#";
  if (!explicit && !lead.repo) return true; // ("linmei0120", "opus-5.5": no number)
  if (lead.repo && !lead.kw && repoEnd === start) return true;
  return !lead.kw && !lead.repo && start > 0 && isAsciiWordish(blank.charAt(start - 1));
}

function readGroup(blank: string, match: RegExpExecArray): BareGroup | undefined {
  const lead = leadOf(match);
  const indices = match.indices?.groups ?? {};
  const start = indices.nums?.[0] ?? 0;
  if (notPulls(blank, lead, start, indices.repo?.[1])) return undefined;
  const nums = match.groups?.nums ?? "";
  const spans = [...nums.matchAll(/\p{Nd}{1,7}/gu)].map(
    (m) => [m.index + start, m.index + start + m[0].length] as const,
  );
  return {
    spans,
    numbers: spans.map(([a, b]) => decimalInt(blank.slice(a, b))),
    repo: lead.repo,
    explicit: Boolean(lead.kw) || blank[start] === "#",
  };
}

/**
 * Every place `text` names pull requests by number alone. Links, owner/repo#N, mentions, tags and HTML entities are not read
 * (they are blanked first, so the places stay where they are in `text`).
 */
export function bareGroups(text: string): BareGroup[] {
  const blank = blanked(text);
  const found: BareGroup[] = [];
  for (const match of blank.matchAll(withIndices(pyRegExp(BARE_PULLS_SOURCE, "gi")))) {
    const group = readGroup(blank, match);
    if (group !== undefined) found.push(group);
  }
  return found;
}

/**
 * The numbers `text` writes on their own that none of `groups` holds: in a request to review and merge, each may be a pull
 * request the asker meant, so it is named back to them rather than dropped without a word.
 */
export function strayNumbers(text: string, groups: readonly BareGroup[]): number[] {
  const blank = blanked(text);
  const held = new Set(groups.flatMap((g) => g.spans.map(([a, b]) => `${String(a)}:${String(b)}`)));
  const loose: number[] = [];
  for (const m of blank.matchAll(withIndices(pyRegExp(LONE_NUMBER_SOURCE, "g")))) {
    const span = m.indices?.[1];
    if (span === undefined || held.has(`${String(span[0])}:${String(span[1])}`)) continue;
    loose.push(decimalInt(m[1] ?? ""));
  }
  return unique(loose);
}

/** The distinct repositories ("owner/repo") the text names: in its links, its owner/repo#N, and owner/repo written alone. */
export function writtenRepos(text: string): string[] {
  const found = pullsIn(text).map((p) => `${p.owner}/${p.repo}`);
  const blank = hidden(text).replace(prShortPattern(), " ");
  for (const m of blank.matchAll(new RegExp(OWNER_REPO_SOURCE, "gu"))) {
    found.push(`${m[1] ?? ""}/${withoutGitSuffix(m[2] ?? "")}`);
  }
  // Each repository once, spelled as it is first written, in the order of where it is last written.
  const first = new Map<string, string>();
  const last = new Map<string, number>();
  found.forEach((repo, i) => {
    const key = repo.toLowerCase();
    if (!first.has(key)) first.set(key, repo);
    last.set(key, i);
  });
  return [...last.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => first.get(key) ?? key);
}
