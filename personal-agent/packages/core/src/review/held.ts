// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A write Claw holds for the reviewer's own confirmation (a high-risk merge, or an approval as a held review), as Claw's
 * record gives it. Only a record that names this very pull request and holds something a card can show is offered, and a
 * confirmation never outlives what Claw would still accept.
 */

import { type PullRef, slug } from "./pull-ref.js";

export const CONFIRMATION_FALLBACK_SECONDS = 3600;
export const CONFIRMATION_MAX_SECONDS = 24 * 3600;
export const MAX_CONFIRMATIONS_PER_TURN = 3;
/** What a held review can be (Claw holds a high-risk approval; a card shows whichever it holds). */
export const REVIEW_EVENTS: readonly string[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u;

/**
 * When Claw says a confirmation runs out, as epoch seconds: never later than a day from now, and a short life when it does
 * not say, or says something that is not a time with an offset.
 */
export function expiryOf(value: unknown, now: number): number {
  const text = typeof value === "string" ? value : "";
  const at = ISO_WITH_OFFSET.test(text) ? Date.parse(text.replace(" ", "T")) : Number.NaN;
  if (Number.isNaN(at)) return now + CONFIRMATION_FALLBACK_SECONDS;
  return Math.min(at / 1000, now + CONFIRMATION_MAX_SECONDS);
}

/** Claw's confirmation names this very pull request (a record that names none is not one that does). */
export function namesPull(item: Readonly<Record<string, unknown>>, pull: PullRef): boolean {
  const { repo, pr } = item;
  return (
    typeof repo === "string" &&
    repo.toLowerCase() === slug(pull).toLowerCase() &&
    (typeof pr === "string" || typeof pr === "number") &&
    String(pr) === String(pull.number)
  );
}

/** The review a confirmation of kind `review` holds (`{event, body, comments}`), or undefined when a card cannot show it. */
export function heldReview(item: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const held = item.review;
  if (typeof held !== "object" || held === null || Array.isArray(held)) return undefined;
  const event = (held as Readonly<Record<string, unknown>>).event;
  return typeof event === "string" && REVIEW_EVENTS.includes(event)
    ? (held as Readonly<Record<string, unknown>>)
    : undefined;
}
