// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The end-of-turn workspace save, as the session's events tell it.
 *
 * A turn ends on the session (`exec_complete`) before Brain uploads `/workspace`
 * to the session's prefix, because that upload is bounded only by how many files
 * the turn left behind: tens of thousands for a cloned repository, which took up
 * to an hour. So for a while after a turn the session is idle and its files in
 * the object store are not yet the turn's. Brain says so with two events, one
 * when the save starts and one when it is over, whatever became of it; the API
 * reads the last of them to tell a file listing "still being saved" apart from
 * "not there".
 */
export const WORKSPACE_SAVE_EVENT = "workspaceSave";

/** How a save ended: every file up, some failed, nothing to save, or it could not be done. */
export type WorkspaceSaveOutcome = "synced" | "partial" | "empty" | "failed";

export type WorkspaceSaveEvent =
  | { type: typeof WORKSPACE_SAVE_EVENT; phase: "started"; message_id?: string }
  | { type: typeof WORKSPACE_SAVE_EVENT; phase: "finished"; outcome: WorkspaceSaveOutcome; message_id?: string };

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
