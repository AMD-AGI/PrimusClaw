// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A wake-up, not the work.
 *
 * The execution request used to travel on the shared durable as the message
 * itself: whoever pulled it held the keys, the prompt, and the ack. A full
 * replica that could not run it still kept it, so idle siblings saw nothing.
 *
 * A doorbell names the run row and where to claim it. The payload has no
 * credentials. A replica without a slot acks it and walks away; the row stays
 * claimable. Liveness is the lease written at claim time, not the JetStream
 * ack.
 */
import { createHash } from "node:crypto";

export const RUN_DOORBELL_KIND = "run_claim";

/**
 * The delivery-semantics contract this binary implements.
 *
 * Incremented only when a Brain built against version N would behave
 * incorrectly on a doorbell published by an API built against N+1: a new
 * required field, a changed field meaning, a changed claim protocol, or a
 * changed meaning for ack/nak/term after a claim. A binary at version N must
 * keep handling every version in 1..N.
 */
export const DOORBELL_SEMANTICS_VERSION = 1;

/**
 * The largest version number a wire value may name.
 *
 * A bound rather than the version itself, so a corrupt or hostile field is
 * rejected before it is ever compared as a number.
 */
export const DOORBELL_SEMANTICS_MAX = 64;

export interface RunDoorbell {
  kind: typeof RUN_DOORBELL_KIND;
  task_id: string;
  session_id: string;
  message_id?: string;
  /**
   * Address a mixed-fleet replica can POST to if it has no API base of its own.
   * Current Brain ignores this host and claims `task_id` against INTERNAL_BACKEND_URL.
   */
  claim_url: string;
  /**
   * The publishing API's {@link DOORBELL_SEMANTICS_VERSION}.
   *
   * Optional on the wire and deliberately absent from {@link isRunDoorbell}:
   * the stream still holds doorbells published before this field existed, and
   * a doorbell failing the guard would be cast to an `ExecuteRequest`.
   */
  semantics?: number;
}

export function isRunDoorbell(value: unknown): value is RunDoorbell {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === RUN_DOORBELL_KIND
    && typeof v.task_id === "string"
    && v.task_id.length > 0
    && typeof v.session_id === "string"
    && typeof v.claim_url === "string"
    && v.claim_url.length > 0
  );
}

/** An absent field is version 1; anything present and not a bounded integer is rejected. */
export function doorbellSemanticsOf(
  doorbell: Pick<RunDoorbell, "semantics">,
): number | "rejected" {
  const raw = doorbell.semantics;
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return "rejected";
  if (raw < 1 || raw > DOORBELL_SEMANTICS_MAX) return "rejected";
  return raw;
}

/**
 * The JetStream `msgID` for one chat turn's doorbell.
 *
 * Derived from the pair rather than generated, so the immediate and queued
 * publishers of one message deduplicate against each other. The raw chat
 * message id is a millisecond stamp with no session component, and the
 * duplicate window spans the whole stream, so two sessions dispatching in the
 * same millisecond would otherwise collide and one turn would never be woken.
 * NUL separates because it appears in neither field's alphabet.
 */
export function doorbellDedupId(sessionId: string, messageId: string): string {
  return createHash("sha256").update(`${sessionId}\u0000${messageId}`).digest("hex");
}

/** Why a holder is handing a claimed row back. Shared so neither side can widen it alone. */
export const RUN_UNCLAIM_REASONS = [
  "lock_contention",
  "retry",
  "drain",
  "hydrate_failed",
] as const;

/** Why a holder is closing a claimed row for good rather than requeueing it. */
export const RUN_FAIL_CLAIM_REASONS = [
  "session_deleted",
  "claim_abandoned",
  "workspace_unbound",
] as const;

export type RunUnclaimReason = (typeof RUN_UNCLAIM_REASONS)[number];
export type RunFailClaimReason = (typeof RUN_FAIL_CLAIM_REASONS)[number];
