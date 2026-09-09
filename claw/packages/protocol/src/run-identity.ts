// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export type RunIdentitySource = "task_id" | "message_id" | "unknown";

/** An identity as it crosses the wire, where the brand cannot be reconstructed. */
export interface RunIdentityRef {
  readonly key: string;
  readonly source: RunIdentitySource;
}
