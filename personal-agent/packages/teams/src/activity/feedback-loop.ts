// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Teams' own thumbs up / thumbs down under a message: the activity carries this channelData, Teams opens its feedback form
 * and sends the answer back as a `message/submitAction` invoke (read by the feedback feature). `feedbackLoopEnabled: true`
 * is the older spelling of the same.
 */
import { isObject, type JsonObject } from "../cards/json.js";

export const FEEDBACK_LOOP: JsonObject = { type: "default" };

/** A copy of `activity` that asks Teams to show the thumbs under it (any other channelData is kept). */
export function withFeedbackLoop(activity: JsonObject): JsonObject {
  const channelData = activity["channelData"];
  return {
    ...activity,
    channelData: { ...(isObject(channelData) ? channelData : {}), feedbackLoop: { ...FEEDBACK_LOOP } },
  };
}
