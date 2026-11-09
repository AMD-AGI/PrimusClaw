// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The views of the review delegation, as models (no card JSON): the confirmation-setting card, the card a reviewer confirms
 * a held write on, a review item's card with Stop (and its end), and the GitHub connect card beside a question. The Teams
 * package renders them (`teams/src/views/review/`).
 */

import type { JsonObject } from "../json.js";
import type { OutMessage } from "../ports/surface.js";
import type { ViewButton } from "../ports/surface.js";
import type { ReviewMode } from "./review-turn.js";

export interface ReviewModeView {
  /** The one in force ('' none yet). */
  readonly current: ReviewMode | "";
  /** The one asked for: its button comes first. */
  readonly suggested: ReviewMode | "";
  readonly lead: string;
  /** How to answer by typing, for a person whose clicks may not arrive ('' none). */
  readonly hint: string;
  readonly installUrl: string;
}

export interface GithubConfirmView {
  readonly confirmationId: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly headSha: string;
  readonly reasons: readonly string[];
  readonly checks: string;
  readonly requester: string;
  readonly room: string;
  /** The review Claw holds (its event, its text masked, how many inline comments), or undefined for a merge. */
  readonly review: HeldReviewView | undefined;
  readonly model: string;
  readonly hint: boolean;
  readonly installUrl: string;
  /** Where the merge lands ('' not read). */
  readonly base: string;
  readonly login: string;
  readonly lang: "zh" | "en";
  readonly summary: string;
}

export interface HeldReviewView {
  readonly event: string;
  readonly body: string;
  readonly comments: number;
}

export interface ReviewItemView {
  readonly seq: number;
  readonly pull: string;
  readonly who: string;
  readonly reviewOnly: boolean;
  readonly model: string;
  readonly cardId: string;
  readonly lang: "zh" | "en";
  readonly queued: boolean;
}

export interface EndedItemView {
  /** What the card showed (`PlacedCard.render`, with the review's summary added). */
  readonly render: JsonObject;
  readonly ended: string;
  readonly cardId: string;
}

export interface GithubConnectView {
  readonly code: string;
  readonly uri: string;
  readonly minutes: number;
  readonly question: string;
  readonly lang: "zh" | "en";
  readonly cardId: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    reviewMode: ReviewModeView;
    githubConfirm: GithubConfirmView;
    reviewItem: ReviewItemView;
    endedItem: EndedItemView;
    githubConnect: GithubConnectView;
  }
}

export function reviewModeMessage(model: ReviewModeView): OutMessage {
  return { body: { type: "view", view: { name: "reviewMode", model }, fallbackText: "选择代审合入的确认方式" } };
}

export function githubConfirmMessage(model: GithubConfirmView): OutMessage {
  const what = model.review === undefined ? "Merge needs confirmation" : "Review needs confirmation";
  return { body: { type: "view", view: { name: "githubConfirm", model }, fallbackText: what } };
}

export function reviewItemMessage(model: ReviewItemView): OutMessage {
  return { body: { type: "view", view: { name: "reviewItem", model }, fallbackText: model.pull } };
}

export function endedItemMessage(model: EndedItemView): OutMessage {
  return { body: { type: "view", view: { name: "endedItem", model }, fallbackText: model.ended } };
}

export function githubConnectMessage(model: GithubConnectView): OutMessage {
  return { body: { type: "view", view: { name: "githubConnect", model }, fallbackText: model.uri } };
}

/**
 * Merge / Do not merge (a held review: Post review / Do not post): what the confirmation card's buttons carry. The data is
 * the same for both kinds, the id and the choice: which kind it is the store knows.
 */
export function githubConfirmButtons(confirmationId: string, review: boolean, lang: "zh" | "en" = "zh"): ViewButton[] {
  const [allow, deny] =
    lang === "zh"
      ? review
        ? ["确认发布", "不发布"]
        : ["确认合入", "不合入"]
      : review
        ? ["Post review", "Do not post"]
        : ["Merge", "Do not merge"];
  const button = (title: string, decision: string): ViewButton => ({
    title,
    verb: "primusclaw.github_confirm",
    data: { primusclaw: "github_confirm", confirmation: confirmationId, decision },
  });
  return [button(allow, "allow"), button(deny, "deny")];
}

export const TYPED_MODE_HINT =
  "按钮点不了时，直接回复「确认全自动」或「确认高风险再问我」即可。 / If the buttons do not work, reply 确认全自动 or 确认高风险再问我.";

/** The confirmation settings: [Chinese, English] of each, the first the default. */
export const REVIEW_MODES: Readonly<Record<ReviewMode, readonly [string, string]>> = {
  high_risk_confirm: ["高风险人工再确认一次（默认）", "A person confirms high-risk changes (default)"],
  fully_auto: ["全自动合入，无需人工确认", "Fully automatic merge, nobody is asked to confirm"],
};
