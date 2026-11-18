// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The approvals feature's half of the turn's `TurnCards`: the card of a held tool call (Python render.py `permission_card`) and
 * of an agent's question (turn.py `question_card(card_questions(questions), ...)`, the questions read here). The feedback
 * feature brings `thumbs`; whoever assembles the worker joins the two.
 */
import type { ApprovalAsk, QuestionAsk, TurnCards } from "../ports/turn-cards.js";
import type { OutMessage } from "../ports/surface.js";
import { viewMessage } from "./click.js";
import { QUESTION_TOOL, cardQuestions } from "./questions.js";

export const approvalTurnCards: Pick<TurnCards, "approval" | "question"> = {
  approval(ask: ApprovalAsk): OutMessage {
    const { tool, input, sessionId, toolUseId, group, ownerName, event, lang } = ask;
    return viewMessage(
      { name: "approval", model: { tool, input, sessionId, toolUseId, group, ownerName, event, lang } },
      tool,
    );
  },
  question(ask: QuestionAsk): OutMessage {
    const { sessionId, toolUseId, group, ownerName } = ask;
    return viewMessage(
      {
        name: "question",
        model: {
          questions: cardQuestions(ask.questions),
          sessionId,
          toolUseId,
          group,
          ownerName,
          note: "",
          typedReply: true,
        },
      },
      QUESTION_TOOL,
    );
  },
};
