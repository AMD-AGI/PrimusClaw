// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a Worker may tell the assistant: the shape of the `report` tool's input, checked as the Worker's
 * words, not as the server's data.
 *
 * A Worker never speaks to the user. It reports; the assistant decides whether, when and where the user
 * hears about it. What a report does to the item, and whether it wakes the assistant, is `work-items.ts`.
 */
import { z } from "zod";
import { REPORT_KINDS, type WorkReport } from "./work-items.js";

export const REPORT_SUMMARY_MAX = 600;
/**
 * An answer's summary is the answer itself (`kind: "answer"`), said to the user whole: up to this, so that the system's message
 * that carries it (`#12 "title": <answer>`) stays within what one message may hold (`SAY_TEXT_MAX`, 9000). A longer answer goes in
 * a file the worker delivers.
 */
export const REPORT_ANSWER_MAX = 8800;
export const REPORT_QUESTION_MAX = 300;
export const REPORT_NOTES_MAX = 2000;
export const REPORT_REFS_MAX = 20;

const ref = z.object({
  type: z.string().min(1).max(40),
  url: z.string().min(1).max(2000).optional(),
  run_id: z.string().min(1).max(200).optional(),
  sha: z.string().min(1).max(200).optional(),
}).strict();

export const reportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  summary: z.string().trim().min(1).max(
    REPORT_ANSWER_MAX,
    `at most ${REPORT_ANSWER_MAX} characters even for an answer: put a longer one in a file, hand it over with deliver_file, and report its gist`,
  ),
  question: z.string().trim().min(1).max(REPORT_QUESTION_MAX).optional(),
  result: z.object({
    refs: z.array(ref).max(REPORT_REFS_MAX).optional(),
    notes: z.string().max(REPORT_NOTES_MAX).optional(),
  }).strict().optional(),
}).strict();

export type ParsedReport =
  | { ok: true; report: WorkReport }
  | { ok: false; error: string };

/**
 * Validate a `report` call. The error is written for the Worker to read and retry on: nothing is stored for
 * a report that does not parse, so a vague refusal is a lost report.
 */
export function parseReport(input: unknown): ParsedReport {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "report"}: ${i.message}`);
    return { ok: false, error: `invalid report (${problems.join("; ")}). Fix the fields and call report again.` };
  }
  const report = parsed.data;
  if (report.kind !== "answer" && report.summary.length > REPORT_SUMMARY_MAX) {
    return { ok: false, error: `invalid report (summary: at most ${REPORT_SUMMARY_MAX} characters for a ${report.kind} report; only an answer may be longer). Fix the fields and call report again.` };
  }
  if (report.question !== undefined && report.kind !== "waiting" && report.kind !== "blocked") {
    return { ok: false, error: `question is only allowed on a waiting or blocked report, not on ${report.kind}. Put it in summary or report waiting/blocked.` };
  }
  if (report.result !== undefined && report.kind !== "ready") {
    return { ok: false, error: `result is only allowed on a ready report, not on ${report.kind}.` };
  }
  return { ok: true, report };
}
