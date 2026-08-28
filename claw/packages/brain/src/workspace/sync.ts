// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace/sync.ts
//
// Plan Y v2 workspace persistence (checkpoint-architecture-redesign §5.5
// and §6.3): syncs /workspace to a configured shared filesystem at
// ${WORKSPACE_PERSIST_BASE}/users/<uid_hex>/.claw/workspaces/<sid>/{current,pending}/,
// with every fs mutation run inside the sandbox via the Hands MCP `bash`
// tool through withHandsTimeout (enforced by the CI guard
// `lint-no-direct-hands-calltool-in-workspace.sh`).
//
// INV-14 (atomic-current): the sync script recovers from a crash that
// interrupted the two-step `mv current → .swapout.$$; mv pending →
// current` rename; the reaper never touches `pending/` or `.swapout.*`,
// so their lifecycle is owned entirely by this module.

import { HandsClient, withHandsTimeout, isHandsNetworkError } from "../clients/hands.js";
import {
  HANDS_CALL_DEFAULT_TIMEOUT_MS,
  HANDS_CALL_RSYNC_TIMEOUT_MS,
  WORKSPACE_PERSIST_BASE,
  WORKSPACE_RESTORE_TIMEOUT_MS,
} from "../config.js";
import { metrics } from "../infra/metrics.js";
import {
  sharedDiskExcludes,
  rsyncExcludeArgs,
  tarExcludeArgs,
} from "./excludes.js";
import pino from "pino";

// Map a thrown error to the workspace_sync_failures_total{reason} enum
// (§12.1.2). Order matters: hands_unreachable wins over rsync_error so
// a sandbox-down event during rsync is not miscounted as an rsync bug.
//
// The two script refusals get reasons of their own because they are the only
// ones an operator can act on, and rsync_error sends them to look at rsync: a
// persist base that is not mounted is a deployment to fix, and a sync that
// declined to overwrite a snapshot with an empty workspace is a sandbox that
// went away mid-turn. Neither is a bug in the copy.
//
// Exported for unit tests (brain/test/workspace-sync.test.ts).
export function classifySyncFailure(err: unknown):
  "timeout" | "rsync_error" | "meta_write_error" | "hands_unreachable"
  | "config_error" | "empty_workspace" {
  const msg = String((err as { message?: string })?.message ?? err);
  if (/hands_call_timeout|workspace_restore_timeout/.test(msg)) return "timeout";
  if (isHandsNetworkError(err)) return "hands_unreachable";
  if (/meta_parse_failed/.test(msg)) return "meta_write_error";
  if (/workspace_persist_base_missing/.test(msg)) return "config_error";
  if (/workspace_sync_empty/.test(msg)) return "empty_workspace";
  return "rsync_error";
}

const logger = pino({ name: "workspace-sync" });

// ── ID safety guard ─────────────────────────────────────────────────────
//
// Both uidHex and sessionId end up interpolated into a bash command run
// on the sandbox. They must be character-class-restricted before that
// happens so a malicious or buggy upstream cannot inject shell metachars.
// Patterns are deliberately strict (no leading hyphen, no '/', no spaces).
//
//   uidHex     : 32 lowercase hex chars; produced by ensureHands from the
//                user record (see brain/src/index.ts ensureHands).
//   sessionId  : UUID-shaped 32-40 chars, hex + dashes; chat-path uses
//                Postgres uuid_generate_v4(), DAG-path also uses uuid.

const UID_HEX_RE = /^[0-9a-f]{32}$/;
const SID_RE = /^[0-9a-f-]{32,40}$/;

export function assertSafeIds(uidHex: string, sessionId: string): void {
  if (!UID_HEX_RE.test(uidHex)) {
    throw new Error(`workspace_sync.unsafe_user_id: ${JSON.stringify(uidHex)}`);
  }
  if (!SID_RE.test(sessionId)) {
    throw new Error(`workspace_sync.unsafe_session_id: ${JSON.stringify(sessionId)}`);
  }
}

// The third value that reaches the script, and the one the guard above missed.
//
// The header below says every interpolated variable is double-quoted and
// guarded by `assertSafeIds`, which was true of the two ids and never true of
// this: WORKSPACE_PERSIST_BASE is read from the environment and substituted
// straight into `ROOT="..."`. A value carrying a double quote ends the string
// it was substituted into and the remainder of the line is read as script, on
// the sandbox, as part of every sync.
//
// Being a deployment's own setting rather than user input is a reason to expect
// it to be well-formed. It is not a reason for the script to be undefined when
// it is not, and a misconfiguration should say so where it is set rather than
// somewhere inside a bash heredoc.
// Checked at both places the root becomes part of a command, because they are
// separate routes into the same script: `sessionBase` builds the path that is
// substituted as BASE, and `buildSyncCommand` substitutes the root itself as
// ROOT. Guarding one leaves the other open, and the check is written out at the
// point of substitution rather than delegated so that reading the function that
// builds the script is enough to see the root was checked.
const PERSIST_ROOT_RE = /^\/[A-Za-z0-9._/-]*$/;

const unsafePersistRoot = (persistRoot: string): Error =>
  new Error(`workspace_sync.unsafe_persist_base: ${JSON.stringify(persistRoot)}`);

export function assertSafePersistRoot(persistRoot: string): void {
  if (!PERSIST_ROOT_RE.test(persistRoot)) throw unsafePersistRoot(persistRoot);
}

function sessionBase(
  uidHex: string,
  sessionId: string,
  persistBase = WORKSPACE_PERSIST_BASE,
): string {
  if (!persistBase) {
    throw new Error("workspace_persistence_disabled: WORKSPACE_PERSIST_BASE is empty");
  }
  assertSafePersistRoot(persistBase);
  return `${persistBase}/users/${uidHex}/.claw/workspaces/${sessionId}`;
}

// ── Sync metadata returned to the caller ────────────────────────────────
//
// brain/src/index.ts records these into Prometheus histograms and into
// the KV checkpoint's `has_workspace_sync` / `last_sync_turn` fields.
export interface SyncResult {
  size: number;       // bytes in BASE/current/ after the swap
  inodes: number;     // file count under BASE/current/
  durationMs: number; // brain-side wall clock for the whole RPC
}

// ── Sandbox-side bash script ────────────────────────────────────────────
//
// All ${variables} are double-quoted to survive the bash interpolation,
// guarded by assertSafeIds for the two ids and assertSafePersistRoot for
// the root they hang under. The recovery prologue (rm .swapout + maybe
// promote pending) is what makes the two-step atomic rename below safe
// across a SIGKILL between T1 and T2 (see header comment for the
// timeline). The rsync ignore list mirrors the v1.4 aggressive set.
//
// `du -sb` / `find ... -type f | wc -l` are best-effort; their failure
// would propagate via `set -euo pipefail` and abort the script before
// the OK marker, which is exactly what we want — better to surface a
// metric failure than a silently-truncated meta.json.
//
// The ignore list also drops rebuildable compile caches that otherwise
// explode the inode count and push the rsync past its timeout: `hsa/`
// (ROCm gfx kernel code objects), `worktree/` (per-specialist git
// checkouts), `*.co`, `__pycache__/`, and `torchinductor_*/`. Benchmark
// results live under `runs/<arm>/.../benchmark_*` (outside those dirs)
// so they are still persisted.

/**
 * Re-enter `bash` from inside the sandbox `bash` tool. The sandbox tool
 * actually dispatches `command` via `/bin/sh -c` (dash on Debian-slim
 * sandbox images), and dash rejects `set -o pipefail` with:
 *
 *   /bin/sh: 1: set: Illegal option -o pipefail
 *
 * which silently kills every workspace_sync invocation (observed on dev
 * 2026-05-20, session 2dae63bb logs). Wrapping the script in a here-doc
 * fed to `bash` makes `set -o pipefail` honoured regardless of which
 * shell launched the wrapper. The terminator is a long, non-overlapping
 * literal so no inner script line can accidentally close the heredoc.
 *
 * Safety note: `script` MUST come from a trusted source (constants +
 * sessionId/userIdHex already validated by assertSafeIds). Do NOT pass
 * arbitrary user input here.
 */
function wrapWithBash(script: string): string {
  return `bash <<'__CLAW_WORKSPACE_SYNC_EOF__'\n${script}\n__CLAW_WORKSPACE_SYNC_EOF__\n`;
}

// Best-effort rsync provisioning. Some sandbox images (e.g. the ROCm
// pytorch base used by Dockerfile.envd-amd-gpu) ship without rsync, which
// turned every sync into `rsync: command not found`
// (workspace_sync_failures_total{reason="rsync_error"}). We first try to
// `apt-get install` it; that is a no-op on images that already have it and
// fails silently when the sandbox runs non-root or has no apt mirror /
// network. Callers MUST keep a tar-based fallback for that silent-fail case
// (see buildSyncCommand / buildRestoreCommand), so this stays purely an
// optimisation that lets rsync's incremental + --delete fast path win when
// available without ever blocking the sync.
const ENSURE_RSYNC = `if ! command -v rsync >/dev/null 2>&1; then
  (apt-get update -qq && apt-get install -y --no-install-recommends rsync) >/dev/null 2>&1 || true
fi`;

// Both forms come from the one list in workspace/excludes.ts, so the tar
// fallback and the rsync fast path cannot drop different things -- and neither
// can drift away from what the S3 upload skips, which is how the two ended up
// producing different workspaces on restore.
const TAR_EXCLUDES = tarExcludeArgs(sharedDiskExcludes());
const RSYNC_EXCLUDES = rsyncExcludeArgs(sharedDiskExcludes());

// Where the sandbox keeps the working tree. Production never passes anything
// else; the parameter exists so the script can be executed against a scratch
// directory by the tests that run it for real (workspace-sync-exec.test.ts)
// rather than only matching its text.
const SANDBOX_WORKSPACE = "/workspace";

function buildSyncCommand(
  base: string,
  turn: number,
  workspace = SANDBOX_WORKSPACE,
  persistRoot = WORKSPACE_PERSIST_BASE,
): string {
  if (!PERSIST_ROOT_RE.test(persistRoot)) throw unsafePersistRoot(persistRoot);
  return wrapWithBash(`set -euo pipefail
BASE="${base}"
ROOT="${persistRoot}"
TURN="${turn}"
${ENSURE_RSYNC}
# A persist root that is not in the sandbox is a root nobody mounted, and every
# path below it is one \`mkdir -p\` away from existing on the sandbox's own disk.
# The sync would then copy the workspace, report a size and an inode count, and
# lose the snapshot with the pod -- a configured base pointing at nothing looks
# exactly like a working one until a restore comes back empty. Observed while
# bringing this up: the deployment named a mount the platform does not give a
# sandbox, and nothing said so.
[ -d "$ROOT" ] || { echo "workspace_persist_base_missing: $ROOT is not a directory in the sandbox" >&2; exit 1; }
mkdir -p "$BASE/pending"

# Recovery from a prior aborted swap (T1 → T2 crash window).
rm -rf "$BASE/.swapout."* 2>/dev/null || true
if [ ! -d "$BASE/current" ] && [ -d "$BASE/pending" ]; then
  mv "$BASE/pending" "$BASE/current"
fi

# pending/ is scratch, and every sync starts with it empty. Usually it already
# is, because the swap below moves it onto current/ -- but not when the previous
# sync died before the swap, which is a normal way for this to end (Hands' bash
# timeout kills the process group, or the pod goes). --delete does not clean that
# up for us: rsync protects excluded files on the receiving side, so anything left
# in pending/ that matches an exclude survives the copy and is then promoted into
# the snapshot, and the next restore writes it back into the user's workspace. The
# newly added excludes are the likeliest source -- a hands.log or a .o copied
# there by the previous release, when they were not excluded yet. The tar branch
# below already wipes for exactly this reason; incrementality comes from
# --link-dest now, not from pending/ surviving, so the two can agree.
rm -rf "$BASE/pending"
mkdir -p "$BASE/pending"

if command -v rsync >/dev/null 2>&1; then
  # --link-dest is what makes this incremental. pending/ is empty at the start of
  # every sync, so rsync, finding nothing to compare against, copied the entire
  # workspace every turn -- the "incremental sync" was a full copy with extra
  # steps, and on a large workspace it was the reason syncs approached their
  # timeout. Pointed at the previous snapshot, rsync hard-links the files that
  # have not changed and copies only those that have.
  #
  # Hard-linking is safe here because nothing ever modifies a file inside
  # current/ in place: rsync writes to a temporary and renames, and the only
  # other thing that touches current/ is the swap, which unlinks a directory
  # rather than its contents.
  #
  # --modify-window=-1 is not optional, and this is the whole reason the
  # incremental path is conditional. rsync's quick check compares size and
  # mtime at one-second granularity, so a file rewritten within the same second
  # as the previous snapshot, at the same length, looks unchanged -- and with
  # --link-dest the stale copy is then hard-linked forward, silently and
  # permanently. That could not happen while the destination was always empty,
  # because an empty destination means everything is copied. Nanosecond
  # comparison closes it; without it, copying everything is the only correct
  # thing to do, and a slow sync beats a snapshot that quietly disagrees with
  # the workspace.
  #
  # The check is on the version rather than on the option, because
  # \`rsync --modify-window=-1 --version\` exits 0 for any integer -- it proves
  # the argument parses, not that this rsync honours a negative window, which the
  # man page conditions on the receiver being 3.1.3 or newer. Here both ends are
  # this one binary, since the copy is local, so its version settles it.
  #
  # The awk reads to the end rather than exiting after the first line: under
  # pipefail, a reader that leaves early kills rsync with SIGPIPE and the whole
  # sync exits 141 -- intermittently, since it depends on whether the rest of
  # rsync's output had already fitted in the pipe buffer.
  PRECISE_MTIME=""
  RSYNC_NUM=$(rsync --version 2>/dev/null \\
    | awk 'NR==1 { x=$3; gsub(/[^0-9.]/, "", x); split(x, v, "."); printf "%d", (v[1]*10000)+(v[2]*100)+v[3] }')
  if [ -n "$RSYNC_NUM" ] && [ "$RSYNC_NUM" -ge 30103 ]; then
    PRECISE_MTIME="--modify-window=-1"
  fi
  LINK_DEST=""
  if [ -n "$PRECISE_MTIME" ] && [ -d "$BASE/current" ]; then
    LINK_DEST="--link-dest=$BASE/current"
  fi
  rsync -a --delete $PRECISE_MTIME $LINK_DEST \\
    ${RSYNC_EXCLUDES} \\
    ${workspace}/ "$BASE/pending/"
else
  # rsync unavailable (offline / non-root sandbox). Repopulate the same empty
  # pending/ via tar, so no stale file survives here either. tar/cp are in every
  # base image; this path is the safety net for ENSURE_RSYNC failing silently.
  tar -C ${workspace} ${TAR_EXCLUDES} -cf - . | tar -C "$BASE/pending" -xf -
fi

# Nothing copied, over a snapshot that has something in it, is a sandbox coming
# apart rather than a turn's work. The dangerous case is the half-torn-down one:
# with the mount still present and its contents gone, rsync copies nothing and
# exits 0, the swap promotes the empty directory, meta.json records inode_count 0
# and the script prints OK -- and the restore probe then finds current/ and
# meta.json and reports nothing wrong. (A mount that is missing altogether is
# already safe: rsync exits 23 and set -e stops before the swap.) The S3 path
# makes the same call with its empty early return, and for the same reason: a
# user really deleting every file is rarer than a sandbox in the middle of being
# destroyed, and only one of the two is recoverable afterwards.
if [ -d "$BASE/current" ] \\
  && [ -z "$(ls -A "$BASE/pending" 2>/dev/null)" ] \\
  && [ -n "$(ls -A "$BASE/current" 2>/dev/null)" ]; then
  rm -rf "$BASE/pending"
  echo "workspace_sync_empty: ${workspace} produced no files; keeping the previous snapshot" >&2
  exit 1
fi

# Two-step atomic swap. See workspace/sync.ts header for the T0..T3
# timeline that makes this safe under SIGKILL.
if [ -d "$BASE/current" ]; then
  mv "$BASE/current" "$BASE/.swapout.$$"
fi
mv "$BASE/pending" "$BASE/current"
rm -rf "$BASE/.swapout.$$" 2>/dev/null || true

cat > "$BASE/meta.json.tmp" <<EOF
{"session_id":"$(basename "$BASE")","taken_at":$(date +%s%3N),"turn":$TURN,"size_bytes":$(du -sb "$BASE/current" | awk '{print $1}'),"inode_count":$(find "$BASE/current" -type f | wc -l)}
EOF
mv "$BASE/meta.json.tmp" "$BASE/meta.json"
echo OK`);
}

function buildRestoreProbeCommand(base: string): string {
  // Print meta.json verbatim if both meta.json and current/ exist; print
  // MISSING otherwise. brain checks the literal "MISSING" sentinel
  // before attempting the reverse rsync.
  return wrapWithBash(`set -euo pipefail
BASE="${base}"
if [ -d "$BASE/current" ] && [ -f "$BASE/meta.json" ]; then
  cat "$BASE/meta.json"
else
  echo MISSING
fi`);
}

function buildRestoreCommand(base: string, workspace = SANDBOX_WORKSPACE): string {
  // Restore is intentionally NOT --delete — sandbox image-side files
  // (e.g. /workspace/.skills/) that were excluded from the forward rsync
  // must survive the restore. Trailing slash on the source dir copies
  // its contents (not the dir itself).
  return wrapWithBash(`set -euo pipefail
BASE="${base}"
${ENSURE_RSYNC}
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$BASE/current/" ${workspace}/
else
  # Overlay copy: tar extract overwrites snapshot files but leaves
  # image-side extras (e.g. /workspace/.skills/) intact, matching the
  # non-destructive restore semantics (no deletion of unmatched files).
  tar -C "$BASE/current" -cf - . | tar -C ${workspace} -xf -
fi
echo OK`);
}

// ── Public API ──────────────────────────────────────────────────────────
//
// syncWorkspace and restoreWorkspace are the only entry points used by
// brain/src/index.ts. The caller is responsible for the
// AbortSignal lifetime (typically wired to the SIGTERM AbortController)
// and for picking the right semaphore — see workspace/sync-semaphore.ts.

export async function syncWorkspace(
  hands: HandsClient,
  sessionId: string,
  userIdHex: string,
  turn: number,
  opts: { signal?: AbortSignal; kind?: "normal" | "sigterm" } = {},
): Promise<SyncResult> {
  assertSafeIds(userIdHex, sessionId);
  const kind = opts.kind ?? "normal";
  const base = sessionBase(userIdHex, sessionId);
  const t0 = Date.now();
  try {
    const out = await withHandsTimeout<string>(
      hands,
      "bash",
      { command: buildSyncCommand(base, turn) },
      HANDS_CALL_RSYNC_TIMEOUT_MS,
      opts.signal,
    );
    if (!String(out).trim().endsWith("OK")) {
      throw new Error(
        `workspace_sync_failed: ${String(out).slice(-500)}`,
      );
    }

    // Read the meta.json the bash script just wrote so the brain caller
    // can record size / inode counts without parsing rsync stdout.
    const metaOut = await withHandsTimeout<string>(
      hands,
      "read",
      { path: `${base}/meta.json` },
      HANDS_CALL_DEFAULT_TIMEOUT_MS,
      opts.signal,
    );
    let meta: { size_bytes?: number; inode_count?: number };
    try {
      meta = JSON.parse(String(metaOut));
    } catch (e) {
      throw new Error(
        `workspace_sync_meta_parse_failed: ${String(metaOut).slice(0, 200)}`,
      );
    }
    const size = Number(meta.size_bytes ?? 0);
    const inodes = Number(meta.inode_count ?? 0);
    const durationMs = Date.now() - t0;
    metrics.onWorkspaceSync(kind, size, durationMs / 1000);
    logger.info(
      { sessionId, turn, kind, size, inodes, durationMs },
      "workspace_sync.done",
    );
    return { size, inodes, durationMs };
  } catch (err) {
    const reason = classifySyncFailure(err);
    const durationMs = Date.now() - t0;
    logger.error(
      { sessionId, turn, kind, reason, durationMs,
        err: String((err as Error)?.message ?? err).slice(0, 500) },
      "workspace_sync.failed",
    );
    metrics.onWorkspaceSyncFailure(kind, reason);
    throw err;
  }
}

export interface RestoreResult {
  size: number; // size recorded in the snapshot's meta.json
}

export async function restoreWorkspace(
  hands: HandsClient,
  sessionId: string,
  userIdHex: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RestoreResult> {
  assertSafeIds(userIdHex, sessionId);
  const base = sessionBase(userIdHex, sessionId);

  const probe = await withHandsTimeout<string>(
    hands,
    "bash",
    { command: buildRestoreProbeCommand(base) },
    HANDS_CALL_DEFAULT_TIMEOUT_MS,
    opts.signal,
  );
  const probeText = String(probe).trim();
  if (probeText === "MISSING") {
    throw new Error(`workspace_current_missing: ${base}/current`);
  }
  let meta: { size_bytes?: number };
  try {
    meta = JSON.parse(probeText);
  } catch (e) {
    throw new Error(
      `workspace_restore_meta_parse_failed: ${probeText.slice(0, 200)}`,
    );
  }

  const out = await withHandsTimeout<string>(
    hands,
    "bash",
    { command: buildRestoreCommand(base) },
    WORKSPACE_RESTORE_TIMEOUT_MS,
    opts.signal,
  );
  if (!String(out).trim().endsWith("OK")) {
    throw new Error(
      `workspace_restore_failed: ${String(out).slice(-500)}`,
    );
  }
  const size = Number(meta.size_bytes ?? 0);
  logger.info({ sessionId, size }, "workspace_restore.done");
  return { size };
}

// Exported for unit tests; not used by production code paths.
export const __test__ = {
  sessionBase,
  buildSyncCommand,
  buildRestoreProbeCommand,
  buildRestoreCommand,
};
