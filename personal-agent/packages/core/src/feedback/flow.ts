// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { commandArgs } from "../commands/parse.js";
import { isKnownCommand } from "../commands/names.js";
import { FEEDBACK_TEXT as T } from "../locales/feedback.js";
import type { Logger } from "../ports/logger.js";
import type { ClickHandler, ClickRoute, MessageInterceptor, MessageRoute } from "../ports/routing.js";
import type { FeedbackRepository } from "../ports/store/feedback.js";
import { textMessage, type OutMessage } from "../ports/surface.js";
import { pySplit } from "../text/py-text.js";
import type { FeedbackReporting } from "./reporting.js";
import type { FeedbackService, OfferOutcome } from "./service.js";

/**
 * `/feedback [TEXT]` and the question a bare `/feedback` asks, the Report a problem button, and Yes/No under the offer
 * to add the last question and answer. The thumbs are `thumbs.ts`.
 */

export interface FeedbackFlowDeps {
  readonly reports: FeedbackRepository;
  readonly reporting: FeedbackReporting;
  readonly service: FeedbackService;
  readonly log: Logger;
  /** The bot's name in this deployment (`Settings.botName`). */
  readonly botName: string;
}

export class FeedbackFlow {
  constructor(private readonly deps: FeedbackFlowDeps) {}

  /** The interceptor of 1:1 and group chats: before the account check, so an unlinked person can report too. */
  readonly interceptor: MessageInterceptor = {
    name: "feedback",
    intercept: (route) => this.entry(route),
  };

  /** Report a problem (both chats) and the offer's Yes/No (1:1, with the person's credential). */
  readonly clicks: ClickHandler = {
    verbs: ["report", "feedback"],
    beforeCredential: async (click) => {
      if (click.action.data["primusclaw"] !== "report") return false;
      await this.reportClick(click);
      return true;
    },
    withCredential: (click, credential) => this.offerClick(click, credential),
    inGroup: async (click) => {
      if (click.action.data["primusclaw"] !== "report") return false;
      await this.reportClick(click);
      return true;
    },
  };

  /** True when the message was feedback: `/feedback [TEXT]`, or the answer to "What went wrong?". */
  async entry(route: MessageRoute): Promise<boolean> {
    const { sender, scope, text, conversation } = route;
    const { reports } = this.deps;
    let arg = commandArgs(text, "feedback");
    if (arg === null) {
      if (!reports.hasFeedbackAsk(sender.id, scope)) return false;
      const word = (pySplit(text)[0] ?? "").toLowerCase();
      if (word.startsWith("/") && isKnownCommand(word.slice(1))) {
        reports.takeFeedbackAsk(sender.id, scope); // another command: the question is dropped
        return false;
      }
      if (!text || !reports.takeFeedbackAsk(sender.id, scope)) return false;
      arg = text;
    } else {
      reports.takeFeedbackAsk(sender.id, scope); // an older open question is replaced by this message
    }
    if (!arg) {
      reports.openFeedbackAsk(sender.id, scope);
      await conversation.send(textMessage(T.whatWentWrong));
      return true;
    }
    await this.deps.reporting.file(route, arg);
    return true;
  }

  /**
   * Report a problem: the same question as a bare /feedback. The button is looked up in the store, so a group member
   * other than the one whose message went wrong cannot use it. Every outcome replaces the clicked card.
   */
  private async reportClick(click: ClickRoute): Promise<void> {
    const { sender, scope, conversation } = click;
    const promptId = typeof click.action.data["prompt"] === "string" ? click.action.data["prompt"] : "";
    const prompt = this.deps.reports.getFeedbackPrompt(promptId);
    let outcome: string;
    let closing: OutMessage | string;
    if (prompt === null || prompt.scope !== scope) {
      outcome = "inactive";
      closing = T.reportInactiveNote;
      await conversation.send(textMessage(T.reportInactive));
    } else if (prompt.userId !== sender.id) {
      outcome = "not the asker";
      closing = reportMessage(promptId, Boolean(scope)); // the asker's button stays as it was
      await conversation.send(textMessage(T.reportNotAsker));
    } else {
      outcome = "asked";
      closing = T.reportAsked;
      this.deps.reports.openFeedbackAsk(sender.id, scope);
      await conversation.send(
        textMessage(scope ? T.whatWentWrongInGroup({ bot: this.deps.botName }) : T.whatWentWrong),
      );
    }
    const replaced = await click.settle(closing, { announce: false });
    this.deps.log.info("feedback report button", {
      outcome,
      chat: scope ? "group" : "1:1",
      card: replaced ? "replaced" : "not replaced",
    });
  }

  /** Yes or No under the offer: read from the store (its owner, issue and turn), the conversation with the clicker's key. */
  private async offerClick(click: ClickRoute, credential: string): Promise<void> {
    const offerId = typeof click.action.data["offer"] === "string" ? click.action.data["offer"] : "";
    const include = click.action.data["include"] === true;
    const [outcome, issueNumber] = await this.deps.service.answerOffer(click.sender.id, credential, offerId, include);
    if (outcome === "retry") {
      const note = T.offerRetry;
      const card: OutMessage = {
        body: {
          type: "view",
          view: { name: "feedbackOfferRetry", model: { offerId, issueNumber, note } },
          fallbackText: note,
        },
      };
      await click.settle(card, { fallback: note });
      return;
    }
    await click.settle(offerOutcomeText(outcome, issueNumber));
  }
}

export function offerOutcomeText(outcome: Exclude<OfferOutcome, "retry">, issueNumber: number): string {
  switch (outcome) {
    case "added":
      return T.offerAdded({ number: issueNumber });
    case "declined":
      return T.offerDeclined({ number: issueNumber });
    case "empty":
      return T.offerEmpty({ number: issueNumber });
    case "invalid":
      return T.offerInvalid;
  }
}

/** The Report a problem card, as a message. */
export function reportMessage(promptId: string, group: boolean): OutMessage {
  return {
    body: {
      type: "view",
      view: { name: "feedbackReport", model: { promptId, group } },
      fallbackText: "Did something go wrong? You can tell the PrimusClaw team.",
    },
  };
}
