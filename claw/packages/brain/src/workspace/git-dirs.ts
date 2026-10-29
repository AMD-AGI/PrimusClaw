// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which `.git` directories a workspace snapshot carries, and which it leaves behind.
 *
 * `.git` used to be on the exclude list, on the reading that a repository is
 * regenerable: clone it again. That holds for a clean checkout and is false for
 * the thing the session exists to produce. A sandbox that is reclaimed after its
 * idle window comes back from the snapshot with the files in place and no
 * repository around them, and every commit, branch and stash that had not been
 * pushed is gone -- while the conversation still remembers making them.
 *
 * So `.git` is snapshotted like the rest of the workspace, with three things the
 * rest of the workspace does not need:
 *
 *   - A bound. A repository can be arbitrarily large, and a half-copied one is
 *     worse than none (a pack without its index reads as corruption), so the unit
 *     of dropping is one whole `.git`, never part of it. A directory is left out
 *     when it is over `maxBytes` or holds more than `maxFiles` files: bytes are
 *     what Hands has to read into memory to upload a pack, files are what a sync
 *     pays per object (the upload is one PUT per file, so a repository full of
 *     loose objects makes every turn wait for thousands of them). Either way the
 *     user is told, in words, which repository was left out and why.
 *   - Git's own transient files stay behind. A `*.lock` captured mid-command and
 *     restored into a sandbox where nothing runs is a lock nothing will ever
 *     release, and every later git command refuses with "File exists". They are
 *     scoped under `.git` here and not put on the shared exclude list, where a
 *     bare `*.lock` would also drop the user's `yarn.lock` and `Cargo.lock`.
 *   - Measuring is its own step, and can fail. When it does the answer is not
 *     "all of them are small enough": see `GitDecision`.
 */
import pino from "pino";
import { withHandsTimeout, type HandsClient } from "../clients/hands.js";
import { WORKSPACE_GIT_MAX_BYTES, WORKSPACE_GIT_MAX_FILES } from "../config.js";

const logger = pino({ name: "workspace-git" });

export const GIT_DIR = ".git";

export interface GitLimits {
  /** Largest `.git` (apparent bytes) that is carried. 0 or less switches carrying `.git` off. */
  maxBytes: number;
  /** Most files a `.git` may hold and still be carried. */
  maxFiles: number;
}

/** One `.git` directory as the sandbox measured it; -1 where it could not say. */
export interface GitDirMeasure {
  path: string;
  bytes: number;
  files: number;
}

export type GitSkipReason = "too_large" | "too_many_files" | "unmeasured";

export interface GitSkip extends GitDirMeasure {
  reason: GitSkipReason;
}

/**
 * What a sync does about `.git`.
 *
 * `keep` carries every `.git` except the ones in `skipped`. `drop-all` carries
 * none, for one of two reasons that must not be confused:
 *
 *   - `disabled`: an operator turned it off. The old behaviour, deliberately.
 *   - `unmeasured`: the sandbox could not say how big its repositories are. Not
 *     "small enough" and not "too big" -- unknown. A sync that cannot tell
 *     leaves them out for this sync, and the caller must not take the resulting
 *     absence as the user having deleted them: the S3 prune treats the listing as
 *     doubtful, and the shared-disk sync refuses to replace its snapshot.
 */
export type GitDecision =
  | { mode: "keep"; skipped: GitSkip[] }
  | { mode: "drop-all"; why: "disabled" | "unmeasured"; detail?: string };

export const KEEP_ALL_GIT: GitDecision = { mode: "keep", skipped: [] };

/** The limits this deployment is configured with. */
export function configuredGitLimits(): GitLimits {
  return { maxBytes: WORKSPACE_GIT_MAX_BYTES, maxFiles: WORKSPACE_GIT_MAX_FILES };
}

// ── Quoting ─────────────────────────────────────────────────────────────

/** POSIX single-quoting, which carries every byte but NUL. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A literal path as a `find -path` pattern, which reads `* ? [ \` as syntax. */
const globEscape = (s: string): string => s.replace(/[\\*?[]/g, "\\$&");

/**
 * A literal path as an rsync pattern. A backslash does not escape a backslash
 * there (measured: `back\\slash` never matches a directory called `back\slash`),
 * so each special character goes into a bracket expression of its own, which
 * rsync reads literally.
 */
const rsyncEscape = (s: string): string =>
  s.replace(/[\\*?[]/g, (c) => (c === "\\" ? "[\\\\]" : `[${c}]`));

// ── Measuring ───────────────────────────────────────────────────────────

const PROBE_BEGIN = "__claw_git_begin__";
const PROBE_END = "__claw_git_end__";
const PROBE_END_LINE = new RegExp(`^${PROBE_END}:(\\d+)$`);
const PROBE_LINE = /^(-?\d+) (-?\d+) ([0-9a-f]+)$/;
const TRUNCATED_FOOTER = /^\[stdout truncated; \d+ bytes dropped\]$/;
const PROBE_TIMEOUT_SEC = 20;

/**
 * The sandbox-side measurement: one line per `.git` directory, `bytes files
 * hex(path)`, between fences.
 *
 * The path is hex because it is a name the agent chose and may hold anything,
 * newlines included, and the line has to stay a line. For the same reason files
 * are counted as the NULs of a `-print0`, not as lines: a name with newlines in it
 * is one file, and counting lines would let a few of them make a small repository
 * look like thousands of files and be left out. The search does not enter
 * the directories the snapshot drops anyway (a `node_modules` full of vendored
 * `.git` directories is not this step's business), and does not enter a `.git`
 * it has found. The exit status is the search's own, via pipefail: a `find` that
 * walked only part of the tree has not seen every repository, and the unseen one
 * would be uploaded without ever having been measured.
 *
 * Run through `bash <<EOF` for the same reason the sync script is: the sandbox's
 * shell is dash, which has neither `pipefail` nor `read -d`.
 */
export function buildGitProbeCommand(workspace: string, excludes: readonly string[]): string {
  const prune = excludes.map((p) => `-name ${shq(p)}`).join(" -o ");
  return `bash <<'__CLAW_GIT_PROBE_EOF__'
set -o pipefail
echo ${PROBE_BEGIN}
find ${shq(workspace)} \\( ${prune} \\) -prune -o -type d -name ${shq(GIT_DIR)} -prune -print0 2>/dev/null \\
  | while IFS= read -r -d '' g; do
      b=$(du -sb -- "$g" 2>/dev/null | awk '{print $1; exit}')
      n=$(find "$g" -type f -print0 2>/dev/null | tr -cd '\\0' | wc -c | tr -d ' ')
      h=$(printf '%s' "$g" | od -An -v -tx1 | tr -d ' \\n')
      echo "\${b:--1} \${n:--1} $h"
    done
rc=$?
echo ${PROBE_END}:$rc
__CLAW_GIT_PROBE_EOF__
`;
}

export type GitProbe =
  | { ok: true; dirs: GitDirMeasure[] }
  | { ok: false; reason: string };

/**
 * Read the measurement back, or say why it cannot be believed.
 *
 * Strict in the way the workspace listing is, for the same reason: the lines are
 * produced by a sandbox the agent controls, and an output that is cut, forged or
 * not shaped like a measurement is a reason to know less, never to assume more.
 * A path the output names has to be one this module could safely put back into a
 * command: inside the workspace, ending in `/.git`, and free of newlines and NUL.
 */
export function parseGitProbe(raw: string, workspace: string): GitProbe {
  const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.some((l) => TRUNCATED_FOOTER.test(l))) return { ok: false, reason: "output_truncated" };
  const begin = lines.indexOf(PROBE_BEGIN);
  if (begin < 0) return { ok: false, reason: "no_begin_fence" };
  let end = -1;
  let rc = 0;
  for (let i = lines.length - 1; i > begin; i--) {
    const m = PROBE_END_LINE.exec(lines[i]);
    if (m) { end = i; rc = Number(m[1]); break; }
  }
  if (end < 0) return { ok: false, reason: "no_end_fence" };
  if (rc !== 0) return { ok: false, reason: `find_exit_${rc}` };

  const dirs: GitDirMeasure[] = [];
  for (const line of lines.slice(begin + 1, end)) {
    const m = PROBE_LINE.exec(line);
    if (!m) return { ok: false, reason: "unexpected_line" };
    const path = Buffer.from(m[3], "hex").toString("utf8");
    if (Buffer.from(path, "utf8").toString("hex") !== m[3]) return { ok: false, reason: "path_not_utf8" };
    if (/[\n\r\0]/.test(path)) return { ok: false, reason: "path_has_control_character" };
    if (!path.startsWith(`${workspace}/`) || !path.endsWith(`/${GIT_DIR}`)) {
      return { ok: false, reason: "path_outside_workspace" };
    }
    dirs.push({ path, bytes: Number(m[1]), files: Number(m[2]) });
  }
  return { ok: true, dirs };
}

/**
 * Which measured directories are carried.
 *
 * The comparison is strict: a `.git` exactly at a limit is carried. A directory
 * whose size or count could not be read is not guessed at -- it is left out and
 * called `unmeasured`.
 */
export function decideGit(probe: GitProbe, limits: GitLimits): GitDecision {
  if (!probe.ok) return { mode: "drop-all", why: "unmeasured", detail: probe.reason };
  const skipped: GitSkip[] = [];
  for (const d of probe.dirs) {
    let reason: GitSkipReason | null = null;
    if (d.bytes < 0 || d.files < 0) reason = "unmeasured";
    else if (d.bytes > limits.maxBytes) reason = "too_large";
    else if (d.files > limits.maxFiles) reason = "too_many_files";
    if (reason) skipped.push({ ...d, reason });
  }
  return { mode: "keep", skipped };
}

/** Measure the workspace's repositories and decide; never throws. */
export async function planGit(
  hands: HandsClient,
  workspace: string,
  excludes: readonly string[],
  limits: GitLimits,
  signal?: AbortSignal,
): Promise<GitDecision> {
  if (limits.maxBytes <= 0) return { mode: "drop-all", why: "disabled" };
  try {
    const raw = await withHandsTimeout<string>(
      hands,
      "bash",
      { command: buildGitProbeCommand(workspace, excludes), timeout: PROBE_TIMEOUT_SEC },
      (PROBE_TIMEOUT_SEC + 5) * 1000,
      signal,
    );
    const decision = decideGit(parseGitProbe(String(raw), workspace), limits);
    if (decision.mode === "drop-all") {
      logger.warn({ detail: decision.detail }, "workspace_git.unmeasured");
    }
    return decision;
  } catch (e) {
    const detail = String((e as { message?: string })?.message ?? e).slice(0, 200);
    logger.warn({ detail }, "workspace_git.probe_failed");
    return { mode: "drop-all", why: "unmeasured", detail };
  }
}

// ── Rendering the decision for each copy mechanism ──────────────────────

/** Where git's transient files live, as `find -path` patterns (`*` crosses `/` there). */
const TRANSIENT_FIND = ["*/.git/*.lock", "*/.git/objects/*tmp_*"];
/** The same, as rsync patterns: `**` is rsync's `*` that crosses `/`. */
const TRANSIENT_RSYNC = [".git/**.lock", ".git/objects/**tmp_*"];
/** The same, as tar patterns: unanchored, and `*` crosses `/` by default. */
const TRANSIENT_TAR = [".git/*.lock", ".git/objects/*tmp_*"];

const relTo = (workspace: string, path: string): string => path.slice(workspace.length + 1);

/** Extra `find` predicates; the listing and the delta's `stat` both take them, so they cover the same files. */
export function gitFindArgs(d: GitDecision): string {
  if (d.mode === "drop-all") return `-not -path '*/${GIT_DIR}/*' -not -path '*/${GIT_DIR}'`;
  const parts = TRANSIENT_FIND.map((p) => `-not -path ${shq(p)}`);
  for (const s of d.skipped) {
    const p = globEscape(s.path);
    parts.push(`-not -path ${shq(p)}`, `-not -path ${shq(`${p}/*`)}`);
  }
  return parts.join(" ");
}

/** Extra `rsync` arguments, as the `--exclude` lines the sync script already uses. */
export function gitRsyncArgs(d: GitDecision, workspace: string): string {
  if (d.mode === "drop-all") return `--exclude ${shq(GIT_DIR)}`;
  const rules = [
    ...TRANSIENT_RSYNC,
    // Anchored at the transfer root, which is the workspace.
    ...d.skipped.map((s) => `/${rsyncEscape(relTo(workspace, s.path))}`),
  ];
  return rules.map((r) => `--exclude ${shq(r)}`).join(" \\\n    ");
}

/**
 * Extra `tar` arguments. A skipped repository is named exactly, so the options
 * that stop `*` and `[` meaning something come before it; they only affect the
 * excludes that follow, and the transient patterns above them keep theirs.
 */
export function gitTarArgs(d: GitDecision, workspace: string): string {
  if (d.mode === "drop-all") return `--exclude=${shq(GIT_DIR)}`;
  const parts = TRANSIENT_TAR.map((p) => `--exclude=${shq(p)}`);
  if (d.skipped.length) {
    parts.push("--no-wildcards", "--anchored");
    for (const s of d.skipped) parts.push(`--exclude=${shq(`./${relTo(workspace, s.path)}`)}`);
  }
  return parts.join(" ");
}

// ── Telling the user ────────────────────────────────────────────────────

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
const NOTE_LISTED = 3;

/**
 * What to say when a sync left a repository out, or could not tell. Null when
 * there is nothing to say.
 *
 * Plain words and the consequence, because the sync event is the only place the
 * user can find out: a repository that is not saved comes back after a sandbox
 * restart as a folder of files without history, and unpushed commits are gone.
 */
export function gitSkipNote(
  skipped: readonly GitSkip[],
  unmeasured: boolean,
  limits: GitLimits,
): string | null {
  const rel = (p: string): string => p.replace(/^\/workspace\//, "");
  const what = (s: GitSkip): string => {
    if (s.reason === "too_large") return `${rel(s.path)} (${mb(s.bytes)}, limit ${mb(limits.maxBytes)})`;
    if (s.reason === "too_many_files") {
      return `${rel(s.path)} (${s.files} files, limit ${limits.maxFiles}; git gc packs them)`;
    }
    return `${rel(s.path)} (size unknown)`;
  };
  const sentences: string[] = [];
  if (skipped.length) {
    const shown = skipped.slice(0, NOTE_LISTED).map(what).join("; ");
    const more = skipped.length > NOTE_LISTED ? `; and ${skipped.length - NOTE_LISTED} more` : "";
    sentences.push(`Not saved: ${shown}${more}.`);
  }
  if (unmeasured) {
    sentences.push("Could not measure the git repositories in /workspace, so none were saved this time.");
  }
  if (!sentences.length) return null;
  sentences.push(
    "A repository that is not saved comes back as plain files after the sandbox restarts, "
    + "and commits that were not pushed are lost: push them first.",
  );
  return sentences.join(" ");
}

// ── Restoring ───────────────────────────────────────────────────────────

/**
 * The top-level `.git` directories among restored paths: those with a `HEAD`.
 * Paths are relative to the workspace.
 */
export function restoredGitDirs(rels: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const rel of rels) {
    const parts = rel.split("/");
    const at = parts.indexOf(GIT_DIR);
    if (at < 0 || at !== parts.length - 2 || parts[at + 1] !== "HEAD") continue;
    roots.add(parts.slice(0, at + 1).join("/"));
  }
  return [...roots].sort();
}

/**
 * Put back what an object store cannot hold: empty directories.
 *
 * Objects are files, so a restored `.git` is missing every directory that had
 * nothing in it, and git will not treat a directory as a repository without
 * `objects/` and `refs/` -- which a repository whose refs are all packed, or one
 * with no commits yet, does not have a file under. Only repositories whose `HEAD`
 * came back are touched, so this cannot conjure a `.git` out of nothing.
 */
export function buildGitSkeletonCommand(workspace: string, roots: readonly string[]): string {
  const dirs = roots.flatMap((r) => ["refs/heads", "refs/tags", "objects/pack", "objects/info"]
    .map((d) => shq(`${workspace}/${r}/${d}`)));
  return `mkdir -p -- ${dirs.join(" ")} && echo OK`;
}

/** Best effort: a restore that worked must not be failed by a missing empty directory. */
export async function ensureGitSkeleton(
  hands: HandsClient,
  workspace: string,
  rels: readonly string[],
): Promise<void> {
  const roots = restoredGitDirs(rels);
  if (!roots.length) return;
  try {
    const out = await withHandsTimeout<string>(
      hands, "bash", { command: buildGitSkeletonCommand(workspace, roots), timeout: 30 }, 35_000,
    );
    if (!String(out).trim().endsWith("OK")) {
      logger.warn({ roots: roots.length, out: String(out).slice(-200) }, "workspace_git.skeleton_failed");
    }
  } catch (e) {
    logger.warn({ err: (e as Error)?.message ?? String(e) }, "workspace_git.skeleton_failed");
  }
}
