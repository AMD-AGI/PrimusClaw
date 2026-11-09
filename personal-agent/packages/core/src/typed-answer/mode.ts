// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { typedAnswerText } from "../locales/typed-answer.js";
import {
  ALLOW,
  DENY,
  FILLER,
  FULLY,
  HIGH,
  MERGE_WORD,
  MODE_VERB,
  QUESTION,
  REVIEW_ONLY,
  REVIEW_WORD,
  WORD,
  has,
} from "./patterns.js";

/** A typed choice of how merges are confirmed. */
export interface ModeAnswer {
  readonly mode: "fully_auto" | "high_risk_confirm";
  /** The message is nothing but this choice: enough with no model reading. */
  readonly bare: boolean;
}

/** `text` with the words of the two settings taken out. */
export function withoutModes(text: string): string {
  return text.replace(FULLY, " ").replace(HIGH, " ");
}

/**
 * A message that picks one of the two confirmation settings: a word of exactly one of them, and a word that picks it
 * ("确认全自动", "选高风险再问我"). null otherwise ("改成全自动" is a request for the card).
 */
export function typedMode(text: string): ModeAnswer | null {
  const fully = has(FULLY, text);
  if (fully === has(HIGH, text)) return null;
  const rest = withoutModes(text);
  if (!has(MODE_VERB, rest) || has(DENY, rest) || has(QUESTION, text)) return null;
  const left = rest.replace(MODE_VERB, " ").replace(FILLER, " ");
  return { mode: fully ? "fully_auto" : "high_risk_confirm", bare: !has(WORD, left) };
}

/**
 * Whether the message has a word of an answer at all (cheap: anything else is never read further). A word of the
 * settings counts only with a word that picks one.
 */
export function decisionWords(text: string): boolean {
  const rest = withoutModes(text);
  return has(DENY, rest) || has(ALLOW, rest) || typedMode(text) !== null;
}

/**
 * The message names a review and a merge, in either order and any language: a request to review and merge, never a
 * typed answer to one that waits, whatever a model reading says. A confirmation names one of them at most.
 */
export function namesReviewAndMerge(text: string): boolean {
  return has(REVIEW_ONLY, text) && has(MERGE_WORD, text);
}

/** The fields of a pending confirmation that `pickRow` reads. */
export interface HeldRow {
  readonly kind: string;
  readonly event: string;
  readonly repo: string;
  readonly pr: number;
  readonly created_at: number;
  readonly confirmation_id: string;
}

const newest = <R extends HeldRow>(a: R, b: R): R =>
  b.created_at > a.created_at || (b.created_at === a.created_at && b.confirmation_id > a.confirmation_id) ? b : a;

/**
 * The one confirmation a typed answer about one pull request decides. `rows` are the person's pending rows for that
 * pull request (at least one). Two that hold different things (a merge and a review to post) are told apart by a word of
 * the message, else asked back (a string is the question). One held twice for the same thing is answered for the newest.
 */
export function pickRow<R extends HeldRow>(rows: readonly [R, ...R[]], text: string): R | string {
  let candidates: readonly R[] = rows;
  if (new Set(rows.map((r) => r.kind)).size > 1) {
    const merge = has(MERGE_WORD, text);
    if (merge === has(REVIEW_WORD, text)) {
      const [first] = rows;
      const held = [
        ...new Set(
          rows.map((r) =>
            r.kind === "merge" ? typedAnswerText.heldMerge : typedAnswerText.heldReview({ event: r.event }),
          ),
        ),
      ].join("、");
      return typedAnswerText.heldTwice({ pull: `${first.repo}#${String(first.pr)}`, held, pr: first.pr });
    }
    candidates = rows.filter((r) => r.kind === (merge ? "merge" : "review"));
  }
  return candidates.reduce(newest);
}
