// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A pull request named in a review request, and how one is read out of text (links and owner/repo#N). */

import type { PullRef } from "../claw/model.js";

export { MARK_CLOSE, MARK_OPEN } from "../inbound-text/marked-text.js";
import { decimalInt } from "../text/py-text.js";

export type { PullRef };

export type PullKey = string;

export function pullRef(owner: string, repo: string, number: number): PullRef {
  return { owner, repo, number };
}

export function slug(pull: PullRef): string {
  return `${pull.owner}/${pull.repo}`;
}

export function shortName(pull: PullRef): string {
  return `${slug(pull)}#${String(pull.number)}`;
}

export function pullUrl(pull: PullRef): string {
  return `https://github.com/${pull.owner}/${pull.repo}/pull/${String(pull.number)}`;
}

/** What Claw binds a review session to (`config.review_target`). */
export function pullTarget(pull: PullRef): [string, string, number] {
  return [pull.owner, pull.repo, pull.number];
}

/** A pull request as GitHub compares it: owner and repository without case. */
export function pullKey(pull: PullRef): PullKey {
  return keyOf(pull.owner.toLowerCase(), pull.repo.toLowerCase(), pull.number);
}

export function keyOf(owner: string, repo: string, number: number): PullKey {
  return `${owner}\u0000${repo}\u0000${String(number)}`;
}

export function keyParts(key: PullKey): [string, string, number] {
  const [owner = "", repo = "", number = "0"] = key.split("\u0000");
  return [owner, repo, Number(number)];
}

export function samePull(a: PullRef, b: PullRef): boolean {
  return pullKey(a) === pullKey(b);
}

export const PR_URL_SOURCE =
  "https?://github\\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})/pull/(\\p{Nd}{1,7})(?!\\p{Nd})";
// (an ASCII lookbehind: "合入AMD-AGI/x#1" or "，AMD-AGI/x#1" with no space between is still one)
export const PR_SHORT_SOURCE =
  "(?<![A-Za-z0-9_/.-])([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})#(\\p{Nd}{1,7})(?!\\p{Nd})";

export function prUrlPattern(): RegExp {
  return new RegExp(PR_URL_SOURCE, "giu");
}

export function prShortPattern(): RegExp {
  return new RegExp(PR_SHORT_SOURCE, "gu");
}

function withoutGit(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

/**
 * The distinct pull requests the text points at, in the order it names them: links and owner/repo#N, mixed, separated by
 * anything (a comma, 、, a space, a new line).
 */
export function pullsIn(text: string): PullRef[] {
  const hits: { at: number; owner: string; repo: string; number: string }[] = [];
  for (const pattern of [prUrlPattern(), prShortPattern()]) {
    for (const m of text.matchAll(pattern)) {
      hits.push({ at: m.index, owner: m[1] ?? "", repo: m[2] ?? "", number: m[3] ?? "0" });
    }
  }
  hits.sort((a, b) => a.at - b.at || compareTuple(a, b));
  const found: PullRef[] = [];
  for (const hit of hits) {
    const ref = pullRef(hit.owner, withoutGit(hit.repo), decimalInt(hit.number));
    if (found.every((r) => !samePull(r, ref))) found.push(ref);
  }
  return found;
}

function compareTuple(
  a: { owner: string; repo: string; number: string },
  b: { owner: string; repo: string; number: string },
): number {
  return cmp(a.owner, b.owner) || cmp(a.repo, b.repo) || cmp(a.number, b.number);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function withoutGitSuffix(name: string): string {
  return withoutGit(name);
}
