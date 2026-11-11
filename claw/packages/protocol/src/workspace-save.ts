// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The end-of-turn workspace save, as the session's events tell it.
 *
 * A turn ends on the session (`exec_complete`) before Brain uploads `/workspace`
 * to the session's prefix, because that upload is bounded only by how many files
 * the turn left behind: tens of thousands for a cloned repository, which took up
 * to an hour. So for a while after a turn the session is idle and its files in
 * the object store are not yet the turn's. The API tells a file listing "still
 * being saved" apart from "not there" from two facts on the session's events:
 *
 *   - the turn's own `exec_complete` carries `workspace_save: "pending"` and a
 *     `workspace_save_id` when a save follows it. On the completion itself, so it
 *     is stored before the session is set idle and no read can fall between the
 *     two;
 *   - a `workspaceSave` event with `phase: "finished"` and that id as `save_id`
 *     follows once the save is over, however it ended. The id is the save's, not
 *     the turn's: a redelivered turn keeps its `message_id`, and an earlier
 *     attempt's finish must not end the retry's save.
 */
export const WORKSPACE_SAVE_EVENT = "workspaceSave";

/** The `exec_complete` field, and its one value, that says a save follows. */
export const WORKSPACE_SAVE_PENDING_FIELD = "workspace_save";
export const WORKSPACE_SAVE_PENDING = "pending";
/** The `exec_complete` field naming the save that follows it. */
export const WORKSPACE_SAVE_ID_FIELD = "workspace_save_id";

/** How a save ended: every file up, some failed, nothing to save, or it could not be done. */
export type WorkspaceSaveOutcome = "synced" | "partial" | "empty" | "failed";

export interface WorkspaceSaveFinishedEvent {
  type: typeof WORKSPACE_SAVE_EVENT;
  phase: "finished";
  outcome: WorkspaceSaveOutcome;
  /** The completion's `workspace_save_id`. */
  save_id?: string;
  message_id?: string;
}

/**
 * How long a save that never said it finished is still taken to be running.
 *
 * A Brain killed mid-save sends no `finished`, and a listing must not read
 * "saving" for ever after. The run that is saving holds the workspace lock, and a
 * run queued behind that lock waits at most about 80 minutes before it gives up
 * (TASK_LOCK_NAK_* over TASK_MAX_DELIVER), so a save older than this is no longer
 * one anybody is waiting for.
 */
export const WORKSPACE_SAVE_STALE_MS = 2 * 60 * 60 * 1000;
