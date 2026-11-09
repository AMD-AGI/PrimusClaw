// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's ONE message where it was asked: the line that says how it came out (shown the moment the stream shows it),
 * then, once the turn ends, that headline with the model's answer under it, without its verdict line and in plain words.
 */

import {
  PLAIN_WORDS,
  mergeWords,
  modelNoteText,
  notMergedWords,
  reviewReceiptText,
  reviewWords,
} from "../locales/review-receipt.js";
import { cpHead, cpLength, pyRstrip, pyStrip } from "../text/py-text.js";
import { shortName, pullUrl } from "./pull-ref.js";
import { autoOf, type ReviewTurn, reviewerName } from "./review-turn.js";
import { type Redact, prSummaryLine, withSummaryLine } from "./summary.js";
import { pickLang } from "./text/unicode.js";

export const SUMMARY_CHARS = 1200;
export const DM_SUMMARY_CHARS = 700;

const VERDICT = /^\s*VERDICT:\s*(CLEAN|BLOCKING|NOT_REVIEWED)\s*$/iu;
const CJK = /[一-鿿]/u;
const FILE_LINE = /[\p{L}\p{N}_./-]+\.[\p{L}\p{N}_]{1,8}:\p{Nd}+/u;
const NAMES = Object.keys(PLAIN_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");
// A name in backticks loses them with it (the closing one is required when the opening one is there); a longer name is
// tried first; a word that merely contains one (`my_dry_run_flag`) is not one.
const RAW_NAME = new RegExp(
  `\`(?<![A-Za-z0-9_])(${NAMES})(?![A-Za-z0-9_])\`|(?<![A-Za-z0-9_])(${NAMES})(?![A-Za-z0-9_])`,
  "gu",
);

/** One call of a write tool, as the stream showed it: the tool, the status it answered, the review's event. */
export type ToolResult = readonly [tool: string, status: string, event: string];

/**
 * The text with each tool name or state the model wrote by its code said in plain words, in Chinese when the text has any
 * Chinese. A line that has a file:line is a finding about the code under review: it is left as it is.
 */
export function plainWords(text: string): string {
  const zh = CJK.test(text);
  const say = (_m: string, quoted: string | undefined, bare: string | undefined): string =>
    PLAIN_WORDS[quoted ?? bare ?? ""]?.[zh ? 0 : 1] ?? "";
  return text
    .split("\n")
    .map((line) => (FILE_LINE.test(line) ? line : line.replace(RAW_NAME, say)))
    .join("\n");
}

/** A model id as shown: a model id's characters only, at most 100 (it may come from the gateway). */
export function modelId(model: string, limit = 100): string {
  return cpHead(model.replace(/[^A-Za-z0-9._:@/+-]/gu, ""), limit);
}

/** The one line that says which model a review ran on, and that it ran under the reviewer's fully automatic setting. */
export function modelNote(model: string, zh: boolean, autoOfName = ""): string {
  return modelNoteText(modelId(model), zh, autoOfName);
}

/** At most `limit` characters of `text`, said to be shortened, with a link to the whole answer when there is one. */
export function clipSummary(text: string, limit: number, link = ""): string {
  const body = pyStrip(text);
  if (cpLength(body) <= limit) return body;
  const tail = reviewReceiptText.shortened + (link ? reviewReceiptText.openFull(link) : "");
  return pyRstrip(cpHead(body, Math.max(limit - cpLength(tail), 0))) + tail;
}

/** The answer without its last line when that is the VERDICT line. */
export function withoutVerdict(answer: string): string {
  const lines = pyRstrip(answer).split("\n");
  return VERDICT.test(lines.at(-1) ?? "") ? pyRstrip(lines.slice(0, -1).join("\n")) : pyStrip(answer);
}

/** What a group is told of an answer: without its verdict line, in plain words, at most SUMMARY_CHARS, and the model note. */
export function shapeGroupAnswer(
  answer: string,
  options: { link?: string; model?: string; autoOf?: string } = {},
): string {
  const body = plainWords(withoutVerdict(answer));
  if (options.model === undefined) return clipSummary(body, SUMMARY_CHARS, options.link);
  const note = modelNote(options.model, pickLang(answer) === "zh", options.autoOf ?? "");
  return `${clipSummary(body, SUMMARY_CHARS - cpLength(note) - 2, options.link)}\n\n${note}`;
}

/**
 * The one line that says how a review came out, shown the moment the stream shows it. undefined when this call does not
 * settle it: a review that may merge is settled by the merge call (or by a review held or asking for changes), a review
 * only by the review call.
 */
export function resultLine(review: ReviewTurn, outcome: ToolResult, model: string): string | undefined {
  const [tool, status, event] = outcome;
  const actor = reviewerName(review);
  let words: readonly [string, string, string, string];
  if (tool === "gh_pr_merge" && !review.reviewOnly) {
    words = mergeWords(actor, status);
  } else if (
    tool === "gh_review_submit" &&
    (review.reviewOnly || status === "confirmation_required" || event === "REQUEST_CHANGES")
  ) {
    words = [...reviewWords(actor, status, event), ...notMergedWords(review.reviewOnly)];
  } else {
    return undefined;
  }
  const zh = review.lang === "zh";
  return reviewReceiptText.resultLine({
    zh,
    pull: shortName(review.pull),
    verdict: zh ? words[0] : words[1],
    line: zh ? words[2] : words[3],
    note: modelNote(model, zh, autoOf(review)),
    url: pullUrl(review.pull),
  });
}

/**
 * The head of a review's one message: the verdict, whether it merged, how many inline comments it left, the model and the
 * link, from every result the stream showed (the last review call for the verdict, the last merge call for the merge).
 */
export function reviewHeadline(
  review: ReviewTurn,
  results: readonly ToolResult[],
  comments: number,
  model: string,
  lang: "zh" | "en" | "" = "",
): string {
  const zh = (lang || review.lang) === "zh";
  const actor = reviewerName(review);
  const reviews = results.filter((r) => r[0] === "gh_review_submit");
  const merges = review.reviewOnly ? [] : results.filter((r) => r[0] === "gh_pr_merge");
  const lastReview = reviews.at(-1);
  const lastMerge = merges.at(-1);
  const note = modelNote(model, zh, autoOf(review));
  const base = { zh, pull: shortName(review.pull), note, url: pullUrl(review.pull) };
  let words: readonly [string, string, string, string];
  if (lastMerge !== undefined) {
    const merged = mergeWords(actor, lastMerge[1]);
    // (the merge says whether it merged; the review call what the verdict was)
    words = lastReview ? [...reviewWords(actor, lastReview[1], lastReview[2]), merged[2], merged[3]] : merged;
  } else if (lastReview !== undefined) {
    words = [...reviewWords(actor, lastReview[1], lastReview[2]), ...notMergedWords(review.reviewOnly)];
  } else {
    // (the stream showed no write: what happened is the answer's to say, nothing is claimed from the silence)
    return reviewReceiptText.headlineBare(base);
  }
  return reviewReceiptText.headline({
    ...base,
    verdict: zh ? words[0] : words[1],
    line: zh ? words[2] : words[3],
    comments,
  });
}

export interface AnswerParts {
  readonly link?: string;
  readonly model?: string;
  readonly results?: readonly ToolResult[];
  readonly comments?: number;
  readonly prSummary?: string;
}

/** A review's ONE message where it was asked: the headline, the summary line, then the answer in plain words. */
export function reviewAnswer(review: ReviewTurn, answer: string, parts: AnswerParts, mask: Redact): string {
  const lang = pyStrip(answer) ? pickLang(answer) : review.lang;
  const headline = reviewHeadline(review, parts.results ?? [], parts.comments ?? 0, parts.model ?? "", lang);
  const head = withSummaryLine(headline, prSummaryLine(parts.prSummary ?? "", mask, lang));
  const body = withoutVerdict(answer);
  if (!body) return head;
  return `${head}\n\n${clipSummary(plainWords(body), Math.max(SUMMARY_CHARS - cpLength(head) - 2, 200), parts.link)}`;
}
