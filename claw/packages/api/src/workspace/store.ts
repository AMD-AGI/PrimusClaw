// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files a run works on, as a thing with an identity.
 *
 * A workspace has been a naming convention: files live under
 * `users/<u>/sessions/<sid>/` and that path is the whole record of them.
 * Several unrelated-looking problems are that absence. The collector decides
 * what to delete from directory mtime and the absence of a lock, which is
 * guesswork, so it deletes almost nothing and disks fill. Deleting a session
 * takes the files with it even if something else still needs them. Two runs on
 * one session write the same directory and neither knows.
 *
 * Four things hang off the identity, and each answers one of those:
 *
 *   - a reference list, so "is anything still using this?" is a query rather
 *     than an inference;
 *   - a retention lease, so files outlive the last reference by a stated
 *     period instead of disappearing with it or lingering forever;
 *   - a writer claim, so two runs writing one workspace is a fact that gets
 *     recorded rather than a silent race;
 *   - a version, so a writer can tell whether what it is about to overwrite is
 *     what it last wrote. Advanced when the claim is released by the run that
 *     holds it, which today means chat turns only: a DAG run takes the
 *     reference without the claim, so its release matches nothing and the
 *     version does not move for anything it wrote. See recordRunUse for why the
 *     claim is not taken there, and for why what it measures is not yet worth
 *     acting on.
 *
 * `storage_prefix` is deliberately the path already in use, so creating these
 * rows moves no files and changes no layout. This step only writes down what is
 * already true; nothing reads it to make decisions yet, which is what makes it
 * safe to compare against reality before anything depends on it.
 *
 * Every function here is best-effort in the same sense as tasks/chat-run.ts: a
 * bookkeeping row that nothing reads must never be the reason a conversation
 * fails. Failures are logged and swallowed, and a caller gets null.
 */
import pino from "pino";
import { PG_INT4_MAX } from "@claw/utils";
import { envInt, reportSettingProblem } from "../config.js";
import { db } from "../infra/db.js";
import { newWorkspaceId } from "../tasks/ids.js";
import { sessionWorkspacePrefix, workspaceOwnerId } from "./prefix.js";

const logger = pino({ name: "workspace-store" });

/**
 * How long files survive after nothing references them.
 *
 * The lease exists so that "nobody is using it" and "it can be deleted" are
 * different statements. A session deleted by accident, a run that finished
 * minutes ago and whose artifacts the user is still downloading -- both are
 * cases where the last reference is gone and the files are not garbage yet.
 * Seven days matches the collector's existing retention so the two agree.
 *
 * Read through envInt because a bad value here is silent: `Number(...)` turns a
 * typo into NaN, `$2::int` then rejects the statement, the catch below swallows
 * it, and the only trace is a warn -- with the effect that no retention lease is
 * ever set and nothing is ever collected.
 *
 * Exported because it is one half of every window built on top of it, and the
 * other halves have to be expressed against it rather than against the number
 * it happens to have today.
 *
 * Floored at a day because zero is not "keep nothing pending": it writes a lease
 * that has already expired, so the files become collectable in the same moment
 * the last reference is released and the two cases above -- the accidental
 * delete, the download still running -- lose the window this exists to give
 * them. A negative value backdates it further, to the same effect.
 */
export const RETENTION_DAYS = envInt("WORKSPACE_RETENTION_DAYS", 7, { min: 1 });

/**
 * How long a writer claim stays valid without being renewed or released.
 *
 * Floored for the mirror-image reason: a claim that expires as it is written is
 * a claim nothing holds, so the serialisation it provides is gone and two runs
 * write the same workspace at once -- the thing being claimed against.
 */
const WRITER_CLAIM_SEC = envInt("WORKSPACE_WRITER_CLAIM_SEC", 3600, { min: 1 });

/**
 * A run was refused because its files could not be named.
 *
 * A distinct type rather than a plain Error because the callers have to tell
 * this refusal apart from the other reasons a dispatch fails, and they must not
 * do it by matching on the message. The cause is almost always a database that
 * was briefly unavailable, which is worth another attempt; an unrenderable
 * template or a session that does not exist is not.
 */
export class WorkspaceBindingError extends Error {
  constructor(sessionId: string) {
    super(
      `cannot bind run to a workspace (session ${sessionId}); refusing to dispatch `
      + "a run that would not be serialised against others writing the same files",
    );
    this.name = "WorkspaceBindingError";
  }
}

/** Whether a dispatch failure was the workspace binding being refused. */
export function isWorkspaceBindingError(err: unknown): boolean {
  // Both checks, because `instanceof` is the precise one and the name survives
  // a module loaded twice -- which is what a test seam or a bundler produces,
  // and which would otherwise silently turn a retriable refusal into a
  // permanent failure.
  return err instanceof WorkspaceBindingError
    || (err instanceof Error && err.name === "WorkspaceBindingError");
}

/**
 * Insist that a run about to be dispatched knows which files it writes.
 *
 * The concurrency gate keys on the workspace id, so a run dispatched without
 * one is a run that will not be serialised against the others writing the
 * same directory. That failure is silent and destructive: the runs overlap,
 * each restores the directory when its sandbox opens, and the last one to
 * sync deletes whatever the others created. Refusing to dispatch turns it
 * into an error the sender can see and retry.
 *
 * A throw rather than a returned null, because both callers are in the middle
 * of building a message and the only correct response is to abandon it -- and
 * because the two of them producing different wording for the same refusal is
 * how one of them ends up looking like a different problem.
 *
 * Called before anything is persisted, wherever the caller has that choice. A
 * refusal has to leave nothing behind: the chat path used to persist the user's
 * message first, so a turn refused here still appeared in the conversation --
 * sent by the user, answered by nobody, and handed to the model as history on
 * the next turn.
 */
export function requireWorkspaceBinding(
  workspaceId: string | null | undefined,
  ctx: { sessionId: string; runId?: string },
): string {
  if (workspaceId) return workspaceId;
  logger.error({ sessionId: ctx.sessionId, runId: ctx.runId }, "workspace.bind_failed");
  throw new WorkspaceBindingError(ctx.sessionId);
}

export type WorkspaceRefKind = "session" | "run";

export interface WorkspaceRow {
  workspace_id: string;
  owner_user_id: string;
  storage_prefix: string;
  version: string;
  writer_run_id: string | null;
  retention_expires_at: string | null;
  deleted_at: string | null;
}

export interface WorkspaceState {
  workspace_id: string;
  storage_prefix: string;
  /** Live references, by kind. Zero means nothing needs these files now. */
  refs: Array<{ kind: string; id: string }>;
  retention_expires_at: string | null;
  version: string;
  deleted_at: string | null;
}

/**
 * The workspace a session's files belong to, creating the row if this is the
 * first time anyone has asked.
 *
 * Idempotent under concurrency: two requests for the same session race to
 * insert the reference, one live reference per (kind, id) lets exactly one win,
 * and the loser reads the winner's row. The orphaned workspace row the loser
 * created is left behind unreferenced, which the retention sweep collects --
 * cheaper than a transaction on a path that runs on every message.
 *
 * The primary key is not what decides that, which is the part worth stating
 * because it reads as though it were: each caller mints its own workspace id
 * before inserting, so two rows for one session differ in `workspace_id` and
 * the primary key sees no conflict at all. Both callers won, `workspaceForSession`
 * then picked one arbitrarily, and a session with two workspaces is a session
 * whose runs take two gate keys and overwrite each other. What makes this
 * idempotent is `uq_workspace_refs_live_ref` in db.ts -- hence the untargeted
 * `ON CONFLICT`, which has to catch that index rather than the primary key.
 */
export async function ensureSessionWorkspace(
  sessionId: string,
  userId: string,
): Promise<WorkspaceRow | null> {
  try {
    const existing = await workspaceForSession(sessionId);
    if (existing) return existing;

    // A session whose reference was released still has files, under the same
    // prefix, and they are the files this message is about. Minting a second
    // workspace for them would give one directory two gate keys -- the overlap
    // the gate exists to prevent -- so the dormant row is re-adopted instead,
    // which also clears the retention lease that was counting it down.
    const dormant = await workspaceForSession(sessionId, { includeReleased: true });
    if (dormant) {
      await acquireRef(dormant.workspace_id, "session", sessionId);
      return (await workspaceForSession(sessionId)) ?? dormant;
    }

    const workspaceId = newWorkspaceId();
    await db.query(
      `INSERT INTO claw_workspaces (workspace_id, owner_user_id, storage_prefix)
       VALUES ($1, $2, $3)`,
      [workspaceId, workspaceOwnerId(userId), sessionWorkspacePrefix(userId, sessionId)],
    );
    const claimed = await db.query(
      `INSERT INTO claw_workspace_refs (workspace_id, ref_kind, ref_id)
       VALUES ($1, 'session', $2)
       ON CONFLICT DO NOTHING`,
      [workspaceId, sessionId],
    );
    void claimed;
    // Re-read rather than trusting the insert: another request may have
    // created and referenced a workspace for this session in between.
    return (await workspaceForSession(sessionId)) ?? (await getWorkspace(workspaceId));
  } catch (err) {
    logger.warn({ err, sessionId }, "workspace.ensure_failed");
    return null;
  }
}

/**
 * The workspace a session references, or null.
 *
 * `includeReleased` widens the question from "what is this session using" to
 * "where do this session's files live", which are different once the reference
 * is let go. Two callers need the second question. A returning session has to
 * re-adopt its own directory rather than be handed a new workspace for it, and
 * the collector has to be told about a workspace precisely when nothing
 * references it any more -- asking the narrow question there meant the answer
 * was "no such workspace" exactly when the retention lease became the only thing
 * worth reading, so the lease was written and never once read.
 *
 * Live references win over released ones, and among released ones the most
 * recently taken, so a session that somehow accumulated two rows resolves to the
 * one in use rather than to an arbitrary row.
 */
export async function workspaceForSession(
  sessionId: string,
  opts: { includeReleased?: boolean } = {},
): Promise<WorkspaceRow | null> {
  const r = await db.query(
    `SELECT w.workspace_id, w.owner_user_id, w.storage_prefix, w.version::text AS version,
            w.writer_run_id, w.retention_expires_at, w.deleted_at
       FROM claw_workspace_refs r
       JOIN claw_workspaces w ON w.workspace_id = r.workspace_id
      WHERE r.ref_kind = 'session'
        AND r.ref_id = $1
        AND ($2::boolean OR r.released_at IS NULL)
        AND w.deleted_at IS NULL
      ORDER BY (r.released_at IS NULL) DESC, r.created_at DESC
      LIMIT 1`,
    [sessionId, !!opts.includeReleased],
  );
  return (r.rows[0] as WorkspaceRow | undefined) ?? null;
}

async function getWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
  const r = await db.query(
    `SELECT workspace_id, owner_user_id, storage_prefix, version::text AS version,
            writer_run_id, retention_expires_at, deleted_at
       FROM claw_workspaces WHERE workspace_id = $1`,
    [workspaceId],
  );
  return (r.rows[0] as WorkspaceRow | undefined) ?? null;
}

/**
 * Record that something is using this workspace.
 *
 * Taking a reference clears any retention lease: a workspace being used is not
 * counting down to collection, and leaving the lease set would let it expire
 * under a live run.
 *
 * Re-taking a reference this workspace already released is the case the
 * `DO UPDATE` handles. Taking one that is live on a *different* workspace
 * violates `uq_workspace_refs_live_ref` instead, which this conflict target
 * cannot absorb, so it raises and is logged: one run or session belongs to one
 * workspace, and quietly moving the reference would be the split that index
 * exists to prevent.
 */
export async function acquireRef(
  workspaceId: string,
  kind: WorkspaceRefKind,
  refId: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO claw_workspace_refs (workspace_id, ref_kind, ref_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, ref_kind, ref_id)
       DO UPDATE SET released_at = NULL, created_at = NOW()`,
      [workspaceId, kind, refId],
    );
    await db.query(
      `UPDATE claw_workspaces SET retention_expires_at = NULL, updated_at = NOW()
        WHERE workspace_id = $1`,
      [workspaceId],
    );
  } catch (err) {
    logger.warn({ err, workspaceId, kind, refId }, "workspace.ref_acquire_failed");
  }
}

/**
 * What became of a reference somebody asked to release.
 *
 * Three answers rather than two, because "there was nothing holding it" and
 * "it could not be let go" are the same silence from the caller's side and only
 * one of them needs an operator. The caller that acts on the difference is a
 * session delete: after it, a session is never dispatched to again and so never
 * releases anything again, and a live reference is the strongest keep signal
 * the collector has.
 */
export type RefRelease = "released" | "none_held" | "failed";

/**
 * Release a reference, and start the retention lease if it was the last one.
 *
 * The lease is only set when nothing is left, and is computed here rather than
 * by the collector so the deadline is visible on the row: an operator asking
 * "when do these files go?" gets a timestamp instead of having to reconstruct
 * the collector's arithmetic.
 *
 * `retentionDays` is how long that lease runs, and the session delete is the one
 * caller that passes zero. The lease exists so that "nobody is using it" and "it
 * can be deleted" are different statements, and for a session the user asked to
 * delete they are the same one -- the S3 copy is deleted outright by the same
 * cleanup, so a week's lease on the shared-filesystem copy only made the two
 * disagree. A lease already in the past is what the collector needs to move the
 * directory into its trash on the next pass, and the day it holds it there is
 * the window for second thoughts.
 *
 * A lease that is already set may be shortened by this and never extended, which
 * is what lets the delete's zero reach a workspace the idle sweep released a day
 * ago. It does not make a lease unmovable in general: a workspace that is adopted
 * again has its lease cleared outright by `acquireRef`, deliberately, since files
 * in use should not be counting down. What the clause rules out is a second
 * release over a workspace nobody has touched since, which is the case the delete
 * has to win.
 *
 * Still logged and still swallowed, for the callers that release in bulk and
 * can only carry on. What they ignore, one caller reads.
 *
 * @returns which of the three things happened, decided by the row count rather
 *          than by the statement having run: an UPDATE that matched nothing is
 *          a reference the idle sweep has already released, and reporting that
 *          as a release makes the answer unable to distinguish the case the
 *          caller asks for it for.
 */
export async function releaseRef(
  workspaceId: string,
  kind: WorkspaceRefKind,
  refId: string,
  retentionDays: number = RETENTION_DAYS,
): Promise<RefRelease> {
  try {
    const released = await db.query(
      `UPDATE claw_workspace_refs SET released_at = NOW()
        WHERE workspace_id = $1 AND ref_kind = $2 AND ref_id = $3 AND released_at IS NULL`,
      [workspaceId, kind, refId],
    );
    await db.query(
      `UPDATE claw_workspaces w
          SET retention_expires_at = NOW() + ($2::int * INTERVAL '1 day'),
              updated_at = NOW()
        WHERE w.workspace_id = $1
          AND (w.retention_expires_at IS NULL
               OR w.retention_expires_at > NOW() + ($2::int * INTERVAL '1 day'))
          AND NOT EXISTS (
            SELECT 1 FROM claw_workspace_refs r
             WHERE r.workspace_id = w.workspace_id AND r.released_at IS NULL
          )`,
      [workspaceId, retentionDays],
    );
    return released.rowCount ? "released" : "none_held";
  } catch (err) {
    logger.warn({ err, workspaceId, kind, refId }, "workspace.ref_release_failed");
    return "failed";
  }
}

/**
 * Note that this run is using a session's workspace.
 *
 * The reference is what makes deleting the files a decision rather than a
 * guess: while a run holds one, the collector has an answer to "is anything
 * still using this?" that does not involve reading a directory's mtime.
 *
 * `bound` is the workspace the caller has already been given and refused
 * without; when it is present the lookup is skipped rather than repeated, so
 * this run's reference is recorded against the workspace its gate will use.
 *
 * Beside releaseRunUse rather than with either caller, because the two are one
 * pair: a reference taken and never released keeps the files forever, and both
 * the chat turn and the DAG node have to take the same one. The DAG node took
 * none at all for as long as this lived on the chat path, so the workspace a
 * DAG run was writing could be released and collected under it.
 */
export async function takeRunRef(
  sessionId: string,
  userId: string,
  taskId: string,
  bound?: string,
): Promise<string | undefined> {
  const workspaceId = bound
    ?? (await ensureSessionWorkspace(sessionId, userId))?.workspace_id;
  if (!workspaceId) return undefined;
  await acquireRef(workspaceId, "run", taskId);
  return workspaceId;
}

/**
 * Take the reference, and claim the write side with it.
 *
 * The claim is observational: two runs writing one workspace is a real race
 * with a real symptom -- artifacts that vanish because the other run's rsync
 * won -- and the point of this step was to find out how often it happens. A run
 * that cannot get it proceeds anyway and says so in the log.
 *
 * As it stands it measures very little, and saying so is worth more than the
 * appearance of coverage. Only this path claims: the DAG dispatcher takes the
 * reference alone, because claiming there would measure dispatch batches -- the
 * scheduler sends siblings at once, so the first claims and every other reports
 * contention over runs the gate then serialises perfectly. That leaves one
 * claimant, and `agent_status` allows a session one chat turn at a time, so on
 * the ordinary path two claims never overlap.
 *
 * "Ordinary" is doing work in that sentence, and `workspace.writer_contended`
 * is not unreachable. Two ways in, both of them a second run row for one turn:
 *
 *   - a replayed queued message. The drain publishes before it deletes the
 *     queue row and marks the session running, so a failure in between brings
 *     the handler back with the row still there and opens a second run for the
 *     same message (see queuedMessageId in tasks/chat-run.ts). The stream drops
 *     the duplicate task, but the claim was already taken -- and the first
 *     run's claim does not expire for WORKSPACE_WRITER_CLAIM_SEC;
 *   - a turn dispatched while the previous one is still being drained. The
 *     completion handler sets `agent_status` to idle or failed before
 *     dispatchPendingMessage sets it back to running, and a `POST /messages`
 *     arriving in that window sees a session that is not running and dispatches
 *     immediately.
 *
 * Both are rarer than the contention this was built to look for, so an absence
 * of warnings is still not evidence of an absence of contention. The claim is
 * kept because it is what the version hangs off (see releaseWriter) and because
 * what it would measure becomes ordinary the moment a second claimant exists.
 */
export async function recordRunUse(
  sessionId: string,
  userId: string,
  taskId: string,
  bound?: string,
): Promise<string | undefined> {
  const workspaceId = await takeRunRef(sessionId, userId, taskId, bound);
  if (!workspaceId) return undefined;
  const claim = await claimWriter(workspaceId, taskId);
  if (claim && !claim.held) {
    logger.warn(
      { sessionId, taskId, workspaceId, heldBy: claim.heldBy },
      "workspace.writer_contended",
    );
  }
  return workspaceId;
}

/**
 * Let go of everything a finished run held: its reference, and the write side.
 *
 * Looked up by the reference rather than passed in, because the completion
 * path knows the run and the session and has no reason to be carrying a
 * workspace id around as well.
 */
export async function releaseRunUse(taskId: string, changed = true): Promise<void> {
  try {
    const r = await db.query(
      `SELECT workspace_id FROM claw_workspace_refs
        WHERE ref_kind = 'run' AND ref_id = $1 AND released_at IS NULL`,
      [taskId],
    );
    const workspaceId = (r.rows[0] as { workspace_id?: string } | undefined)?.workspace_id;
    if (!workspaceId) return;
    await releaseWriter(workspaceId, taskId, changed);
    await releaseRef(workspaceId, "run", taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "workspace.run_release_failed");
  }
}

/**
 * Release the references left behind by runs that ended without releasing them.
 *
 * A run lets go of its workspace when the completion path closes its row. That
 * is not the only path that closes one: the sweeper closes rows too, and it
 * cannot do this itself -- reaping a lost lease runs long after the worker is
 * gone, and closing the row is deliberately its whole job. So the reference
 * outlives the run, and a reference is not a small thing to leave behind. The
 * retention lease only starts once the last one is released, and a live
 * reference outranks every other signal the collector has, on purpose. One
 * abandoned reference is a workspace that is never collected again -- files
 * that would have aged out on their own before anything referenced them.
 *
 * Reconciling here rather than at each closer is what keeps that true for the
 * next closer somebody writes. Idempotent, and cheap enough to want no leader:
 * releaseRunUse only acts on a reference that is still held.
 */
export async function releaseRefsOfFinishedRuns(limit = 200): Promise<number> {
  try {
    const r = await db.query(
      `SELECT r.ref_id
         FROM claw_workspace_refs r
         JOIN claw_tasks t ON t.task_id = r.ref_id
        WHERE r.ref_kind = 'run'
          AND r.released_at IS NULL
          AND t.status IN ('completed','failed','cancelled')
        LIMIT $1`,
      [limit],
    );
    for (const row of r.rows as Array<{ ref_id: string }>) {
      // Counted as a change: a run that was cut short may have written half of
      // what it meant to, and a version a later writer compares against is
      // safer too high than too low.
      await releaseRunUse(row.ref_id);
    }
    if (r.rowCount) logger.info({ released: r.rowCount }, "workspace.refs_reconciled");
    return r.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "workspace.refs_reconcile_failed");
    return 0;
  }
}

/**
 * How long a deleted session's leaked reference may sit before it is reclaimed.
 *
 * The teardown releases a deleted session's reference; one that is still held
 * means that step did not land, and nothing else can put it right, because a
 * deleted session is never dispatched to again and so never releases anything
 * again. The workspace then keeps a live reference forever, which outranks
 * every other signal the collector has -- so the files of deleted sessions are
 * the ones that are never collected.
 *
 * On by default and with a short window, because there is nothing here to lose:
 * the teardown deleted the objects before it tried the release, so what this
 * reclaims is bookkeeping about files that are already gone. The day is margin
 * for a teardown still running rather than a period anyone is waiting out.
 *
 * Measured from `claw_sessions.updated_at`, which the soft delete stamps on its
 * way out (see sessions/teardown.ts), so the window runs from the delete. Zero,
 * or anything else not positive, switches it off, as it does for every other
 * window here.
 */
const DELETED_RELEASE_DAYS = envInt("WORKSPACE_DELETED_RELEASE_DAYS", 1);

/**
 * How long a session that still exists may sit untouched before it stops
 * holding its files.
 *
 * A session idle this long lets go of its workspace, the retention lease starts
 * counting from then, and the files go some days after that. Coming back
 * re-adopts the same workspace (see ensureSessionWorkspace), so the cost of
 * returning inside the lease is nothing; after it, the sandbox rehydrates from
 * the S3 copy instead. Zero, or anything else not positive, switches it off.
 *
 * Off by default, and deliberately unlike the deleted-session sweep above. This
 * one ends with the files of a session the user still has being deleted, so the
 * first deployment to upgrade must not start doing that on a number nobody
 * chose. An operator opts in.
 */
const IDLE_RELEASE_DAYS = envInt("WORKSPACE_IDLE_RELEASE_DAYS", 0);

/**
 * The shortest live-session window that is a choice rather than an accident.
 *
 * The three windows are serial: the release starts RETENTION_DAYS, and after
 * that a trashed workspace waits out the collector's trash grace, so the time a
 * user can be away before their files really go is idle + retention + grace. No
 * idle value "clears" the other two -- what it decides is the total. What a
 * short one does decide is how much of that total is theirs, and a window
 * shorter than the lease it starts hands most of it to the lease: at one day,
 * the files of a session the operator meant to release quickly still go seven
 * days later, and the number they set accounts for an eighth of the wait.
 * Twice the lease is not the smallest window that leads -- one day more than
 * the lease already does -- but the smallest at which the operator's number
 * plainly dominates the total rather than merely edging past the terms it is
 * added to.
 *
 * Written against RETENTION_DAYS rather than as a number so that raising the
 * lease cannot silently invert the two. Clamped to what Postgres will take,
 * because it reaches the sweep's scan as `$1::int`, and a lease configured near
 * the ceiling would otherwise double into a statement that throws every tick --
 * the one bound `envInt` applies to every value read directly and this one
 * derives its way around.
 *
 * A configured window below this is raised to it, erring towards keeping files.
 * That is reported at startup, next to every other setting that was refused,
 * because the alternative is an operator who set three days having no way to
 * learn the effective window is fourteen: the sweep only logs when it finds
 * rows, so on a deployment with nothing to release it says nothing at all.
 */
export const MIN_IDLE_RELEASE_DAYS = Math.min(2 * RETENTION_DAYS, PG_INT4_MAX);

if (IDLE_RELEASE_DAYS > 0 && IDLE_RELEASE_DAYS < MIN_IDLE_RELEASE_DAYS) {
  reportSettingProblem(
    `WORKSPACE_IDLE_RELEASE_DAYS=${IDLE_RELEASE_DAYS} is below the floor of `
    + `${MIN_IDLE_RELEASE_DAYS} days (twice WORKSPACE_RETENTION_DAYS); `
    + `using ${MIN_IDLE_RELEASE_DAYS}`,
  );
}

/**
 * Let the references of deleted sessions go, so their files can be collected.
 *
 * Separate from the live-session sweep below rather than one query over both,
 * because the two do different things to a user. This one reclaims bookkeeping
 * for objects the teardown already deleted; the other one starts the countdown
 * that deletes the files of a session that still exists. They cannot share a
 * switch, and neither can be read off the other's log line.
 *
 * No retention lease, for the same reason the delete path sets none: these are
 * sessions the user asked to delete, so the window the lease gives is a window
 * they did not ask for. Reaching this at all means the delete's own release did
 * not land, and writing a week's lease here would leave the two paths disagreeing
 * about the same directory by exactly that week.
 */
export async function releaseRefsOfDeletedSessions(
  days = DELETED_RELEASE_DAYS,
  limit = 200,
): Promise<number> {
  return releaseDormantSessionRefs({
    idleDays: days,
    deleted: true,
    retentionDays: 0,
    event: "workspace.deleted_sessions_released",
    limit,
  });
}

/**
 * Let dormant sessions that still exist stop holding their files, when so
 * configured.
 *
 * Deliberately based on the session's own activity rather than on the directory:
 * the collector already looks at mtime, and the reason it collects almost
 * nothing is that mtime cannot tell a session nobody will return to from one
 * paused mid-task. The session row can, and this converts that into the one
 * signal the collector treats as knowledge.
 *
 * A session with a run still in flight is unaffected without needing a check for
 * it: that run holds a reference of its own, so releasing the session's leaves
 * the workspace referenced and starts no lease.
 *
 * A window below MIN_IDLE_RELEASE_DAYS is raised to it, which the configured
 * value has already been reported for at startup.
 */
export async function releaseRefsOfIdleSessions(
  idleDays = IDLE_RELEASE_DAYS,
  limit = 200,
): Promise<number> {
  if (!Number.isFinite(idleDays) || idleDays <= 0) return 0;
  return releaseDormantSessionRefs({
    idleDays: Math.max(idleDays, MIN_IDLE_RELEASE_DAYS),
    deleted: false,
    event: "workspace.idle_sessions_released",
    limit,
  });
}

/**
 * The scan both sweeps run, over the population each of them owns.
 *
 * `deleted` is a filter rather than an option to leave out: a query written for
 * one of them and run for both is how releasing a reference the teardown lost
 * and deleting a live user's files became the same switch.
 */
async function releaseDormantSessionRefs(opts: {
  idleDays: number;
  deleted: boolean;
  retentionDays?: number;
  event: string;
  limit: number;
}): Promise<number> {
  const { idleDays, deleted, retentionDays, event, limit } = opts;
  if (!Number.isFinite(idleDays) || idleDays <= 0) return 0;
  try {
    const r = await db.query(
      `SELECT r.workspace_id, r.ref_id
         FROM claw_workspace_refs r
         JOIN claw_sessions s ON s.session_id = r.ref_id
        WHERE r.ref_kind = 'session'
          AND r.released_at IS NULL
          AND (s.deleted_at IS NOT NULL) = $3
          AND s.updated_at < NOW() - ($1::int * INTERVAL '1 day')
        LIMIT $2`,
      [Math.floor(idleDays), limit, deleted],
    );
    for (const row of r.rows as Array<{ workspace_id: string; ref_id: string }>) {
      await releaseRef(row.workspace_id, "session", row.ref_id, retentionDays);
    }
    if (r.rowCount) logger.info({ released: r.rowCount, idleDays }, event);
    return r.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err, idleDays, deleted }, "workspace.dormant_release_failed");
    return 0;
  }
}

/**
 * Release the reference a session holds on its workspace, e.g. when the session
 * is deleted.
 *
 * Every reference this session is the reason for: its own, and those of its runs
 * on the same workspace. Ordinarily a run's reference is the run's own business
 * -- released when it ends, reconciled by `releaseRefsOfFinishedRuns` when its
 * row was closed elsewhere -- and leaving it alone here is the correct answer,
 * because a run still in flight is still using the files.
 *
 * A deleted session is the case where it is not. Deleting one cancels its open
 * runs without touching their references, so the session's release lands while a
 * run reference is still live and writes no lease at all; then the reconcile
 * sweep releases that one with its own default, and the deliberate delete's
 * files get the seven-day lease the S3 copy was already deleted without. Since
 * this is the caller that passes zero, releasing them together is what makes the
 * zero mean anything -- and it leaves nothing for the reconcile sweep to release,
 * so nothing writes a lease over it afterwards.
 *
 * Reports rather than raises, like everything else here, but reports enough to
 * be acted on: the lookup failing and the workspace not existing used to be one
 * answer, and the release failing was no answer at all -- `releaseRef` logs a
 * warn and returns -- so the delete that depends on this step could only ever
 * report itself complete.
 *
 * `retentionDays` is passed through for the one caller that has a reason to
 * override it; see releaseRef for why a session delete passes zero.
 */
export async function releaseSessionRefs(
  sessionId: string,
  opts: { retentionDays?: number } = {},
): Promise<RefRelease> {
  let ws: WorkspaceRow | null;
  try {
    ws = await workspaceForSession(sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, "workspace.session_refs_lookup_failed");
    return "failed";
  }
  if (!ws) return "none_held";
  try {
    await db.query(
      `UPDATE claw_workspace_refs r SET released_at = NOW()
        WHERE r.workspace_id = $1
          AND r.ref_kind = 'run'
          AND r.released_at IS NULL
          AND EXISTS (
            SELECT 1 FROM claw_tasks t
             WHERE t.task_id = r.ref_id AND t.session_id = $2
          )`,
      [ws.workspace_id, sessionId],
    );
  } catch (err) {
    // Reported, because the lease the next statement writes is the point and a
    // reference left live silently withholds it.
    logger.warn({ err, sessionId }, "workspace.session_run_refs_release_failed");
    return "failed";
  }
  return releaseRef(ws.workspace_id, "session", sessionId, opts.retentionDays);
}

export interface WriterClaim {
  /** True when this run now holds the write side of the workspace. */
  held: boolean;
  /** Who holds it, when someone else does. */
  heldBy?: string;
  version: string;
}

/**
 * Claim the right to write this workspace.
 *
 * Two runs writing one workspace is the race behind lost artifacts, and today
 * it happens silently -- both rsync into the same directory and the last one
 * wins whatever it happened to have. The claim makes it observable: a run that
 * cannot get it is told who has it, and the caller decides what to do about it.
 * Nothing refuses to run on a failed claim.
 *
 * With one claimant it observes little: the loser branch below is reached only
 * when one session has two runs open at once, which takes a replayed message
 * dispatched twice or a turn accepted during the drain -- see recordRunUse for
 * both. What it does on every path is name a holder for the version bump on
 * release.
 *
 * An expired claim is takeable, so a run whose worker died does not lock the
 * workspace for the rest of its retention.
 */
export async function claimWriter(
  workspaceId: string,
  runId: string,
): Promise<WriterClaim | null> {
  try {
    const r = await db.query(
      `UPDATE claw_workspaces
          SET writer_run_id     = $2,
              writer_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
              updated_at        = NOW()
        WHERE workspace_id = $1
          AND (writer_run_id IS NULL
               OR writer_run_id = $2
               OR writer_expires_at IS NULL
               OR writer_expires_at < NOW())
        RETURNING version::text AS version`,
      [workspaceId, runId, WRITER_CLAIM_SEC],
    );
    if (r.rowCount) {
      return { held: true, version: String((r.rows[0] as { version: string }).version) };
    }
    const current = await getWorkspace(workspaceId);
    return {
      held: false,
      heldBy: current?.writer_run_id ?? undefined,
      version: current?.version ?? "0",
    };
  } catch (err) {
    logger.warn({ err, workspaceId, runId }, "workspace.writer_claim_failed");
    return null;
  }
}

/**
 * Release the write side and record that the contents changed.
 *
 * The version is what a later writer compares against to know whether the
 * workspace it is about to overwrite is the one it last saw. Bumped on release
 * rather than on every sync, because a sync that is still in progress has not
 * produced a state anyone should be comparing against.
 *
 * Only for the run that holds the claim, which a DAG run never does: it takes
 * the reference and no claim, so this matches no row for it and the version
 * does not move for what it wrote. A version that only chat turns advance is
 * not the whole record the module header describes, and nothing reads it yet;
 * the two are reconciled when something does.
 */
export async function releaseWriter(
  workspaceId: string,
  runId: string,
  changed: boolean,
): Promise<void> {
  try {
    await db.query(
      `UPDATE claw_workspaces
          SET writer_run_id     = NULL,
              writer_expires_at = NULL,
              version           = version + CASE WHEN $3 THEN 1 ELSE 0 END,
              updated_at        = NOW()
        WHERE workspace_id = $1 AND writer_run_id = $2`,
      [workspaceId, runId, changed],
    );
  } catch (err) {
    logger.warn({ err, workspaceId, runId }, "workspace.writer_release_failed");
  }
}

/**
 * Everything a collector needs to decide whether these files may go.
 *
 * Returned as facts rather than a verdict: the collector runs in Brain, has no
 * database, and has to combine this with what it can see on disk. Giving it the
 * evidence rather than the answer keeps the decision in the one place that can
 * also see the filesystem.
 *
 * The one function here that raises rather than swallowing. Everywhere else a
 * failure means "carry on without the bookkeeping", because a row nothing reads
 * must not break a conversation. Here the caller is a collector deciding what to
 * delete, and null means "no workspace has ever been recorded for this session"
 * -- permission to fall back to mtime. Reporting a failed read that way would
 * hand out that permission for every session at once during an outage, which is
 * a mass delete of files whose rows exist and say keep.
 */
export async function workspaceState(sessionId: string): Promise<WorkspaceState | null> {
  // Released references included on purpose: see workspaceForSession. The refs
  // below are still only the live ones, so an unreferenced workspace reports
  // itself as unreferenced-with-a-deadline rather than as absent.
  const ws = await workspaceForSession(sessionId, { includeReleased: true });
  if (!ws) return null;
  const refs = await db.query(
    `SELECT ref_kind, ref_id FROM claw_workspace_refs
      WHERE workspace_id = $1 AND released_at IS NULL`,
    [ws.workspace_id],
  );
  return {
    workspace_id: ws.workspace_id,
    storage_prefix: ws.storage_prefix,
    refs: (refs.rows as Array<{ ref_kind: string; ref_id: string }>)
      .map((r) => ({ kind: r.ref_kind, id: r.ref_id })),
    retention_expires_at: ws.retention_expires_at,
    version: ws.version,
    deleted_at: ws.deleted_at,
  };
}
