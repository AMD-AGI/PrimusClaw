// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a Claw call is made with: a person's own linked API key (`ak-...`) or an identity token the identity service
 * exchanged for them. The credential is a per-call argument and never kept on the client, so no code path can reach Claw
 * with a credential other than the one its caller names.
 */
export type ClawCredential = string;

/** Whether `credential` is a person's linked API key rather than an exchanged identity token. */
export function isApiKey(credential: ClawCredential): boolean {
  return credential.startsWith("ak-");
}
