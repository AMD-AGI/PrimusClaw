// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The answer to a tool-approval request, and to a question the model asked
 * with `ask_user_question`, as a client sends them:
 *
 *   POST /v1/sessions/:id/messages
 *   { messageType: "decision",
 *     extData: { tool_use_id, action, reason?, edited_input? } }
 *   { messageType: "answer",
 *     extData: { tool_use_id, answers: { <question id>: <answer> }, skipped?: [<question id>] } }
 *
 * and as Brain's decision dispatcher reads them from `decision.<sessionId>`.
 * Pure, so the mapping can be tested without a NATS connection.
 */

export interface DecisionNatsMessage {
  type: "decision";
  session_id: string;
  user_id: string;
  action_id: string;
  decision: "allow" | "deny" | "edit" | "skip";
  feedback: string;
  edited_input?: Record<string, unknown>;
  /** Session-scoped "always allow this tool". */
  remember?: boolean;
}

export interface AnswerNatsMessage {
  type: "answer";
  session_id: string;
  user_id: string;
  action_id: string;
  answers: Record<string, unknown>;
  skipped: string[];
}

const ACTIONS = new Set(["allow", "deny", "always_allow", "skip", "edit"]);

function extDataOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.extData && typeof body.extData === "object" ? body.extData : {}) as Record<string, unknown>;
}

function actionIdOf(body: Record<string, unknown>, ext: Record<string, unknown>): string {
  return String(ext.tool_use_id ?? ext.action_id ?? body.actionId ?? body.action_id ?? "");
}

export function buildDecisionMessage(
  sessionId: string,
  userId: string,
  body: Record<string, unknown>,
): { ok: true; message: DecisionNatsMessage } | { ok: false; error: string } {
  const ext = extDataOf(body);
  const actionId = actionIdOf(body, ext);
  const action = String(ext.action ?? body.decision ?? "");
  if (!actionId) return { ok: false, error: "extData.tool_use_id is required" };
  if (!ACTIONS.has(action)) {
    return { ok: false, error: "extData.action must be allow, deny, always_allow, skip, or edit" };
  }
  const message: DecisionNatsMessage = {
    type: "decision",
    session_id: sessionId,
    user_id: userId,
    action_id: actionId,
    decision: action === "always_allow" ? "allow" : (action as DecisionNatsMessage["decision"]),
    feedback: typeof ext.reason === "string" ? ext.reason : "",
  };
  if (action === "always_allow") message.remember = true;
  if (action === "edit") {
    const edited = ext.edited_input;
    if (!edited || typeof edited !== "object" || Array.isArray(edited)) {
      return { ok: false, error: "extData.edited_input is required when action is edit" };
    }
    message.edited_input = edited as Record<string, unknown>;
  }
  return { ok: true, message };
}

export function buildAnswerMessage(
  sessionId: string,
  userId: string,
  body: Record<string, unknown>,
): { ok: true; message: AnswerNatsMessage } | { ok: false; error: string } {
  const ext = extDataOf(body);
  const actionId = actionIdOf(body, ext);
  if (!actionId) return { ok: false, error: "extData.tool_use_id is required" };
  const answers = ext.answers ?? body.answers ?? {};
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { ok: false, error: "extData.answers must be an object keyed by question id" };
  }
  const skipped = ext.skipped ?? body.skipped ?? [];
  if (!Array.isArray(skipped) || skipped.some((id) => typeof id !== "string")) {
    return { ok: false, error: "extData.skipped must be a list of question ids" };
  }
  return {
    ok: true,
    message: {
      type: "answer",
      session_id: sessionId,
      user_id: userId,
      action_id: actionId,
      answers: answers as Record<string, unknown>,
      skipped: skipped as string[],
    },
  };
}
