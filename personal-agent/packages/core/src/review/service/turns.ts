// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's turn, as the review service shapes it and follows it up: what the turn engine is given (its one message, the
 * line shown as each write lands, the acknowledgement on top), what follows its end (held writes offered to the reviewer,
 * the reviewer told what was done as them, the asker told when Claw did not take their key), and the retry as the
 * reviewer's item when a newer Claw refuses a session made here for someone else.
 */

import { errorName } from "../../errors.js";
import { REVIEW_MODES } from "../views.js";
import type { Conversation } from "../../ports/surface.js";
import type { GithubOutcome } from "../../turn/github-outcome.js";
import type { ReviewTurnOptions } from "../../turn/runner.js";
import { displayName } from "../names.js";
import { ownItemEndText, ITEM_STOPPED_ZH } from "../progress.js";
import { pullUrl, shortName, slug } from "../pull-ref.js";
import { DM_SUMMARY_CHARS, clipSummary, modelNote, resultLine, reviewAnswer, shapeGroupAnswer } from "../receipt.js";
import { autoOf, type ReviewTurn, selfReview } from "../review-turn.js";
import { pickLang } from "../text/unicode.js";
import { say } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import type { AskerFollow } from "./follow.js";
import type { ItemCards } from "./item-cards.js";
import type { Notices } from "./notices.js";
import type { Settled } from "./start.js";

/** What a review's turn left, as the turn engine collects it. */
export interface ReviewTurnOutcome {
  readonly finalAnswer: string;
  /** The review moved to the reviewer's item during the turn (`asItem`). */
  readonly moved: boolean;
  /** Claw did not take the asker's credentials (401). */
  readonly refusal: { readonly status: number; readonly code: string } | null;
  readonly ranModel: string;
  readonly wrote: readonly GithubOutcome[];
  readonly prSummary: string;
}

const WROTE_ZH: Readonly<Record<string, string>> = {
  "merged:": "合入",
  "queued:": "加入合并队列",
  "submitted:APPROVE": "批准",
  "submitted:REQUEST_CHANGES": "提交了 request changes",
  "submitted:COMMENT": "提交了评论",
  "submitted:": "提交了评审",
};
const WROTE_EN: Readonly<Record<string, string>> = {
  "merged:": "merged it",
  "queued:": "put it in the merge queue",
  "submitted:APPROVE": "approved it",
  "submitted:REQUEST_CHANGES": "requested changes",
  "submitted:COMMENT": "posted a review comment",
  "submitted:": "posted a review",
};

function wroteWords(wrote: readonly GithubOutcome[], words: Readonly<Record<string, string>>, join: string): string {
  const said = wrote.map(([, status, event]) => words[`${status}:${event}`] ?? words[`${status}:`] ?? status);
  return [...new Set(said)].join(join);
}

/** Offers what Claw holds for the reviewer after a turn (`confirm.ts`). */
export type OfferHeld = (
  review: ReviewTurn,
  item: Readonly<Record<string, unknown>>,
  asked: Conversation,
) => Promise<void>;

export class ReviewTurns {
  offerHeld: OfferHeld = () => Promise.resolve();
  /** Starts a review's items again for the reviewer (`launch.ts`), set by the assembly of the service. */
  retryAsItem: (review: ReviewTurn, s: Settled) => Promise<boolean> = () => Promise.resolve(false);

  constructor(
    private readonly deps: ReviewDeps,
    private readonly notices: Notices,
    private readonly cards: ItemCards,
    private readonly follows: AskerFollow,
  ) {}

  /** What the turn engine is given for a review. */
  options(review: ReviewTurn, modelKey: string): ReviewTurnOptions {
    const mention =
      review.fromGroup && review.requesterChannelId
        ? { id: review.requesterId, channelUserId: review.requesterChannelId, name: review.requesterName, email: "" }
        : undefined;
    return {
      actingAs: review.actorUserId,
      reviewTarget: review.pull,
      modelKey,
      reviewModel: review.model || this.deps.defaultModel,
      reviewOnly: review.reviewOnly,
      attach: review.item !== undefined,
      attachMessageId: review.item?.messageId ?? "",
      lead: review.ack,
      mention,
      shapeAnswer: (answer, link, model, results, comments, prSummary) =>
        reviewAnswer(review, answer, { link, model, results, comments, prSummary }, this.deps.mask),
      onGithubResult: (outcome, model) => this.noteResult(review, outcome, model),
      ...(review.asItem === undefined ? {} : { asItem: review.asItem }),
    };
  }

  /** A result of the review's write tools: the line that says how it came out; a merge made in the review itself is audited. */
  noteResult(review: ReviewTurn, outcome: GithubOutcome, model: string): string | undefined {
    if (outcome[0] === "gh_pr_merge" && outcome[1] === "merged") {
      this.deps.audit("pr_merged", {
        operation: "pr_merge",
        outcome: "merged",
        aad_object_id: review.requesterId,
        session_id: review.sessionId || null,
        repo: slug(review.pull),
        pr_number: review.pull.number,
        github_login: review.actorLogin || null,
      });
    }
    return resultLine(review, outcome, model);
  }

  /** The `ReviewTurn.asItem` of a review asked of someone else whose session is made here: tried once, never in a loop. */
  asItemOnce(review: ReviewTurn, s: Settled): () => Promise<boolean> {
    let tried = false;
    return async () => {
      if (tried) return false;
      tried = true;
      return this.retryAsItem(review, s);
    };
  }

  /** A review of one's own that is an item ended with its turn: its card shows how. */
  endOwnItemCard(review: ReviewTurn): void {
    const itemId = review.item?.itemId;
    if (itemId === undefined) return;
    const ended = this.follows.takeStopped(itemId) ? ITEM_STOPPED_ZH : ownItemEndText(review);
    void this.cards.end(itemId, ended, review.prSummary).catch((err: unknown) => {
      this.deps.logger.warn("the card of a review's own item could not be ended", { error: errorName(err) });
    });
  }

  /** The turn has ended: what follows it, by how it ended. */
  async afterTurn(review: ReviewTurn, outcome: ReviewTurnOutcome, asked: Conversation): Promise<void> {
    if (outcome.moved) return; // (followed as the reviewer's item now)
    if (outcome.refusal !== null) {
      await this.notices.tellRequesterRefused(review, outcome.refusal.code);
      return;
    }
    review.ranModel = outcome.ranModel;
    review.wrote = [...outcome.wrote];
    review.prSummary = outcome.prSummary;
    await this.followUp(review, outcome.finalAnswer, asked);
  }

  /** Held writes go to the reviewer as cards; and the reviewer, who typed nothing, is told what was done as them. */
  private async followUp(review: ReviewTurn, answer: string, asked: Conversation): Promise<void> {
    if (!review.sessionId) return;
    await this.offerPending(review, asked);
    // (nothing left on GitHub as them, or held: the card is the message)
    if (!review.wrote.length) return;
    // (asked in their own chat: the answer there is the notice; with no answer, the notice is the one word of what was written)
    if (selfReview(review) && !review.fromGroup && answer.trim()) return;
    let delivered: boolean;
    let why: string;
    try {
      [delivered, why] = await this.tellActor(review, answer);
    } catch (err) {
      [delivered, why] = [false, "私聊发送失败"];
      this.deps.logger.warn("the reviewer could not be told what was done as them", { error: errorName(err) });
    }
    this.deps.store.reviewDelegation.noteReviewNotice({
      sessionId: review.sessionId,
      actorId: review.actorId,
      requesterId: review.requesterId,
      pull: shortName(review.pull),
      delivered,
      reason: why,
    });
    if (delivered) return;
    // (never silently: the asker hears it where they asked)
    this.deps.logger.warn("a review notice was not delivered", { pull: shortName(review.pull), why });
    try {
      await say(
        this.deps,
        asked,
        `${shortName(review.pull)}：未能通知到 ${displayName(review.actorName) || "对方"}（${why}）。`,
      );
    } catch (err) {
      this.deps.logger.warn("the asker could not be told the notice failed", { error: errorName(err) });
    }
  }

  private async offerPending(review: ReviewTurn, asked: Conversation): Promise<void> {
    const token = await this.notices.requesterToken(review);
    if (token === undefined) return;
    try {
      const held = await this.deps.claw.mergeConfirmations.pending(token, review.sessionId);
      for (const item of held.slice(0, 3)) await this.offerHeld(review, item, asked);
    } catch (err) {
      this.deps.logger.info("pending confirmations were not read or handled", { error: errorName(err) });
    }
  }

  /** The reviewer's notice of what was left on GitHub as them: [delivered, why not]. */
  private async tellActor(review: ReviewTurn, answer: string): Promise<readonly [boolean, string]> {
    const chat = await this.notices.reviewerChat(review);
    if (chat === undefined) return [false, "TA 还没和 Clawy 私聊过"];
    const summary = answer.trim()
      ? clipSummary(shapeGroupAnswer(answer), DM_SUMMARY_CHARS)
      : "（没有拿到这次 review 的结论，请打开 PR 查看。 / The review's conclusion did not reach me; look at the pull request.）";
    const title = review.title ? `「${review.title}」` : "";
    const [modeZh, modeEn] = REVIEW_MODES[review.reviewMode];
    const zh = (answer.trim() ? pickLang(answer) : review.lang) === "zh";
    const text = zh ? this.noticeZh(review, title, summary, modeZh) : this.noticeEn(review, title, summary, modeEn);
    try {
      await say(this.deps, chat, text);
    } catch (err) {
      this.deps.logger.warn("the reviewer's notice could not be sent", { error: errorName(err) });
      return [false, "私聊发送失败"];
    }
    return [true, ""];
  }

  private noticeZh(review: ReviewTurn, title: string, summary: string, mode: string): string {
    const asker = selfReview(review) ? "你" : review.requesterName || "有同事";
    const done = wroteWords(review.wrote, WROTE_ZH, "、");
    return (
      `${asker}在${review.where}请我以你的名义 ${review.reviewOnly ? "review" : "review 合入"} ${shortName(review.pull)}${title}，我已用你的 GitHub 账号${done}：\n` +
      `${pullUrl(review.pull)}\n\n结论：\n${summary}\n\n${modelNote(review.ranModel, true, autoOf(review))}\n\n你的确认方式：${mode}`
    );
  }

  private noticeEn(review: ReviewTurn, title: string, summary: string, mode: string): string {
    const asker = selfReview(review) ? "You" : review.requesterName || "A colleague";
    const done = wroteWords(review.wrote, WROTE_EN, ", ");
    const where =
      review.where === "群聊"
        ? "a group chat"
        : review.where === "私聊"
          ? "your 1:1 chat"
          : `the group chat ${review.where}`;
    return (
      `${asker} asked me in ${where} to ${review.reviewOnly ? "review" : "review and merge"} ${shortName(review.pull)}${title} as you; with your GitHub ` +
      `account I ${done}:\n${pullUrl(review.pull)}\n\nConclusion:\n${summary}\n\n${modelNote(review.ranModel, false, autoOf(review))}\n\nYour confirmation setting: ${mode}`
    );
  }
}
