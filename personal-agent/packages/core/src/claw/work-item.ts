// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { JsonObject } from "../json.js";
import { parseRequesterView } from "./requester-view.js";
import { anything, isObject, objectOf, someText, wholeNumber } from "./lenient.js";
import type { AskerView, PullRef, WorkItem } from "./model.js";

/** A work item as the board lists it and as an event carries it; an event's item carries less, read as nothing. */
const workItemSchema = z.looseObject({
  item_id: z.string().min(1),
  seq: wholeNumber,
  title: someText,
  board_state: someText,
  result_version: wholeNumber,
  can_accept: anything,
  needs_accept: anything,
  last_report_kind: someText,
  pending_question: someText,
  summary: someText,
  outcome: someText,
  kind: someText,
  params: objectOf,
  updated_at: someText,
});

/** The pull request of a review item (`params.pr`); null for anything else, or for one that is not a pull request. */
export function pullOf(params: Readonly<Record<string, unknown>> | undefined): PullRef | null {
  const pr = params?.["pr"];
  if (!isObject(pr)) return null;
  const { owner, repo, number } = pr;
  if (typeof owner !== "string" || owner === "" || typeof repo !== "string" || repo === "") return null;
  if (typeof number !== "number" || !Number.isInteger(number)) return null;
  return { owner, repo, number };
}

/**
 * A work item from Claw's JSON; null when it is not one (no id, or not an object), so a malformed row is skipped. Only
 * a `can_accept` that is true counts, and not when Claw says the result needs no acceptance (`needs_accept` false).
 */
export function parseWorkItem(raw: unknown): WorkItem | null {
  const parsed = workItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  return {
    itemId: item.item_id,
    seq: item.seq ?? 0,
    title: item.title ?? "",
    boardState: item.board_state ?? "in_progress",
    resultVersion: item.result_version ?? 0,
    canAccept: item.can_accept === true && item.needs_accept !== false,
    lastReportKind: item.last_report_kind ?? null,
    pendingQuestion: item.pending_question ?? null,
    summary: item.summary ?? "",
    outcome: item.outcome ?? null,
    kind: item.kind ?? "task",
    params: (item.params ?? {}) as JsonObject,
    pull: pullOf(item.params),
    updatedAt: item.updated_at ?? "",
  };
}

/**
 * A work item made of the asker's view alone (Claw answers the asker of someone else's review with nothing more): its
 * id, its pull request as its title, and the view in `params` so that what is shown is what the asker may see.
 */
export function requesterViewItem(view: AskerView, raw: unknown): WorkItem {
  const seq = isObject(raw) ? (wholeNumber.parse(raw["seq"]) ?? 0) : 0;
  const finished = isFinished(view);
  return {
    itemId: view.itemId,
    seq,
    title: view.prUrl,
    boardState: finished ? "done" : "in_progress",
    resultVersion: 0,
    canAccept: false,
    lastReportKind: null,
    pendingQuestion: null,
    summary: "",
    outcome: finished ? view.status : null,
    kind: "review",
    params: {
      requester_view: { status: view.status, pr_url: view.prUrl, verdict: view.verdict, merged: view.merged },
    },
    pull: null,
    updatedAt: "",
  };
}

/**
 * The item an accept, stop or retry answered with. To the asker of a review someone else runs Claw answers with the
 * asker's view alone: an answer without the board's own fields (`board_state`) is read as that view.
 */
export function decidedItem(itemId: string, data: unknown): WorkItem | null {
  if (isObject(data) && !("board_state" in data)) {
    const view = parseRequesterView(data, itemId);
    if (view !== null) return requesterViewItem(view, data);
  }
  return parseWorkItem(data);
}

/** The statuses of a review that is still open to its asker; a waiting one waits for its reviewer. */
export const REQUESTER_VIEW_WAITING: ReadonlySet<string> = new Set(["needs_you", "waiting", "waiting_for_reviewer"]);
export const REQUESTER_VIEW_OPEN: ReadonlySet<string> = new Set([
  "",
  "in_progress",
  "running",
  "queued",
  "pending",
  ...REQUESTER_VIEW_WAITING,
]);

/** Whether the review is over, to its asker. */
export function isFinished(view: AskerView): boolean {
  return !REQUESTER_VIEW_OPEN.has(view.status);
}

/** Whether the review waits for its reviewer. */
export function waitsForReviewer(view: AskerView): boolean {
  return REQUESTER_VIEW_WAITING.has(view.status);
}
