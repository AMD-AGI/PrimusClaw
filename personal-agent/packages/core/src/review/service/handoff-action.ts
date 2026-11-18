// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review the person's assistant handed back (`review_for_other`, an `assistant.action` with a typed `review`): the assistant
 * understood the message, and the review runs on the reviewer's own credentials, which only this worker holds (teams_agent/agent.py
 * `_review_handoff`, `_run_handoff`). It is started exactly as the same request typed here would be, only for a message this worker
 * sent for this person that declared the handoff, only of someone that message named, and once per event id. It runs in the
 * background (a review's checks outlast a delivery) and answers in one message: the assistant says nothing about it, so the answer
 * closes the receipt under the person's message when that is still open.
 */

import { ReceiptConversation, type Receipts } from "../../assistant/receipts.js";
import { errorName } from "../../errors.js";
import type { InboundMessage, UserRef } from "../../ports/surface.js";
import { textMessage } from "../../ports/surface.js";
import { pyRepr, pyStr } from "../../text/py-json.js";
import { parseReviewHandoff, REVIEW_HANDOFF, type ReviewHandoff } from "../handoff.js";
import { stored } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import type { GithubReview } from "./github-review.js";

const FAILED =
  "这次代审我这边出了问题，没有开始。请稍后再说一次。 / Something went wrong on my side, so that review " +
  "did not start. Please ask again in a moment.";

export interface HandoffActionDeps {
  readonly review: Pick<GithubReview, "handoff">;
  readonly receipts: Receipts;
  /** The assistant understands the person's messages. */
  readonly understands: (userId: string) => boolean;
  /** The person's assistant can answer them. */
  readonly reachable: (userId: string) => boolean;
}

type Event = Readonly<Record<string, unknown>>;

function record(value: unknown): Event {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Event) : {};
}

export class ReviewHandoffAction {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: ReviewDeps,
    private readonly action: HandoffActionDeps,
  ) {}

  /** Settles when every handoff taken so far has run. For tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  /** The handoff `event` for `userId`, taken and started in the background ('delivered'), or 'dropped'. */
  take(userId: string, event: Event): "delivered" | "dropped" {
    const { store, logger } = this.deps;
    const channelMessageId = pyStr(event["channel_message_id"]);
    const sent = store.assistantMessages.assistantMessage(channelMessageId);
    const handoff = parseReviewHandoff(event["review"]);
    const reference = store.references.getReference(userId);
    const conversation = reference === null ? undefined : stored(this.deps, reference);
    if (
      handoff === undefined ||
      record(event["action"])["name"] !== REVIEW_HANDOFF ||
      sent === null ||
      sent.userId !== userId ||
      !sent.actions.has(REVIEW_HANDOFF) ||
      !store.assistantMessages.assistantMessagePeople(channelMessageId).has(handoff.reviewerUserId) ||
      !this.action.understands(userId) ||
      !this.action.reachable(userId) ||
      conversation === undefined
    ) {
      logger.warn(
        "a review handed back by the assistant was not taken: not for a message this chat sent and declared it for",
      );
      return "dropped";
    }
    if (!store.idempotency.claimProcessed(`assistant-action:${eventId(event["event_id"])}`)) return "dropped";
    const { receipts } = this.action;
    const answer = new ReceiptConversation(
      conversation,
      receipts,
      receipts.reserve(conversation.ref.id, channelMessageId),
      handoff.said,
    );
    const sender: UserRef = { id: userId, channelUserId: "", name: store.members.memberName(userId) ?? "", email: "" };
    const task = this.run(inboundOf(`${channelMessageId}-review`, sender, answer), sender, answer, handoff);
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
    return "delivered";
  }

  private async run(
    message: InboundMessage,
    sender: UserRef,
    answer: ReceiptConversation,
    handoff: ReviewHandoff,
  ): Promise<void> {
    const { logger } = this.deps;
    try {
      await this.action.review.handoff(message, sender, answer, handoff);
    } catch (err) {
      logger.error("a review handed back by the assistant failed", { error: errorName(err) });
      try {
        await answer.send(textMessage(FAILED));
      } catch (again) {
        logger.warn("telling the user that the review did not start did not work either", { error: errorName(again) });
      }
    } finally {
      try {
        await answer.sayPostscript(); // (nothing carried what the assistant said beside it: said on its own)
      } catch (err) {
        logger.warn("what the assistant said beside a handed-back review could not be sent", { error: errorName(err) });
      }
      answer.release(); // (said nothing: the receipt closes as any other, by a reply or at its own limit)
    }
  }
}

/** The handed-back request as a message of the person's 1:1 chat, with the id the review's records key on. */
function inboundOf(id: string, sender: UserRef, answer: ReceiptConversation): InboundMessage {
  return {
    type: "message",
    id,
    sender,
    conversation: answer.ref,
    locale: "",
    clientPlatform: "",
    text: "",
    mentioned: false,
    targeted: false,
    namesBotFirst: false,
    conversationName: "",
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    unreadableFiles: [],
    provenance: "typed",
  };
}

/** Python's f-string of the event id (`None` for none). */
function eventId(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value ?? null);
}
