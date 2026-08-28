// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Read a setting, treating blank the same as unset.
 *
 * `||` rather than `??`, matching api/src/config.ts and brain/src/config.ts:
 * `start-all.sh` does `set -a; source .env`, so a key left empty in `.env` is
 * exported as "" rather than absent, and `??` substitutes the fallback only for
 * `undefined`. A blank `MCP_PORT` would then `parseInt("")` to NaN and leave
 * Hands listening nowhere Brain calls; a blank `WORKSPACE_PATH` would root
 * every tool at "". The trade is that no setting here can be configured *to*
 * the empty string.
 */
function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

export const WORKSPACE = env("WORKSPACE_PATH", "/workspace");
export const MCP_PORT = parseInt(env("MCP_PORT", "9100"));
export const INTERNAL_TOKEN = env("AUTH_CLAW_TOKEN") || env("AUTH_INTERNAL_TOKEN");

/**
 * Whether this sandbox may run background shells.
 *
 * Brain has the same flag and used to be the only place it was read, where it
 * decided which tool schemas the model was shown. A schema is not a gate: the
 * tools stayed registered here and ran for anyone who asked, so a replayed
 * transcript, a plugin, or a direct MCP call kept the feature working while it
 * was supposedly off. Brain now forwards its value in the sandbox env
 * (see brain sandbox/bootstrap.ts handsBaseEnv), so the two agree by
 * construction and the refusal happens where the processes are actually
 * spawned. Defaults off, matching Brain.
 */
export const BG_SHELL_ENABLED = /^(1|true|yes)$/i.test(env("BG_SHELL_ENABLED"));
