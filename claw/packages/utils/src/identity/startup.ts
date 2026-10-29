// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { IdentityClient } from "./client.js";
import { readIdentityConfig } from "./config.js";
import type { IdentityMetrics } from "./types.js";

/** The part of a pino logger the start-up helpers use. */
export interface IdentityStartupLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** What a process supplies: where the client reports, and the gauge that says it is on. */
export interface IdentityProcessMetrics {
  /** Handed to the client at construction. */
  identity: IdentityMetrics;
  /** Called once per build with whether the client is configured on. */
  setIdentityClientEnabled(enabled: boolean): void;
}

/**
 * Build the client from an environment: null while IDENTITY_CLIENT_ENABLED is
 * off, which is the default. Every process builds it this way, so a refusal, a
 * log line or a metric means the same thing in all of them.
 *
 * A process that was told to have the client and cannot build it throws: running
 * on without it would be running without the thing it was configured to depend
 * on, and nothing downstream would say so.
 */
export function buildIdentityClient(
  env: Readonly<Record<string, string | undefined>>,
  log: IdentityStartupLog,
  metrics: IdentityProcessMetrics,
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
 * {@link buildIdentityClient}, then read discovery and the key set in the
 * background, so a wrong issuer or an unreachable provider is in the log at boot
 * rather than at the first request. The read does not hold start-up and its
 * failure is not fatal: the provider may simply not be up yet, and every request
 * path that needs it handles it being down.
 */
export function startIdentityClient(
  env: Readonly<Record<string, string | undefined>>,
  log: IdentityStartupLog,
  metrics: IdentityProcessMetrics,
): IdentityClient | null {
  const client = buildIdentityClient(env, log, metrics);
  if (client) {
    client.warmup().then(
      () => log.info({}, "identity.client_ready"),
      (err: unknown) => log.warn(
        { reason: (err as { reason?: string }).reason ?? "unknown" },
        "identity.warmup_failed",
      ),
    );
  }
  return client;
}
