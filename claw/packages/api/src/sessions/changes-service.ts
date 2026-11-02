// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/sessions/:id/changes`: what the session's sandbox has changed, asked of
 * the sandbox that is running, never of one made for the purpose.
 *
 * The one rule this module exists to keep: it reads the registry and talks to the
 * sandbox the registry already names. It starts nothing, wakes nothing and writes
 * nothing, so looking at a session whose sandbox was reclaimed costs nothing and
 * brings nothing back. "Not running" is the answer, and the caller decides what to
 * do about it.
 */
import { kv } from "../infra/nats.js";
import { handsSessionKey } from "@claw/protocol";
import pino from "pino";
import { execInSandbox, SandboxUnreachableError, type HandsTarget } from "./hands-exec.js";
import {
  assembleRepo, checkPatchParams, parsePatch, parseSummary, patchScript, resolvePatchTarget, summaryScript,
  WORKSPACE_ROOT, type ChangesRepo, type KnownFile,
} from "./changes.js";

const logger = pino({ name: "session-changes" });

/** Foreground timeouts, seconds: well inside Hands' own limit, and the caller is waiting. */
const SUMMARY_TIMEOUT_SEC = 45;
const PATCH_TIMEOUT_SEC = 30;
/** Patch requests for one session in flight at once; more are asked to wait. */
const MAX_PATCHES_IN_FLIGHT = 2;

/**
 * Everything outside this module the route touches, behind a seam: the registry
 * read, the command, and where the work trees are. Tests substitute them; the
 * defaults are the production reads.
 */
/**
 * The Hands address and token a registry entry names, or null when it names no
 * sandbox that is ready: absent, deleted, pending, closing, unreadable, or missing
 * either half. The bucket is a parameter so the read can be tested without NATS.
 */
export async function readHandsTarget(
  sessionId: string,
  bucket: { get(key: string): Promise<{ operation?: string; value: Uint8Array } | null> },
): Promise<HandsTarget | null> {
  try {
    const entry = await bucket.get(handsSessionKey(sessionId));
    if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) return null;
    const info = JSON.parse(new TextDecoder().decode(entry.value)) as { status?: unknown; handsUrl?: unknown; token?: unknown };
    // Only a ready entry: a pending one is a sandbox on its way, not one to ask.
    if (info.status !== "ready") return null;
    if (typeof info.handsUrl !== "string" || !info.handsUrl || typeof info.token !== "string" || !info.token) return null;
    return { url: info.handsUrl, token: info.token };
  } catch {
    // An unreadable registry is not a sandbox that is there.
    return null;
  }
}

export const changesPorts = {
  root: WORKSPACE_ROOT,
  /** The sandbox's Hands address and token, from the registry entry Brain wrote when it became ready. Null: there is none. */
  readTarget: (sessionId: string): Promise<HandsTarget | null> => readHandsTarget(sessionId, kv),
  exec: execInSandbox,
};

export type ChangesFailure =
  | { kind: "not_running" }
  | { kind: "unavailable" }
  | { kind: "bad_request"; error: string }
  | { kind: "not_found"; error: string }
  | { kind: "busy" };

export type ChangesOutcome<T> = { kind: "ok"; value: T } | ChangesFailure;

interface Listing {
  repos: ChangesRepo[];
  truncated: boolean;
  /** Every changed file the sandbox reported, by repository path, for matching a patch request against. */
  known: Map<string, Map<string, KnownFile>>;
}

const listings = new Map<string, Promise<ChangesOutcome<Listing>>>();

async function runListing(sessionId: string): Promise<ChangesOutcome<Listing>> {
  const target = await changesPorts.readTarget(sessionId);
  if (!target) return { kind: "not_running" };
  let result;
  try {
    result = await changesPorts.exec(target, summaryScript(changesPorts.root), SUMMARY_TIMEOUT_SEC);
  } catch (err) {
    if (err instanceof SandboxUnreachableError) {
      logger.info({ sessionId, reason: err.reason.slice(0, 200) }, "session.changes.sandbox_unreachable");
      return { kind: "not_running" };
    }
    logger.warn({ sessionId, err: (err as Error)?.message }, "session.changes.exec_failed");
    return { kind: "unavailable" };
  }
  if (result.isError) {
    logger.warn({ sessionId }, "session.changes.script_failed");
    return { kind: "unavailable" };
  }
  const parsed = parseSummary(result.text, changesPorts.root);
  const repos: ChangesRepo[] = [];
  const known = new Map<string, Map<string, KnownFile>>();
  for (const p of parsed.repos) {
    const a = assembleRepo(p);
    repos.push(a.repo);
    known.set(p.path, a.known);
  }
  repos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind: "ok", value: { repos, truncated: parsed.moreRepos || repos.some((r) => r.truncated), known } };
}

/** Concurrent asks for one session's listing share one run in the sandbox. */
function listing(sessionId: string): Promise<ChangesOutcome<Listing>> {
  const existing = listings.get(sessionId);
  if (existing) return existing;
  const run = runListing(sessionId).finally(() => { listings.delete(sessionId); });
  listings.set(sessionId, run);
  return run;
}

export interface ChangesSummary {
  session_id: string;
  generated_at: string;
  truncated: boolean;
  repos: ChangesRepo[];
}

export async function getChangesSummary(sessionId: string): Promise<ChangesOutcome<ChangesSummary>> {
  const l = await listing(sessionId);
  if (l.kind !== "ok") return l;
  return {
    kind: "ok",
    value: { session_id: sessionId, generated_at: new Date().toISOString(), truncated: l.value.truncated, repos: l.value.repos },
  };
}

const patchesActive = new Map<string, number>();

/** One file's unified diff: the file is matched against the live listing before git is told its name. */
export async function getChangesPatch(
  sessionId: string, repoParam: unknown, fileParam: unknown,
): Promise<ChangesOutcome<{ patch: string; truncated: boolean }>> {
  // A request that is not shaped like a path under the work tree is refused before the
  // sandbox is asked anything.
  const shape = checkPatchParams(repoParam, fileParam, changesPorts.root);
  if (!shape.ok) return { kind: "bad_request", error: shape.error };
  const active = patchesActive.get(sessionId) ?? 0;
  if (active >= MAX_PATCHES_IN_FLIGHT) return { kind: "busy" };
  patchesActive.set(sessionId, active + 1);
  try {
    const l = await listing(sessionId);
    if (l.kind !== "ok") return l;
    const target = resolvePatchTarget(repoParam, fileParam, l.value.known, changesPorts.root);
    if (!target.ok) return target.status === 400 ? { kind: "bad_request", error: target.error } : { kind: "not_found", error: target.error };
    const sandbox = await changesPorts.readTarget(sessionId);
    if (!sandbox) return { kind: "not_running" };
    let result;
    try {
      result = await changesPorts.exec(sandbox, patchScript(target.repo, target.file, target.untracked, target.orig), PATCH_TIMEOUT_SEC);
    } catch (err) {
      if (err instanceof SandboxUnreachableError) return { kind: "not_running" };
      logger.warn({ sessionId, err: (err as Error)?.message }, "session.changes.patch_exec_failed");
      return { kind: "unavailable" };
    }
    if (result.isError) return { kind: "unavailable" };
    const patch = parsePatch(result.text);
    if (!patch) return { kind: "unavailable" };
    return { kind: "ok", value: patch };
  } finally {
    const left = (patchesActive.get(sessionId) ?? 1) - 1;
    if (left <= 0) patchesActive.delete(sessionId); else patchesActive.set(sessionId, left);
  }
}
