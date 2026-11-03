// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router turn that ended with words and no message.
 *
 * Only `say` reaches the user, and the Router is told so, yet once in a few hundred turns a model answers in plain
 * text and ends. The user wrote, the turn ran and finished, and they hear nothing. The words are the answer it meant
 * to give, so the end of such a turn delivers them through the one door there is, `recordAssistantSay`, and the turn
 * is neither retried nor lost: a retry is another model call that may fail the same way, and the text is already
 * in hand.
 *
 * Only for a turn that answers the user. A turn that a worker's report started may end without a word on purpose
 * (the prompt says to speak only when the user must decide something), and what a model writes then is not for them;
 * an item that needs the user and was not announced is the silent sweep's.
 */
import pino from "pino";
import { db } from "../infra/db.js";
import { SAY_TEXT_MAX, recordAssistantSay, SayRefused, type SayDeps } from "./outbound.js";
import { WORK_EVENT_PREFIX } from "./prompts.js";

const logger = pino({ name: "assistant-router-turn-end" });

export interface RouterTurnEnd {
  sessionId: string;
  /** The runs the completion closed. */
  runIds: string[];
  failed: boolean;
  interrupted: boolean;
  /** The completion was written by the sweeper for a run that never reported, so its text is a placeholder and not the model's. */
  fromSweeper?: boolean;
  /** What the model wrote outside any tool. */
  finalText?: string;
}

/**
 * The text as a message: one that is too long for `say` is cut where it fits, not refused. Cut in the unit `say` counts
 * (UTF-16 code units), and never inside a character.
 */
function asMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SAY_TEXT_MAX) return trimmed;
  let kept = "";
  for (const char of trimmed) {
    if (kept.length + char.length > SAY_TEXT_MAX - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * Deliver what the Router wrote when it ended a turn that answers the user without saying anything. Returns
 * `said` when it did. A redelivered completion finds the message it stored and does nothing.
 */
export async function deliverUnsaidAnswer(end: RouterTurnEnd, deps: SayDeps = {}): Promise<"said" | "skipped"> {
  const text = asMessage(end.finalText ?? "");
  if (end.failed || end.interrupted || end.fromSweeper || !text) return "skipped";
  const router = (await db.query("SELECT user_id FROM claw_assistants WHERE session_id = $1", [end.sessionId])).rows[0] as
    { user_id: string } | undefined;
  if (!router) return "skipped";
  const runs = (await db.query(
    `SELECT COALESCE(started_at, created_at) AS began, COALESCE(prompt, input->>'prompt', '') AS prompt
       FROM claw_tasks WHERE session_id = $1 AND task_id = ANY($2::text[]) AND origin = 'chat'`,
    [end.sessionId, end.runIds],
  )).rows as Array<{ began: Date; prompt: string }>;
  if (!runs.length || runs.every((r) => r.prompt.startsWith(WORK_EVENT_PREFIX))) return "skipped";
  const began = new Date(Math.min(...runs.map((r) => new Date(r.began).getTime())));
  // The system's own messages are not the model's, so they do not count as the turn having spoken.
  const spoke = await db.query(
    "SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND NOT fallback AND created_at >= $2 LIMIT 1",
    [router.user_id, began],
  );
  if (spoke.rowCount) return "skipped";
  try {
    await recordAssistantSay({ userId: router.user_id, sessionId: end.sessionId, text }, deps);
  } catch (err) {
    // A refusal (the hourly cap) is the same answer the model's own say would have had; only a fault is worth a retry.
    if (err instanceof SayRefused) {
      logger.warn({ sessionId: end.sessionId, code: err.code }, "assistant.unsaid_answer_refused");
      return "skipped";
    }
    throw err;
  }
  logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.unsaid_answer_delivered");
  return "said";
}
