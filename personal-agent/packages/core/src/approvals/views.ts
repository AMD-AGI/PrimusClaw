// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The approval and question views any feature may show (a turn's permission request, a remote agent's, a work item's). The
 * channel adapter renders them; `approvalView` (approval-view.ts) is what an approval card says.
 */
import type { JsonObject } from "../json.js";
import type { Lang } from "../locales/lang.js";
import type { CardQuestion } from "./questions.js";

/** An approval card: the arguments of the Python worker's `render.permission_card`, one for one. */
export interface ApprovalCardModel {
  readonly tool: string;
  readonly input: unknown;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  /** Who alone can answer it in a group ("" for "the person who asked"). */
  readonly ownerName: string;
  /** Brain's permissionRequest (summary, tool_description, intent, approval_label); null when there is none. */
  readonly event: JsonObject | null;
  /** "zh" or "en"; null to follow the summary's language. */
  readonly lang: string | null;
}

/** A question card: the arguments of `render.question_card`. */
export interface QuestionCardModel {
  readonly questions: readonly CardQuestion[];
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
  /** A line under the header: which task asks, or what happened when the card comes back after a click ("" when none). */
  readonly note: string;
  /**
   * The card says it can also be answered by a message in the chat: a turn's question, which a typed message answers
   * (`routing/question-reply.ts`). A work item's question is answered on its card only.
   */
  readonly typedReply?: boolean;
}

/** What replaces an approval card once it was answered (render.decided_card). */
export interface ApprovalDecidedModel {
  readonly tool: string;
  /** "allow" or "deny". */
  readonly action: string;
  /** When it was answered, epoch seconds, shown as HH:MM in `zone`. */
  readonly when: number;
  readonly zone: string;
}

/** An approval or a question that ran out (render.expired_card). */
export interface ApprovalExpiredModel {
  readonly tool: string;
}

/** What replaces a question card once it was answered (render.answered_card). */
export interface QuestionAnsweredModel {
  /** (question id, answer), in the order of the questions. */
  readonly answers: readonly (readonly [string, string])[];
  readonly when: number;
  readonly zone: string;
  /** Answered by a message typed in the chat (not on the card), in this language: the card says "Answered: <answer>". */
  readonly replied?: Lang;
}

/** An approval card put back after a press that did not go through: the note, then Approve and Deny again. */
export interface ApprovalAgainModel {
  readonly text: string;
  readonly tool: string;
  readonly sessionId: string;
  readonly toolUseId: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    approval: ApprovalCardModel;
    approvalAgain: ApprovalAgainModel;
    approvalDecided: ApprovalDecidedModel;
    approvalExpired: ApprovalExpiredModel;
    question: QuestionCardModel;
    questionAnswered: QuestionAnsweredModel;
  }
}
