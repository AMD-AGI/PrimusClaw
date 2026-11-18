// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's turn as the router starts it (`StartTurn.review`): the review service's `ReviewHost.startTurn` on the router's
 * own `startTurn`, so the worker's assembly only injects the router and the chat it builds. As Python's `_guarded` does for a
 * review: the session is the review's (never the chat's stored one), it is noted as an acting session as soon as it exists,
 * and the review service reads the turn once it is over.
 */
import type { Chat } from "../../routing/chat.js";
import type { ReviewTurnStart, RunningTurn, StartTurn } from "../../routing/turn-start.js";
import type { ReviewTurnOutcome } from "../../turn/runner.js";
import type { Conversation } from "../../ports/surface.js";
import { shortName } from "../../review-text/pull-ref.js";
import type { ReviewTurn } from "../review-turn.js";
import type { ReviewDeps, ReviewHost, StartReviewTurn } from "./deps.js";

/** What follows a review's turn (`GithubReview.afterTurn`). */
export type AfterReviewTurn = (
  review: ReviewTurn,
  finalAnswer: string,
  outcome: ReviewTurnOutcome,
  asked: Conversation,
) => Promise<void>;

/** The router's `startTurn`. */
export type StartRouterTurn = (request: StartTurn) => Promise<RunningTurn | undefined>;

/** The review part of the router's `StartTurn` for one review's turn. */
export function reviewTurnStart(
  request: StartReviewTurn,
  store: Pick<ReviewDeps["store"], "reviewDelegation">,
  afterTurn: AfterReviewTurn,
): ReviewTurnStart {
  const { review } = request;
  return {
    itemId: review.item?.itemId ?? "",
    // (a review item's session is Claw's own, made with its first message: it is only followed)
    itemSessionId: review.item === undefined ? null : review.item.sessionId || null,
    pull: shortName(review.pull),
    model: review.model,
    lang: review.lang,
    fields: { kind: "review", turn: request.turn },
    onSession: (sessionId) => {
      review.sessionId = sessionId;
      // (an approval in it is answered with the exchanged token only, so it is written as soon as the session exists)
      store.reviewDelegation.noteActingSession(sessionId, review.requesterId, review.actorId);
    },
    after: async (outcome) => {
      if (outcome.review !== undefined)
        await afterTurn(review, outcome.finalAnswer, outcome.review, request.conversation);
    },
  };
}

/** `ReviewHost.startTurn` on the router's `startTurn`, with the chat `chatOf` builds for the request. */
export function routedReviewTurns(
  start: StartRouterTurn,
  chatOf: (request: StartReviewTurn) => Chat,
  store: Pick<ReviewDeps["store"], "reviewDelegation">,
  afterTurn: AfterReviewTurn,
): ReviewHost["startTurn"] {
  return async (request) => {
    const running = await start({
      chat: chatOf(request),
      credential: request.token,
      text: request.prompt,
      messageId: request.message.id,
      clientPlatform: request.message.clientPlatform,
      review: reviewTurnStart(request, store, afterTurn),
    });
    return running === undefined ? undefined : { ended: running.done };
  };
}
