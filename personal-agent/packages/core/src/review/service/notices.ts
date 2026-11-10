// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the reviewer and the asker are told in their own chats: that a review was asked of the reviewer and started, that it
 * waits for them (with their item's card), how it ended; that the asker must link their key, or the reviewer must connect
 * GitHub (once a day each); and that what waits for the reviewer does not reach their chat.
 */

import { errorKind } from "../../claw/errors.js";
import type { WorkItem, PullRef } from "../../claw/model.js";
import { errorName } from "../../errors.js";
import { REACH_WORDS } from "../../locales/review-github.js";
import type { Conversation, ConversationRef, UserRef } from "../../ports/surface.js";
import { shortName } from "../../review-text/pull-ref.js";
import { queueReason, shorts } from "../refusals.js";
import { askerName, type ReviewTurn, reviewerName } from "../review-turn.js";
import { prSummaryLine } from "../summary.js";
import { personalChat, say } from "./chat.js";
import { tokenFor } from "./identity.js";
import type { ReviewDeps } from "./deps.js";
import type { Actor } from "./reviewer.js";

/** A person who was named but has not bound GitHub (or the asker who has not linked) is told how at most once a day. */
export const BIND_NOTICE_SECONDS = 24 * 3600;

/** Puts a card of a work item in a chat and keeps where it went (the assistant's work card; owned by the assistant line). */
export type PostWorkCard = (conversation: Conversation, owner: string, item: WorkItem, text: string) => Promise<void>;

export class Notices {
  constructor(
    private readonly deps: ReviewDeps,
    private readonly postWorkCard: PostWorkCard,
  ) {}

  /** The asker's exchanged token, to read what a review's session holds as them; undefined when there is none now. */
  async requesterToken(review: ReviewTurn): Promise<string | undefined> {
    const token = await tokenFor(this.deps, review.requesterId);
    return "token" in token ? token.token : undefined;
  }

  /**
   * Claw did not take the asker's credentials for this review (401): what they can do goes to them alone. A key that belongs
   * to another Primus account than the one connected at the identity service (`key_subject_mismatch`) is linked again from
   * the right account; any other is linked again.
   */
  async tellRequesterRefused(review: ReviewTurn, code: string): Promise<void> {
    const pull = shortName(review.pull);
    const [en, zh] =
      code === "key_subject_mismatch"
        ? [
            "the key you linked belongs to a different Primus account than the one you connected at the identity service. Send `/unlink`, then link again (`/link CODE`) while signed in to the account you connected there. If that does not help, tell the operator.",
            "你 /link 的 key 属于的 Primus 账号，和你在身份服务里连接的不是同一个。请发 `/unlink`，再用你在身份服务里连接的那个账号登录后重新 `/link CODE`；仍不行请联系管理员。",
          ]
        : [
            "PrimusClaw did not accept your linked key (it may have expired or been deleted). Send `/unlink`, then link again (`/link CODE`). If it happens again, tell the operator.",
            "PrimusClaw 没有接受你 /link 的 key（可能已过期或被删除）。请发 `/unlink`，再用 `/link CODE` 重新连接；仍然如此请联系管理员。",
          ];
    try {
      const chat = await personalChat(
        this.deps,
        { userId: review.requesterId, channelUserId: review.requesterChannelId },
        review.asked,
      );
      if (chat === undefined) return;
      await say(
        this.deps,
        chat,
        `Your request to review ${pull} for a colleague did not start: ${en}\n\n你请我代同事 review ${pull}，但没有开始：${zh}`,
      );
    } catch (err) {
      this.deps.logger.warn("the asker could not be told that Claw did not take their key", { error: errorName(err) });
    }
  }

  /** A person's own 1:1 chat. */
  personalChatOf(person: Actor, via: ConversationRef): Promise<Conversation | undefined> {
    return personalChat(this.deps, person, via);
  }

  /** The reviewer's own 1:1 chat. */
  reviewerChat(review: ReviewTurn): Promise<Conversation | undefined> {
    return personalChat(this.deps, { userId: review.actorId, channelUserId: review.actorChannelId }, review.asked);
  }

  async tellReviewer(review: ReviewTurn, text: string): Promise<void> {
    try {
      const chat = await this.reviewerChat(review);
      if (chat !== undefined) await say(this.deps, chat, text);
    } catch (err) {
      this.deps.logger.warn("the reviewer could not be told about a review asked of them", { error: errorName(err) });
    }
  }

  /** The reviewer hears, in their own chat, that someone asked a review of them and that it is an item on their board. */
  async tellReviewerStarted(review: ReviewTurn): Promise<void> {
    const item = review.item;
    const seq = item?.seq ? `（事项 #${String(item.seq)}）` : "";
    const verb = review.reviewOnly ? "review（只 review，不合入）" : "review 合入";
    const held =
      review.mergeHeld && !review.reviewOnly
        ? "合入前会先请你确认（卡片按钮或回复「批准 #编号」），你确认之前不会合入。"
        : "";
    const state = item?.queued
      ? `已作为你看板上的事项排队${seq}（${queueReason(item.queued, "你", askerName(review), true)}），名额空出后会自动开始`
      : `已作为你看板上的事项开始${seq}`;
    await this.tellReviewer(
      review,
      `${askerName(review)}在${review.where}请你代 ${verb} ${shortName(review.pull)}，${state}，用你的 GitHub 账号和你的模型额度。${held}发 /board 查看或停止。`,
    );
  }

  /** The reviewer's item as Claw shows it to them, read with their own key; undefined when it cannot be. */
  private async reviewersItem(review: ReviewTurn): Promise<WorkItem | undefined> {
    const key = review.item ? this.deps.store.links.getKey(review.actorId) : null;
    if (key === null || review.item === undefined) return undefined;
    try {
      return await this.deps.claw.workItems.get(key, review.item.itemId);
    } catch (err) {
      // (whatever it is, the reviewer is still told, with the reply that answers it)
      this.deps.logger.info("the reviewer's item could not be read as them", { error: errorKind(err) });
      return undefined;
    }
  }

  /** The reviewer's item waits for them: what it asks and how to answer, with the item's card when it can be read as them. */
  async tellReviewerWaiting(review: ReviewTurn, prSummary: string): Promise<void> {
    const item = await this.reviewersItem(review);
    const question = item?.pendingQuestion?.trim() ?? "";
    try {
      const chat = await this.reviewerChat(review);
      if (chat === undefined) return;
      await say(this.deps, chat, this.waitingText(review, item, question, prSummary));
      if (item !== undefined) await this.postWorkCard(chat, review.actorId, item, question || item.summary);
    } catch (err) {
      this.deps.logger.warn("the reviewer could not be told that a review waits for them", { error: errorName(err) });
    }
  }

  private waitingText(review: ReviewTurn, item: WorkItem | undefined, question: string, prSummary: string): string {
    const seq = item?.seq || review.item?.seq || 0;
    const ref = seq ? `#${String(seq)}` : "#编号";
    const lead = `${askerName(review)}请你代审的 ${shortName(review.pull)}${seq ? `（事项 #${String(seq)}）` : ""} 在等你确认`;
    const how =
      item !== undefined
        ? `点下面卡片上的按钮，或直接回复「批准 ${ref}」确认、「拒绝 ${ref}」不同意。`
        : `直接回复「批准 ${ref}」确认、「拒绝 ${ref}」不同意。`;
    const line = prSummaryLine(prSummary);
    return `${question ? `${lead}：${question}` : `${lead}。`}${line ? `\n${line}` : ""}\n\n${how}`;
  }

  /** For a review handed to someone else: '' when what waits for them reaches their chat, else one line for the asker. */
  async reachNote(review: ReviewTurn | undefined): Promise<string> {
    if (review === undefined || this.deps.host.reviewerReach === undefined) return "";
    const why = await this.deps.host.reviewerReach(review.actorId);
    if (!why) return "";
    const [cause, fix] = (Object.hasOwn(REACH_WORDS, why) ? REACH_WORDS[why] : undefined) ??
      REACH_WORDS.no_subscription ?? ["", ""];
    return `注意：${reviewerName(review)} 现在收不到这项代审在等 TA 确认时的提醒和确认卡片（${cause}）。需要 TA 确认的步骤会一直等着，请提醒 TA ${fix}。`;
  }

  /** Sends what `send` says into the person's own chat, at most once a day for this kind; true when they have it. */
  async onceADay(
    person: Actor,
    via: ConversationRef,
    kind: string,
    send: (chat: Conversation) => Promise<void>,
  ): Promise<boolean> {
    const delegation = this.deps.store.reviewDelegation;
    if (!delegation.claimGithubNotice(person.userId, kind, BIND_NOTICE_SECONDS)) return true;
    const chat = await personalChat(this.deps, person, via);
    try {
      if (chat === undefined) throw new Error("no 1:1 chat with this person");
      await send(chat);
    } catch (err) {
      this.deps.logger.warn("the steps for a person a review needs could not be sent", { error: errorName(err) });
      delegation.releaseGithubNotice(person.userId, kind);
      return false;
    }
    return true;
  }

  /** The asker has no Primus key of their own linked, and a review runs on it: one line where asked, and the steps in their chat. */
  async requesterMustLink(
    via: ConversationRef,
    group: boolean,
    requester: Actor,
    conversation: Conversation,
    pulls: readonly PullRef[],
  ): Promise<void> {
    const lead =
      `You asked me${group ? " in a group chat" : ""} to have a colleague review and merge ${shorts(pulls)}, but your PrimusClaw ` +
      `account is not linked (the review runs on your own key), so I did nothing. 你${group ? "在群里" : ""}请我让同事 review 合入，` +
      "但你还没有 /link，所以我没有做任何事。\n\n";
    const person: UserRef = {
      id: requester.userId,
      channelUserId: requester.channelUserId,
      name: requester.name,
      email: "",
    };
    const sent = await this.onceADay(requester, via, "link", (chat) => this.deps.host.askLink(person, chat, lead));
    const again = group ? "再 @ 我一次" : "再发一次";
    const done = sent
      ? group
        ? `我已私信说明；完成后请${again}。`
        : `连接方式见上；完成后请${again}。`
      : `我没能私信你；请在 1:1 里给我发任意消息获取连接方式，完成后${again}。`;
    await say(
      this.deps,
      conversation,
      `${requester.name || "你"}：请同事 review 合入，需要你先用 \`/link\` 连接你的 PrimusClaw 账号（review 用你自己的 key 调用模型）。${done}`,
    );
  }

  /** The person named cannot be acted as yet: one line where asked and, once a day, the steps in their own chat. */
  async noGithub(
    via: ConversationRef,
    group: boolean,
    sender: UserRef,
    actor: Actor,
    pulls: readonly PullRef[],
    conversation: Conversation,
    known: boolean,
  ): Promise<void> {
    const who = actor.name || "对方";
    const steps =
      `${sender.name || "A colleague"} asked me${group ? " in a group chat" : ""} to review and merge ${shorts(pulls)} as you, but ` +
      "your GitHub account is not connected, so I did nothing. To allow it, send me `/github bind` here (it explains what you agree " +
      `to).\n\n${sender.name || "有同事"}${group ? "在群里" : ""}请我以你的名义 review 合入 ${shorts(pulls)}，但你还没有连接 GitHub，` +
      "所以我没有做任何事。如要允许，请在这里发 `/github bind`（会说明你同意的内容）。";
    const person: UserRef = { id: actor.userId, channelUserId: actor.channelUserId, name: actor.name, email: "" };
    const sent = await this.onceADay(actor, via, "bind", async (chat) => {
      await say(this.deps, chat, steps);
      // (not known to the identity service: the card that connects a Primus account follows)
      if (!known) await this.deps.host.connectIdentity(person, chat, "");
    });
    const again = group ? "再 @ 我一次" : "再发一次";
    await say(
      this.deps,
      conversation,
      `${who} 还没有绑定 GitHub，` +
        (sent
          ? `我已私信 TA 说明绑定方式；绑定后请${again}。`
          : `我没能私信 ${who}；请 ${who} 在 1:1 里给我发 \`/github bind\`，之后你${again}。`),
    );
  }
}
