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
 * Hands' own runtime settings, by the rule Hands uses to refuse them from the
 * env file (hands/src/runtime/env-file.ts `serviceOwned`; the test holds the
 * two together). The env file cannot carry them, so a deployment that sets one
 * (a system env `BG_SHELL_MAX_CONCURRENT`, `BASH_OUTPUT_BYTES`) still reaches
 * Hands only through the container: they stay in the workload. They are
 * configuration, not credentials; a name among them that looks like one is
 * still left out (see CREDENTIAL_NAME).
 */
const HANDS_OWNED_NAMES: ReadonlySet<string> = new Set([
  "MCP_PORT", "WORKSPACE_PATH", "BASH_MAX_TIMEOUT_SEC", "BASH_DEFAULT_TIMEOUT_SEC",
  "BASH_OUTPUT_BYTES", "WAIT_MAX_SEC", "WAIT_DEFAULT_SEC",
]);
const HANDS_OWNED_PREFIXES = ["HANDS_", "BG_SHELL_", "CLAW_", "ENVD_"];

/** Whether Hands reads this name as its own configuration (and so refuses it from the env file). */
export function isHandsRuntimeSetting(name: string): boolean {
  return HANDS_OWNED_NAMES.has(name) || HANDS_OWNED_PREFIXES.some((p) => name.startsWith(p));
}

/** A name that says it holds a credential; never kept on the strength of a prefix alone. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|COOKIE|APIKEY|API_KEY|ACCESS_KEY|(^|_)(KEY|KEYS|PAT|DSN|AUTH)(_|$)/;

/**
 * The environment to write into the SaFE workload: the allowed names of `env`
 * and Hands' own runtime settings, and never a platform credential.
 *
 * @param env The composed sandbox environment; not modified.
 * @param allowed The names the workload may carry besides Hands' settings.
 */
export function workloadSpecEnv(
  env: Record<string, string>,
  allowed: ReadonlySet<string> = HANDS_WORKLOAD_ENV_NAMES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (PLATFORM_CREDENTIAL_ENV.has(name)) continue;
    const kept = allowed.has(name)
      || (isHandsRuntimeSetting(name) && !CREDENTIAL_NAME.test(name.toUpperCase()));
    if (kept) out[name] = value;
  }
  return out;
}
