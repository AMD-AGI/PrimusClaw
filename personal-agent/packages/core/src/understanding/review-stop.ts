// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pullsIn } from "../review-text/pulls.js";
import { PY_B_END as E, PY_B_START as B, PY_D as D, PY_W_CHARS as W, pyInt } from "../text/py-regex.js";

/**
 * A stop is read only when the message says nothing but that: once the pull requests are taken out, what is left must
 * be stop words and the few words around them ("把 825 的 review 停一下"). Anything else ("不要停", "停不了", "don't
 * stop") is no stop. A stop that is not read is only asked again; a stop read against the words would stop a review the
 * person wanted.
 */
const STOP = new RegExp(
  `停(?:下来|下|止|掉|一下)?|别审了?|不用审了?|先?别合了?|取消|撤回|${B}(?:stop|cancel|abort|halt)${E}`,
  "giu",
);
const AROUND = new RegExp(
  `把|对|的|请|帮我|麻烦|一下|先|也|都|和|、|吧|了|代审|审查|评审|合入|${B}(?:review|reviews|reviewing|pr|prs|pull|request|` +
    `please|pls|the|of|for|and|it|them|now)${E}|[\\s,，.。;；!！:：#]`,
  "giu",
);
const NUMBER = new RegExp(`(?<![${W}/#.-])#?(${D}{1,7})(?![${W}.])`, "gu");

/** A pull request a stop names: (owner/repo in lower case, or "" when only the number was written, number). */
export type StoppedPull = readonly [repo: string, number: number];

/**
 * The pull requests a group message asks to stop the review of ("停 825", "stop AMD-AGI/Primus#825"); empty when it is
 * no such stop (a stop that names no pull request is the chat's `/stop`).
 */
export function reviewStop(text: string): StoppedPull[] {
  const named = pullsIn(text);
  let rest = text;
  for (const p of named) {
    // a number inside a link or owner/repo#N is that pull request: the whole word goes (word by word: linear)
    const repo = p.repo.toLowerCase();
    rest = rest
      .split(/(\s+)/u)
      .map((part) => (part.toLowerCase().includes(repo) ? " " : part))
      .join("");
  }
  const numbers = [...rest.matchAll(NUMBER)].map((m): StoppedPull => ["", pyInt(m[1] ?? "0")]);
  const words = rest.replace(NUMBER, " ");
  if (words.search(STOP) === -1 || words.replace(STOP, "").replace(AROUND, "") !== "") return [];
  const all: StoppedPull[] = [
    ...named.map((p): StoppedPull => [`${p.owner}/${p.repo}`.toLowerCase(), p.number]),
    ...numbers,
  ];
  const seen = new Set<string>();
  return all.filter(([repo, number]) => {
    const key = `${repo}#${String(number)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
