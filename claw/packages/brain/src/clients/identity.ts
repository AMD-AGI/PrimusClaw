// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  buildIdentityClient as build, startIdentityClient as start,
  type IdentityClient, type IdentityStartupLog,
} from "@claw/utils";
import { metrics } from "../infra/metrics.js";

export type { IdentityStartupLog };

let instance: IdentityClient | null = null;

/**
 * The process's identity client, or null while IDENTITY_CLIENT_ENABLED is off,
 * which is the default. Nothing in Brain reads this yet.
 */
export function identityClient(): IdentityClient | null {
  return instance;
}

/**
 * Build the client from an environment, reporting into this process's registry.
 * Exported for the test that proves what a given environment does; the process
 * calls {@link startIdentityClient}. The build and start-up behaviour is shared
 * with the API, in @claw/utils.
 */
export function buildIdentityClient(
  env: Readonly<Record<string, string | undefined>>,
  log: IdentityStartupLog,
): IdentityClient | null {
  return build(env, log, metrics);
}

/** Build the process's client from its environment and keep it for {@link identityClient}. */
export function startIdentityClient(log: IdentityStartupLog): IdentityClient | null {
  instance = start(process.env, log, metrics);
  return instance;
}
