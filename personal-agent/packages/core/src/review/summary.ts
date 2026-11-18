// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's one sentence of what the pull request does (`pr_summary`), shown right under its verdict, clipped as Claw's
 * views clip it (`clipPrSummary`).
 */

import { clipPrSummary } from "../claw/requester-view.js";
import { reviewReceiptText } from "../locales/review-receipt.js";

export { clipPrSummary };
export type { Redact } from "../inbound-text/redact.js";

/** The line that says what a pull request does, under its verdict; '' when there is none. */
export function prSummaryLine(summary: unknown, lang: "zh" | "en" = "zh"): string {
  const text = clipPrSummary(summary);
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
