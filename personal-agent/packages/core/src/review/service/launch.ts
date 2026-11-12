// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Starting the reviews that passed every check: Claw's items for them (or, from a Claw without them, sessions made here),
 * the one acknowledgement of the request (which items were made, which wait for a slot, how the merges will be made, the
 * model, where to stop them), a turn followed for each review of one's own, a follow of the asker's view for each review
 * asked of someone else, and a card with Stop for each item in the asker's own chat.
 */

import { errorName } from "../../errors.js";
import { reviewStartText as t } from "../../locales/review-start.js";
import type { InboundMessage } from "../../ports/surface.js";
import { shortName } from "../../review-text/pull-ref.js";
import type { PullRef } from "../../claw/model.js";
import { modelNote } from "../receipt.js";
import { ALREADY, REVIEWS_STARTED_AT_ONCE, itemsNote, mergeLine, modelChosenNote, refusedText } from "../refusals.js";
import { reviewPrompt } from "../prompts.js";
import { DEFAULT_MODE, isReviewMode, type ReviewTurn } from "../review-turn.js";
import { say } from "./chat.js";
import type { ReviewDeps, StartedReviewTurn } from "./deps.js";
import type { AskerFollow } from "./follow.js";
import { modeOf } from "./identity.js";
import type { ItemCards } from "./item-cards.js";
import type { ItemsAsked, ReviewItems } from "./items.js";
import type { Notices } from "./notices.js";
import type { Settled } from "./start.js";
import type { ReviewTurns } from "./turns.js";

/** How the merges will be made, from what Claw started; a Claw that does not say it held every handed-over review. */
function markHeld(reviews: readonly ReviewTurn[], handedOver: boolean): void {
  for (const review of reviews) {
    const told = review.item?.mergeNeedsConfirmation ?? null;
    review.mergeHeld = told === true || (told === null && review.item !== undefined && handedOver);
  }
}

/** Where to stop the reviews, when Claw made items of them. */
function stopHint(reviews: readonly ReviewTurn[], group: boolean): string {
  if (!reviews.some((r) => r.item !== undefined)) return "";
  return group ? t.stopInGroup : t.stopHere;
}

export class ReviewLaunch {
  constructor(
    private readonly deps: ReviewDeps,
    private readonly items: ReviewItems,
    private readonly notices: Notices,
    private readonly cards: ItemCards,
    private readonly follows: AskerFollow,
    private readonly turns: ReviewTurns,
  ) {}

  /** The model a review's card and receipt name: the one Claw says it runs on, else the one asked for (or the default). */
  shownModel(review: ReviewTurn): string {
    return review.modelReported ? review.model : review.model || this.deps.defaultModel;
  }

  async launch(s: Settled, held: PullRef[], handed: PullRef[]): Promise<void> {
    const who = s.actor.name || "对方";
    const readAs = t.readAs(s.ask.repo);
    let unread = s.ask.unread.length ? t.unreadNumbers(s.ask.unread.map((n) => `#${String(n)}`).join("、")) : "";
    // (read as the reviewer: Claw holds it for them)
    const reviewerMode = s.reviews.length ? await modeOf(this.deps, s.actor.userId) : "";
    for (const review of s.reviews) review.reviewMode = isReviewMode(reviewerMode) ? reviewerMode : DEFAULT_MODE;
    let reviews = s.reviews;
    if (reviews.length) {
      const started = await this.startItems(s, held);
      if (started === undefined) return;
      reviews = started;
      unread = itemsNote(reviews, who) + unread;
    }
    if (!reviews.length) {
      await this.nothingStarted(s);
      return;
    }
    // A review of one's own that Claw queued has no turn to follow here yet: its receipt says where its result is.
    const carded = reviews;
    const waiting = reviews.filter((r) => !r.forReviewer && r.item?.queued);
    reviews = reviews.filter((r) => !waiting.includes(r));
    if (!reviews.length) {
      await say(this.deps, s.ctx.conversation, t.received(readAs, unread.trim()));
      await this.postCards(s, carded);
      return;
    }
    await this.acknowledge(s, reviews, readAs, unread, reviewerMode === "fully_auto");
    await this.run(s, reviews, handed);
    // After the turns are kept: a Stop pressed the moment its card arrives finds the turn it ends as stopped.
    await this.postCards(s, carded);
  }

  /** Claw's items for the reviews (or the reviews this worker takes itself); undefined when the asker was told why not. */
  private async startItems(s: Settled, held: PullRef[]): Promise<ReviewTurn[] | undefined> {
    const counted = [...s.reviews];
    const request = {
      token: s.token,
      modelKey: s.modelKey,
      actor: s.actor,
      actingAs: s.state.userId,
      merge: s.ask.merge,
      model: s.model,
      actingToken: s.actingToken,
      actingKey: s.actingKey,
      note: s.ctx.text,
      handoffId: s.ask.handoffId,
    };
    const asked = await this.items.start(request, s.reviews, s.refused);
    if (asked.kind === "refused") {
      s.giveBack(counted);
      await say(this.deps, s.ctx.conversation, asked.text);
      return undefined;
    }
    let reviews: ReviewTurn[];
    if (asked.kind === "no_items") {
      // A Claw without review items: the sessions are made here, on the asker's own key.
      if (!s.modelKey) {
        s.giveBack(counted);
        await this.notices.requesterMustLink(
          s.ctx.conversation.ref,
          s.ctx.group,
          s.requester,
          s.ctx.conversation,
          s.reviews.map((r) => r.pull),
        );
        return undefined;
      }
      let kept = s.reviews;
      if (kept.length > REVIEWS_STARTED_AT_ONCE) {
        const extra = kept.slice(REVIEWS_STARTED_AT_ONCE);
        for (const r of extra)
          s.refused.push([
            r.pull,
            `PrimusClaw 这一版一次只接受 ${String(REVIEWS_STARTED_AT_ONCE)} 个，这个没有开始，请稍后单独再发`,
          ]);
        s.giveBack(extra);
        kept = kept.slice(0, REVIEWS_STARTED_AT_ONCE);
      }
      reviews = this.items.hold(kept, s.refused, held);
      // (Claw may be rolling out: the session made here can be refused by a newer one)
      if (s.actingToken) for (const review of reviews) review.asItem = this.turns.asItemOnce(review, s);
    } else {
      reviews = asked.reviews;
    }
    s.giveBack(counted.filter((r) => !reviews.includes(r))); // refused by Claw, or under review already
    for (const r of reviews) if (r.item !== undefined) s.slots?.itemIds.add(r.item.itemId);
    return reviews;
  }

  private async nothingStarted(s: Settled): Promise<void> {
    const [first] = s.refused;
    let text: string;
    if (s.several || first === undefined) text = t.noneStarted(refusedText(s.refused));
    else if (first[1] === ALREADY) text = t.alreadyReviewing(shortName(first[0]));
    else text = t.notStarted(refusedText(s.refused));
    await say(this.deps, s.ctx.conversation, text);
  }

  /** The acknowledgement: one message for several reviews, else at the top of the review's progress message. */
  private async acknowledge(
    s: Settled,
    reviews: ReviewTurn[],
    readAs: string,
    unread: string,
    auto: boolean,
  ): Promise<void> {
    const who = s.actor.name || "对方";
    const [first] = reviews;
    if (first === undefined) return;
    const chosen = modelChosenNote(first, who, s.model);
    markHeld(reviews, Boolean(s.ask.handoffId));
    const reach = await this.notices.reachNote(
      reviews.find((r) => r.forReviewer),
      s.ctx.conversation.caps.shortName,
    );
    const setting = [mergeLine(reviews, who, s.ask.merge, auto), reach].filter(Boolean).join("\n\n");
    const stop = stopHint(reviews, s.ctx.group);
    const verb = s.ask.merge ? "review 合入" : "review（只 review，不合入）";
    const note = modelNote(this.shownModel(first), true);
    if (s.several) {
      await say(
        this.deps,
        s.ctx.conversation,
        this.severalText(s, reviews, { readAs, who, verb, note, chosen, setting, unread, stop }),
      );
      return;
    }
    // (at the top of the review's progress message, which its answer replaces: no message of its own)
    if (s.model || chosen || setting || readAs || unread || !s.ask.merge || stop) {
      first.ack = t.single(readAs, who, verb, shortName(first.pull), note) + chosen + setting + unread + stop;
    }
  }

  private severalText(
    s: Settled,
    reviews: readonly ReviewTurn[],
    p: {
      readAs: string;
      who: string;
      verb: string;
      note: string;
      chosen: string;
      setting: string;
      unread: string;
      stop: string;
    },
  ): string {
    const lined = reviews.some((r) => r.item?.queued);
    const head = t.several({
      readAs: p.readAs,
      who: p.who,
      verb: p.verb,
      count: reviews.length,
      note: p.note,
      lined,
      pulls: reviews.map((r) => shortName(r.pull)).join("、"),
      allTheirs: reviews.every((r) => r.forReviewer),
      where: s.ctx.group ? "群里" : "这里",
    });
    const refused = s.refused.length ? `\n\n没有开始：${refusedText(s.refused)}。` : "";
    return (
      head + (p.chosen ? `\n\n${p.chosen}` : "") + (p.setting ? `\n\n${p.setting}` : "") + refused + p.unread + p.stop
    );
  }

  /** A turn for each review of one's own; the asker follows the reviews asked of someone else together. */
  private async run(s: Settled, reviews: readonly ReviewTurn[], handed: PullRef[]): Promise<void> {
    const followed: ReviewTurn[] = [];
    for (const [index, review] of reviews.entries()) {
      if (review.forReviewer) {
        // (no turn, so no progress message to carry its acknowledgement: said on its own)
        if (review.ack) await say(this.deps, s.ctx.conversation, review.ack);
        followed.push(review);
        await this.notices.tellReviewerStarted(review);
        continue;
      }
      // Claw makes one session per idempotency key: each pull request's session gets its own.
      const message: InboundMessage = s.several
        ? { ...s.ctx.message, id: `${s.ctx.message.id}-${String(index + 1)}` }
        : s.ctx.message;
      const running = await this.startTurn(s, review, message);
      if (running !== undefined) {
        handed.push(review.pull);
        void running.ended.finally(() => {
          this.items.release(review.pull);
          if (review.item !== undefined) this.turns.endOwnItemCard(review);
        });
      }
    }
    this.follows.follow(followed, s.ctx.conversation);
  }

  private async startTurn(
    s: Settled,
    review: ReviewTurn,
    message: InboundMessage,
  ): Promise<StartedReviewTurn | undefined> {
    let running: StartedReviewTurn | undefined;
    try {
      try {
        running = await this.deps.host.startTurn({
          message,
          sender: s.ctx.sender,
          token: s.token,
          prompt: reviewPrompt(review),
          conversation: s.ctx.conversation,
          scope: s.ctx.scope,
          review,
          modelKey: s.modelKey,
          turn: this.turns.options(review, s.modelKey),
        });
      } finally {
        // (kept as a turn now, which counts itself, or not started: either way its slot is let go)
        s.slots?.followed(review.item?.itemId ?? "");
      }
    } catch (err) {
      // (one that did not start must not keep the others from starting; an item runs in Claw all the same)
      if (review.item === undefined) s.giveBack([review]);
      if (!s.several && review.item === undefined) throw err;
      this.deps.logger.warn("one review of a request could not be started or followed", { error: errorName(err) });
      if (review.item === undefined) await say(this.deps, s.ctx.conversation, t.notStartedHere(shortName(review.pull)));
      running = undefined;
    }
    if (running === undefined && review.item === undefined) s.giveBack([review]);
    if (running === undefined && review.item !== undefined) {
      this.deps.logger.warn("a review item started but is not followed here", { item: review.item.itemId });
      const stop = review.ack ? (s.ctx.group ? t.stopInGroup : t.stopHere) : "";
      await say(this.deps, s.ctx.conversation, t.startedNotFollowed(shortName(review.pull)) + stop);
    }
    return running;
  }

  /**
   * A review asked of someone else whose session was made here, refused by a newer Claw (`acting_as_must_be_self`): asked for
   * once more as the reviewer's item, exactly as the start asks. True: the asker was told; false: the turn says its failure.
   */
  async asItem(review: ReviewTurn, s: Settled): Promise<boolean> {
    const refused: [PullRef, string][] = [];
    const request = {
      token: s.token,
      modelKey: s.modelKey,
      actor: s.actor,
      actingAs: s.state.userId,
      merge: s.ask.merge,
      model: s.model,
      actingToken: s.actingToken,
      actingKey: s.actingKey,
      note: s.ctx.text,
      handoffId: "",
    };
    let started: ReviewTurn | undefined;
    let asked: ItemsAsked;
    try {
      asked = await this.items.start(request, [review], refused);
      [started] = asked.kind === "started" ? asked.reviews : [];
    } finally {
      // (not started this way either: refused, a 404 again, or an error on the way: never done, as the session before it was not)
      if (started === undefined) s.giveBack([review]);
    }
    if (asked.kind === "refused") {
      await say(this.deps, s.ctx.conversation, asked.text);
      return true;
    }
    if (started === undefined) {
      if (!refused.length) return false;
      await say(this.deps, s.ctx.conversation, t.notStarted(refusedText(refused)));
      return true;
    }
    this.deps.logger.info("a review started as the reviewer's item after Claw refused the session", {
      item: started.item?.itemId ?? "",
    });
    this.follows.follow([started], s.ctx.conversation);
    await this.notices.tellReviewerStarted(started);
    await this.postCards(s, [started]);
    return true;
  }

  /** The cards with Stop, in the asker's own chat (a group's request too). */
  async postCards(s: Settled, reviews: readonly ReviewTurn[]): Promise<void> {
    if (!reviews.some((r) => r.item !== undefined)) return;
    let target = s.ctx.conversation;
    if (s.ctx.group) {
      const chat = await this.notices.personalChatOf(s.requester, s.ctx.conversation.ref);
      if (chat === undefined) {
        this.deps.logger.warn("the asker's own chat could not be opened; their review items have no card");
        return;
      }
      target = chat;
    }
    await this.cards.post(target, s.ctx.sender.id, reviews, (r) => this.shownModel(r));
  }
}
