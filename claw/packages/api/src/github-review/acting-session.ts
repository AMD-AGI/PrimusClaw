// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a request that creates a session asks of it, checked once for every place that creates one: `POST /v1/sessions` and the review
 * items of the assistant (`assistant/review-items.ts`). A session that acts as a user is the person's say, so the two must not be able to
 * drift apart: the same parse of `acting_as`, `review_target` and `review_only`, the same model and effort, and the same credential check.
 *
 * The answer for a session that acts as a user carries `attended`, the proof that the request was a person's (or an allowed service's)
 * identity-provider token. It can only be made here, and it is what the server needs to put a first message in front of such a session's
 * model by itself (`assistant/messages.ts`): a message the server queues has no request of its own to be checked.
 */
import type { UserInfo } from "../auth/models.js";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { parseSessionEffort, parseSessionModel } from "../sessions/session-model.js";
import type { PrRef } from "./github.js";
import { parseActingAs } from "./acting-as.js";
import { classifyAttendedCaller } from "./attended.js";
import { parseReviewOnly, parseReviewTarget } from "./review-target.js";
import { readGithubReviewSettings } from "./settings.js";
import type { DecidedVia } from "./store.js";

declare const ATTENDED: unique symbol;
/** Made only by {@link checkSessionCreate}, for a request whose credential is a person's: see the module comment. */
export interface AttendedProof {
  readonly [ATTENDED]: true;
  /** The service that answered for the person, or null when it was the person. */
  readonly via: DecidedVia | null;
}

export type SessionCreateCheck =
  | {
    ok: true;
    actingAs: string | null;
    target: PrRef | null;
    reviewOnly: boolean;
    model: string | null;
    effort: string | null;
    /** Set exactly when `actingAs` is. */
    attended: AttendedProof | null;
  }
  | { ok: false; status: 400 | 401 | 403; error: string; log?: string };

/**
 * Check what a create asks for. `config` is the session's config as the caller sent it; for a session that acts as a user,
 * `acting_as_requester` (the footer's name for who asked) is written into it from the verified caller. `model` and `effort` are the
 * request's fields, undefined when it sent none.
 */
export function checkSessionCreate(input: {
  config: Record<string, unknown>;
  model: unknown;
  effort: unknown;
  user: UserInfo | null;
  /** How the request was authenticated (`getAuthMethod`). */
  method: string | null;
}): SessionCreateCheck {
  const { config, user } = input;
  // The user whose GitHub account this session's review tools act as. A reference only; refused while the feature is off so that a
  // session never silently goes without the tools it asked for.
  const parsedActingAs = parseActingAs(config.acting_as);
  if (!parsedActingAs.ok) return { ok: false, status: 400, error: parsedActingAs.error };
  let attended: AttendedProof | null = null;
  if (parsedActingAs.actingAs !== null) {
    if (!CLAW_GITHUB_REVIEW_ENABLED) return { ok: false, status: 400, error: "config.acting_as is not enabled on this deployment" };
    if (!user) return { ok: false, status: 401, error: "authentication required" };
    // A session that acts as a user is the person's say, and the key a sandbox holds (or a sign-in that key can complete) must not be
    // able to start one: a model injected in any ordinary session of the user would otherwise review and merge with their account
    // on its own. The same credentials as answering a held merge (attended.ts).
    const caller = classifyAttendedCaller(input.method, user, readGithubReviewSettings().decisionClientIds);
    if (!caller.ok) return { ok: false, status: 403, error: caller.error, log: `github_review.acting_as_refused_${caller.error}` };
    attended = { via: caller.via } as AttendedProof;
    config.acting_as_requester = (user.userName || user.userId).slice(0, 100);
  }
  // The one pull request the session's review tools may touch, and whether they may only review it. Both bind nothing without
  // `acting_as`, which is why asking for either without one is refused rather than silently ignored.
  const parsedTarget = parseReviewTarget(config.review_target);
  if (!parsedTarget.ok) return { ok: false, status: 400, error: parsedTarget.error };
  if (parsedTarget.target !== null && parsedActingAs.actingAs === null) {
    return { ok: false, status: 400, error: "config.review_target needs config.acting_as" };
  }
  const parsedReviewOnly = parseReviewOnly(config.review_only);
  if (!parsedReviewOnly.ok) return { ok: false, status: 400, error: parsedReviewOnly.error };
  if (parsedReviewOnly.reviewOnly && parsedActingAs.actingAs === null) {
    return { ok: false, status: 400, error: "config.review_only needs config.acting_as" };
  }
  // Absent and null both mean no choice; whether the gateway serves the name is its answer to give, on the first turn that uses it.
  let model: string | null = null;
  if (input.model !== undefined) {
    const parsed = parseSessionModel(input.model);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    model = parsed.model;
  }
  // What the session's creator asked for, nothing the deployment adds.
  let effort: string | null = null;
  if (input.effort !== undefined) {
    const parsed = parseSessionEffort(input.effort);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    effort = parsed.effort;
  }
  return {
    ok: true, actingAs: parsedActingAs.actingAs, target: parsedTarget.target, reviewOnly: parsedReviewOnly.reviewOnly, model, effort, attended,
  };
}
