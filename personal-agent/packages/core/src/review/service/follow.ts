// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review asked of someone else is theirs: their item, their session, their quota. Its asker follows only the item's asker
 * view, read as the asker, and hears what is news (a conclusion, a merge held for the reviewer, a failure, an end) where they
 * asked, one message for whatever of a request's reviews has news together. Each item is kept in the store until its end is
 * said, so a restart of the worker loses none of it.
 */

import { ClawError, errorKind } from "../../claw/errors.js";
import type { AskerView } from "../../claw/model.js";
import { errorName } from "../../errors.js";
import type { JsonObject } from "../../json.js";
import { type Conversation, type OutMessage, textMessage } from "../../ports/surface.js";
import { displayName } from "../names.js";
import {
  type Followed,
  entryStage,
  followedItemId,
  itemEndText,
  ITEM_STOPPED_ZH,
  progressText,
  reviewerEndedText,
  unfinishedText,
} from "../progress.js";
import { followRecord, reviewOfRecord, type ReviewTurn, viewFinished, viewWaitsForReviewer } from "../review-turn.js";
import { stored } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import { clawFailure, tokenFor } from "./identity.js";
import type { ItemCards } from "./item-cards.js";
import type { Notices } from "./notices.js";

/** How often the asker's view of a review someone else runs is read. */
export const REQUESTER_VIEW_MS = 30_000;
export const REQUESTER_VIEW_LIMIT_SECONDS = 24 * 3600;
/** News is held this long for more to join it, at most this long in all. */
export const VIEW_SETTLE_MS = 90_000;
export const VIEW_HOLD_MS = 600_000;
/** How often a last line is tried before it is left (to the next worker that starts). */
export const DEADLINE_TRIES = 10;

/** The item waits for its reviewer for something they have not been told of yet. */
function waitsNewly(entry: Followed, view: AskerView): boolean {
  return viewWaitsForReviewer(view) && view.waitingFor !== "failed" && !entry.reviewerTold;
}

function stillRunning(view: AskerView): boolean {
  return !viewFinished(view) && !viewWaitsForReviewer(view);
}

interface BatchState {
  readonly open: Map<string, Followed>;
  readonly news: Map<string, readonly [Followed, AskerView]>;
  first: number;
  last: number;
}

export class AskerFollow {
  /** item id -> the follow of its request. */
  private readonly viewing = new Map<string, Promise<void>>();
  /** Items the asker stopped from their card: their end is said there, not again. */
  private readonly stopped = new Set<string>();
  /** For tests: the interval between reads. */
  viewMs = REQUESTER_VIEW_MS;

  constructor(
    private readonly deps: ReviewDeps,
    private readonly cards: ItemCards,
    private readonly notices: Notices,
  ) {}

  following(itemId: string): boolean {
    return this.viewing.has(itemId);
  }

  /** Settles when every follow started so far has ended. */
  async idle(): Promise<void> {
    await Promise.all([...new Set(this.viewing.values())]);
  }

  /** The asker stopped the item from their card, where that is said: its end is not said a second time. */
  itemStopped(itemId: string): void {
    this.stopped.add(itemId);
  }

  /** Follows the reviews one request asked of someone else, together, for their asker. */
  follow(reviews: readonly ReviewTurn[], conversation: Conversation): void {
    const batch = reviews.filter((r) => r.item !== undefined);
    const [first] = batch;
    if (first?.item === undefined) return;
    const deadline = this.deps.store.now() + REQUESTER_VIEW_LIMIT_SECONDS;
    const batchId = first.item.itemId;
    const entries: Followed[] = [];
    for (const review of batch) {
      const itemId = review.item?.itemId ?? "";
      const wire = review.asked === undefined ? {} : this.deps.followWire(review.asked);
      this.deps.store.reviewDelegation.addAskerFollow({
        itemId,
        batchId,
        review: followRecord(review, wire),
        reference: conversation.ref.wire as JsonObject,
        deadline,
      });
      // (its receipt said it waits: what it is told next is that it started)
      const queued = Boolean(review.item?.queued);
      if (queued) this.deps.store.reviewDelegation.askerFollowSaid(itemId, "queued");
      entries.push({ review, said: queued ? "queued" : "", reviewerTold: false, resumed: false, seenQueued: false });
    }
    this.start(entries, conversation, deadline);
  }

  private start(entries: readonly Followed[], conversation: Conversation, deadline: number): void {
    const ids = entries.map(followedItemId);
    const task = this.watch(entries, conversation, deadline).finally(() => {
      for (const id of ids) this.viewing.delete(id);
    });
    for (const id of ids) this.viewing.set(id, task);
  }

  /** Every review that was followed when the last worker stopped is followed again, from what its asker was told last. */
  resume(): number {
    const batches = new Map<string, ReturnType<ReviewDeps["store"]["reviewDelegation"]["askerFollows"]>>();
    for (const row of this.deps.store.reviewDelegation.askerFollows()) {
      batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row]);
    }
    let count = 0;
    for (const rows of batches.values()) {
      const entries: Followed[] = [];
      let conversation: Conversation | undefined;
      for (const row of rows) {
        const review = reviewOfRecord(row.review);
        const where = stored(this.deps, row.reference);
        if (review === undefined || where === undefined) {
          this.deps.store.reviewDelegation.dropAskerFollow(row.itemId);
          continue;
        }
        conversation ??= where;
        entries.push({
          review,
          said: row.said,
          reviewerTold: row.reviewerTold,
          resumed: true,
          seenQueued: row.said === "queued",
        });
      }
      if (conversation !== undefined && entries.length) {
        this.start(entries, conversation, Math.min(...rows.map((r) => r.deadline)));
        count += entries.length;
      }
    }
    if (count) this.deps.logger.info("following reviews asked of someone else again for their askers", { count });
    return count;
  }

  /** Reads each open item's view every `viewMs`; news is held a little, then said in one message. */
  private async watch(entries: readonly Followed[], conversation: Conversation, deadline: number): Promise<void> {
    const state: BatchState = {
      open: new Map(entries.map((e) => [followedItemId(e), e])),
      news: new Map(),
      first: 0,
      last: 0,
    };
    let tries = 0;
    try {
      while (state.open.size || state.news.size) {
        if (!state.open.size) {
          // (all ended, and what they ended with could not be said yet: said again, a while longer)
          await this.deps.clock.sleep(this.viewMs);
          if (!(await this.tryFlush(entries, conversation, state))) tries += 1;
          if (tries >= DEADLINE_TRIES) return; // (kept in the store: said by the next worker that starts)
          continue;
        }
        if (this.deps.store.now() >= deadline) {
          if (await this.atDeadline(entries, conversation, state, ++tries)) return;
          continue;
        }
        await this.deps.clock.sleep(this.viewMs);
        try {
          await this.round(entries, conversation, state);
        } catch (err) {
          // (never the end of the follow: the items run in Claw all the same)
          this.deps.logger.warn("a round of following a request's reviews for their asker failed", {
            error: errorName(err),
          });
        }
      }
    } finally {
      for (const entry of entries) {
        this.stopped.delete(followedItemId(entry));
        // (not followed to its end here: a late press is answered by Claw)
        this.cards.forget(followedItemId(entry));
      }
    }
  }

  private async tryFlush(
    entries: readonly Followed[],
    conversation: Conversation,
    state: BatchState,
  ): Promise<boolean> {
    try {
      await this.flush(entries, conversation, state);
      return true;
    } catch (err) {
      this.deps.logger.warn("the end of a request's reviews could not be said to their asker", {
        error: errorName(err),
      });
      return false;
    }
  }

  /** The deadline: what is held is said, then that the rest is still open; the rows go once the asker has been told. */
  private async atDeadline(
    entries: readonly Followed[],
    conversation: Conversation,
    state: BatchState,
    tries: number,
  ): Promise<boolean> {
    const left = [...state.open.values()];
    try {
      if (state.news.size) await this.flush(entries, conversation, state);
      const [first] = left;
      if (first !== undefined) await this.sayToAsker(first.review, conversation, unfinishedText(left));
    } catch (err) {
      this.deps.logger.warn("the asker could not be told their reviews are still open", { error: errorName(err) });
      if (tries < DEADLINE_TRIES) {
        await this.deps.clock.sleep(this.viewMs);
        return false;
      }
    }
    for (const entry of left) this.deps.store.reviewDelegation.dropAskerFollow(followedItemId(entry));
    return true;
  }

  /** The asker's view of one item now; undefined when it is not followed any more, "running" for a moment's trouble. */
  private async viewOf(entry: Followed, state: BatchState): Promise<AskerView | "gone" | "trouble"> {
    const itemId = followedItemId(entry);
    const token = await tokenFor(this.deps, entry.review.requesterId);
    if (!("token" in token)) {
      if (token.failed !== "not_bound") return "trouble";
      this.deps.logger.info("the asker of an item is no longer bound; its view is not followed", { item: itemId });
      state.open.delete(itemId);
      this.deps.store.reviewDelegation.dropAskerFollow(itemId);
      return "gone";
    }
    try {
      return await this.deps.claw.workItems.requesterView(token.token, itemId);
    } catch (err) {
      if (!clawFailure(err)) throw err;
      if (err instanceof ClawError && [401, 403, 404].includes(err.status)) {
        this.deps.logger.info("the asker's view of an item is not readable", { item: itemId, error: errorKind(err) });
        state.open.delete(itemId);
        this.deps.store.reviewDelegation.dropAskerFollow(itemId);
        return "gone";
      }
      return "trouble";
    }
  }

  private async round(entries: readonly Followed[], conversation: Conversation, state: BatchState): Promise<void> {
    let running = false;
    const waiting: [Followed, string][] = [];
    for (const entry of [...state.open.values()]) {
      if (await this.endStopped(entry, state)) continue;
      const view = await this.viewOf(entry, state);
      if (view === "gone") continue;
      if (view === "trouble") {
        running = true;
        continue;
      }
      if (waitsNewly(entry, view)) waiting.push([entry, view.prSummary]);
      running ||= stillRunning(view);
      await this.note(entry, view, state);
    }
    // (each with its own card, whose buttons answer it; marked first: never told twice after a restart)
    for (const [entry, prSummary] of waiting) {
      entry.reviewerTold = true;
      this.deps.store.reviewDelegation.askerFollowReviewerTold(followedItemId(entry));
      await this.notices.tellReviewerWaiting(entry.review, prSummary);
    }
    const now = this.deps.clock.monotonicMs();
    const due = !running || !state.open.size || now - state.last >= VIEW_SETTLE_MS || now - state.first >= VIEW_HOLD_MS;
    if (state.news.size && due) await this.flush(entries, conversation, state);
  }

  /** An item the asker stopped on its card: that card is left as the press made it, and said there. */
  private async endStopped(entry: Followed, state: BatchState): Promise<boolean> {
    const itemId = followedItemId(entry);
    if (!this.stopped.has(itemId)) return false;
    this.stopped.delete(itemId);
    await this.cards.end(itemId, ITEM_STOPPED_ZH);
    state.open.delete(itemId);
    state.news.delete(itemId);
    this.deps.store.reviewDelegation.dropAskerFollow(itemId);
    return true;
  }

  /** What one view is: news to hold, back to what was said, a start, or an end. */
  private async note(entry: Followed, view: AskerView, state: BatchState): Promise<void> {
    const itemId = followedItemId(entry);
    if (view.status === "queued") entry.seenQueued = true;
    // (it waited, and now runs: its card says so)
    else if (!viewFinished(view) && (entry.seenQueued || entry.said === "queued")) await this.cards.started(itemId);
    const stage = entryStage(entry, view);
    const held = state.news.get(itemId);
    if (stage && stage !== entry.said) {
      // (new news: the same again is not)
      if (held === undefined || entryStage(entry, held[1]) !== stage) {
        const now = this.deps.clock.monotonicMs();
        state.first = state.first || now;
        state.last = now;
      }
      state.news.set(itemId, [entry, view]);
    } else if (held !== undefined && stage === entry.said) {
      state.news.delete(itemId); // (back to what was said: nothing new after all)
    }
    if (viewFinished(view)) {
      state.open.delete(itemId);
      await this.cards.end(itemId, itemEndText(view), view.prSummary);
      if (stage === entry.said) this.deps.store.reviewDelegation.dropAskerFollow(itemId);
    }
  }

  /** Says the held news in one message; what is said is recorded first, and put back when the message did not go. */
  private async flush(entries: readonly Followed[], conversation: Conversation, state: BatchState): Promise<void> {
    const told = [...state.news.values()];
    const before = new Map(told.map(([e]) => [followedItemId(e), e.said] as const));
    for (const [entry, view] of told) {
      entry.said = entryStage(entry, view);
      this.deps.store.reviewDelegation.askerFollowSaid(followedItemId(entry), entry.said);
    }
    const [first] = told;
    try {
      if (first !== undefined)
        await this.sayToAsker(first[0].review, conversation, progressText(entries, told, this.deps.mask));
    } catch (err) {
      for (const [entry] of told) {
        entry.said = before.get(followedItemId(entry)) ?? "";
        this.deps.store.reviewDelegation.askerFollowSaid(followedItemId(entry), entry.said);
      }
      throw err;
    }
    state.news.clear();
    state.first = state.last = 0;
    for (const [entry, view] of told)
      if (viewFinished(view)) this.deps.store.reviewDelegation.dropAskerFollow(followedItemId(entry));
    const ended = told.filter(([, v]) => viewFinished(v));
    const [one] = ended;
    if (one !== undefined) await this.notices.tellReviewer(one[0].review, reviewerEndedText(ended, this.deps.mask));
  }

  /** A line for the asker where they asked: in a group it @mentions them (and only them). */
  async sayToAsker(review: ReviewTurn, conversation: Conversation, text: string): Promise<void> {
    const message: OutMessage = textMessage(this.deps.mask(text));
    const name = displayName(review.requesterName) || review.requesterName;
    if (!review.fromGroup || !review.requesterChannelId || !name) {
      await conversation.send(message);
      return;
    }
    await conversation.send({
      ...message,
      mentions: [{ id: review.requesterId, channelUserId: review.requesterChannelId, name, email: "" }],
    });
  }
}
