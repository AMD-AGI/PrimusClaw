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

/** Names this process was started with, which the file must not overrule. */
const BOOTSTRAP_OWNED = new Set([
  "HANDS_ENV_FILE",
  // The token this launch was given. The file carries the same value today,
  // and if it ever did not, the file's copy would leave Hands rejecting the
  // Brain that started it.
  "AUTH_CLAW_TOKEN",
  "CLAW_SESSION_ID",
  "MCP_PORT",
  "WORKSPACE_PATH",
  "BG_SHELL_ENABLED",
  "BASH_MAX_TIMEOUT_SEC",
  "BASH_DEFAULT_TIMEOUT_SEC",
  "WAIT_MAX_SEC",
  "WAIT_DEFAULT_SEC",
]);

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
    // The handful of names the launch command set are the exception: those are
    // this process's own configuration, decided after the file was written.
    if (BOOTSTRAP_OWNED.has(key)) continue;
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
