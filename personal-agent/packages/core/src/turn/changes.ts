// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session changed in its sandbox, as Claw's `GET /v1/sessions/<id>/changes` reports it (contract C3), made safe to
 * show. Everything here is a best effort on top of an answer already delivered: a reply that is not what the contract
 * says, a sandbox that is gone (409), a session Claw does not know (404), a slow or failed call, and a session that changed
 * nothing all end the same way, as undefined, and the user sees no changes block and no error.
 */

import { cpSlice, pyRstrip, squashSpaces } from "../text/py-text.js";
import { isObject, objectOr } from "./json.js";
import { errorName } from "../errors.js";
import type { Logger } from "../ports/logger.js";
import type { TurnClaw } from "./ports.js";
import { ClawError, errorKind } from "./upstream.js";

/** One try, then nothing: the answer is already in the chat. */
export const CHANGES_TIMEOUT_SECONDS = 5.0;
/** What is read of a reply: more repositories than a person looks at is not a changes block. */
const MAX_REPOS = 20;
/** Per repository (Claw lists at most 200). */
const MAX_FILES_READ = 500;
const STATUSES: ReadonlySet<string> = new Set(["M", "A", "D", "R", "?"]);

export interface FileChange {
  readonly path: string;
  /** M modified, A added, D deleted, R renamed, ? untracked or unknown. */
  readonly status: string;
  /** undefined: not counted (binary, or Claw could not say). */
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly binary: boolean;
}

export interface RepoChanges {
  /** "/workspace/<name>". */
  readonly path: string;
  readonly branch: string | undefined;
  /** Short sha. */
  readonly head: string;
  /** Claw listed fewer files than changed. */
  readonly truncated: boolean;
  readonly files: readonly FileChange[];
  /** What Claw counted (at least the files listed). */
  readonly totalFiles: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface Changes {
  readonly repos: readonly RepoChanges[];
  readonly truncated: boolean;
}

export function repoName(repo: RepoChanges): string {
  return pyRstrip(repo.path, "/").split("/").at(-1) || repo.path;
}

export const totalFiles = (changes: Changes): number => changes.repos.reduce((n, r) => n + r.totalFiles, 0);
export const totalAdditions = (changes: Changes): number => changes.repos.reduce((n, r) => n + r.additions, 0);
export const totalDeletions = (changes: Changes): number => changes.repos.reduce((n, r) => n + r.deletions, 0);

/** A line count from the reply: a whole number of at least 0, else undefined (a boolean is not a number here). */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? cpSlice(squashSpaces(value), 0, limit) : "";
}

function fileOf(raw: unknown): FileChange | undefined {
  if (!isObject(raw)) return undefined;
  const path = text(raw["path"], 300);
  if (!path) return undefined;
  const status = raw["status"];
  const binary = raw["binary"] === true;
  return {
    path,
    status: typeof status === "string" && STATUSES.has(status) ? status : "?",
    additions: binary ? undefined : count(raw["additions"]),
    deletions: binary ? undefined : count(raw["deletions"]),
    binary,
  };
}

function repoOf(raw: unknown): RepoChanges | undefined {
  if (!isObject(raw) || !Array.isArray(raw["files"])) return undefined;
  const files = raw["files"]
    .slice(0, MAX_FILES_READ)
    .map(fileOf)
    .filter((f): f is FileChange => f !== undefined);
  const totals = objectOr(raw["totals"]);
  return {
    path: text(raw["path"], 200) || "/workspace",
    branch: text(raw["branch"], 100) || undefined,
    head: text(raw["head"], 12),
    truncated: raw["truncated"] === true,
    files,
    totalFiles: Math.max(count(totals["files"]) ?? 0, files.length),
    additions: count(totals["additions"]) || 0,
    deletions: count(totals["deletions"]) || 0,
  };
}

/**
 * The reply as `Changes`, or undefined when it is not a changes reply or nothing changed. Items that are not what the
 * contract says are left out one by one, so a single odd file never hides the rest.
 */
export function parseChanges(reply: unknown): Changes | undefined {
  if (!isObject(reply) || reply["ok"] !== true || !Array.isArray(reply["repos"])) return undefined;
  const repos = reply["repos"]
    .slice(0, MAX_REPOS)
    .map(repoOf)
    .filter((r): r is RepoChanges => r !== undefined && r.totalFiles > 0);
  if (repos.length === 0) return undefined;
  return { repos, truncated: reply["truncated"] === true || repos.some((r) => r.truncated) };
}

/** The session's changes, or undefined for anything that means there is nothing to show. Never rejects. */
export async function fetchChanges(
  claw: TurnClaw,
  key: string,
  sessionId: string,
  log: Logger,
): Promise<Changes | undefined> {
  let reply: unknown;
  try {
    reply = await claw.changes(key, sessionId, CHANGES_TIMEOUT_SECONDS * 1000);
  } catch (err) {
    // 409 sandbox_not_running and 404 are the contract's ordinary answers; anything else is worth a line in the log
    if (err instanceof ClawError && (err.status === 404 || err.status === 409)) {
      log.info("changes for a session not shown", { status: err.status });
    } else {
      log.warn("changes for a session not shown", {
        error: err instanceof ClawError ? errorKind(err) : errorName(err),
      });
    }
    return undefined;
  }
  return parseChanges(reply);
}
