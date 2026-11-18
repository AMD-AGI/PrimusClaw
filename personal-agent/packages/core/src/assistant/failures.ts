// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the assistant's flows tell Claw's failures apart (the Python worker's `except ClawError`, `except httpx.HTTPError`,
 * `except (ValueError, KeyError)`): a refusal with a status, no answer at all, an answer this client does not understand. Anything
 * else is a bug and is not caught.
 */
import { ClawAnswerInvalid, ClawError, ClawUnreachable } from "../claw/errors.js";

/** Claw answered with an error status. */
export function refusal(error: unknown): ClawError | undefined {
  return error instanceof ClawError ? error : undefined;
}

/** No answer at all (the request may or may not have arrived). */
export function unreachable(error: unknown): boolean {
  return error instanceof ClawUnreachable;
}

/** An answer this client does not understand (the Python worker's `ValueError` from reading it). */
export function answerInvalid(error: unknown): boolean {
  return error instanceof ClawAnswerInvalid;
}

/** Any of Claw's failures: refused, unreachable, or an answer not understood. */
export function clawFailure(error: unknown): boolean {
  return error instanceof ClawError || error instanceof ClawUnreachable || error instanceof ClawAnswerInvalid;
}

/** Rethrows anything that is not one of Claw's failures. */
export function onlyClawFailures(error: unknown): void {
  if (!clawFailure(error)) throw error;
}
