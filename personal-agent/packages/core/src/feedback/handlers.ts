// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { DailyBrief } from "../brief/brief.js";
import type { Observer } from "../observe/observer.js";
import type { RouteHandlers } from "../ports/routing.js";
import type { FeedbackFlow } from "./flow.js";
import type { FeedbackThumbs } from "./thumbs.js";

/**
 * What feedback, observation and the daily brief give the router, in the Python worker's order: in a 1:1 chat the
 * feedback answer is read before the account check; in a group `/observe` is read first, then the feedback answer; the
 * buttons of each card by their kind; the channel's own thumbs as a vote (`FeedbackThumbs.onVote`).
 */
export function w8RouteHandlers(parts: {
  readonly flow: FeedbackFlow;
  readonly thumbs: FeedbackThumbs;
  readonly observer: Observer;
  readonly brief: DailyBrief;
}): RouteHandlers {
  return {
    personalInterceptors: [parts.flow.interceptor],
    groupInterceptors: [parts.observer.interceptor, parts.flow.interceptor],
    commands: [parts.brief],
    clicks: [parts.flow.clicks, parts.thumbs.clicks, parts.observer.clicks],
    votes: parts.thumbs.votes,
  };
}
