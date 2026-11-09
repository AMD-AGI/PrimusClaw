// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The approval and question views any feature may show (a turn's permission request, a remote agent's, a work item's). The
 * channel adapter renders them; `approvalView` (approval-view.ts) is what an approval card says.
 */
import type { JsonObject } from "../json.js";
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
}

declare module "../ports/surface.js" {
  interface ViewMap {
    approval: ApprovalCardModel;
    question: QuestionCardModel;
  }
}
