// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The answer to a tool-approval request, as the web client sends it:
 *
 *   POST /v1/sessions/:id/messages
 *   { messageType: "decision",
 *     extData: { tool_use_id, action, reason?, edited_input? } }
 *
 * and as Brain's decision dispatcher reads it from `decision.<sessionId>`.
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

const ACTIONS = new Set(["allow", "deny", "always_allow", "skip", "edit"]);

export function buildDecisionMessage(
  sessionId: string,
  userId: string,
  body: Record<string, unknown>,
): { ok: true; message: DecisionNatsMessage } | { ok: false; error: string } {
  const ext = (body.extData && typeof body.extData === "object" ? body.extData : {}) as Record<string, unknown>;
  const actionId = String(ext.tool_use_id ?? ext.action_id ?? body.actionId ?? body.action_id ?? "");
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
