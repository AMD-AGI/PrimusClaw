// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The work item an assistant event carries (claw.py `parse_work_item`): undefined when it is not one (no id, or not an object).
 * An event's item carries less than a row of the board, so what is missing reads as nothing; only a `can_accept` that is true
 * counts, and not when Claw says the result needs no acceptance (`needs_accept` false).
 */
import { z } from "zod";

import type { WorkItem } from "../claw/model.js";
import type { JsonObject } from "../json.js";

const text = z.string().min(1).optional().catch(undefined);
const count = z.number().int().optional().catch(undefined);
const pr = z.object({ owner: z.string().min(1), repo: z.string().min(1), number: z.number().int() });
const itemSchema = z.looseObject({
  item_id: z.string().min(1),
  seq: count,
  title: text,
  board_state: text,
  result_version: count,
  can_accept: z.unknown(),
  needs_accept: z.unknown(),
  last_report_kind: text,
  pending_question: text,
  summary: text,
  outcome: text,
  kind: text,
  params: z.record(z.string(), z.unknown()).optional().catch(undefined),
  updated_at: text,
});

export function parseWorkItem(raw: unknown): WorkItem | undefined {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = parsed.data;
  const params = (r.params ?? {}) as JsonObject;
  const pull = pr.safeParse(params["pr"]);
  return {
    itemId: r.item_id,
    seq: r.seq ?? 0,
    title: r.title ?? "",
    boardState: r.board_state ?? "in_progress",
    resultVersion: r.result_version ?? 0,
    canAccept: r.can_accept === true && r.needs_accept !== false,
    lastReportKind: r.last_report_kind ?? null,
    pendingQuestion: r.pending_question ?? null,
    summary: r.summary ?? "",
    outcome: r.outcome ?? null,
    kind: r.kind ?? "task",
    params,
    pull: pull.success ? pull.data : null,
    updatedAt: r.updated_at ?? "",
  };
}
