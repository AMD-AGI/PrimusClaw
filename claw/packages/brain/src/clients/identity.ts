// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { IdentityClient, readIdentityConfig } from "@claw/utils";
import { metrics } from "../infra/metrics.js";

/** The part of a pino logger this module uses. */
export interface IdentityStartupLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

let instance: IdentityClient | null = null;

/**
 * The process's identity client, or null while IDENTITY_CLIENT_ENABLED is off,
 * which is the default. Nothing in Brain reads this yet.
 */
export function identityClient(): IdentityClient | null {
  return instance;
}

/**
 * Build the client from an environment. Exported for the test that proves what
 * a given environment does; the process calls {@link startIdentityClient}.
 *
 * A process that was told to have the client and cannot build it throws: running
 * on without it would be running without the thing it was configured to depend
 * on, and nothing downstream would say so.
 */
export function buildIdentityClient(
  env: Readonly<Record<string, string | undefined>>,
  log: IdentityStartupLog,
): IdentityClient | null {
  const config = readIdentityConfig(env);
  metrics.setIdentityClientEnabled(config.enabled);
  if (!config.enabled) return null;
  if (config.errors.length > 0 || config.settings === null) {
    log.error({ errors: config.errors }, "startup.identity_client_refused");
    throw new Error(`IDENTITY_CLIENT_ENABLED is true but the client cannot be built: ${config.errors.join("; ")}`);
  }
  if (config.problems.length > 0) log.error({ refused: config.problems }, "startup.config_refused");
  return new IdentityClient(config.settings, {
    metrics: metrics.identity,
    logger: { warn: (fields, message) => log.warn(fields, message) },
  });
}

/**
 * Build the process's client and read discovery and the key set in the
 * background, so a wrong issuer or an unreachable provider is in the log at boot
 * rather than at the first use. The read does not hold start-up and its failure
 * is not fatal: the provider may simply not be up yet.
 */
export function startIdentityClient(log: IdentityStartupLog): IdentityClient | null {
  instance = buildIdentityClient(process.env, log);
  if (instance) {
    instance.warmup().then(
      () => log.info({}, "identity.client_ready"),
      (err: unknown) => log.warn(
        { reason: (err as { reason?: string }).reason ?? "unknown" },
        "identity.warmup_failed",
      ),
    );
  }
  return instance;
}
