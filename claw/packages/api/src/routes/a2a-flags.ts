// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// The switches behind the A2A server's context/task model.
//
// Read on each use, as auth/identity-token.ts does, so what a request is
// judged by is what the environment says now and a suite can flip them per
// file. Both are off by default: with them off the server is the one it was.
//
//   CLAW_A2A_CONTEXT_TASKS        contextId names a session, taskId names one
//                                 run of it (INPUT_REQUIRED, CANCELED, the
//                                 caller owns the session, truthful card)
//   CLAW_A2A_PUSH_ENABLED         push notifications (needs the switch above)
//   CLAW_A2A_PUSH_ALLOWED_HOSTS   hosts a webhook may name though they resolve
//                                 to a private address; the only hosts where
//                                 plain http is accepted
//   CLAW_A2A_IDENTITY_CLIENT_IDS  client ids of the upstream services whose
//                                 identity-provider access tokens may call A2A
// ---------------------------------------------------------------------------

import { envBool } from "../config.js";

function listSetting(key: string): Set<string> {
  return new Set((process.env[key] ?? "").split(/[\s,]+/).map((v) => v.trim()).filter(Boolean));
}

export function a2aContextTasksEnabled(): boolean {
  return envBool("CLAW_A2A_CONTEXT_TASKS", false);
}

export function a2aPushEnabled(): boolean {
  return a2aContextTasksEnabled() && envBool("CLAW_A2A_PUSH_ENABLED", false);
}

/** Lower-cased: a host name has no case. */
export function a2aPushAllowedHosts(): Set<string> {
  return new Set([...listSetting("CLAW_A2A_PUSH_ALLOWED_HOSTS")].map((h) => h.toLowerCase()));
}

export function a2aIdentityClientIds(): Set<string> {
  return listSetting("CLAW_A2A_IDENTITY_CLIENT_IDS");
}

/**
 * Whether a caller authenticated by an identity provider's access token may use
 * A2A. Such a caller has no virtual key, so the run is paid for by the shared
 * deployment key (see docs/identity-client.md): only the upstream services an
 * operator named may spend it. Every other credential is judged as it always was.
 */
export function identityCallerMayUseA2a(
  authMethod: string | null,
  clientId: string | undefined,
  allowed: Set<string> = a2aIdentityClientIds(),
): boolean {
  if (authMethod !== "identity_token") return true;
  return clientId !== undefined && clientId !== "" && allowed.has(clientId);
}
