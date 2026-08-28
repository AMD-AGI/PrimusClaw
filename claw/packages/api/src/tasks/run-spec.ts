// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The execute request minus anything that must not sit in Postgres in the clear.
 *
 * Skills, topology and the rest of the turn are the run's definition and
 * belong on the row. History does not -- see RUN_SPEC_REBUILT_KEYS. LLM keys, platform keys, the live user-env vault,
 * the caller's `session_env` and its MCP server definitions do not.
 *
 * The last two used to travel with the spec, on the argument that
 * `session_env` has no vault of its own to be re-read from. True, and beside
 * the point: it is the caller's environment, which is where people put tokens,
 * and an MCP entry carries an `Authorization` header as a matter of course.
 * Having no vault means they must be sealed into the credentials blob, not
 * that they may be written in the clear.
 */

import type { EnvironmentTopology } from "@claw/protocol";

/** Top-level fields stripped before the spec is written to `claw_tasks.input`. */
export const RUN_SPEC_SECRET_KEYS = [
  "llm_api_key",
  "platform_key",
  "user_env",
  // Caller-supplied per-message env, and MCP definitions that carry their own
  // auth headers. Sealed into the credentials blob rather than dropped: unlike
  // `user_env` there is no vault to re-read them from at claim time.
  "session_env",
  "mcp_servers",
  "run_lease",
  "backend_internal_token",
] as const;

const SECRET_SET = new Set<string>(RUN_SPEC_SECRET_KEYS);

/**
 * Fields the row does not need to carry because the claim can rebuild them.
 *
 * A different reason from the secrets above, and worth keeping separate:
 * `history` is not dangerous to store, it is simply the largest thing on the
 * row -- about two thirds of the persisted spec -- and it is a copy of state
 * that already lives in `claw_conversation_turns`.
 *
 * The copy is the problem. `claw_conversation_turns` is soft-deleted and is on
 * `session-teardown`'s list, so deleting a session removes the conversation
 * from it; nothing anywhere deletes from `claw_tasks`. Persisting the assembled
 * context therefore put a second, permanent copy of every user's conversation
 * in a table with no lifecycle at all, and a session the user deleted would
 * still have its content sitting in the rows of its runs.
 *
 * Rebuilding at claim time is also what the system already does elsewhere: the
 * pending-message drain has always called `buildMessages` when it drains, not
 * when the message was parked. Persisting it here was the deviation.
 */
export const RUN_SPEC_REBUILT_KEYS = ["history"] as const;

const REBUILT_SET = new Set<string>(RUN_SPEC_REBUILT_KEYS);

/** Ciphertext of the keys that have no live lookup by user id. */
export const RUN_CREDENTIALS_FIELD = "credentials";

export function stripRunSecrets(
  task: Record<string, unknown>,
): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    if (SECRET_SET.has(key) || REBUILT_SET.has(key) || key === RUN_CREDENTIALS_FIELD) continue;
    spec[key] = value;
  }
  return spec;
}

export function gpuNodesFromSpec(task: Record<string, unknown>): number {
  const topology = task.topology;
  if (!topology || typeof topology !== "object" || Array.isArray(topology)) return 0;
  const nodes = (topology as EnvironmentTopology).nodes;
  return typeof nodes === "number" && Number.isFinite(nodes) && nodes > 0 ? nodes : 0;
}

export function wantsSandboxFromSpec(task: Record<string, unknown>): boolean {
  if (typeof task.sandbox_image === "string" && task.sandbox_image.trim()) return true;
  const spec = task.sandbox_spec;
  if (spec && spec !== "none") return true;
  return false;
}
