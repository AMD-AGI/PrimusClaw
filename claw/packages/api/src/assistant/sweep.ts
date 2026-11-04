// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the sweeper does for the assistant on each tick: the things that must happen even if every
 * model, hook and message went wrong.
 *
 * The third guarantee, that an item's first message and a queued report are drained, is the sweeper's
 * existing orphan drain (`drainOrphanedPendingMessages`): everything the assistant queues is an ordinary
 * queued message on an ordinary session.
 */
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { sweepReviewItems } from "./review-items.js";
import { reconcileOrphanedItems, reconcileWorkerRuns } from "./turn-end.js";
import { tellSilentItems } from "./silent-sweep.js";
import { surfaceStuckItems } from "./watchdog.js";

export async function sweepAssistant(): Promise<void> {
  if (!CLAW_ASSISTANT_ENABLED) return;
  // In this order: a run recorded as ready here needs the user, and is then eligible for the announcement.
  // The two passes share no item: one with a run started under its current generation is the first's, one with
  // none is the second's.
  await reconcileWorkerRuns();
  await reconcileOrphanedItems();
  // Review items report nothing: their state is read off the review's own tables, here as well as at each turn's end and answer.
  await sweepReviewItems();
  // An item something is still open behind, with no sign of life past the watchdog's threshold (off by default): in
  // front of the user with the reason, before the announcement below looks for items that need them.
  await surfaceStuckItems();
  await tellSilentItems();
}
