// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of each review item, with Stop, in the asker's own chat (a group's request too: the item is theirs, and only
 * there can a button of theirs be told from a colleague's), and its end: once the item is over every open card of it shows
 * how, in place of its buttons. Where each card is, is kept with it in the store, so a worker started later edits it too.
 */

import { ClawError, errorKind } from "../../claw/errors.js";
import { errorName } from "../../errors.js";
import type { JsonObject } from "../../json.js";
import type { PlacedCard } from "../../ports/store/assistant.js";
import { ASSISTANT_CARD_KEEP_SECONDS } from "../../ports/store/policy.js";
import type { Conversation } from "../../ports/surface.js";
import { displayName } from "../../review-text/names.js";
import { itemEndText, ITEM_STOPPED_ZH } from "../progress.js";
import { shortName } from "../../review-text/pull-ref.js";
import { type ReviewTurn, viewFinished } from "../review-turn.js";
import { clipPrSummary } from "../summary.js";
import { endedItemMessage, reviewItemMessage } from "../views.js";
import { stored } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import { tokenFor } from "./identity.js";

/** The plain end a card gets when Teams refused the full one. */
export const ITEM_CARD_ENDED_PLAIN_ZH = "已结束，见上方结果";
/** Open review cards are checked this often for an item that is over. */
export const CARD_SWEEP_MS = 120_000;
/** ... posted within this long (all the store keeps: a review held for its reviewer may end late). */
export const CARD_SWEEP_MAX_AGE_SECONDS = ASSISTANT_CARD_KEEP_SECONDS;

const BOARD_OUTCOME_ZH: Readonly<Record<string, string>> = { accepted: "已接受", dropped: "已放弃", stopped: "已停止" };

interface CardAt {
  readonly conversation: Conversation;
  readonly messageId: string;
  readonly cardId: string;
}

export class ItemCards {
  /** item id -> where its card with Stop was sent. */
  private readonly cardAt = new Map<string, CardAt>();
  /** item id -> how it ended (and the review's summary), for an item that ended before its card went out. */
  private readonly endedBeforeCard = new Map<string, readonly [string, string]>();

  constructor(
    private readonly deps: ReviewDeps,
    /** Item ids whose end is said by a follow here (their cards are not swept). */
    private readonly followed: (itemId: string) => boolean,
  ) {}

  has(itemId: string): boolean {
    return this.cardAt.has(itemId);
  }

  forget(itemId: string): void {
    this.cardAt.delete(itemId);
  }

  /** A card for each review item in `target` (the asker's own chat). Best effort: an item without a card stays on the board. */
  async post(
    target: Conversation,
    ownerId: string,
    reviews: readonly ReviewTurn[],
    shownModel: (r: ReviewTurn) => string,
  ): Promise<void> {
    for (const review of reviews) {
      const item = review.item;
      if (item === undefined) continue;
      const cardId = this.deps.store.assistantCards.addAssistantCard(ownerId, item.itemId, 0, false);
      // (a review that waits for a slot says so on its card until it starts)
      const queued = Boolean(item.queued);
      const model = shownModel(review);
      const render: JsonObject = {
        kind: "review",
        seq: item.seq,
        pull: shortName(review.pull),
        who: displayName(review.actorName),
        review_only: review.reviewOnly,
        model,
        lang: review.lang,
        queued,
      };
      let messageId: string | undefined;
      try {
        messageId = await target.post(
          reviewItemMessage({
            seq: item.seq,
            pull: shortName(review.pull),
            who: displayName(review.actorName),
            reviewOnly: review.reviewOnly,
            model,
            cardId,
            lang: review.lang,
            queued,
          }),
        );
      } catch (err) {
        this.deps.logger.warn("the card of a review item could not be sent", { error: errorName(err) });
        this.endedBeforeCard.delete(item.itemId);
        continue;
      }
      // (kept: a worker started after this one edits it all the same when the review ends)
      if (messageId)
        this.deps.store.assistantCards.placeAssistantCard(cardId, {
          activityId: messageId,
          reference: target.ref.wire as JsonObject,
          render,
        });
      this.cardAt.set(item.itemId, { conversation: target, messageId: messageId ?? "", cardId });
      const early = this.endedBeforeCard.get(item.itemId);
      if (early !== undefined) {
        // (it ended while its card was on its way)
        this.endedBeforeCard.delete(item.itemId);
        await this.end(item.itemId, early[0], early[1]);
      }
    }
  }

  /** A review that waited for a slot has started: each open card that still says it is queued becomes the running card. */
  async started(itemId: string): Promise<void> {
    for (const card of this.deps.store.assistantCards.placedAssistantCards({ itemId })) {
      const render = card.render;
      if (render.kind !== "review" || !render.queued || typeof render.pull !== "string") continue;
      const conversation = stored(this.deps, card.reference);
      if (conversation === undefined) continue;
      try {
        await conversation.update(
          card.activityId,
          reviewItemMessage({
            seq: Number(render.seq ?? 0) || 0,
            pull: render.pull,
            who: typeof render.who === "string" ? render.who : "",
            reviewOnly: Boolean(render.review_only),
            model: typeof render.model === "string" ? render.model : "",
            cardId: card.cardId,
            lang: render.lang === "en" ? "en" : "zh",
            queued: false,
          }),
        );
      } catch (err) {
        this.deps.logger.warn("the card of an item could not be shown as started", { error: errorName(err) });
        continue;
      }
      this.deps.store.assistantCards.placeAssistantCard(card.cardId, {
        activityId: card.activityId,
        reference: card.reference,
        render: { ...render, queued: false },
      });
    }
  }

  /** The review item ended: every card of it still open shows how, in place of its buttons. */
  async end(itemId: string, ended: string, prSummary = ""): Promise<void> {
    const at = this.cardAt.get(itemId);
    this.cardAt.delete(itemId);
    const placed = this.deps.store.assistantCards.placedAssistantCards({ itemId });
    if (at === undefined && !placed.length) {
      // (an item with no card on its way is forgotten when the card is never sent)
      if (this.endedBeforeCard.size < 1000) this.endedBeforeCard.set(itemId, [ended, prSummary]);
      return;
    }
    // (posted, but the channel's id never came back: it cannot be edited, its buttons are answered so)
    if (at !== undefined && !at.messageId) this.deps.store.assistantCards.endAssistantCard(at.cardId, ended);
    for (const card of placed) await this.close(card, ended, prSummary);
  }

  /** Edits one open card into its end; a plain end when the channel refuses the full one. False when this call did not end it. */
  async close(card: PlacedCard, ended: string, prSummary = ""): Promise<boolean> {
    if (!this.deps.store.assistantCards.endAssistantCard(card.cardId, ended)) return false;
    const conversation = stored(this.deps, card.reference);
    if (conversation === undefined) return true;
    const render = prSummary ? { ...card.render, pr_summary: clipPrSummary(prSummary, this.deps.mask) } : card.render;
    try {
      await conversation.update(card.activityId, endedItemMessage({ render, ended, cardId: card.cardId }));
      return true;
    } catch (err) {
      this.deps.logger.warn("the card of an item could not be closed; a plain end is put in its place", {
        error: errorName(err),
      });
    }
    try {
      await conversation.update(
        card.activityId,
        endedItemMessage({ render: card.render, ended: ITEM_CARD_ENDED_PLAIN_ZH, cardId: "" }),
      );
    } catch (err) {
      this.deps.logger.warn("the card of an item could not be edited at all; its buttons answer that it ended", {
        error: errorName(err),
      });
    }
    return true;
  }

  /** How the item of one open card ended, read as the card's owner; undefined while it runs or when it cannot be read now. */
  private async endOf(card: PlacedCard): Promise<readonly [string, string] | undefined> {
    if (card.render.kind === "review") {
      const token = await tokenFor(this.deps, card.userId);
      if ("token" in token) {
        try {
          const view = await this.deps.claw.workItems.requesterView(token.token, card.itemId);
          return viewFinished(view) ? [itemEndText(view), view.prSummary] : undefined;
        } catch (err) {
          if (!(err instanceof ClawError && (err.status === 403 || err.status === 404))) throw err;
        }
      }
    }
    const key = this.deps.store.links.getKey(card.userId);
    if (key === null) return undefined;
    const item = await this.deps.claw.workItems.get(key, card.itemId);
    if (item.boardState !== "done") return undefined;
    const outcome = item.outcome ?? "";
    return [outcome === "stopped" ? ITEM_STOPPED_ZH : `已结束：${BOARD_OUTCOME_ZH[outcome] ?? "已完成"}`, ""];
  }

  /**
   * Every open card of a review item posted within `maxAge`, whose item is over, is edited into its end: what a follow did
   * not end is ended here. Returns how many cards it ended.
   */
  async closeEnded(maxAge = CARD_SWEEP_MAX_AGE_SECONDS): Promise<number> {
    let closed = 0;
    for (const card of this.deps.store.assistantCards.placedAssistantCards({ since: this.deps.store.now() - maxAge })) {
      // (followed here: its end is said there)
      if (this.followed(card.itemId) || this.cardAt.has(card.itemId)) continue;
      let end: readonly [string, string] | undefined;
      try {
        end = await this.endOf(card);
      } catch (err) {
        // (read again on the next sweep)
        this.deps.logger.info("the item of an open card was not read this time", { error: errorKind(err) });
        continue;
      }
      if (end !== undefined && (await this.close(card, end[0], end[1]))) closed += 1;
    }
    if (closed) this.deps.logger.info("cards of items that are over were edited into their end", { closed });
    return closed;
  }
}
