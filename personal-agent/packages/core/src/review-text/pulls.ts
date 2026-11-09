// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { PullRef } from "../claw/model.js";
import { PY_D as D, pyInt } from "../text/py-regex.js";

/** A pull request's link. */
export const PR_URL = new RegExp(
  `https?://github\\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})/pull/(${D}{1,7})(?!${D})`,
  "giu",
);
/** owner/repo#N (an ASCII lookbehind: "合入AMD-AGI/x#1" with no space between is still one). */
export const PR_SHORT = new RegExp(
  `(?<![A-Za-z0-9_/.-])([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})#(${D}{1,7})(?!${D})`,
  "gu",
);
const MODEL_ID = "[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,99}";
/** "model: X" anywhere. */
export const MODEL_FIELD = new RegExp(`(?<![A-Za-z0-9_])(?:model|模型)\\s*[:：=]\\s*(?<model>${MODEL_ID})`, "giu");

/** A pull request as GitHub compares it: owner and repository without case. */
export function pullKey(pull: PullRef): string {
  return `${pull.owner.toLowerCase()}/${pull.repo.toLowerCase()}#${String(pull.number)}`;
}

/**
 * The distinct pull requests the text points at, in the order it names them: links and owner/repo#N, mixed, separated
 * by anything.
 */
export function pullsIn(text: string): PullRef[] {
  const hits = [...text.matchAll(PR_URL), ...text.matchAll(PR_SHORT)].sort((a, b) => a.index - b.index);
  const found: PullRef[] = [];
  for (const m of hits) {
    const repo = m[2] ?? "";
    const ref: PullRef = {
      owner: m[1] ?? "",
      repo: repo.endsWith(".git") ? repo.slice(0, -4) : repo,
      number: pyInt(m[3] ?? "0"),
    };
    if (found.every((r) => pullKey(r) !== pullKey(ref))) found.push(ref);
  }
  return found;
}
