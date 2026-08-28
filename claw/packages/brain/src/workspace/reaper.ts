// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace/reaper.ts
//
// K8s CronJob worker that sweeps abandoned per-session workspace
// directories from the configured shared filesystem established by Plan Y v2
// workspace_sync path (checkpoint-architecture-redesign §6.3, this
// file's spec is workspace-reaper-design.md v1.0).
//
// Lifecycle of a single sweep:
//
//   Phase 1 — classify and trash
//     readdir <base>/users/<uidHex>/.claw/workspaces/<sid>/ for
//     every hex user dir, then for each <sid> apply classifyForReap().
//     The three INV-R1 conditions (no live KV ckpt, no live KV lock,
//     mtime older than retention + KV grace) must ALL hold before the
//     dir is moved to `.claw/.trash/<sid>-<unixms>/`. The rename is a
//     same-fs operation — atomic, no data movement.
//
//   Phase 2 — empty trash
//     readdir `.claw/.trash/` for every hex user dir; entries older
//     than REAPER_TRASH_GRACE_HOURS get rm -rf'd. The 24h trash grace
//     gives operators a recovery window for misclassifications
//     (manual mv back, see workspace-reaper-design.md §11).
//
// Safety invariants:
//   INV-R1 — three-fold AND condition (KV ckpt absent, KV lock absent,
//            mtime old enough); classifier defaults to "keep" on any
//            error.
//   INV-R3 — rename-then-rm two-phase delete with 24h grace.
//   INV-R4 — reaper never touches sandbox state, only NATS KV + fs.
//   INV-R5 — every classifier error path returns "keep" (bias toward
//            data preservation; the dir lives one more cycle and will
//            be re-evaluated next hour).
//   INV-R6 — dry-run mode only logs; never renames or removes.
//
// All public types are exported so test/workspace-reaper.test.ts can
// drive the cycle with mock KV / mock fs without standing up NATS.

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { type KV } from "nats";
import pino from "pino";

const logger = pino({ name: "workspace-reaper" });

// Strict regex guards. Anything not matching is silently skipped —
// reaper must NEVER follow a path with shell metachars, even though
// it does not invoke a shell. These also bound the readdir loop to
// the directories produced by the main workspace_sync path.
const USER_HEX = /^[0-9a-f]{32}$/;
const SID_RE = /^[0-9a-f-]{32,40}$/;

export interface ReaperOpts {
  /** NATS KV bucket holding `lock.<gateKey>` (BRAIN_REGISTRY). */
  kv: KV;
  /** NATS KV bucket holding `task-ckpt.<sid>.<messageId>` (BRAIN_CHECKPOINTS). */
  kvCkpt: KV;
  /** Configured shared-filesystem root. */
  base: string;
  /** Minimum age in days before a candidate becomes deletable. */
  retentionDays: number;
  /** Extra minutes beyond retentionDays during which a dir is kept
   *  even after KV ckpt disappears, to absorb transient NATS outages
   *  that would otherwise lose a recoverable session. */
  kvGraceMin: number;
  /** How long trashed entries live under .claw/.trash before rm -rf. */
  trashGraceHours: number;
  /** Hard cap on the number of trash operations per cycle so a sudden
   *  spike (e.g. cluster-wide GC of millions of sids) cannot blow the
   *  reaper's 30 min activeDeadlineSeconds. */
  maxDeletePerRun: number;
  /** When true, classifier still runs and would-trash decisions are
   *  logged but no fs.rename / fs.rm is invoked. Required for the
   *  first-week rollout window per workspace-reaper-design.md §10. */
  dryRun: boolean;
  /** Asks the API who still needs these files. Absent means the classifier
   *  falls back to the evidence it can see for itself, which is what every
   *  deployment did before workspaces had rows. */
  owner?: OwnershipOracle;
}

/**
 * What the API knows about a workspace and this process cannot see.
 *
 * The reaper has always decided from a directory's mtime plus the absence of a
 * checkpoint and a lock -- circumstantial evidence about user data, which is
 * why it is tuned to keep almost everything and why disks fill up instead. A
 * reference list and a retention deadline are the direct answer, and they
 * correct the classifier in both directions: a session that is alive but idle
 * keeps its files however old they look, and files nothing has referenced
 * since their lease ran out go without waiting for mtime to agree.
 */
export interface OwnershipOracle {
  /**
   * @returns the workspace's references and retention deadline, `"unknown"`
   *          when the API has no row for this session (which is every session
   *          predating workspace rows), or `"error"` when it could not be
   *          reached -- the two must not be conflated, since one means "decide
   *          for yourself" and the other means "do not decide at all".
   */
  lookup(sessionId: string): Promise<WorkspaceOwnership | "unknown" | "error">;
}

export interface WorkspaceOwnership {
  workspaceId: string;
  /** Sessions and runs still using it. Non-empty means keep, whatever the age. */
  refs: Array<{ kind: string; id: string }>;
  /** When the files may be collected once nothing references them. */
  retentionExpiresAt: string | null;
}

export interface ReapStats {
  scanned: number;
  kept: number;
  trashed: number;
  trashRemoved: number;
  errors: number;
  durationMs: number;
}

export interface ReapDecision {
  action: "keep" | "trash";
  reason: string;
}

/**
 * The oracle backed by the API's internal workspace endpoint.
 *
 * Every answer other than a workspace it knows about is reported as such: a
 * 404 is "no row for this session", which the classifier treats as permission
 * to decide for itself, and anything else -- unreachable, unauthorised, a
 * malformed body -- is an error, which stops it from deciding at all. Getting
 * that distinction wrong in the permissive direction would delete the files of
 * every session that predates workspace rows on the first cycle after an
 * outage.
 */
export function httpOwnershipOracle(baseUrl: string, token: string): OwnershipOracle {
  return {
    async lookup(sessionId: string) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const resp = await fetch(
          `${baseUrl}/v1/internal/workspaces/by-session/${encodeURIComponent(sessionId)}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          },
        );
        if (resp.status === 404) return "unknown";
        if (!resp.ok) {
          logger.warn({ sessionId, status: resp.status }, "reaper.owner_lookup_rejected");
          return "error";
        }
        const body = await resp.json() as {
          workspace?: {
            workspace_id?: string;
            refs?: Array<{ kind: string; id: string }>;
            retention_expires_at?: string | null;
          };
        };
        const ws = body?.workspace;
        if (!ws?.workspace_id || !Array.isArray(ws.refs)) return "error";
        return {
          workspaceId: ws.workspace_id,
          refs: ws.refs,
          retentionExpiresAt: ws.retention_expires_at ?? null,
        };
      } catch (err) {
        logger.warn(
          { sessionId, err: (err as Error)?.message },
          "reaper.owner_lookup_failed",
        );
        return "error";
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export async function runOneReapCycle(opts: ReaperOpts): Promise<ReapStats> {
  const t0 = Date.now();
  const stats: ReapStats = {
    scanned: 0, kept: 0, trashed: 0, trashRemoved: 0, errors: 0, durationMs: 0,
  };

  let userDirs: Dirent[];
  try {
    userDirs = await fs.readdir(`${opts.base}/users`, { withFileTypes: true });
  } catch (err) {
    logger.error({ err, base: opts.base }, "reaper.readdir_users_failed");
    stats.errors++;
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  // ─ Phase 1: scan, classify, trash ─
  await phase1ScanAndTrash(opts, userDirs, stats);
  // ─ Phase 2: empty trash older than grace ─
  await phase2EmptyTrash(opts, userDirs, stats);

  stats.durationMs = Date.now() - t0;
  return stats;
}

async function phase1ScanAndTrash(
  opts: ReaperOpts,
  userDirs: Dirent[],
  stats: ReapStats,
): Promise<void> {
  for (const u of userDirs) {
    if (!u.isDirectory() || !USER_HEX.test(u.name)) continue;
    const wsDir = `${opts.base}/users/${u.name}/.claw/workspaces`;
    const sids = await fs.readdir(wsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const s of sids) {
      if (!s.isDirectory() || !SID_RE.test(s.name)) continue;
      stats.scanned++;
      // Per-run delete cap: stop trashing once we hit the limit. The
      // remaining candidates are counted as "kept" and will be
      // re-evaluated on the next cron tick. We don't `break` because
      // we still want stats.scanned to reflect the full inventory.
      if (stats.trashed >= opts.maxDeletePerRun) {
        stats.kept++;
        continue;
      }
      const decision = await classifyForReap(opts, u.name, s.name).catch((err) => {
        stats.errors++;
        logger.warn({ err, uid: u.name, sid: s.name }, "reaper.classify_failed");
        // INV-R5: bias keep on any classifier error.
        return { action: "keep", reason: "classify_error" } as ReapDecision;
      });
      if (decision.action === "keep") {
        stats.kept++;
        continue;
      }
      if (opts.dryRun) {
        logger.info(
          { uid: u.name, sid: s.name, reason: decision.reason },
          "reaper.dry_run_would_trash",
        );
        stats.kept++;
        continue;
      }
      try {
        await trashSessionDir(opts, u.name, s.name);
        stats.trashed++;
        logger.info(
          { uid: u.name, sid: s.name, reason: decision.reason },
          "reaper.trashed",
        );
      } catch (err) {
        stats.errors++;
        logger.warn({ err, uid: u.name, sid: s.name }, "reaper.trash_failed");
      }
    }
  }
}

async function phase2EmptyTrash(
  opts: ReaperOpts,
  userDirs: Dirent[],
  stats: ReapStats,
): Promise<void> {
  for (const u of userDirs) {
    if (!u.isDirectory() || !USER_HEX.test(u.name)) continue;
    const trashRoot = `${opts.base}/users/${u.name}/.claw/.trash`;
    const items = await fs.readdir(trashRoot, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const item of items) {
      // Trashed entries are named "<sid>-<unixMillisec>"; pull the
      // trailing timestamp out so we can compare against grace.
      const m = item.name.match(/-(\d+)$/);
      if (!m) continue;
      const ts = Number(m[1]);
      const ageMs = Date.now() - ts;
      if (ageMs < opts.trashGraceHours * 3600 * 1000) continue;
      const target = `${trashRoot}/${item.name}`;
      if (opts.dryRun) {
        logger.info({ target, ageMs }, "reaper.dry_run_would_rm");
        continue;
      }
      try {
        await fs.rm(target, { recursive: true, force: true });
        stats.trashRemoved++;
        logger.info({ target, ageMs }, "reaper.rm_done");
      } catch (err) {
        stats.errors++;
        logger.warn({ err, target }, "reaper.rm_failed");
      }
    }
  }
}

/**
 * Does any run in this session still have a checkpoint?
 *
 * `*` matches exactly one subject token, which is what we want: it spans every
 * message id under the session without reaching into anything else. Rejections
 * propagate so the caller can apply INV-R5 and keep.
 */
async function anyCheckpointForSession(kvCkpt: KV, sid: string): Promise<boolean> {
  const iter = await kvCkpt.keys(`task-ckpt.${sid}.*`);
  for await (const _key of iter) return true;
  return false;
}

/**
 * Apply INV-R1 (KV ckpt absent ∧ KV lock absent ∧ mtime past retention
 * + KV grace). Returns "keep" on every error path per INV-R5.
 *
 * Exported for unit tests; production callers should go through
 * runOneReapCycle.
 */
export async function classifyForReap(
  opts: ReaperOpts,
  uid: string,
  sid: string,
): Promise<ReapDecision> {
  const dir = `${opts.base}/users/${uid}/.claw/workspaces/${sid}`;
  const st = await fs.stat(dir).catch(() => null);
  if (!st) return { action: "keep", reason: "stat_missing" };
  const ageMs = Date.now() - st.mtimeMs;

  // INV-R1.a: KV ckpt present → session is alive (or recently was), keep.
  // Checkpoints are keyed per run (`task-ckpt.<sid>.<messageId>`, see
  // task-runner checkpointKey), so a session is alive when *any* of its runs
  // has one — hence a prefix scan rather than a point lookup on the session id,
  // which would now never match and would reap live sessions' workspaces.
  const ckpt = await anyCheckpointForSession(opts.kvCkpt, sid).catch((err) => {
    logger.warn({ err, uid, sid }, "reaper.kv_ckpt_get_failed");
    return "kv_error" as const;
  });
  if (ckpt === "kv_error") return { action: "keep", reason: "kv_error" };
  if (ckpt) return { action: "keep", reason: "ckpt_alive" };

  // INV-R1.d: ask who still needs these files, when anyone can answer.
  //
  // This outranks mtime in both directions, because it is knowledge rather
  // than inference. A live session that has been idle for a fortnight keeps
  // its files; files whose retention lease ran out go now, without waiting for
  // an mtime that a stray touch could have reset. An unreachable API decides
  // nothing: the directory lives another cycle, same as any other error here.
  //
  // Asked before the lock check because it is what names the lock. The gate key
  // is `ws.<workspaceId>` now, and the workspace id is random, so the only way
  // to know which lock covers this directory is to be told.
  const owned = opts.owner
    ? await opts.owner.lookup(sid).catch(() => "error" as const)
    : "unknown";
  if (owned === "error") return { action: "keep", reason: "owner_unreachable" };

  // INV-R1.b: KV lock present → another brain holds it, keep.
  //
  // Both keys are checked, because which one a run took is not this process's
  // decision to know: RUN_GATE_KEY may be set back to `session`, a message from
  // an API too old to bind workspaces falls back to the session key, and during
  // a rollout the two coexist. A lock the reaper fails to see is a directory it
  // deletes from under a running task, so the union is the only safe reading.
  const lockKeys = [`lock.${sid}`];
  if (owned !== "unknown") lockKeys.push(`lock.ws.${owned.workspaceId}`);
  for (const key of lockKeys) {
    const lock = await opts.kv.get(key).catch((err) => {
      logger.warn({ err, uid, sid, key }, "reaper.kv_lock_get_failed");
      return "kv_error";
    });
    if (lock === "kv_error") return { action: "keep", reason: "kv_error" };
    if (lock) return { action: "keep", reason: "lock_held" };
  }

  if (owned !== "unknown") {
    if (owned.refs.length > 0) return { action: "keep", reason: "referenced" };
    const until = owned.retentionExpiresAt
      ? Date.parse(owned.retentionExpiresAt) : Number.NaN;
    if (Number.isNaN(until)) {
      // Unreferenced with no lease: nothing has released the last reference
      // yet, so no deadline has been set. Fall through to the age rule.
    } else if (Date.now() < until) {
      return { action: "keep", reason: "retention_lease" };
    } else {
      return { action: "trash", reason: "retention_expired" };
    }
  }

  // INV-R1.c: mtime must be past retention + KV grace window.
  const retentionMs = opts.retentionDays * 24 * 3600 * 1000;
  const graceMs = opts.kvGraceMin * 60 * 1000;
  if (ageMs < retentionMs + graceMs) {
    return {
      action: "keep",
      reason: ageMs < retentionMs ? "too_young" : "kv_grace",
    };
  }
  return { action: "trash", reason: "expired" };
}

/**
 * Move <base>/users/<uid>/.claw/workspaces/<sid> →
 * <base>/users/<uid>/.claw/.trash/<sid>-<unixMillis>. Same-fs rename
 * means this is atomic; a crash between the mkdir and the rename
 * leaves no half-state because the destination didn't exist yet.
 *
 * Exported for unit tests.
 */
export async function trashSessionDir(
  opts: ReaperOpts,
  uid: string,
  sid: string,
): Promise<string> {
  const src = `${opts.base}/users/${uid}/.claw/workspaces/${sid}`;
  const trashRoot = `${opts.base}/users/${uid}/.claw/.trash`;
  await fs.mkdir(trashRoot, { recursive: true });
  const dst = `${trashRoot}/${sid}-${Date.now()}`;
  await fs.rename(src, dst);
  return dst;
}
