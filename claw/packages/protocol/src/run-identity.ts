// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Nominal. Only brain's `tasks/run-identity.ts` may mint one. */
export type RunIdentityKey = string & { readonly __runIdentity: unique symbol };

export type RunIdentitySource = "task_id" | "message_id" | "unknown";

export interface RunIdentity {
  readonly key: RunIdentityKey;
  readonly source: RunIdentitySource;
}

/** The same identity minus the brand, which a receiver cannot reconstruct. */
export interface RunIdentityRef {
  readonly key: string;
  readonly source: RunIdentitySource;
}
