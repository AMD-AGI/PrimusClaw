// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Review items as the Claw HTTP API returns them: the reviews `POST /v1/assistant/reviews` started, and what the person
 * who asked for a review someone else runs may see of it (`GET /v1/work-items/:id` and the stop's answer for that person,
 * `GET /v1/work-items/asked-of-others`).
 *
 * Types only. The API builds these in `packages/api/src/assistant/review-items.ts` and `requester-view.ts`.
 */

/** One pull request. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** One review `POST /v1/assistant/reviews` started (`data.items[]`), as its owner is answered. */
export interface StartedReview {
  item_id: string;
  seq: number;
  title: string;
  session_id: string;
  pr: PrRef;
  /** The turn id of the session's first message (`claw-pending-<id>`), for a caller that follows that turn's stream. */
  message_id: string | null;
  /** What the request named that the review does not take (a review asked of someone else runs on their settings). */
  ignored?: Array<"model" | "effort">;
  /** The review never merges. */
  review_only: boolean;
  /** Present when every merge of this review waits for the acting user's own confirmation, whatever their review mode. */
  merge_needs_confirmation?: true;
  /** Present on a review asked of someone else that may merge: the requester's own account merges it once it is approved and green. */
  merge_by_requester?: true;
  /** With model choice on: the model the review runs on (null: the deployment's default). Absent with model choice off. */
  model?: string | null;
  /** The model it was to run on, which the payer's key could not use. */
  fell_back_from?: string;
  /** Present when the item waits for a slot (`reason`: the limit that was full); it starts by itself. Absent: it started. */
  queued?: { reason: string };
}

/** A review started for someone else, as the person who asked is answered: the session is the reviewer's, so its ids are left out. */
export type StartedReviewForRequester = Omit<StartedReview, "session_id" | "message_id">;

/** What the person who asked for a review someone else runs may see of it, and all they see. */
export interface RequesterView {
  /** `queued`: made, and waiting for a slot; it starts by itself, and then reads `in_progress`. */
  status: "queued" | "in_progress" | "waiting_for_reviewer" | "done" | "stopped";
  pr_url: string | null;
  verdict: "approve" | "request_changes" | "comment" | null;
  merged: boolean;
  /** Only while `status` is `waiting_for_reviewer`, else null. */
  waiting_for: "confirm_merge" | "confirm_review" | "failed" | "reviewer" | null;
  /** Open findings the review posted on the pull request; null when it posted none (no record yet). */
  findings: number | null;
  /** The first open finding, one line, credentials masked; null when there is none. */
  note: string | null;
  /** What the pull request does, in one sentence the review gave with its verdict; null when it gave none. */
  pr_summary: string | null;
}

/** One review the caller asked of someone else (`GET /v1/work-items/asked-of-others`): its id, who reviews it, and the view. */
export interface AskedOfOther {
  item_id: string;
  reviewer: string | null;
  view: RequesterView;
}
