// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the identity client reports about itself, and the seams a caller can
 * replace. This file imports nothing so every other module here can use it.
 */

/** The four upstream conversations the client has. */
export type IdentityOp = "discovery" | "jwks" | "introspection" | "exchange";

/**
 * How a lookup was answered. `hit` and `hit_negative` never left the process,
 * `miss` made the upstream call, `coalesced` waited on a call another caller had
 * already started. Exactly one of these is recorded per lookup, so
 * `(hit + hit_negative + coalesced) / total` is the cache's hit ratio.
 *
 * Serving a stale answer after a failed call is NOT a member: it is a
 * separate event (see {@link IdentityMetrics.onStaleServed}) because it is the
 * one an operator alerts on.
 */
export type CacheResult = "hit" | "hit_negative" | "miss" | "coalesced";

/**
 * How an upstream call ended. Everything but `ok`, `inactive` and `refused` is
 * "could not get an answer" and surfaces to the caller as
 * {@link IdentityUnavailableError}.
 *
 * `inactive` is an introspection answer of `active:false`; `refused` is the
 * token endpoint turning a request down with a 4xx OAuth error body. Both are
 * answers, not failures.
 */
export type UpstreamOutcome =
  | "ok" | "inactive" | "refused"
  | "timeout" | "network" | "rate_limited" | "http_5xx" | "http_4xx" | "bad_response"
  | "client_rejected" | "not_configured";

/**
 * The client's counters. Implemented by each process over its own registry; the
 * client never imports a metrics library. Every argument is a member of a closed
 * union, so none of them can grow a series per credential or per user.
 */
export interface IdentityMetrics {
  onCache(op: IdentityOp, result: CacheResult): void;
  /** An answer was served from a cache entry that had expired, because the upstream could not be asked. */
  onStaleServed(op: IdentityOp): void;
  onUpstream(op: IdentityOp, outcome: UpstreamOutcome, seconds: number): void;
}

export const NOOP_METRICS: IdentityMetrics = {
  onCache() {},
  onStaleServed() {},
  onUpstream() {},
};

/** The one logging call the client makes. Never receives a credential. */
export interface IdentityLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export const NOOP_LOGGER: IdentityLogger = { warn() {} };

/** What the pieces of the client share. */
export interface IdentityDeps {
  fetch: typeof fetch;
  /** Epoch milliseconds. Replaceable so a test moves time instead of sleeping. */
  now: () => number;
  metrics: IdentityMetrics;
  logger: IdentityLogger;
}
