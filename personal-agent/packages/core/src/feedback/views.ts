// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The views of feedback, as core knows them (a channel renders each one; Teams: `teams/src/views/feedback/`). They carry
 * ids only: whose a button is, and which issue or turn it means, is looked up in the store when it is pressed.
 */

/** Thumbs up and down under a final answer, where the channel's own thumbs do not reach the worker (Teams mobile). */
export type ThumbsView = Readonly<Record<string, never>>;

/** What a thumbs-down on `ThumbsView` turns into: an optional comment, Send or Skip. */
export type ThumbCommentView = Readonly<Record<string, never>>;

/** "Report a problem" under a message that went wrong. In a group only the asker may use it, and the card says so. */
export interface FeedbackReportView {
  readonly promptId: string;
  readonly group: boolean;
}

/** Yes or No: add the reporter's last question and answer to the issue. */
export interface FeedbackOfferView {
  readonly offerId: string;
  readonly issueNumber: number;
}

/** The offer after a Yes that could not be carried out: a note saying so, with Yes and No again. */
export interface FeedbackOfferRetryView extends FeedbackOfferView {
  readonly note: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    thumbs: ThumbsView;
    thumbComment: ThumbCommentView;
    feedbackReport: FeedbackReportView;
    feedbackOffer: FeedbackOfferView;
    feedbackOfferRetry: FeedbackOfferRetryView;
  }
}

/** The longest comment a thumbs-down card takes (the card's own limit; the handler clips again). */
export const THUMB_COMMENT_MAX = 1000;

/** The question the offer asks. */
export function offerTitle(issueNumber: number): string {
  return `Add your last question and my answer to #${String(issueNumber)}?`;
}
