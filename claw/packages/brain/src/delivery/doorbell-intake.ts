// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a doorbell should become a claim.
 *
 * The wakeup names a row and a session. Claiming a deleted session writes a
 * lease the sweeper would put back on the queue; a replica that cannot take
 * the row should ack the wakeup and leave it for claim-next. The claim itself
 * always goes by `task_id` against this replica's API, never the payload host.
 */

import type { ExecuteRequest, RunDoorbell } from "@claw/protocol";

import type { ClaimedRun } from "../clients/run-claim.js";

export type DoorbellIntake =
  | { kind: "drop" }
  | { kind: "miss" }
  | { kind: "retry"; err: unknown }
  | { kind: "claimed"; request: ExecuteRequest; claimCount: number };

export interface DoorbellIntakeDeps {
  sessionDeleted: (sessionId: string) => Promise<boolean>;
  claim: (taskId: string) => Promise<ClaimedRun | null>;
}

export async function intakeDoorbell(
  doorbell: Pick<RunDoorbell, "task_id" | "session_id">,
  deps: DoorbellIntakeDeps,
): Promise<DoorbellIntake> {
  if (await deps.sessionDeleted(doorbell.session_id)) return { kind: "drop" };
  try {
    const claimed = await deps.claim(doorbell.task_id);
    if (!claimed) return { kind: "miss" };
    return { kind: "claimed", request: claimed.request, claimCount: claimed.claimCount };
  } catch (err) {
    return { kind: "retry", err };
  }
}
