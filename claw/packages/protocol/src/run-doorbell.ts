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
export const RUN_DOORBELL_KIND = "run_claim";

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
