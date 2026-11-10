// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How Teams shows feedback's views: small single-column cards with Action.Execute buttons only, so they render the same
 * on desktop and on the phone. Byte for byte the Python worker's `render.report_card`, `thumbs_card`, `thumb_comment_card`
 * and `feedback.offer_card` (snapshots `report`, `thumbs`, `thumb_comment`, `feedback_offer`).
 */
import {
  THUMB_COMMENT_MAX,
  offerTitle,
  type FeedbackOfferRetryView,
  type FeedbackOfferView,
  type FeedbackReportView,
} from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { buttons, execute, header, icon, message, note, text, type CardMessage } from "../../cards/kit.js";
import type { Renderers } from "../registry.js";

export function reportCard(model: FeedbackReportView): CardMessage {
  const words = "Did something go wrong? You can tell the PrimusClaw team.";
  const shown = model.group ? `${words} Only the person who asked can use this button.` : words;
  return message(
    [note(icon("feedback", shown))],
    buttons([execute("Report a problem", "primusclaw.feedback", { primusclaw: "report", prompt: model.promptId })], ""),
  );
}

export function thumbsCard(): CardMessage {
  const thumb = (title: string, reaction: string): CardElement =>
    execute(title, "primusclaw.thumb", { primusclaw: "thumb", reaction });
  return message(
    [note(icon("feedback", "Was this answer helpful?"))],
    buttons([thumb("\u{1f44d}", "like"), thumb("\u{1f44e}", "dislike")], ""),
  );
}

export function thumbCommentCard(): CardMessage {
  const choice = (title: string, skip: boolean): CardElement =>
    execute(title, "primusclaw.thumb_note", { primusclaw: "thumb_note", skip });
  return message(
    [
      header("Sorry about that. What went wrong? (optional)", { emoji: "feedback" }),
      {
        type: "Input.Text",
        id: "comment",
        isMultiline: true,
        maxLength: THUMB_COMMENT_MAX,
        placeholder: "What went wrong?",
      },
    ],
    buttons([choice("Send", false), choice("Skip", true)]),
  );
}

/** Yes (primary) and No: what the offer's buttons carry, also when a Yes has to be pressed again. */
export function offerButtons(offerId: string): CardElement[] {
  const button = (title: string, include: boolean, style: string): CardElement => ({
    type: "Action.Execute",
    title,
    verb: "primusclaw.feedback",
    style,
    data: { primusclaw: "feedback", offer: offerId, include },
  });
  return [button("Yes, add them", true, "positive"), button("No", false, "default")];
}

export function offerCard(model: FeedbackOfferView): CardMessage {
  return message(
    [
      header(offerTitle(model.issueNumber), { tone: "accent", emoji: "feedback" }),
      note(
        "The PrimusClaw team can then read them. Passwords and keys are hidden first. " +
          "The report does not include them unless you choose Yes.",
      ),
    ],
    offerButtons(model.offerId),
  );
}

/** The offer after a Yes that could not be carried out: the note, under the offer's question, with Yes and No again. */
export function offerRetryCard(model: FeedbackOfferRetryView): CardMessage {
  return message(
    [header(offerTitle(model.issueNumber), { emoji: "notice" }), text(model.note)],
    offerButtons(model.offerId),
  );
}

export const FEEDBACK_RENDERERS = {
  thumbs: thumbsCard,
  thumbComment: thumbCommentCard,
  feedbackReport: reportCard,
  feedbackOffer: offerCard,
  feedbackOfferRetry: offerRetryCard,
} satisfies Partial<Renderers>;
