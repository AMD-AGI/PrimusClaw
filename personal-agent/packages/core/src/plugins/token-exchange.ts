// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { err, type Result } from "../result.js";

/**
 * Short-lived tokens that act as a person, from an identity service's token exchange (RFC 8693; the Python worker's
 * `exchange.ExchangeClient`). The person's channel identity is traded for a token; nothing long-lived is stored. A
 * person with no confirmed binding gets `not_bound` and is offered a one-time binding link (`bindingRequest`).
 */
export interface NotBound {
  readonly kind: "not_bound";
}

/** The exchange could not be done (service down, client rejected, malformed reply); `reason` is status and code only. */
export interface ExchangeFailed {
  readonly kind: "exchange_failed";
  readonly reason: string;
}

/** No exchange is configured in this deployment. */
export interface ExchangeUnavailable {
  readonly kind: "exchange_unavailable";
}

export type ExchangeError = NotBound | ExchangeFailed | ExchangeUnavailable;

/** A one-time link that binds this channel user to the account that confirms it. */
export interface BindingRequest {
  readonly confirmUrl: string;
  readonly expiresInSeconds: number;
}

export interface TokenExchange {
  /** False when no exchange is configured: the flows that need one are not offered. */
  readonly enabled: boolean;
  /** A token acting as the person bound to channel user `userId`. */
  tokenFor(userId: string): Promise<Result<string, ExchangeError>>;
  /** The confirm link for `userId`; `email`, when the channel supplied one, restricts who can confirm it. */
  bindingRequest(userId: string, email: string): Promise<Result<BindingRequest, ExchangeFailed | ExchangeUnavailable>>;
  /** Forget the cached token and the cached "not bound" of `userId` (after the person says they confirmed). */
  invalidate(userId: string): void;
}

const unavailable = (): Promise<Result<never, ExchangeUnavailable>> =>
  Promise.resolve(err({ kind: "exchange_unavailable" }));

/** No exchange configured. */
export const noTokenExchange: TokenExchange = {
  enabled: false,
  tokenFor: unavailable,
  bindingRequest: unavailable,
  invalidate: () => undefined,
};
