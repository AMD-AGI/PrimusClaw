// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of other features that a turn shows while it runs or after it ends: the approval card of a held tool call, the card
 * of an agent's question (both the approvals feature's), and the worker's own thumbs under a final answer (the feedback
 * feature's). The turn engine knows only this port, never those features' views; whoever assembles the worker passes the
 * features' implementation in. Each method returns the message to show; the turn sends it.
 */
import type { Lang } from "../locales/lang.js";
import type { JsonObject } from "../json.js";
import type { OutMessage } from "./surface.js";

/** A held tool call, as the turn engine passes it on (Python turn.py `permission_card(...)` arguments). */
export interface ApprovalAsk {
  /** The tool's name (Brain's `tool`, "tool" when it named none). */
  readonly tool: string;
  /** The call's input as Brain sent it. */
  readonly input: unknown;
  readonly sessionId: string;
  /** "" when Brain sent none. */
  readonly toolUseId: string;
  /** Asked in a group chat: everyone sees the card, only the owner may answer. */
  readonly group: boolean;
  /** The person whose turn it is ("" when not known). */
  readonly ownerName: string;
  /** Brain's permissionRequest event itself (summary, tool_description, intent). */
  readonly event: JsonObject;
  /** The card's language. */
  readonly lang: Lang;
}

/** An agent's question, as the turn engine passes it on (Python turn.py `question_card(card_questions(...), ...)` arguments). */
export interface QuestionAsk {
  /**
   * The questions as Brain sent them (its userQuestion event's `questions`), not yet read. The implementation reads them as
   * Python `card_questions` does (validates, drops what is malformed, limits questions and options) before it builds the
   * card: reading them is the approvals feature's, so the turn engine passes them on untouched.
   */
  readonly questions: unknown;
  readonly sessionId: string;
  /** The question's action id ("" when Brain sent none). */
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
}

export interface TurnCards {
  /** The approval card of a held tool call (Python render.py `permission_card`); its fallback text names the tool. */
  approval(ask: ApprovalAsk): OutMessage;
  /**
   * The card of an agent's question, with no note: Python turn.py's `question_card(card_questions(questions), session_id,
   * tool_use_id, group, owner_name)`, the reading included.
   */
  question(ask: QuestionAsk): OutMessage;
  /** The worker's own thumbs under a final answer, for a client whose thumbs never reach it (Python render.py `thumbs_card`). */
  thumbs(): OutMessage;
}
