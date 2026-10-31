// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { IdentityOp } from "./types.js";

/**
 * Why the upstream could not be asked, or could not answer. Every one of these
 * means "we do not know", which a caller must answer with a 503 and must never
 * read as "this credential is invalid".
 *
 * `client_rejected` is the upstream refusing OUR credentials (401 or 403 from an
 * endpoint that authenticates the caller). It is not an outage and is never
 * answered from a stale entry: a client the identity service has disabled must
 * stop at once.
 */
export type UnavailableReason =
  | "timeout" | "network" | "rate_limited" | "http_5xx" | "http_4xx"
  | "bad_response" | "client_rejected" | "not_configured";

export class IdentityUnavailableError extends Error {
  readonly op: IdentityOp;
  readonly reason: UnavailableReason;
  readonly status?: number;

  constructor(op: IdentityOp, reason: UnavailableReason, status?: number, cause?: unknown) {
    super(`identity ${op} unavailable: ${reason}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "IdentityUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.op = op;
    this.reason = reason;
    this.status = status;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * The token endpoint answered and said no (RFC 6749 section 5.2 error body). The
 * subject is unknown, has no consent on record, or the audience is not allowed.
 * Unlike {@link IdentityUnavailableError} this is a decision, and a retry will
 * not change it.
 */
export class IdentityExchangeRefusedError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, description?: string) {
    // Truncated because the text is the upstream's, and ends up in logs.
    super(`token exchange refused: ${code}${description ? ` (${description.slice(0, 200)})` : ""}`);
    this.name = "IdentityExchangeRefusedError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.status = status;
  }
}

export type JwtFailure =
  | "malformed" | "alg_not_allowed" | "typ_mismatch" | "unknown_key" | "key_mismatch"
  | "bad_signature" | "issuer_mismatch" | "audience_mismatch" | "expired" | "not_yet_valid"
  | "missing_claim";

/** A JWT that cannot be accepted. The credential is bad; the upstream is fine. */
export class JwtVerificationError extends Error {
  readonly reason: JwtFailure;

  constructor(reason: JwtFailure) {
    super(`jwt rejected: ${reason}`);
    this.name = "JwtVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.reason = reason;
  }
}

/**
 * The identity provider answered a credential lookup and said no: the user has
 * nothing of that kind on record (`not_bound`) or it has run out (`expired`).
 * A decision, not an outage: a retry will not change it.
 */
export class IdentityCredentialRefusedError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`credential lookup refused: ${code}`);
    this.name = "IdentityCredentialRefusedError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.status = status;
  }
}
