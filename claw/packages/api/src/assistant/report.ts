// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a Worker may tell the assistant, and what each kind of report does to its work item.
 *
 * A Worker never speaks to the user. It reports through the `report` tool; the assistant decides whether,
 * when and where the user hears about it. Which reports wake the assistant is decided here, in one table,
 * so "the user is only interrupted when a decision, a result or a failure needs them" is a property of this
 * file and not of a prompt.
 */
import { z } from "zod";

export const REPORT_KINDS = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_SUMMARY_MAX = 600;
export const REPORT_QUESTION_MAX = 300;
export const REPORT_NOTES_MAX = 2000;
export const REPORT_REFS_MAX = 20;
/** What the Router's list shows for an item: the summary, clipped. */
export const ITEM_SUMMARY_MAX = 80;

const ref = z.object({
  type: z.string().min(1).max(40),
  url: z.string().min(1).max(2000).optional(),
  run_id: z.string().min(1).max(200).optional(),
  sha: z.string().min(1).max(200).optional(),
}).strict();

export const reportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  summary: z.string().trim().min(1).max(REPORT_SUMMARY_MAX),
  question: z.string().trim().min(1).max(REPORT_QUESTION_MAX).optional(),
  result: z.object({
    refs: z.array(ref).max(REPORT_REFS_MAX).optional(),
    notes: z.string().max(REPORT_NOTES_MAX).optional(),
  }).strict().optional(),
}).strict();

export interface WorkerReport {
  kind: ReportKind;
  summary: string;
  question?: string;
  result?: { refs?: Array<z.infer<typeof ref>>; notes?: string };
}

export type ParsedReport =
  | { ok: true; report: WorkerReport }
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
  if (report.question !== undefined && report.kind !== "waiting" && report.kind !== "blocked") {
    return { ok: false, error: `question is only allowed on a waiting or blocked report, not on ${report.kind}. Put it in summary or report waiting/blocked.` };
  }
  if (report.result !== undefined && report.kind !== "ready") {
    return { ok: false, error: `result is only allowed on a ready report, not on ${report.kind}.` };
  }
  return { ok: true, report };
}

export type BoardState = "in_progress" | "needs_you" | "done";

export interface ReportEffect {
  boardState: BoardState;
  /** Whether the assistant is woken with a `[work_event]` message. */
  wakesRouter: boolean;
  /** `needs_you` was entered: the user has something new to hear about. */
  bumpsAttention: boolean;
  /** A new result exists to accept. */
  bumpsResultVersion: boolean;
  closes: boolean;
  keepsQuestion: boolean;
}

/**
 * Report -> item state. A `waiting` report with no question is the Worker waiting on something outside the
 * conversation (a CI run): nobody is asked anything, so nobody is woken.
 */
export function effectOfReport(kind: ReportKind, hasQuestion: boolean): ReportEffect {
  switch (kind) {
    case "progress":
      return { boardState: "in_progress", wakesRouter: false, bumpsAttention: false, bumpsResultVersion: false, closes: false, keepsQuestion: false };
    case "waiting":
      return hasQuestion
        ? { boardState: "needs_you", wakesRouter: true, bumpsAttention: true, bumpsResultVersion: false, closes: false, keepsQuestion: true }
        : { boardState: "in_progress", wakesRouter: false, bumpsAttention: false, bumpsResultVersion: false, closes: false, keepsQuestion: false };
    case "blocked":
      return { boardState: "needs_you", wakesRouter: true, bumpsAttention: true, bumpsResultVersion: false, closes: false, keepsQuestion: true };
    case "ready":
      return { boardState: "needs_you", wakesRouter: true, bumpsAttention: true, bumpsResultVersion: true, closes: false, keepsQuestion: false };
    case "failed":
      return { boardState: "needs_you", wakesRouter: true, bumpsAttention: true, bumpsResultVersion: false, closes: false, keepsQuestion: false };
    case "dropped":
      return { boardState: "done", wakesRouter: true, bumpsAttention: false, bumpsResultVersion: false, closes: true, keepsQuestion: false };
  }
}

export function clipItemSummary(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= ITEM_SUMMARY_MAX ? one : `${one.slice(0, ITEM_SUMMARY_MAX - 1)}…`;
}
