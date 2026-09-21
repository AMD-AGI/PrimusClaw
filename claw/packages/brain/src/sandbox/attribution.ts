// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a sandbox's ending belongs to.
 *
 * TWO DIFFERENT QUESTIONS live in this subsystem, and conflating them is what
 * this module exists to stop:
 *
 *   - MAY I USE IT / MAY I DESTROY IT. Answered at session or DAG-root grain,
 *     by `entryOwnedByAnother` and the DAG handle registry. Reuse across the
 *     tasks of a session is a FEATURE -- the next message takes the sandbox the
 *     last one left warm -- and nothing here narrows it. No field in this file
 *     is ever a precondition for reuse.
 *
 *   - WHOSE ENDING DOES ITS DEATH EXPLAIN. Answered at attempt grain, here.
 *     Asking it of session- or task-grained storage is what produced a string
 *     of defects: a chat turn reporting the previous message's preemption, a
 *     redelivery reporting its predecessor's exit code.
 *
 * THE FIELD MEANS "WHO HOLDS IT NOW", NOT "WHO MINTED IT". A container minted
 * by attempt A and then reused by task B is B's to report while B is using it:
 * if it dies under B, that death is B's ending. So the attribution is
 * re-stamped when a run takes the sandbox on, in the same write that takes it
 * on. Recording the minter instead would refuse B its own ending -- the exact
 * breakage that makes this worth spelling out.
 */

/** The run a sandbox's ending currently belongs to. */
export interface SandboxAttribution {
  /** The task holding it. Null for a request that carries no task id. */
  taskId: string | null;
  /**
   * The attempt holding it.
   *
   * A task id does not separate one delivery of a task from the next, and a
   * redelivery's predecessor can leave a record behind -- a SIGTERM
   * mid-provision is enough.
   */
  attemptId: string | null;
}

/** The attribution fields as they appear on a stored entry. */
export interface AttributedEntry {
  taskId?: string | null;
  attemptId?: string | null;
}

/**
 * Whether `entry` is the caller's to REPORT.
 *
 * Four answers rather than a boolean, because the callers differ on what to do
 * with two of them and a boolean forced each to decide for itself -- which is
 * how "the store could not say" ended up reading as "nobody owns it" in more
 * than one place on this branch.
 *
 *   - `mine`        the entry names this attempt
 *   - `other`       it names a different task or attempt
 *   - `unattributed` it names neither, so it predates the field: no caller can
 *                   show it is theirs, and none may claim it
 *   - `unasked`     the caller itself names no attempt, so it is making no
 *                   claim and this answers nothing
 *
 * Never consulted to decide whether a sandbox may be USED or STOPPED. See the
 * module docstring.
 */
export function attributionOf(
  entry: AttributedEntry,
  held: SandboxAttribution,
): "mine" | "other" | "unattributed" | "unasked" {
  if (!held.attemptId && !held.taskId) return "unasked";
  if (!entry.attemptId && !entry.taskId) return "unattributed";
  if (held.attemptId && entry.attemptId) {
    return entry.attemptId === held.attemptId ? "mine" : "other";
  }
  // One side names only a task. Falling back to it is weaker on purpose: it
  // cannot separate two attempts of one task, so it may only ever say `other`
  // with confidence, never `mine`.
  if (held.taskId && entry.taskId && entry.taskId !== held.taskId) return "other";
  return "unattributed";
}

/**
 * Whether a stored entry should be re-stamped as this run takes it on.
 *
 * A holder only stamps what it KNOWS. Writing its own absence over a value the
 * entry already carries is the defect this guards against: a take-over whose
 * attribution had a task but no attempt used to null out a real `attemptId`,
 * after which `attributionOf` answered `unattributed` for ever and the entry's
 * platform facts were unreachable by anyone. Absent is not a correction.
 *
 * Normalised on both sides, because `undefined` and `null` are the same
 * statement here -- "not recorded" -- and comparing them raw made every entry
 * written before these fields existed take one pointless CAS on first reuse.
 */
export function needsRestamp(entry: AttributedEntry, held: SandboxAttribution): boolean {
  if (!held.attemptId && !held.taskId) return false;
  const differs = (a?: string | null, b?: string | null) => (a ?? null) !== (b ?? null);
  // Only fields the holder can actually fill count as a difference.
  if (held.attemptId && differs(entry.attemptId, held.attemptId)) return true;
  if (held.taskId && differs(entry.taskId, held.taskId)) return true;
  return false;
}

/**
 * The attribution to write when `needsRestamp` says to.
 *
 * Fills in what the holder knows and leaves the rest as it found it, so a
 * partial identity never erases a complete one.
 */
export function stampFor(
  entry: AttributedEntry, held: SandboxAttribution,
): { taskId: string | null; attemptId: string | null } {
  return {
    taskId: held.taskId ?? entry.taskId ?? null,
    attemptId: held.attemptId ?? entry.attemptId ?? null,
  };
}
