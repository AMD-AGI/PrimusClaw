// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { MODEL_FIELD } from "./pulls.js";

/** "review 合入", and the same with 并 / 并且 / 和 / 与 / 、 / 然后 between. */
export const REVIEW_MERGE = /review\s*(?:(?:并且|并|和|与|、|然后)\s*)?合入/iu;
/** "请 XX 帮我 review <PR>" with no word of merging: a review only. 帮 is required, and so is a name. */
const REVIEW_ONLY_ASK = /^\s*请(?!问)\s*(?:让|叫)?\s*(?<who>.*?)\s*帮(?:我|忙)?(?:一下)?\s*review(?<rest>.*)$/isu;
/** Python's `str.strip(" \t,，、:：@")`. */
const AROUND_NAME = /^[ \t,，、:：@]+|[ \t,，、:：@]+$/gu;

/** "请 XX 帮我 review ..." that names someone and says nothing of merging: its match (`who`, `rest`), or null. */
export function asksReviewOnly(text: string): RegExpExecArray | null {
  const match = REVIEW_ONLY_ASK.exec(text);
  if (match === null || REVIEW_MERGE.test(text)) return null;
  const who = (match.groups?.["who"] ?? "").replace(MODEL_FIELD, " ").replace(AROUND_NAME, "");
  return who ? match : null;
}
