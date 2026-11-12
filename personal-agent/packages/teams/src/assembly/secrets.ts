// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's secrets, from where SECRETS_SOURCE says: the environment (W2's EnvSecretSource) or Azure Key Vault as the
 * worker's own identity. Read once at start; one that cannot be read stops the worker before it opens the store.
 */
import type { Clock, Logger, SecretName } from "@primusclaw/personal-agent";
import { EnvSecretSource, secretsSourceOf, wantedSecrets } from "@primusclaw/personal-agent-runtime";

import { keyVaultSourceFromEnv } from "../azure/keyvault.js";
import type { WorkerEnv } from "@primusclaw/personal-agent-worker";

export async function loadSecrets(
  env: WorkerEnv,
  deps: { readonly clock: Clock; readonly logger: Logger; readonly fetch?: typeof fetch },
): Promise<ReadonlyMap<SecretName, string>> {
  const names = wantedSecrets(env);
  if (secretsSourceOf(env) === "keyvault") {
    const source = keyVaultSourceFromEnv(env, {
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    return source.load(names);
  }
  return new EnvSecretSource(env).load(names);
}
