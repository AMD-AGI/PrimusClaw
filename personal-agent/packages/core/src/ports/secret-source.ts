// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where the worker's secrets come from. The names are the settings they first replaced, kept as stable ids; how a source
 * finds each one (an environment variable, now under its `PA_` name, a mounted file, a vault entry) is that source's
 * business.
 */
export const SECRET_NAMES = [
  "TEAMS_ENCRYPTION_KEYS",
  "TEAMS_EXCHANGE_CLIENT_SECRET",
  "FEEDBACK_GITHUB_APP_KEY",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** The sources a deployment may name in SECRETS_SOURCE. */
export const SECRETS_SOURCES = ["env", "keyvault"] as const;
export type SecretsSourceName = (typeof SECRETS_SOURCES)[number];

/** A secret could not be read. The message names the secret and the reason, never a value. */
export class SecretsUnavailable extends Error {
  override readonly name = "SecretsUnavailable";
}

export interface SecretSource {
  readonly name: SecretsSourceName;
  /**
   * Every one of `names`, read once at start and kept in memory only; throws SecretsUnavailable when one cannot be read
   * (the worker stops before it takes a message: it never runs with a missing or stale secret).
   */
  load(names: readonly SecretName[]): Promise<ReadonlyMap<SecretName, string>>;
}
