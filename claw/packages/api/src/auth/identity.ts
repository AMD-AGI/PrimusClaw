// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  buildIdentityClient as build, startIdentityClient as start,
  type IdentityClient, type IdentityProcessMetrics, type IdentityStartupLog,
} from "@claw/utils";
import { metrics } from "../infra/metrics.js";

export type { IdentityStartupLog };

/** This process's registry, in the shape the shared start-up helper takes. */
const processMetrics: IdentityProcessMetrics = {
  identity: metrics.identity,
  setIdentityClientEnabled: (enabled) => metrics.setIdentityClientEnabled(enabled),
};

let instance: IdentityClient | null = null;

/**
 * The process's identity client, or null while IDENTITY_CLIENT_ENABLED is off,
 * which is the default. Request authentication reads it for one thing, and only
 * with CLAW_IDENTITY_TOKEN_AUTH_ENABLED on: an identity provider's access token
 * (identity-token.ts).
 */
export function identityClient(): IdentityClient | null {
  return instance;
}

/**
 * Build the client from an environment, reporting into this process's registry.
 * Exported for the test that proves what a given environment does; the process
 * calls {@link startIdentityClient}. The build and start-up behaviour is shared
 * with Brain, in @claw/utils.
 */
export function buildIdentityClient(
  env: Readonly<Record<string, string | undefined>>,
  log: IdentityStartupLog,
): IdentityClient | null {
  return build(env, log, processMetrics);
}

/** Build the process's client from its environment and keep it for {@link identityClient}. */
export function startIdentityClient(log: IdentityStartupLog): IdentityClient | null {
  instance = start(process.env, log, processMetrics);
  return instance;
}
