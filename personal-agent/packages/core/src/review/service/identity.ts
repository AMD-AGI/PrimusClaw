// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The calls the review service makes as a person: the exchanged identity token (never a linked API key) for Claw's review
 * routes, and what Claw holds for them (the confirmation setting, what it reads their GitHub with). A failure to read is an
 * answer of its own ('' / NOT_YET / unknown), never an exception that ends the flow.
 */

import { ClawAnswerInvalid, ClawError, ClawUnreachable, errorKind } from "../../claw/errors.js";
import type { GithubConnection } from "../../claw/model.js";
import { DEFAULT_MODE, isReviewMode, type ReviewMode } from "../review-turn.js";
import type { ReviewDeps } from "./deps.js";

/** Claw answers 404 for the setting: its API is not deployed yet, and every review is confirmed as by default. */
export const NOT_YET = "not_yet";

export type ModeRead = ReviewMode | typeof NOT_YET | "";

/** The exchanged token that acts as `userId`, or why there is none. */
export async function tokenFor(
  deps: ReviewDeps,
  userId: string,
): Promise<{ readonly token: string } | { readonly failed: "not_bound" | "unavailable"; readonly reason: string }> {
  const result = await deps.exchange.tokenFor(userId);
  if (result.ok) return { token: result.value };
  const error = result.error;
  return error.kind === "not_bound"
    ? { failed: "not_bound", reason: "not_bound" }
    : { failed: "unavailable", reason: error.kind === "exchange_failed" ? error.reason : error.kind };
}

const isNotFound = (err: unknown): boolean => err instanceof ClawError && err.status === 404;

/** A failed call of Claw's (an answer, no answer, an answer not understood); anything else is a bug and is thrown on. */
export function clawFailure(err: unknown): boolean {
  return err instanceof ClawError || err instanceof ClawUnreachable || err instanceof ClawAnswerInvalid;
}

/**
 * The person's confirmation setting as Claw holds it, read as them; '' when it cannot be read, NOT_YET for a Claw without
 * it. A value this worker does not know is the default, as Claw itself reads it.
 */
export async function modeOf(deps: ReviewDeps, userId: string): Promise<ModeRead> {
  const token = await tokenFor(deps, userId);
  if (!("token" in token)) {
    deps.logger.info("the confirmation setting could not be read", { error: token.reason });
    return "";
  }
  try {
    const mode = await deps.claw.settings.reviewMode(token.token);
    return isReviewMode(mode) ? mode : DEFAULT_MODE;
  } catch (err) {
    if (!clawFailure(err)) throw err;
    deps.logger.info("the confirmation setting could not be read", { error: errorKind(err) });
    return isNotFound(err) ? NOT_YET : "";
  }
}

/** Writes the person's confirmation setting as them: true, NOT_YET for a Claw without it, false when it was not written. */
export async function writeMode(
  deps: ReviewDeps,
  userId: string,
  mode: ReviewMode,
): Promise<true | false | typeof NOT_YET> {
  const token = await tokenFor(deps, userId);
  if (!("token" in token)) {
    deps.logger.warn("the confirmation setting could not be written", { error: token.reason });
    return false;
  }
  try {
    await deps.claw.settings.setReviewMode(token.token, mode);
    return true;
  } catch (err) {
    if (!clawFailure(err)) throw err;
    deps.logger.warn("the confirmation setting could not be written", { error: errorKind(err) });
    return isNotFound(err) ? NOT_YET : false;
  }
}

/**
 * What Claw says about the person's GitHub tools, asked as them, and whether it could say: [null, true] for a Claw without
 * the answer, [null, false] when it could not be asked.
 */
export async function connectionOf(
  deps: ReviewDeps,
  userId: string,
): Promise<readonly [GithubConnection | null, boolean]> {
  const token = await tokenFor(deps, userId);
  if (!("token" in token)) {
    deps.logger.info("Claw's GitHub connection could not be read", { error: token.reason });
    return [null, false];
  }
  try {
    return [await deps.claw.settings.githubConnection(token.token), true];
  } catch (err) {
    if (!clawFailure(err)) throw err;
    deps.logger.info("Claw's GitHub connection could not be read", { error: errorKind(err) });
    return [null, false];
  }
}
