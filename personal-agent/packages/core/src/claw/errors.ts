// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";

/**
 * The errors a Claw call ends in. Every implementation of `ClawPort` throws these and nothing else, so a caller never
 * meets a transport library's error (whose text can carry a URL, a header or the body of an answer).
 */

/** Claw's error words: "sandbox_not_running", "session_closed". */
const ERROR_WORD = /^[a-z][a-z0-9_]{0,63}$/;
/** The leading `{"ok": false, "error": "..."}` of a body that was cut mid-JSON (only the first 200 characters are kept). */
const LEADING_ERROR = /^\s*\{\s*"ok"\s*:\s*false\s*,\s*"error"\s*:\s*"([a-z][a-z0-9_]{0,59})"/;

/** Whether `code` is a plain snake_case error word ("connector_outdated"), safe to put in front of a person or in a log. */
export function isErrorWord(code: string): boolean {
  return ERROR_WORD.test(code);
}

/** The `error` word of Claw's `{"ok": false, "error": "..."}` answer in `detail` ("" when the body is not that). */
export function errorCodeOf(detail: string): string {
  let body: unknown;
  try {
    body = JSON.parse(detail);
  } catch {
    // `detail` is the start of the body only: an answer with `data` after its error word is cut mid-JSON. Its leading
    // `"error"` word is still read, and only a plain word.
    return LEADING_ERROR.exec(detail)?.[1] ?? "";
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "";
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error === "string") return error;
  if (typeof error === "number") return error === 0 ? "" : String(error);
  // Anything else is not an error word; it is kept only so that a log line can say Claw sent one (never a code).
  return error === undefined || error === null || error === false ? "" : JSON.stringify(error);
}

/**
 * Claw refused or failed a call. `detail` keeps the start of the answer's body so that `code` can read Claw's error word,
 * but the error's message is only the status and that word: a body can echo what the request carried.
 */
export class ClawError extends Error {
  override readonly name: string = "ClawError";
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail = "") {
    const code = errorCodeOf(detail);
    super(`Claw returned ${String(status)}` + (isErrorWord(code) ? ` (${code})` : ""));
    this.status = status;
    this.detail = detail;
  }

  /** The `error` word of Claw's answer ("" when the body is not that). */
  get code(): string {
    return errorCodeOf(this.detail);
  }
}

/** The answer Claw gives for an id that is not the caller's; also what an id that is not a Claw id is refused as. */
export function notAClawId(): ClawError {
  return new ClawError(404, "not a Claw id");
}

/**
 * Claw refused a request for reviews as a whole (it starts all of them or none): its `error` word, its sentence for a
 * person (`said`) and its `data` (which pull request, the limit, what remains).
 */
export class ReviewsRefused extends ClawError {
  override readonly name: string = "ReviewsRefused";
  readonly error: string;
  readonly said: string;
  readonly data: Readonly<Record<string, unknown>>;

  constructor(status: number, error: string, said: string, data: Readonly<Record<string, unknown>>) {
    super(status, JSON.stringify({ ok: false, error }));
    this.error = error;
    this.said = said;
    this.data = data;
  }
}

/** A reply this process will not hold: larger than the caller allows, or content-encoded. */
export class ReplayRefused extends Error {
  override readonly name: string = "ReplayRefused";
}

/** Claw answered with something this client does not understand (not a list, an item without an id, ...). */
export class ClawAnswerInvalid extends Error {
  override readonly name: string = "ClawAnswerInvalid";
}

/**
 * A call that would send the wrong kind of credential, refused before anything goes out: an `ak-` API key where only an
 * exchanged identity token may go, or a model key next to an API key.
 */
export class CredentialMisuse extends Error {
  override readonly name: string = "CredentialMisuse";
}

/** Claw was not reached, or did not answer in time. `kind` says which; the cause's text is never kept. */
export class ClawUnreachable extends Error {
  override readonly name: string = "ClawUnreachable";
  readonly kind: "timeout" | "network";

  constructor(kind: "timeout" | "network", what: string) {
    super(`Claw ${kind === "timeout" ? "did not answer in time" : "was not reached"}: ${what}`);
    this.kind = kind;
  }
}

/**
 * What a log line says about a failed call: Claw's status (and error word), or only the kind of error. Never the text of
 * another library's error, which can carry a URL, a header or the body of an answer.
 */
export function errorKind(err: unknown): string {
  return err instanceof ClawError ? err.message : errorName(err);
}
