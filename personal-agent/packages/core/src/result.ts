// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The result of an operation that can fail in a way its caller is expected to handle.
 *
 * The convention for the whole package:
 *  - An expected failure (the identity service says "not bound", Teams refuses a stream, a card's data is not what the
 *    handler reads) is a value: `Result<T, E>` where `E` is a discriminated union with a `kind` field. The caller has
 *    to look at it; the compiler sees a case it forgot.
 *  - A broken invariant (a bug, a programming error) is thrown, as an `Error`. Nothing catches it to continue as if the
 *    operation had worked; the one place that catches everything (the handler of one inbound event) logs its type and
 *    tells the person the request did not finish.
 *  - Nothing swallows an error: a `catch` that continues returns or records what it caught.
 */
export type Result<T, E extends Failure> = Ok<T> | Err<E>;

/** What every expected failure carries: which one it is. */
export interface Failure {
  readonly kind: string;
}

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E extends Failure> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E extends Failure>(error: E): Err<E> {
  return { ok: false, error };
}

/** The value of a result, or `fallback` when it failed. */
export function valueOr<T, E extends Failure>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** A result whose value went through `fn`; a failure passes through unchanged. */
export function mapResult<T, U, E extends Failure>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
