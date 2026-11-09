// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Feedback's cards (W8), with the Python catalog's inputs. */
import { offerCard, reportCard, thumbCommentCard, thumbsCard } from "../../packages/teams/src/views/feedback/index.js";
import { entries } from "./catalog.js";

export const FEEDBACK_CARDS = entries(
  ["report", () => reportCard({ promptId: "p-1", group: false })],
  ["thumbs", () => thumbsCard()],
  ["thumb_comment", () => thumbCommentCard()],
  ["feedback_offer", () => offerCard({ offerId: "off-1", issueNumber: 512 })],
);
