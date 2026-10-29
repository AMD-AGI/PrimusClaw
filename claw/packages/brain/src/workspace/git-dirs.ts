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
 *     "all of them are small enough", and it is not "stop syncing" either: see
 *     `GitDecision`.
 */
import pino from "pino";
import { withHandsTimeout, type HandsClient } from "../clients/hands.js";
import { TRUNCATED_FOOTER, shq } from "./sync-delta.js";
import {
  WORKSPACE_GIT_MAX_BYTES,
  WORKSPACE_GIT_MAX_FILES,
  WORKSPACE_GIT_PROBE_TIMEOUT_SEC,
  WORKSPACE_GIT_TOTAL_MAX_BYTES,
  WORKSPACE_GIT_TOTAL_MAX_FILES,
} from "../config.js";

const logger = pino({ name: "workspace-git" });

export const GIT_DIR = ".git";

export interface GitLimits {
  /** Largest `.git` (apparent bytes) that is carried. 0 or less switches carrying `.git` off. */
  maxBytes: number;
  /** Most files a `.git` may hold and still be carried. */
  maxFiles: number;
  /** Most bytes all the carried `.git` directories may add up to; the largest are left out until they fit. */
  totalBytes: number;
  /** Most files all the carried `.git` directories may add up to; the largest are left out until they fit. */
  totalFiles: number;
}

/** One `.git` directory as the sandbox measured it; -1 where it could not say. */
export interface GitDirMeasure {
  path: string;
  bytes: number;
  files: number;
}

export type GitSkipReason =
  | "too_large"
  | "too_many_files"
  | "over_total_bytes"
  | "over_total_files"
  | "unmeasured";

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
 *     does not upload them this time, and the caller must not take the resulting
 *     absence as the user having deleted them: the S3 prune spares their objects,
 *     and the shared-disk sync carries the previous snapshot's copy forward. The
 *     rest of the workspace is synced as usual -- a repository nobody can measure
 *     is not a reason for every other file to stop being saved.
 *
 * A repository in `skipped` -- over a bound, or one whose own size could not be
 * read -- is left out of this sync and nothing more. It is not a repository the
 * user deleted, so whatever the last sync that carried it saved is kept, the same
 * way: see `gitPruneExempt` and `gitCarryCommand`. Otherwise one `git add` that
 * pushes a project over a bound would delete the whole saved history of it, and
 * the last good snapshot is exactly what a reclaimed sandbox needs.
 */
export type GitDecision =
  | { mode: "keep"; skipped: GitSkip[] }
  | { mode: "drop-all"; why: "disabled" | "unmeasured"; detail?: string };

export const KEEP_ALL_GIT: GitDecision = { mode: "keep", skipped: [] };

/** The limits this deployment is configured with. */
export function configuredGitLimits(): GitLimits {
  return {
    maxBytes: WORKSPACE_GIT_MAX_BYTES,
    maxFiles: WORKSPACE_GIT_MAX_FILES,
    totalBytes: WORKSPACE_GIT_TOTAL_MAX_BYTES,
    totalFiles: WORKSPACE_GIT_TOTAL_MAX_FILES,
  };
}

// ── Quoting ─────────────────────────────────────────────────────────────

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
/** What the measurement gets when the sync is a SIGTERM's: its budget has no room for more. */
export const SIGTERM_PROBE_TIMEOUT_SEC = 8;
/** Beyond the sandbox's own deadline, for the call to come back; if it does not, the answer is the same. */
const PROBE_CALL_SLACK_SEC = 2;

/**
 * The sandbox-side measurement: one line per `.git` directory, `bytes files
 * hex(path)`, between fences.
 *
 * The path is hex because it is a name the agent chose and may hold anything,
 * newlines included, and the line has to stay a line. For the same reason files
 * are counted by `-printf '%s\n'`, one line per file whatever its name is made of:
 * a name with newlines in it is one file, and counting a listing of names by lines
 * would let a few of them make a small repository look like thousands of files
 * and be left out. One `find` per repository gives both numbers, the bytes of the
 * regular files in it (what an upload reads) and how many there are (what an
 * upload pays for). The outer search does not enter the directories the snapshot
 * drops anyway (a `node_modules` full of vendored `.git` directories is not this
 * step's business), and does not enter a `.git` it has found.
 *
 * What the exit status of the outer search says: 0 and 1 are a walk that ran to
 * its end -- 1 is `find` reporting something it could not read or a file that
 * vanished under it (a build running beside the sync), which is a fact about
 * unrelated corners of the tree and not about git. A repository inside a
 * directory nobody can read is not one the snapshot could have copied either.
 * Anything else, or no end fence at all, is a walk that did not finish, and the
 * repository it never reached would be uploaded without ever having been measured.
 * A repository whose own `find` fails is reported as `-1 -1`: unmeasured.
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
      if m=$(find "$g" -type f -printf '%s\\n' 2>/dev/null | awk '{ s += $1; n++ } END { printf "%.0f %d\\n", s, n }'); then :; else m="-1 -1"; fi
      h=$(printf '%s' "$g" | od -An -v -tx1 | tr -d ' \\n')
      echo "$m $h"
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
  if (rc !== 0 && rc !== 1) return { ok: false, reason: `find_exit_${rc}` };

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
 *
 * Then the same two bounds are applied to what is left, added up: the largest
 * repository goes first, whole, until the rest fit. Files are settled before
 * bytes, since a tree of many small clones breaks the first and rarely the second.
 */
export function decideGit(probe: GitProbe, limits: GitLimits): GitDecision {
  if (!probe.ok) return { mode: "drop-all", why: "unmeasured", detail: probe.reason };
  const skipped: GitSkip[] = [];
  const carried: GitDirMeasure[] = [];
  for (const d of probe.dirs) {
    let reason: GitSkipReason | null = null;
    if (d.bytes < 0 || d.files < 0) reason = "unmeasured";
    else if (d.bytes > limits.maxBytes) reason = "too_large";
    else if (d.files > limits.maxFiles) reason = "too_many_files";
    if (reason) skipped.push({ ...d, reason });
    else carried.push(d);
  }
  const shed = (
    key: "files" | "bytes", bound: number, reason: GitSkipReason,
  ): void => {
    let sum = carried.reduce((n, d) => n + d[key], 0);
    // Largest first; a tie goes by path, so the same workspace gives the same answer.
    const order = [...carried].sort((a, b) => b[key] - a[key] || (a.path < b.path ? -1 : 1));
    for (const d of order) {
      if (sum <= bound) break;
      sum -= d[key];
      carried.splice(carried.indexOf(d), 1);
      skipped.push({ ...d, reason });
    }
  };
  shed("files", limits.totalFiles, "over_total_files");
  shed("bytes", limits.totalBytes, "over_total_bytes");
  return { mode: "keep", skipped };
}

/**
 * Hold the listing an upload is about to be built from to the file bounds again.
 *
 * The measurement and the listing are two calls, and the agent keeps working
 * between them: a `.git` that was created or grown after it was measured is in the
 * listing and not in the decision. For the upload the cost of that is one request
 * per file, and the listing is the one thing that says exactly how many there are,
 * so the per-repository and the total file bounds are applied to what it holds. A
 * repository that is over after all is dropped whole, as if it had been measured
 * over: it joins `skipped`, and so its saved copy is kept like any other's.
 *
 * Bytes are not in a listing, so the byte bounds stay with the measurement; a
 * repository that grew past one since is caught by the next sync's.
 */
export function enforceListedGit(
  files: readonly string[],
  d: GitDecision,
  limits: GitLimits,
): { files: string[]; decision: GitDecision } {
  const unchanged = { files: [...files], decision: d };
  if (d.mode !== "keep") return unchanged;
  const rootOf = (f: string): string | null => {
    const at = f.indexOf(`/${GIT_DIR}/`);
    return at < 0 ? null : f.slice(0, at + 1 + GIT_DIR.length);
  };
  const counts = new Map<string, number>();
  for (const f of files) {
    const root = rootOf(f);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const dirs = [...counts].map(([path, n]) => ({ path, bytes: 0, files: n }));
  const over = decideGit(
    { ok: true, dirs },
    { ...limits, maxBytes: Infinity, totalBytes: Infinity },
  );
  const extra = over.mode === "keep" ? over.skipped : [];
  if (!extra.length) return unchanged;
  const dropped = new Set(extra.map((s) => s.path));
  return {
    files: files.filter((f) => !dropped.has(rootOf(f) ?? "")),
    decision: { mode: "keep", skipped: [...d.skipped, ...extra] },
  };
}

/**
 * Whether this sync could not see some repository it should have, as opposed to
 * having seen it and found it too big. This is what the user is told ("could not
 * measure"); what is done about it is `gitPruneExempt` and `gitCarryCommand`, which
 * also cover the repositories that were seen and left out.
 */
export function unmeasuredGit(d: GitDecision): boolean {
  if (d.mode === "drop-all") return d.why === "unmeasured";
  return d.skipped.some((s) => s.reason === "unmeasured");
}

/** Whether a path relative to the workspace is, or is inside, a `.git`. */
export const hasGitComponent = (rel: string): boolean => rel.split("/").includes(GIT_DIR);

/**
 * Which paths (relative to the workspace) the prune of a saved snapshot must leave
 * alone: those of a repository this sync left out. Absence from the listing means
 * "the user deleted it" only for a repository that was in the listing's view; one
 * that was too big this time, or could not be measured, is absent because of the
 * sync, and its saved copy is the last good one. Everything else is pruned as
 * before, so one repository that is left out does not freeze the rest.
 *
 * Not for `disabled`: an operator who turned `.git` snapshots off asked for what
 * the old behaviour did, which is not to keep them.
 */
export function gitPruneExempt(d: GitDecision, workspace: string): (rel: string) => boolean {
  if (d.mode === "drop-all") return d.why === "unmeasured" ? hasGitComponent : () => false;
  const roots = d.skipped.map((s) => `${relTo(workspace, s.path)}/`);
  return (rel) => roots.some((r) => rel.startsWith(r));
}

/**
 * Measure the workspace's repositories and decide; never throws.
 *
 * `timeoutSec` is how long the sandbox gets. Running out of it is an answer like
 * any other failure here -- `unmeasured` -- and not an error: see `GitDecision`.
 */
export async function planGit(
  hands: HandsClient,
  workspace: string,
  excludes: readonly string[],
  limits: GitLimits,
  signal?: AbortSignal,
  timeoutSec: number = WORKSPACE_GIT_PROBE_TIMEOUT_SEC,
): Promise<GitDecision> {
  if (limits.maxBytes <= 0) return { mode: "drop-all", why: "disabled" };
  try {
    const raw = await withHandsTimeout<string>(
      hands,
      "bash",
      { command: buildGitProbeCommand(workspace, excludes), timeout: timeoutSec },
      (timeoutSec + PROBE_CALL_SLACK_SEC) * 1000,
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

/**
 * The shared-disk script's step for a repository this sync left out: keep what the
 * previous snapshot holds.
 *
 * A snapshot is built into an empty `pending/` and swapped in, so a repository the
 * copy leaves out is gone from the next `current/` -- which is the user's unpushed
 * history deleted by a slow `du`, or by one `git add` that took a project past a
 * bound. So the copy of each such repository in `current/` is hard-linked into
 * `pending/` (a repository is one whole directory or nothing, so a failed link
 * falls back to a copy and a failed copy to nothing, never half of one).
 *
 * Only where the directory it sat in is still in the new snapshot: a repository
 * whose working tree the user deleted is not brought back as a lone `.git`.
 * It runs after the script's emptiness check, so it cannot make an emptied
 * workspace look like it still had content. Empty for a decision that measured.
 */
export function gitCarryCommand(d: GitDecision, workspace: string): string {
  const fn = `carry_git() {
  p="\${1#./}"
  [ -d "$BASE/current/$p" ] || return 0
  parent="\${p%/*}"; [ "$parent" = "$p" ] && parent=.
  [ -d "$BASE/pending/$parent" ] || return 0
  rm -rf "$BASE/pending/$p"
  cp -al "$BASE/current/$p" "$BASE/pending/$p" 2>/dev/null \\
    || { rm -rf "$BASE/pending/$p"; cp -a "$BASE/current/$p" "$BASE/pending/$p" 2>/dev/null; } \\
    || rm -rf "$BASE/pending/$p"
}`;
  if (d.mode === "drop-all") {
    if (d.why !== "unmeasured") return "";
    return `${fn}
if [ -d "$BASE/current" ]; then
  ( cd "$BASE/current" && find . -type d -name ${shq(GIT_DIR)} -prune -print0 ) 2>/dev/null \\
    | while IFS= read -r -d '' g; do carry_git "$g"; done || true
fi`;
  }
  if (!d.skipped.length) return "";
  return `${fn}
if [ -d "$BASE/current" ]; then
${d.skipped.map((s) => `  carry_git ${shq(relTo(workspace, s.path))}`).join("\n")}
fi`;
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
 * restart as it was last saved, if it ever was, and unpushed commits made since
 * are gone.
 */
export function gitSkipNote(
  skipped: readonly GitSkip[],
  unmeasured: boolean,
  limits: GitLimits,
  workspace: string,
): string | null {
  const rel = (p: string): string => relTo(workspace, p);
  const what = (s: GitSkip): string => {
    if (s.reason === "too_large") return `${rel(s.path)} (${mb(s.bytes)}, limit ${mb(limits.maxBytes)})`;
    if (s.reason === "too_many_files") {
      return `${rel(s.path)} (${s.files} files, limit ${limits.maxFiles}; git gc packs them)`;
    }
    if (s.reason === "over_total_files") {
      return `${rel(s.path)} (${s.files} files; together the repositories are over ${limits.totalFiles} files)`;
    }
    if (s.reason === "over_total_bytes") {
      return `${rel(s.path)} (${mb(s.bytes)}; together the repositories are over ${mb(limits.totalBytes)})`;
    }
    return `${rel(s.path)} (size unknown)`;
  };
  const sentences: string[] = [];
  if (skipped.length) {
    const shown = skipped.slice(0, NOTE_LISTED).map(what).join("; ");
    const more = skipped.length > NOTE_LISTED ? `; and ${skipped.length - NOTE_LISTED} more` : "";
    sentences.push(`Not saved this time: ${shown}${more}.`);
  }
  if (unmeasured) {
    sentences.push(`Could not measure the git repositories in ${workspace}, so none were saved this time.`);
  }
  if (!sentences.length) return null;
  sentences.push(
    "What was saved of them before is kept, but commits made since are not: "
    + "if the sandbox restarts they are lost, so push them first.",
  );
  return sentences.join(" ");
}

/** What a sync tells its caller about the repositories it did not (fully) save. */
export interface GitReport {
  skipped: GitSkip[];
  /** Some repository could not be measured: the whole probe failed, or one directory's size was unreadable. */
  unmeasured: boolean;
  /** The sentence the user is shown. */
  note: string;
}

/** The report for a decision, or undefined when there is nothing to tell. */
export function gitReport(d: GitDecision, limits: GitLimits, workspace: string): GitReport | undefined {
  const skipped = d.mode === "keep" ? d.skipped : [];
  const probeFailed = d.mode === "drop-all" && d.why === "unmeasured";
  const note = gitSkipNote(skipped, probeFailed, limits, workspace);
  return note ? { skipped, unmeasured: unmeasuredGit(d), note } : undefined;
}

/**
 * What a report is about, apart from the figures in its sentence: which
 * repositories were left out and why. A repository 350 MB over a 300 MB bound that
 * grows a few MB a turn has a different sentence every turn and the same news, so
 * "have I already said this" compares this and not the text.
 */
export function gitReportKey(r: GitReport): string {
  return `${r.unmeasured ? "unmeasured" : "measured"}|${r.skipped.map((s) => `${s.path}:${s.reason}`).sort().join("|")}`;
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
