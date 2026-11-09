// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one sentence of what a pull request does, as the review session wrote it after reading the diff (`pr_summary`, an optional
 * argument of gh_review_submit and gh_pr_merge). It is part of the review's own structured output, never a model call of its own, and
 * whoever shows a review's conclusion (the requester's view, the acting user's confirmation) shows it beside the verdict.
 *
 * Clipped the same way wherever it is read: one line, credentials masked, at most PR_SUMMARY_MAX_CJK characters when it is written in
 * Chinese (or Japanese, Korean) and PR_SUMMARY_MAX_OTHER otherwise. Nothing that is not a non-empty string is a summary; a review
 * without one is shown as it always was.
 */
import { redactPublicJson } from "../events/redaction.js";

export const PR_SUMMARY_MAX_CJK = 80;
export const PR_SUMMARY_MAX_OTHER = 160;

// (a character past the basic plane, CJK Extension B and on, is a surrogate pair: matched as one, without the u flag)
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]|[\ud840-\ud87e][\udc00-\udfff]/;

/** The summary as it is kept and shown: one line, masked and clipped; null when `value` holds none. */
export function clipPrSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = String(redactPublicJson(value.replace(/\s+/g, " ").trim()) ?? "").trim();
  if (!line) return null;
  const max = CJK.test(line) ? PR_SUMMARY_MAX_CJK : PR_SUMMARY_MAX_OTHER;
  const chars = Array.from(line);   // (by code point: a clip never splits a surrogate pair)
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/**
 * The latest summary the session gave with a review or merge call, as the audit log kept it (every call is audited with its arguments
 * before it runs, a held or refused one included: the sentence is about the pull request, whatever came of the call). Null when none.
 */
export async function latestPrSummary(q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: unknown): Promise<string | null> {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const row = (await q.query(
    `SELECT arguments->>'pr_summary' AS pr_summary FROM claw_github_audit
      WHERE session_id = $1 AND tool IN ('gh_review_submit', 'gh_pr_merge') AND COALESCE(arguments->>'pr_summary', '') <> ''
      ORDER BY id DESC LIMIT 1`,
    [sessionId],
  )).rows[0] as { pr_summary?: unknown } | undefined;
  return clipPrSummary(row?.pr_summary);
}
