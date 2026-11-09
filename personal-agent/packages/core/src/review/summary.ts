// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's one sentence of what the pull request does (`pr_summary`), as it is shown: one line, credentials masked, no
 * link or tag markup (its brackets become their full-width forms, which no markdown or HTML reads), and at most 80
 * characters when it is Chinese and 160 otherwise (a longer one is cut and ends in an ellipsis).
 */

import { reviewReceiptText } from "../locales/review-receipt.js";
import { cpHead, cpLength, pyRstrip, pyStrip, squashSpaces } from "../text/py-text.js";

import type { Redact } from "../inbound-text/redact.js";

export type { Redact };

export const PR_SUMMARY_MAX_CJK = 80;
export const PR_SUMMARY_MAX_OTHER = 160;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}]/u;
const MARKUP: Readonly<Record<string, string>> = { "[": "［", "]": "］", "<": "‹", ">": "›" };

/** '' for anything that is not a non-empty string: a review without one is shown as it always was. */
export function clipPrSummary(value: unknown, mask: Redact): string {
  if (typeof value !== "string") return "";
  const line = pyStrip(mask(squashSpaces(value)).replace(/[[\]<>]/gu, (c) => MARKUP[c] ?? c));
  if (!line) return "";
  const limit = CJK.test(line) ? PR_SUMMARY_MAX_CJK : PR_SUMMARY_MAX_OTHER;
  return cpLength(line) <= limit ? line : `${pyRstrip(cpHead(line, limit - 1))}…`;
}

/** The line that says what a pull request does, under its verdict; '' when there is none. */
export function prSummaryLine(summary: unknown, mask: Redact, lang: "zh" | "en" = "zh"): string {
  const text = clipPrSummary(summary, mask);
  return text ? reviewReceiptText.summaryLabel[lang] + text : "";
}

/** `text` (a verdict line, then the link and anything else) with the summary line right under its first line. */
export function withSummaryLine(text: string, summaryLine: string): string {
  if (!summaryLine) return text;
  const at = text.indexOf("\n");
  const first = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? "" : text.slice(at + 1);
  return `${first}\n${summaryLine}${rest ? `\n${rest}` : ""}`;
}
