// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a message asks about the state of the person's own GitHub ("我开着的 PR 有几个", "my latest CI run failed"), and
 * the repositories it names: what decides whether the GitHub connect card is offered beside the answer.
 */

import { isUpper } from "../text/unicode.js";

// A word for something on GitHub, bounded by anything that is not an ASCII letter ("的pr" has no word boundary in Unicode).
const NOUN =
  /(?<![A-Za-z])(?:github|PRs?|pull\s*requests?|CI|issues?|commits?|checks?|repos?|workflows?)(?![A-Za-z])|仓库|合入|合并请求|流水线|提交记录/iu;
// The person themselves, or a Chinese phrasing that leaves it implicit.
const PERSON = /我|咱|最近一次|上一次|开着的|(?<![A-Za-z])(?:my|mine|me|I|our)(?![A-Za-z])/iu;
// What is asked about it: its state or number.
const STATE =
  /开着|打开的|没合|合了|关了|挂|红|失败|几个|多少|哪些|最近|最新|状态|等我|(?<![A-Za-z])(?:open|opened|merged|closed|failing|failed|red|how\s+many|latest|last|status|waiting|assigned)(?![A-Za-z])/iu;
// A review asked for: reviews go their own way, and no card is offered beside one.
const REVIEW_NEAR = /(?:合入|merge|https?:\/\/|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\p{Nd})/iu;
const REVIEW_WORD = /(?<![A-Za-z])review(?![A-Za-z])/giu;
const REVIEW_OTHER = /代审|帮.{0,6}审/u;

export const MAX_QUESTION_CHARS = 2000;
export const MAX_REPOS_LOOKED_AT = 3;

const REPO_LINK = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/giu;
const REPO_NAME =
  /(?<![\p{L}\p{N}_./-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?![\p{L}\p{N}_/])/gu;

/** "review" followed within 40 characters of its line by a merge word, a link or owner/repo#N; or 代审, 帮…审. */
function asksForReview(text: string): boolean {
  if (REVIEW_OTHER.test(text)) return true;
  for (const m of text.matchAll(REVIEW_WORD)) {
    const after = text.slice(m.index + m[0].length).split("\n", 1)[0] ?? "";
    // (`[^\n]{0,40}?` then one of them: it must start within 40 characters)
    const found = REVIEW_NEAR.exec(after);
    if (found !== null && Array.from(after.slice(0, found.index)).length <= 40) return true;
  }
  return false;
}

/** Whether a message asks about the state of the person's own GitHub (a GitHub word, the person, a word of state). */
export function asksAboutOwnGithub(text: string): boolean {
  if (!text || Array.from(text).length > MAX_QUESTION_CHARS || asksForReview(text)) return false;
  return NOUN.test(text) && PERSON.test(text) && STATE.test(text);
}

/** The repositories a message names, each once, in order: a github.com link, or owner/name in a message with a GitHub word. */
export function repositoriesNamed(text: string): [string, string][] {
  if (!text || Array.from(text).length > MAX_QUESTION_CHARS) return [];
  const found = [...text.matchAll(REPO_LINK)].map((m) => [m[1] ?? "", (m[2] ?? "").replace(/\.git$/u, "")] as const);
  if (NOUN.test(text)) {
    for (const m of text.matchAll(REPO_NAME)) found.push([m[1] ?? "", (m[2] ?? "").replace(/\.git$/u, "")]);
  }
  const seen = new Map<string, [string, string]>();
  for (const [owner, raw] of found) {
    const name = raw.replace(/\.+$/u, "");
    // ("CI/CD", "I/O": words, not a repository)
    if (isUpper(owner) && isUpper(name)) continue;
    if (name && name !== "." && name !== "..") {
      const key = `${owner}/${name}`.toLowerCase();
      if (!seen.has(key)) seen.set(key, [owner, name]);
    }
  }
  return [...seen.values()];
}
