// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The words of a review request the rules and the assistant's understanding both read (github_review.py): "review 合入",
 * a review-only ask, and a model named in the text. Parsing a whole request is the review delegation's.
 */
import { pyFullmatch, pyRegExp } from "../text/py-regex.js";
import { PY_SPACE, pyRstrip } from "../text/py-text.js";
import { bareName } from "./text/unicode.js";

/** A model id as a request writes it. */
export const MODEL_ID = "[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,99}";
const MODEL_FIELD_SOURCE = `(?<![A-Za-z0-9_])(?:model|模型)\\s*[:：=]\\s*(?<model>${MODEL_ID})`;

/** "model: X" (or 模型：X) anywhere in a text; a new global pattern each call. */
export function modelFieldPattern(): RegExp {
  return new RegExp(MODEL_FIELD_SOURCE, "giu");
}

/** "review 合入", and the same with 并 / 并且 / 和 / 与 / 、 / 然后 between (Python's `re.I`, so `İ` and `ı` fold to i). */
const REVIEW_MERGE = pyRegExp(String.raw`review\s*(?:(?:并且|并|和|与|、|然后)\s*)?合入`, "i");

/** Whether the text says "review 合入" (or "review 并合入", ...). */
export function saysReviewAndMerge(text: string): boolean {
  return REVIEW_MERGE.test(text);
}

/**
 * "请 XX 帮我 review <PR>": Python's `^\s*请(?!问)\s*(?:让|叫)?\s*(?P<who>.*?)\s*帮(?:我|忙)?(?:一下)?\s*review(?P<rest>.*)$`
 * (re.I, re.S), matched by hand: as one regular expression its neighbouring runs of white space take polynomial time on
 * a long one. The opening is matched greedily, the name is the text up to the first 帮 after which the rest reads on
 * (its trailing white space left out), as the lazy group of the pattern gives.
 */
const OPENING = new RegExp(`^[${PY_SPACE}]*请(?!问)[${PY_SPACE}]*(?:让|叫)?[${PY_SPACE}]*`, "u");
const AFTER_HELP = pyFullmatch(String.raw`(?:我|忙)?(?:一下)?\s*review(?P<rest>.*)`, "is");

/** The name and the rest of a review-only ask. */
export interface ReviewOnlyAsk {
  readonly who: string;
  readonly rest: string;
}

function splitAtHelp(body: string): ReviewOnlyAsk | undefined {
  for (let at = body.indexOf("帮"); at !== -1; at = body.indexOf("帮", at + 1)) {
    const tail = AFTER_HELP.exec(body.slice(at + 1));
    if (tail !== null) return { who: pyRstrip(body.slice(0, at)), rest: tail.groups?.["rest"] ?? "" };
  }
  return undefined;
}

/** "请 XX 帮我 review ..." that names someone and says nothing of merging: its name and the rest. */
export function asksReviewOnly(text: string): ReviewOnlyAsk | undefined {
  const opening = OPENING.exec(text);
  if (opening === null || REVIEW_MERGE.test(text)) return undefined;
  const ask = splitAtHelp(text.slice(opening[0].length));
  return ask !== undefined && bareName(ask.who.replace(modelFieldPattern(), " ")) ? ask : undefined;
}
