// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HMAC signing for outbound notification webhooks.
 *
 * The signed string is `<unix-seconds>.<raw body>`, the digest is HMAC-SHA256
 * under a per-subscription secret, and the header value is `sha256=<hex>`. The
 * timestamp is part of the signed string so a captured request cannot be
 * replayed outside the tolerance window with a fresh timestamp attached.
 *
 * Receivers verify with {@link verifySignature}; it is exported from here so
 * the sender and the check cannot drift apart.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a request timestamp may be from the receiver's clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const TIMESTAMP_HEADER = "x-claw-timestamp";
export const SIGNATURE_HEADER = "x-claw-signature";
export const EVENT_ID_HEADER = "x-claw-event-id";

export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`)
    .update(body)
    .digest("hex");
  return `sha256=${digest}`;
}

export type SignatureVerdict = "ok" | "bad_signature" | "stale_timestamp" | "malformed";

export interface VerifyInput {
  secret: string;
  /** The `X-Claw-Timestamp` header value. */
  timestamp: string | undefined;
  /** The `X-Claw-Signature` header value. */
  signature: string | undefined;
  /** The raw request body, byte for byte as received. */
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export function verifySignature(input: VerifyInput): SignatureVerdict {
  const { secret, timestamp, signature, body } = input;
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return "malformed";
  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return "stale_timestamp";
  const expected = Buffer.from(signPayload(secret, ts, body));
  const presented = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which is itself a refusal.
  if (expected.length !== presented.length) return "bad_signature";
  return timingSafeEqual(expected, presented) ? "ok" : "bad_signature";
}
