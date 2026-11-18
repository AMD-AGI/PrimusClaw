// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Teams' own thumbs under a message (desktop and web): after the person submitted Teams' feedback form, a
 * `message/submitAction` invoke with value `{actionName: "feedback", actionValue: {reaction, feedback}}`, where
 * `feedback` is a JSON string `{"feedbackText": "..."}` (a plain string or an object is read the same way). The Python
 * worker's `activity.thumb_of` and `_feedback_text`. The bot's own thumbs card is a card press, not this.
 */
import { pyStrip } from "@primusclaw/personal-agent";

import { isFields, type Activity } from "../activity/inbound/schema.js";

export interface TeamsVote {
  readonly reaction: "like" | "dislike";
  /** What the person typed in Teams' form ("" when nothing). */
  readonly comment: string;
}

/** The comment of a feedback form: `{"feedbackText": ...}` as JSON text or an object, or the words themselves. */
export function feedbackTextOf(raw: unknown): string {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return pyStrip(String(value));
    }
  }
  if (isFields(value)) value = value["feedbackText"];
  return typeof value === "string" ? pyStrip(value) : "";
}

/** The thumb an activity carries, if it is Teams' own thumbs invoke; undefined for anything else. */
export function voteOf(activity: Activity): TeamsVote | undefined {
  if (activity.type !== "invoke" || activity["name"] !== "message/submitAction") return undefined;
  const value = activity.value;
  if (!isFields(value) || value["actionName"] !== "feedback") return undefined;
  const action = value["actionValue"];
  const reaction = isFields(action) ? action["reaction"] : undefined;
  if (reaction !== "like" && reaction !== "dislike") return undefined;
  return { reaction, comment: feedbackTextOf(isFields(action) ? action["feedback"] : undefined) };
}
