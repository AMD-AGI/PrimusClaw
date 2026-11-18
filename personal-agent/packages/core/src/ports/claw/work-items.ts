// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";
import type { ClawCredential } from "../../claw/credential.js";
import type { ReviewAskedOfOther, Decision, AskerView, WorkItem } from "../../claw/model.js";
import type { BoardState } from "../../protocol.js";

/** The assistant's work items, the board (`/v1/work-items/*`). */
export interface ClawWorkItemsPort {
  /** The caller's board, newest first; `state` narrows it (done: the last 7 days). */
  list(key: ClawCredential, state?: BoardState): Promise<WorkItem[]>;
  /** The reviews the caller asked of others, newest first ([] from a Claw without the route). */
  askedOfOthers(key: ClawCredential): Promise<ReviewAskedOfOther[]>;
  /** One of the caller's items as it is now. ClawError(404): not theirs, or gone. */
  get(key: ClawCredential, itemId: string): Promise<WorkItem>;
  /** What the asker of a review someone else runs may know of it now. */
  requesterView(key: ClawCredential, itemId: string): Promise<AskerView>;
  /** Accepts result `version` and only that one; a 409 comes back as a Decision with the item as it is now. */
  accept(key: ClawCredential, itemId: string, version: number): Promise<Decision>;
  /** Runs a task that failed or was stopped again. */
  retry(key: ClawCredential, itemId: string): Promise<Decision>;
  /** Stops the item and its worker. */
  stop(key: ClawCredential, itemId: string): Promise<Decision>;
  /** The item, and the pull requests its worker reported as its result (newest first, each once). */
  pulls(key: ClawCredential, itemId: string): Promise<{ item: WorkItem; pulls: string[] }>;
  /** The item watches `pull` on GitHub; `reply` needs the person's exchanged token. */
  watchPull(token: ClawCredential, itemId: string, pull: string, reply?: boolean): Promise<JsonObject>;
  /** The pull requests the item watches, and watched: each `{sub_id, pr, url, reply_allowed, state, ...}`. */
  watches(key: ClawCredential, itemId: string): Promise<JsonObject[]>;
  /** The item stops watching one pull request. */
  unwatchPull(key: ClawCredential, itemId: string, subId: string): Promise<JsonObject>;
}
