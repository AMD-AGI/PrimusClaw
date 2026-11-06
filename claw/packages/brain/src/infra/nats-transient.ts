// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether an error is NATS saying "not right now" rather than "no".
 *
 * Matched on the client's own `name` and `code`, never on the message. The
 * message of the commonest case is the bare word "TIMEOUT": a JetStream publish
 * or KV write that got no PubAck inside the client's request timeout. The
 * retry policy used to look for "nats" in the message, which that word does
 * not contain, so a twenty-second JetStream stall (one storage node rebooting
 * under the R3 streams, 2026-11-06) failed two runs outright as if the model
 * had timed out, and acked them so nothing ever retried them.
 *
 * Every code here is about reachability or a leader that is not there yet:
 * TIMEOUT (no answer in time), 503 (no responders -- a stream mid-election, or
 * JetStream briefly unavailable), and the connection states the client passes
 * through while it reconnects. None of them says anything about the request
 * itself, so the same request may succeed a moment later. Codes that do --
 * a bad subject, a permissions violation, a payload over the limit -- are
 * deliberately absent.
 */
const TRANSIENT_NATS_CODES = new Set([
  "TIMEOUT",
  "503",
  "408",
  "CONNECTION_REFUSED",
  "CONNECTION_CLOSED",
  "CONNECTION_DRAINING",
  "CONNECTION_TIMEOUT",
  "DISCONNECT",
  "IDLE_HEARTBEAT",
]);

export function isTransientNatsError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null | undefined;
  if (!e || typeof e !== "object") return false;
  if (e.name !== "NatsError") return false;
  return typeof e.code === "string" && TRANSIENT_NATS_CODES.has(e.code);
}
