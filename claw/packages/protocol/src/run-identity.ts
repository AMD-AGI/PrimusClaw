// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one value a run is tracked under while its time is being accounted for.
 *
 * Declared here rather than in the process that mints it because both sides of
 * the lease wire name the type: brain resolves the identity and reports under
 * it, the API stores what it was told. Minting stays in one place -- brain's
 * `tasks/run-identity.ts` holds the only cast that produces a branded key --
 * so nothing downstream can invent an identity out of a proxy string.
 */

/** Nominal. Only the brain's run-identity resolver may mint one. */
export type RunIdentityKey = string & { readonly __runIdentity: unique symbol };

export type RunIdentitySource = "task_id" | "message_id" | "unknown";

export interface RunIdentity {
  readonly key: RunIdentityKey;
  readonly source: RunIdentitySource;
}

/**
 * An identity that has crossed a wire or come back out of storage.
 *
 * Structurally the same, minus the brand: a receiver cannot reconstruct the
 * guarantee that the key came from the resolver, so it does not claim to.
 * Every {@link RunIdentity} is assignable to this.
 */
export interface RunIdentityRef {
  readonly key: string;
  readonly source: RunIdentitySource;
}
