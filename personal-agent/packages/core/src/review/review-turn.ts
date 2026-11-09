// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One review while it runs: who asked, for whom, where the asker and the reviewer are reached, and what Claw made of it.
 * Mutable on purpose, as the Python worker's `ReviewTurn`: the turn fills in what it left on GitHub, the model it ran on and
 * the pull request's one-line summary as it learns them.
 */

import type { AskerView, ReviewStart, PullRef } from "../claw/model.js";
import type { JsonObject } from "../json.js";
import type { ConversationRef } from "../ports/surface.js";
import { cpHead, squashSpaces } from "../text/py-text.js";
import { displayName } from "../review-text/names.js";

export type ReviewMode = "high_risk_confirm" | "fully_auto";
export const DEFAULT_MODE: ReviewMode = "high_risk_confirm";
export const REVIEW_MODE_NAMES: readonly ReviewMode[] = ["high_risk_confirm", "fully_auto"];

export function isReviewMode(value: unknown): value is ReviewMode {
  return value === "high_risk_confirm" || value === "fully_auto";
}

/** What a turn left on GitHub: the tool, the status it answered and the review's event ("" none). */
export type Wrote = readonly [tool: string, status: string, event: string];

export interface ReviewTurn {
  readonly requesterId: string;
  readonly requesterName: string;
  readonly requesterChannelId: string;
  readonly actorId: string;
  /** The reviewer's Claw user id. */
  actorUserId: string;
  readonly actorName: string;
  readonly actorChannelId: string;
  readonly pull: PullRef;
  /** Where the request was asked (the group's, or the asker's own chat). */
  readonly asked: ConversationRef | undefined;
  /** Set when Claw has made the session. */
  sessionId: string;
  /** The model the request named ('' the default); Claw's own once it says (`modelReported`). */
  model: string;
  modelReported: boolean;
  /** The reviewer's confirmation setting when the review started. */
  reviewMode: ReviewMode;
  /** Every merge waits for the reviewer's own confirmation, whatever their setting. */
  mergeHeld: boolean;
  /** The pull request's title as GitHub's public read gave it ('' not read). */
  readonly title: string;
  /** The chat it was asked in, as the reviewer's notice names it (the group's name, "群聊" or "私聊"). */
  readonly where: string;
  readonly fromGroup: boolean;
  readonly lang: "zh" | "en";
  /** What the turn left on GitHub (set after the turn). */
  wrote: Wrote[];
  /** The turn's sentence of what the pull request does (set after the turn). */
  prSummary: string;
  /** The model the turn ran on ('' the default; set after the turn). */
  ranModel: string;
  readonly reviewOnly: boolean;
  /** The reviewer's GitHub login, as the identity service named it when the review started. */
  readonly actorLogin: string;
  /** The review item Claw made for it; undefined: the session was made here. */
  item: ReviewStart | undefined;
  /** The item is the reviewer's own (asked of someone else): followed by its asker view, never its session. */
  forReviewer: boolean;
  /**
   * A review asked of someone else whose session is made here because Claw answered 404: asks Claw once more for it as the
   * reviewer's item when the session is then refused. True: the asker was told; false: the turn says its own failure.
   */
  asItem: (() => Promise<boolean>) | undefined;
  /** The acknowledgement shown at the top of the review's progress message ('' nothing to acknowledge). */
  ack: string;
}

export type NewReviewTurn = Pick<
  ReviewTurn,
  "requesterId" | "requesterName" | "actorId" | "actorUserId" | "actorName" | "actorChannelId" | "pull"
> &
  Partial<ReviewTurn>;

export function reviewTurn(fields: NewReviewTurn): ReviewTurn {
  return {
    requesterChannelId: "",
    asked: undefined,
    sessionId: "",
    model: "",
    modelReported: false,
    reviewMode: DEFAULT_MODE,
    mergeHeld: false,
    title: "",
    where: "",
    fromGroup: true,
    lang: "zh",
    wrote: [],
    prSummary: "",
    ranModel: "",
    reviewOnly: false,
    actorLogin: "",
    item: undefined,
    forReviewer: false,
    asItem: undefined,
    ack: "",
    ...fields,
  };
}

export function selfReview(review: ReviewTurn): boolean {
  return review.actorId === review.requesterId;
}

/** The reviewer's name when the review runs under their fully automatic setting (and nothing holds its merge), else ''. */
export function autoOf(review: ReviewTurn): string {
  return review.reviewMode === "fully_auto" && !review.mergeHeld ? displayName(review.actorName) || "对方" : "";
}

/** The reviewer's name as the asker reads it ("对方" when there is none). */
export function reviewerName(review: ReviewTurn): string {
  return displayName(review.actorName) || "对方";
}

/** The asker's name as the reviewer reads it ("有同事" when there is none). */
export function askerName(review: ReviewTurn): string {
  return displayName(review.requesterName) || "有同事";
}

// --- the asker's view of a review someone else runs -------------------------------------------------------------------------

const VIEW_WAITING = new Set(["needs_you", "waiting", "waiting_for_reviewer"]);
const VIEW_OPEN = new Set(["", "in_progress", "running", "queued", "pending", ...VIEW_WAITING]);

export function viewFinished(view: AskerView): boolean {
  return !VIEW_OPEN.has(view.status);
}

export function viewWaitsForReviewer(view: AskerView): boolean {
  return VIEW_WAITING.has(view.status);
}

// --- the record kept of a followed review -----------------------------------------------------------------------------------

const FOLLOW_FIELDS = [
  "requesterId:requester_aad",
  "requesterName:requester_name",
  "requesterChannelId:requester_teams_id",
  "actorId:actor_aad",
  "actorUserId:actor_user_id",
  "actorName:actor_name",
  "actorChannelId:actor_teams_id",
  "fromGroup:from_group",
  "reviewOnly:review_only",
  "mergeHeld:merge_held",
  "lang:lang",
  "where:where",
] as const;

/**
 * What is kept of a followed review (`asker_follows.review`): names, chats and the pull request, never a credential. The
 * JSON keys are the Python worker's, so either worker reads what the other wrote. `wire` carries the reply-address fields
 * the channel needs to open the reviewer's chat (Teams: service url, tenant, bot id), kept as the channel gave them.
 */
export function followRecord(review: ReviewTurn, wire: JsonObject): JsonObject {
  if (review.item === undefined) throw new TypeError("a followed review has an item");
  const out: Record<string, JsonObject[string]> = { ...wire };
  for (const pair of FOLLOW_FIELDS) {
    const [field, key] = pair.split(":") as [keyof ReviewTurn, string];
    out[key] = review[field] as JsonObject[string];
  }
  out.pull = [review.pull.owner, review.pull.repo, review.pull.number];
  out.item_id = review.item.itemId;
  out.seq = review.item.seq;
  return out;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A followed review again, from what was kept of it; undefined when it cannot be read (it is then let go). */
export function reviewOfRecord(raw: unknown): ReviewTurn | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Readonly<Record<string, unknown>>;
  const pull = record.pull;
  if (!Array.isArray(pull) || pull.length !== 3) return undefined;
  const number = Number(pull[2]);
  if (!Number.isInteger(number) || (typeof record.item_id !== "string" && typeof record.item_id !== "number"))
    return undefined;
  const pullRef: PullRef = { owner: String(pull[0]), repo: String(pull[1]), number };
  const review = reviewTurn({
    requesterId: text(record.requester_aad),
    requesterName: text(record.requester_name),
    requesterChannelId: text(record.requester_teams_id),
    actorId: text(record.actor_aad),
    actorUserId: text(record.actor_user_id),
    actorName: text(record.actor_name),
    actorChannelId: text(record.actor_teams_id),
    fromGroup: record.from_group !== false,
    reviewOnly: record.review_only === true,
    mergeHeld: record.merge_held === true,
    lang: record.lang === "en" ? "en" : "zh",
    where: text(record.where),
    pull: pullRef,
  });
  review.item = {
    target: pullRef,
    itemId: String(record.item_id),
    seq: Number(record.seq) || 0,
    title: "",
    sessionId: "",
    messageId: "",
    model: null,
    fellBackFrom: "",
    ignored: [],
    mergeNeedsConfirmation: null,
    queued: "",
    mergeByRequester: false,
  };
  review.forReviewer = true;
  return review;
}

/** A display name as it is kept on one line (at most 100 characters). */
export function keptName(name: string): string {
  return cpHead(squashSpaces(name), 100);
}
