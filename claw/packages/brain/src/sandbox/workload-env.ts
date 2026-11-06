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
 * OPENAI_API_KEY and SAFE_API_KEY), the per-sandbox Hands token, and the
 * owner's stored variables; written there, each of them was one GET away from
 * other users of the workspace.
 *
 * The full environment still reaches Hands, and through it every command the
 * model runs: bootstrap hands it over as a private file over the execute
 * channel (sandbox/bootstrap.ts writeEnvFileCmd), which is authenticated as the
 * owner and per sandbox. The workload keeps only what is not a credential, so
 * that what the container itself starts with (image entrypoints, an operator's
 * shell) still sees the ordinary configuration.
 *
 * A credential is recognised three ways, any of which removes the variable:
 *   - it is one the platform sets (PLATFORM_CREDENTIAL_ENV);
 *   - the caller said where it came from (`withhold`): the owner's stored
 *     variables and the request's session env are the user's own and are
 *     treated as secret whatever they are called;
 *   - its name or its value looks like one (isCredentialEnvName,
 *     hasCredentialInValue), which covers the deployment's system env and the
 *     sandbox spec's own env.
 */

/** Variables the platform itself fills with a credential. */
export const PLATFORM_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  "AUTH_CLAW_TOKEN",
  "AUTH_INTERNAL_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "SAFE_API_KEY",
]);

/** Name fragments that mark a credential anywhere in the name. */
const CREDENTIAL_FRAGMENTS = [
  "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL",
  "PRIVATE", "COOKIE", "APIKEY", "API_KEY", "ACCESS_KEY", "SIGNING",
];

/** Name segments that mark a credential when they stand alone between underscores. */
const CREDENTIAL_SEGMENT = /(^|_)(KEY|KEYS|PAT|DSN|AUTH|PWD|PASS)(_|$)/;

/** Whether a variable's name says it holds a credential. */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_FRAGMENTS.some((f) => upper.includes(f)) || CREDENTIAL_SEGMENT.test(upper);
}

/** A URL carrying a password in its userinfo (`scheme://user:pass@host`). */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** Whether a variable's value carries a credential whatever it is called. */
export function hasCredentialInValue(value: string): boolean {
  return URL_WITH_PASSWORD.test(value);
}

/**
 * The environment to write into the SaFE workload: `env` without anything that
 * is, or may be, a credential.
 *
 * @param env The composed sandbox environment; not modified.
 * @param withhold Names whose source makes them secret regardless of name.
 */
export function workloadSpecEnv(
  env: Record<string, string>,
  withhold: Iterable<string> = [],
): Record<string, string> {
  const secret = new Set(withhold);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (PLATFORM_CREDENTIAL_ENV.has(name)) continue;
    if (secret.has(name)) continue;
    if (isCredentialEnvName(name)) continue;
    if (typeof value === "string" && hasCredentialInValue(value)) continue;
    out[name] = value;
  }
  return out;
}
