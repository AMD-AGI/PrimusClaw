// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Adopt the per-request environment Brain left for us, before anything reads it.
 *
 * The environment carrying `user_env`, `session_env`, the system env and the
 * LLM keys used to reach a sandbox only one way: as part of the pod spec, set
 * when the pod was created. That works while every pod is created for the
 * request it will serve, and stops working the moment pods are pre-created --
 * a pooled pod exists before anyone knows whose request it will take, and a
 * running pod's environment cannot be changed. So the warm pool has been
 * pinned to zero, because enabling it would have handed out sandboxes that
 * looked healthy and had none of the user's credentials in them.
 *
 * Bootstrap already reaches into the sandbox after the request is known, so
 * that is where the environment comes from now. Applying it here puts it in
 * this process, which is what every shell spawned by a tool inherits.
 *
 * Imported for its side effect, and imported first: `config.ts` reads
 * `process.env` while it is being evaluated, so anything that arrives later
 * arrives too late for it.
 */
import { readFileSync, unlinkSync } from "node:fs";

/**
 * Names this service reads as its own configuration.
 *
 * Every name Hands reads from its environment is here or under one of the
 * prefixes below, and test/service-owned-names.test.ts holds the source to
 * that. Two things are decided from this one set, so they cannot drift apart:
 * the env file never applies one of these names, and a spawned command never
 * inherits one (child-privilege.ts).
 */
const SERVICE_OWNED = new Set([
  // The token this launch was given. The file carries the same value today,
  // and if it ever did not, the file's copy would leave Hands rejecting the
  // Brain that started it.
  "AUTH_CLAW_TOKEN",
  // The legacy name of the same token, read where AUTH_CLAW_TOKEN is blank.
  "AUTH_INTERNAL_TOKEN",
  "MCP_PORT",
  "WORKSPACE_PATH",
  "BASH_MAX_TIMEOUT_SEC",
  "BASH_DEFAULT_TIMEOUT_SEC",
  // The output cap the bash tool keeps per command.
  "BASH_OUTPUT_BYTES",
  "WAIT_MAX_SEC",
  "WAIT_DEFAULT_SEC",
]);

/**
 * Namespaces reserved whole.
 *
 * `HANDS_` and `BG_SHELL_` are this service's own. `CLAW_` is reserved for
 * Claw's internal contracts, as the request gate in @claw/protocol treats it.
 * `ENVD_` is the sandbox daemon's (its key for verifying callers, the file it
 * reads the session from), which reaches this process only because the daemon
 * starts it.
 */
const SERVICE_OWNED_PREFIXES = ["HANDS_", "BG_SHELL_", "CLAW_", "ENVD_"];

/**
 * Whether a name belongs to the sandbox runtime's own configuration rather
 * than to the request or the workspace.
 *
 * Reserved by prefix and not only by enumeration, because the file is built
 * from user, session and sandbox-spec environment and an omission here is a
 * request choosing how the sandbox is configured: `HANDS_CHILD_ISOLATION` and
 * the child identity range decide whether a command runs under an identity of
 * its own, `HANDS_STATE_DIR` decides where the records that address background
 * shells live, and `BASH_OUTPUT_BYTES` how much of a command's output is kept.
 * All are read after this file is applied, so a name that slipped through
 * would be indistinguishable from one an operator set.
 */
export function serviceOwned(key: string): boolean {
  return SERVICE_OWNED.has(key) || SERVICE_OWNED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * @returns the names applied, for the caller to log. Values are not returned:
 * they are secrets, and the reason for the whole mechanism.
 */
export function applyEnvFile(path: string | undefined = process.env.HANDS_ENV_FILE): string[] {
  if (!path) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // Loud but not fatal. Hands still serves, and a run that needed one of
    // these values fails on the value rather than on a sandbox that never
    // started -- which is the more diagnosable of the two.
    process.stderr.write(
      `hands: could not read ${path}: ${(err as Error)?.message}\n`,
    );
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    // The file is the per-request answer and outranks whatever the image or a
    // pooled pod's template happened to set -- that is the case it exists for.
    if (serviceOwned(key)) continue;
    process.env[key] = value;
    applied.push(key);
  }
  // The values live in this process's environment from here on, which the
  // agent could read from /proc anyway; removing the file just stops it
  // sitting there for anything that walks the filesystem.
  try { unlinkSync(path); } catch { /* already gone, or read-only /tmp */ }
  return applied;
}

export const APPLIED_ENV_KEYS = applyEnvFile();
