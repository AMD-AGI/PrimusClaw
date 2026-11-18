// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Work items as the Claw HTTP API returns them: the board (`GET /v1/work-items`), one item
 * (`GET /v1/work-items/:id`) and the answers of accept, stop and retry
 * (`POST /v1/work-items/:id/{accept,stop,retry}`).
 *
 * Types and constants only. The API builds these from its rows (`packages/api/src/assistant/work-items.ts`);
 * a client of the API reads them. Timestamps are `Date` where the API builds the object and ISO 8601
 * strings on the wire, so every type that carries one takes it as a parameter, `string` by default.
 */

export const BOARD_STATES = ["in_progress", "needs_you", "done"] as const;
export type BoardState = (typeof BOARD_STATES)[number];

/** What a worker's report says; the last one is the item's `last_report_kind`. */
export const REPORT_KINDS = ["progress", "waiting", "ready", "answer", "blocked", "failed", "dropped"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** How a `done` item ended. */
export type WorkItemOutcome = "accepted" | "answered" | "dropped" | "stopped";

/**
 * `task`: a worker that reports does it. `review`: a GitHub review on someone's behalf (its `params` say which pull
 * request, as whom, how). `remote`: an agent on one of the user's own machines.
 */
export const ITEM_KINDS = ["task", "review", "remote"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** One work item as the board lists it, and as accept, stop and retry answer with it. */
export interface WorkItemView<Time = string> {
  item_id: string;
  seq: number;
  title: string;
  summary: string;
  board_state: BoardState;
  last_report_kind: ReportKind | null;
  pending_question: string | null;
  outcome: WorkItemOutcome | null;
  result_version: number;
  accepted_version: number | null;
  /** A result waits for this person: `board_state` is `needs_you` and the last report was `ready`. */
  can_accept: boolean;
  kind: ItemKind;
  /** What a review was asked with; `{}` for a task. */
  params: Record<string, unknown>;
  updated_at: Time;
}

/** One entry of an item's history, newest first in `WorkItemDetail.events`. */
export interface WorkItemEvent<Time = string> {
  /** A bigint row id, sent as a string. */
  id: string;
  /**
   * `created`, `run_started`, a report kind (`ReportKind`), `accepted` or `stopped`. Kept a string: a client meets kinds
   * a newer server adds.
   */
  kind: string;
  /** Who wrote it: `worker`, `turn_end`, `sweep`, `watchdog`, `user`, `router`, `policy`, `github`. */
  source: string;
  generation: number;
  run_id: string | null;
  summary: string | null;
  question: string | null;
  /** A `ready` report's result as the worker gave it (`{refs: [{type: "pr", url}], ...}`), the accepted version, or null. */
  result: unknown;
  created_at: Time;
}

/** `GET /v1/work-items/:id` for the item's owner: the item, where its worker runs, and its latest events. */
export interface WorkItemDetail<Time = string> extends WorkItemView<Time> {
  worker_session_id: string;
  /** The repository the item was bound to, as it was asked (`{url, branch?}`), or null. */
  repo: unknown;
  created_at: Time;
  closed_at: Time | null;
  events: Array<WorkItemEvent<Time>>;
}

/** Why a review item cannot be stopped: its merge is being made, or was made. */
export type StopRefusal = "merge_in_progress" | "already_merged";

/** The `error` of a 409 from accept or stop; its `data` is the item as it is now. */
export type WorkItemDecisionError = "version_mismatch" | "not_acceptable" | "item_closed" | StopRefusal;

/** The `error` of a 409 from retry; its `data` is the item as it is now. */
export type RetryRefusal = "not_retryable" | "too_many_active_items" | "session_not_found" | "no_credentials" | "acting_session_unattended";
