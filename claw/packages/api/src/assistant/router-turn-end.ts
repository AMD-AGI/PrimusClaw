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
 * A turn that failed or was stopped and said nothing leaves the user with nothing either; for it the system says so in
 * its own words (`turnLostNotice`), once.
 *
 * Only for a turn that answers the user. A turn that a worker's report started may end without a word on purpose
 * (the prompt says to speak only when the user must decide something), and what a model writes then is not for them;
 * an item that needs the user and was not announced is the silent sweep's.
 *
 * Nor for a turn that handed a review to the person's channel (`turnHandedOffReview`): the channel answers that message itself, in
 * one message, so neither the turn's plain text nor a notice that it failed is said beside it.
 */
import pino from "pino";
import { db } from "../infra/db.js";
import { detectLanguage } from "./language.js";
import { SAY_TEXT_MAX, recordAssistantSay, recordSystemNotice, SayRefused, turnHandedOffReview, type SayDeps } from "./outbound.js";
import { internalTextIn, userWordsOf } from "./internal-text.js";
import { WORK_EVENT_PREFIX } from "./prompts.js";

const logger = pino({ name: "assistant-router-turn-end" });

export interface RouterTurnEnd {
  sessionId: string;
  /** The runs the completion closed. */
  runIds: string[];
  /** The message id of the turn that ended. */
  messageId?: string;
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
 * What a turn that ended in plain text is to say, if anything: the text, as a message, for a turn that answers the user.
 * A turn that only a worker's report started may end silent on purpose, and the text it wrote then is not for the user.
 * Pure, so the evaluation asks the same question the completion handler does.
 */
export function answerToDeliver(finalText: string | undefined, prompts: readonly string[]): string | null {
  const text = asMessage(finalText ?? "");
  // Every run started by a report, or no run at all, is nothing to answer.
  if (!text || prompts.every((p) => p.startsWith(WORK_EVENT_PREFIX))) return null;
  return text;
}

/**
 * Deliver what the Router wrote when it ended a turn that answers the user without saying anything. Returns
 * `said` when it did. A redelivered completion finds the message it stored and does nothing.
 */
/**
 * What the user is told when the turn answering them failed or was stopped before it said anything, in the language
 * of what they wrote. The system's words, so they say nothing of what the turn may have done before it stopped.
 */
export function turnLostNotice(prompts: readonly string[]): string | null {
  const own = prompts.filter((p) => !p.startsWith(WORK_EVENT_PREFIX));
  if (!own.length) return null;
  return detectLanguage(own.join("\n")) === "Chinese"
    ? "刚才这条没有处理成功，请再说一次。进行中的事项不受影响。"
    : "That message did not go through; please say it again. Your work items are not affected.";
}

export async function deliverUnsaidAnswer(end: RouterTurnEnd, deps: SayDeps = {}): Promise<"said" | "skipped"> {
  const lost = end.failed || end.interrupted || end.fromSweeper;
  const router = (await db.query("SELECT user_id FROM claw_assistants WHERE session_id = $1", [end.sessionId])).rows[0] as
    { user_id: string } | undefined;
  if (!router) return "skipped";
  const runs = (await db.query(
    `SELECT COALESCE(started_at, created_at) AS began, COALESCE(prompt, input->>'prompt', '') AS prompt, metadata->>'message_id' AS message_id
       FROM claw_tasks WHERE session_id = $1 AND task_id = ANY($2::text[]) AND origin = 'chat'`,
    [end.sessionId, end.runIds],
  )).rows as Array<{ began: Date; prompt: string; message_id: string | null }>;
  if (!runs.length) return "skipped";
  const prompts = runs.map((r) => r.prompt);
  let text = lost ? turnLostNotice(prompts) : answerToDeliver(end.finalText, prompts);
  if (!text) return "skipped";
  // The message the turn answered, as the completion names it, or as its runs were started for it (a sweeper's completion may not say).
  const answered = new Set([end.messageId, ...runs.map((r) => r.message_id)].filter((m): m is string => !!m));
  for (const messageId of answered) {
    if (await turnHandedOffReview((t, p) => db.query(t, p), router.user_id, messageId)) {
      logger.info({ sessionId: end.sessionId, runIds: end.runIds, lost }, "assistant.unsaid_answer_handed_off");
      return "skipped";
    }
  }
  // The router's own words with internal text in them (a tool name, an item_id, ...): never shown. The turn is answered with
  // the system's notice instead, as one that said nothing is (`say` would have refused the same text).
  const leaked = !lost && internalTextIn(text, userWordsOf(prompts));
  if (leaked) {
    logger.warn({ sessionId: end.sessionId, runIds: end.runIds, leaked }, "assistant.unsaid_answer_withheld");
    text = turnLostNotice(prompts);
    if (!text) return "skipped";
  }
  const began = new Date(Math.min(...runs.map((r) => new Date(r.began).getTime())));
  // The system's own messages are not the model's, so they do not count as the turn having spoken.
  const spoke = await db.query(
    "SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND NOT fallback AND created_at >= $2 LIMIT 1",
    [router.user_id, began],
  );
  if (spoke.rowCount) return "skipped";
  if (lost || leaked) {
    // Once per turn: a redelivered completion finds the notice it stored.
    const stored = await recordSystemNotice({
      userId: router.user_id, sessionId: end.sessionId, text, key: `turn_lost:${[...end.runIds].sort().join(",")}`,
    }, deps);
    if (stored) logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.turn_lost_notice_delivered");
    return stored ? "said" : "skipped";
  }
  try {
    await recordAssistantSay({ userId: router.user_id, sessionId: end.sessionId, text, turnMessageId: end.messageId }, deps);
  } catch (err) {
    // A refusal (the hourly cap) is the same answer the model's own say would have had, and the user was told of the cap
    // when it first refused them (`recordAssistantSay`); only a fault is worth a retry, and it is thrown for the caller's.
    if (err instanceof SayRefused) {
      logger.warn({ sessionId: end.sessionId, code: err.code }, "assistant.unsaid_answer_refused");
      return "skipped";
    }
    throw err;
  }
  logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.unsaid_answer_delivered");
  return "said";
}
