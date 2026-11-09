// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Errors that are thrown (see `result.ts` for when to throw and when to return a failure).
 *
 * A message of a thrown error may end up in a log line; it never carries user text, a token or a response body.
 * `errorName` is what is logged about an error that came from outside (an exception of a dependency): its type only,
 * the way the Python worker logged `type(err).__name__`.
 */

/** A broken invariant of this package: a bug, never a condition a user or a peer can cause. */
export class InvariantError extends Error {
  override readonly name = "InvariantError";
}

/** The kind of an error, safe to log: its constructor's name, or the type of a non-error value that was thrown. */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name;
  if (error === null) return "null";
  return typeof error;
}

/** Exhaustiveness check for a discriminated union: `default: return unreachable(x)`. */
export function unreachable(value: never): never {
  throw new InvariantError(`unhandled case: ${JSON.stringify(value)}`);
}
