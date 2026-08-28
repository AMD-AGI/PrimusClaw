// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a tool call belongs to, for the duration of that call.
 *
 * Background shells outlive the request that started them, so the registry
 * needs a name to file them under. The MCP tool signature is `execute(args)`
 * and nothing else, and adding an owner argument would put it in the schema
 * where the model could set it to anything. The owner instead rides on an HTTP
 * header that only Brain sets, and is carried to the tool through async
 * context so no tool has to thread it.
 *
 * Two names, because they answer different questions. The owner is who may
 * address a shell -- a sandbox handed to a new run must not let it read the
 * previous occupant's output -- and it deliberately outlives one run. The run
 * is which single execution started the shell, which is what lets a batch node
 * take its processes with it when it ends while a conversation's keep running.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Header Brain stamps with the addressing scope a shell belongs to: the DAG
 * root when the run is a DAG node, else the session.
 */
export const OWNER_HEADER = "x-claw-owner";

/** Header Brain stamps with the id of the single run making the call. */
export const RUN_HEADER = "x-claw-run";

/**
 * Owner used when the header is absent: an older Brain, a probe, a test, a
 * human with curl. Its shells are still tracked and still killed at shutdown;
 * they are simply all in one bucket, which is what the registry did for
 * everyone before owners existed.
 */
export const UNOWNED = "unowned";

/**
 * Run recorded when the header is absent, meaning "no run claims this shell".
 * Such a shell is never reaped by run, only by owner shutdown -- which is what
 * every shell did before runs were recorded.
 */
export const NO_RUN = "";

interface CallerContext {
  owner: string;
  run: string;
}

const store = new AsyncLocalStorage<CallerContext>();

/**
 * Reject anything that could forge a registry key.
 *
 * The owner is a key prefix, so a value containing the separator could name a
 * shell belonging to someone else. Control characters are refused rather than
 * escaped, and the length is capped, because a legitimate value is an id.
 *
 * Shared by both headers: the run is matched against exactly, so a value with a
 * NUL in it could not name another run, but a header that fails these checks is
 * not a value to trust with either job.
 */
function normalizeCallerKey(raw: unknown, absent: string): string {
  if (typeof raw !== "string") return absent;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return absent;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return absent;
  return trimmed;
}

export function normalizeOwner(raw: unknown): string {
  return normalizeCallerKey(raw, UNOWNED);
}

export function normalizeRun(raw: unknown): string {
  return normalizeCallerKey(raw, NO_RUN);
}

export function withCaller<T>(ctx: CallerContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentOwner(): string {
  return store.getStore()?.owner ?? UNOWNED;
}

export function currentRun(): string {
  return store.getStore()?.run ?? NO_RUN;
}
