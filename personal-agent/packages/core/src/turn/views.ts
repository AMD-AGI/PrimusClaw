// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The semantic views a turn shows besides its text. Each is rendered by the surface (a card in Teams); the kinds the turn
 * only asks for (an approval, a question, the thumbs) are rendered by the lines that own them (W5, W8).
 */

import type { Changes } from "./changes.js";
import type { Delivery } from "./deliveries.js";
import type { JsonObject } from "./json.js";
import type { View } from "./ports.js";

/** The tool whose call waits for the answer to a question card (Brain's userQuestion event). */
export const QUESTION_TOOL = "ask_user_question";

/** Brain holds a tool call for the user's decision (a permissionRequest): Approve / Deny. */
export interface ApprovalView extends View {
  readonly kind: "approval";
  readonly tool: string;
  readonly input: unknown;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
  /** Brain's permissionRequest: its summary, tool_description and intent say what will change. */
  readonly event: JsonObject;
  readonly lang: "en" | "zh";
}

/** The agent asks the user before it goes on (a userQuestion): its questions, as Brain sent them. */
export interface QuestionView extends View {
  readonly kind: "question";
  readonly questions: unknown;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
}

/** The chat's own thumbs under the final answer, for a user whose client does not send the chat's thumbs on (W8). */
export interface ThumbsView extends View {
  readonly kind: "thumbs";
}

/** A file the agent delivered, in a 1:1 chat: its name, size, caption, a small image, and Download. */
export interface DeliveryView extends View {
  readonly kind: "delivery";
  readonly delivery: Delivery;
  readonly url: string;
}

/** What the session changed, under a finished answer: Create PR and Open diff in Claw. */
export interface ChangesView extends View {
  readonly kind: "changes";
  readonly changes: Changes;
  readonly sessionId: string;
  readonly publicBaseUrl: string;
}

export type TurnView = ApprovalView | QuestionView | ThumbsView | DeliveryView | ChangesView;
