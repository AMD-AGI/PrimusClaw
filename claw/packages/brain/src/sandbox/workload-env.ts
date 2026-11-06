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

/** A URL carrying a password in its userinfo (`scheme://user:pass@host`). */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** Whether a name, or its value, says the variable holds a credential. */
export function looksLikeCredential(name: string, value: string): boolean {
  return CREDENTIAL_NAME.test(name.toUpperCase()) || URL_WITH_PASSWORD.test(value);
}

/**
 * The environment to write into the SaFE workload: the allowed names of `env`,
 * Hands' own runtime settings, and the sandbox spec's own boot-time settings;
 * never a platform credential and never anything that looks like one.
 *
 * The spec's env is kept because its contract is "baked into the sandbox at
 * create time" (protocol SandboxSpecCreate.env): an image entrypoint may need
 * it before bootstrap runs. It is the spec author's own configuration, and its
 * documentation says it is stored in the workload. A value a later layer (the
 * owner's variables, the request's env) replaced is not the spec's and is left
 * out; so is every other layer -- the deployment's system env and the owner's
 * stored variables -- whatever it is called.
 *
 * @param env The composed sandbox environment; not modified.
 * @param specEnv The sandbox spec's own env, the only layer kept by name.
 * @param allowed The names the workload may carry besides those.
 */
export function workloadSpecEnv(
  env: Record<string, string>,
  specEnv: Record<string, string> = {},
  allowed: ReadonlySet<string> = HANDS_WORKLOAD_ENV_NAMES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (PLATFORM_CREDENTIAL_ENV.has(name)) continue;
    if (allowed.has(name)) { out[name] = value; continue; }
    if (looksLikeCredential(name, value)) continue;
    const fromSpec = Object.prototype.hasOwnProperty.call(specEnv, name) && specEnv[name] === value;
    if (fromSpec || isHandsRuntimeSetting(name)) out[name] = value;
  }
  return out;
}
