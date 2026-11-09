// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawAnswerInvalid, ClawError, ClawUnreachable, ReplayRefused } from "../upstream.js";

/** A Claw call failed in a way the turn survives (an error status, no answer, an answer it could not read). */
export function isClawFailure(err: unknown): boolean {
  return isClawOrNetwork(err) || err instanceof ClawAnswerInvalid || err instanceof ReplayRefused;
}

/** An error status or no answer at all: Python's `(ClawError, httpx.HTTPError)`. */
export function isClawOrNetwork(err: unknown): err is ClawError | ClawUnreachable {
  return err instanceof ClawError || err instanceof ClawUnreachable;
}

/** What a log line says about it: the status, or the kind of failure. */
export function statusOrKind(err: ClawError | ClawUnreachable): string | number {
  return err instanceof ClawError ? err.status : err.kind;
}
