// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * User-supplied environment variable governance shared between Backend API
 * (route validation) and Brain (sandbox env merge fallback). See the deny
 * list and gate functions below for the specific rules enforced.
 */

/** Allowed key name shape: starts with uppercase letter, then [A-Z0-9_], <= 64 chars total. */
export const USER_ENV_KEY_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const USER_ENV_DENY_LIST: ReadonlySet<string> = new Set([
  // Shell startup hooks
  "PATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "IFS",
  // Dynamic linker hijack
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  // Language runtime hooks
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  // Tool arbitrary-command env
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "RSYNC_RSH",
  "EDITOR",
  "VISUAL",
  "PAGER",
  // Claw internal contracts (explicit list; broader CLAW_* coverage handled by
  // isClawInternalEnv so new CLAW_* vars never have to be appended here)
  "AUTH_CLAW_TOKEN",
  "MCP_PORT",
  "WORKSPACE_PATH",
  "USER_ID_HEX",
  "USER_DATA_PATH",
  "HYPERLOOM_SESSION_ID",
  "INFERENCE_OPTIMIZER_SESSION_LAYOUT",
  "SAFE_API_URL",
  "SAFE_API_KEY",
  // NOTE: ANTHROPIC_BASE_URL / OPENAI_BASE_URL are intentionally NOT denied.
  // Brain no longer injects an LLM gateway URL (see brain/src/index.ts), and
  // users may want to override the default endpoint (e.g. point an agent at
  // their personal proxy). Other layer-2 keys above stay denied because they
  // are still authoritative for Claw-internal contracts.
]);

/** True when the env name uses the Bash exported function injection prefix. */
export function isBashFuncInjection(name: string): boolean {
  return name.startsWith("BASH_FUNC_");
}

/**
 * True when the env name is reserved for Claw-internal contracts.
 * Catches `CLAW_*` family wholesale so adding a new internal env never
 * requires expanding the deny list.
 */
export function isClawInternalEnv(name: string): boolean {
  return name.startsWith("CLAW_");
}

/**
 * Single composite gate used by both API (PUT validation) and Brain
 * (env merge re-check). Returns true iff the env name is safe for
 * user-supplied injection.
 */
export function isUserEnvKeyAllowed(name: string): boolean {
  if (!USER_ENV_KEY_NAME_RE.test(name)) return false;
  if (isBashFuncInjection(name)) return false;
  if (isClawInternalEnv(name)) return false;
  if (USER_ENV_DENY_LIST.has(name)) return false;
  return true;
}

/**
 * Extra deny list applied ONLY to system-scoped env (admin-managed global
 * env). On top of every user-env rule, system env must NOT shadow the
 * SaFE-managed LLM keys: they are injected by the SaFE platform key with
 * per-user cost tracking, so a global admin value overriding them would break
 * billing attribution. The base URLs (ANTHROPIC_BASE_URL / OPENAI_BASE_URL)
 * remain allowed — an endpoint override has no billing impact.
 */
export const SYSTEM_ENV_EXTRA_DENY_LIST: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

/**
 * Composite gate for system-scoped env. Stricter than the user gate: applies
 * all user rules, then the system-only extra deny list. Used by the system
 * env API (PUT validation) and Brain (ops-fallback merge re-check).
 */
export function isSystemEnvKeyAllowed(name: string): boolean {
  if (!isUserEnvKeyAllowed(name)) return false;
  if (SYSTEM_ENV_EXTRA_DENY_LIST.has(name)) return false;
  return true;
}

/**
 * Compose the final sandbox env from its layers (system-env-design.md §5.1).
 *
 * Precedence (low → high):
 *   base                caller-prepared layer (sandbox_spec.env + CLAW internal
 *                       env + SaFE platform key), already merged by the caller.
 *   systemEnv           admin-managed global env; fallback-only, so it never
 *                       overrides a key already present in `base`.
 *   userEnv             validated, overrides everything above.
 *   sessionEnv          request-level env from POST body; highest precedence.
 *
 * Returns a NEW object; inputs are never mutated. `systemEnv` entries are gated
 * by isSystemEnvKeyAllowed, `userEnv` and `sessionEnv` by isUserEnvKeyAllowed.
 * Non-string values are skipped.
 */
export function composeSandboxEnv(args: {
  base: Record<string, string>;
  systemEnv?: Record<string, string>;
  userEnv?: Record<string, unknown>;
  sessionEnv?: Record<string, unknown>;
}): Record<string, string> {
  const env: Record<string, string> = { ...args.base };

  for (const [k, v] of Object.entries(args.systemEnv ?? {})) {
    if (typeof v === "string" && isSystemEnvKeyAllowed(k) && !(k in env)) env[k] = v;
  }

  for (const [k, v] of Object.entries(args.userEnv ?? {})) {
    if (typeof v !== "string") continue;
    if (!isUserEnvKeyAllowed(k)) continue;
    env[k] = v;
  }

  for (const [k, v] of Object.entries(args.sessionEnv ?? {})) {
    if (typeof v !== "string") continue;
    if (!isUserEnvKeyAllowed(k)) continue;
    env[k] = v;
  }

  return env;
}
