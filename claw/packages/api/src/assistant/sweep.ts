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
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { releaseHoldsOfEndedRuns } from "./holds.js";
import { followReviewItems, sweepReviewItems } from "./review-items.js";
import { reconcileOrphanedItems, reconcileWorkerRuns } from "./turn-end.js";
import { announceMissedDeliveries } from "./deliveries.js";
import { tellSilentItems } from "./silent-sweep.js";
import { surfaceStuckItems } from "./watchdog.js";

const logger = pino({ name: "assistant-sweep" });

export async function sweepAssistant(): Promise<void> {
  if (!CLAW_ASSISTANT_ENABLED) return;
  // In this order: a run recorded as ready here needs the user, and is then eligible for the announcement.
  // The two passes share no item: one with a run started under its current generation is the first's, one with
  // none is the second's.
  // First, a request whose run is over and was not seen to end: the item goes back to in progress, and its run's end is
  // then the next pass's to record.
  await releaseHoldsOfEndedRuns();
  await reconcileWorkerRuns();
  await reconcileOrphanedItems();
  // Review items report nothing: their state is read off the review's own tables, here as well as at each turn's end and answer.
  await sweepReviewItems();
  // And what became of their pull requests on GitHub: merged or closed there ends the item; a merge the requester asked for is made.
  await followReviewItems();
  // An item something is still open behind, with no sign of life past the watchdog's threshold (off by default): in
  // front of the user with the reason, before the announcement below looks for items that need them.
  await surfaceStuckItems();
  // The files of a report whose announcement did not get through (the store did not answer), before the announcement below.
  await announceMissedDeliveries().catch((err) => logger.warn({ err }, "assistant.missed_deliveries_sweep_failed"));
  await tellSilentItems();
}
