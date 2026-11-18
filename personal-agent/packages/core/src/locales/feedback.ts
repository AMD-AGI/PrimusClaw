// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * What feedback says. The Python worker says all of it in English in every chat; the catalog keeps that (both languages
 * hold the same texts) until it is translated as a change of its own.
 */
const texts = {
  filed: (p: { number: number; url: string }) =>
    `Thanks. I filed your report as issue [#${String(p.number)}](${p.url}). The PrimusClaw team will look at it.`,
  commented: (p: { number: number; url: string }) =>
    "Thanks. This is the same session you reported a few minutes ago, so I added it to issue " +
    `[#${String(p.number)}](${p.url}).`,
  unconfigured:
    "Feedback is not configured yet, so I could not send your report to the team. " +
    "I saved it on my side so it is not lost.",
  failed: "I could not reach GitHub just now. I saved your report and will retry on my own.",
  whatWentWrong: "What went wrong?",
  whatWentWrongInGroup: (p: { bot: string }) => `What went wrong? Reply with @${p.bot} and what happened.`,
  thumbReportFailed: "I could not record that report. Send /feedback and tell me what went wrong.",
  thumbsAsk: "Was this answer helpful?",
  thumbsUp: "Thanks for the thumbs-up.",
  thumbsDownAsk: "What went wrong? Send /feedback and tell me.",
  buttonInactive: "That button is no longer active.",
  filing: "Thanks. I am filing your report.",
  reportInactive: "That button is no longer active. Send /feedback to report a problem.",
  reportInactiveNote: "This button is no longer active.",
  reportNotAsker: "Only the person who asked can use that button. You can report a problem yourself with /feedback.",
  reportAsked: "Reporting a problem: your next message to me is the report.",
  offerAdded: (p: { number: number }) =>
    `Added your last question and my answer to #${String(p.number)}. Passwords and keys were hidden.`,
  offerDeclined: (p: { number: number }) => `OK. Nothing else was added to #${String(p.number)}.`,
  offerEmpty: (p: { number: number }) => `There was no question and answer to add to #${String(p.number)}.`,
  offerInvalid: "That choice is no longer active.",
  offerRetry: "I could not add them just now. Press Yes again in a minute.",
};

export const feedbackText = defineCatalog({ en: texts, zh: texts });
/** The texts of feedback: the same in every language for now (see above). */
export const FEEDBACK_TEXT = texts;
