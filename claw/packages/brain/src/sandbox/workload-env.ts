// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What of a sandbox's composed environment may be written into the SaFE
 * workload that creates it.
 *
 * Everything in a workload's `env` is stored by SaFE and returned by
 * `GET /api/v1/workloads/{id}` to every caller allowed to read that workload,
 * not only its owner, and it is kept for finished workloads too. A sandbox's
 * composed environment holds the owner's platform key (as ANTHROPIC_API_KEY,
 * OPENAI_API_KEY and SAFE_API_KEY), the per-sandbox Hands token, the
 * deployment's system env, the sandbox spec's env and the owner's stored
 * variables; written there, each of them was one GET away from other users of
 * the workspace.
 *
 * So the workload carries an allow list, not a filtered copy: a deny list only
 * knows the credentials someone thought to name, and any layer can hold one
 * under a name nobody would guess. What is allowed is what Brain itself sets
 * and needs to be readable from outside the sandbox: the session id SaFE
 * lookups match on, and the plain plumbing Hands is started with.
 *
 * The full environment still reaches Hands, and through it every command the
 * model runs: bootstrap hands it over as a private file over the execute
 * channel (sandbox/bootstrap.ts writeEnvFileCmd), which is authenticated as the
 * owner and per sandbox.
 */

/** Platform variables that carry a credential. Never in a workload. */
export const PLATFORM_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  "AUTH_CLAW_TOKEN",
  "AUTH_INTERNAL_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "SAFE_API_KEY",
]);

/**
 * The only variables a Hands sandbox's workload carries. `CLAW_SESSION_ID` is
 * the discovery index (SaFE's list endpoint filters on `envKey`, see
 * multi-node/safe-provider.ts findSessionWorkloads); the rest are plain
 * settings Brain sets for Hands.
 */
export const HANDS_WORKLOAD_ENV_NAMES: ReadonlySet<string> = new Set([
  "CLAW_SESSION_ID",
  "MCP_PORT",
  "WORKSPACE_PATH",
  "SAFE_API_URL",
]);

/**
 * The environment to write into the SaFE workload: only the allowed names of
 * `env`, and never a platform credential even if one were allowed by mistake.
 *
 * @param env The composed sandbox environment; not modified.
 * @param allowed The names the workload may carry.
 */
export function workloadSpecEnv(
  env: Record<string, string>,
  allowed: ReadonlySet<string> = HANDS_WORKLOAD_ENV_NAMES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!allowed.has(name) || PLATFORM_CREDENTIAL_ENV.has(name)) continue;
    out[name] = value;
  }
  return out;
}
