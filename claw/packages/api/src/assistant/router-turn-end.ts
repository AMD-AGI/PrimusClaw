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
 * an item that needs the user and was not announced is the silent sweep's. Except an answer (`tellUnsaidAnswers`): a report
 * of kind `answer` closes its item with what the user asked for, and nothing else will tell them. A turn woken to say one that
 * ended without saying it -- stopped for the user's next message (`preemptReportTurn`), failed, or written in plain text -- has
 * the system say it in its own words at once, not the silent sweep five minutes later (release gate run 1108021655-0c1088:
 * the file was delivered, the router's line said its content would follow, and nothing followed inside the scenario).
 *
 * Nor for a turn that handed a review to the person's channel (`turnHandedOffReview`): the channel answers that message itself, in
 * one message, so neither the turn's plain text nor a notice that it failed is said beside it.
 */
import pino from "pino";
import { db } from "../infra/db.js";
import { detectLanguage } from "./language.js";
import {
  ANSWERED_UNSAID_SQL, SAY_TEXT_MAX, publishSayEvent, recordAssistantSay, recordNeedsYouFallback, recordSystemNotice, SayRefused,
  turnHandedOffReview, type SayDeps,
} from "./outbound.js";
import { citedNumbers } from "./citations.js";
import { internalTextIn, userWordsOf } from "./internal-text.js";
import { answerEventItemOf, TOOL_NAME_PREFIX, WORK_EVENT_PREFIX } from "./prompts.js";
import { ROUTER_ASSISTANT_READS, ROUTER_SPEAK_TOOL } from "./read-tools.js";
import { releaseHeldSays } from "./say-hold.js";
import { voidStreamedSay } from "./router-speed.js";
import { textShown } from "./lookup-ack.js";
import { kickDelivery } from "../notifications/outbox.js";
import { metrics } from "../infra/metrics.js";

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
 * The text without the [n] it cites: plain text carries no sources (only `say` does), so each [n] would reach the user as a number that
 * links nowhere (citations follow-up #8). Only the numbers the text cites on their own (`citedNumbers`), each with the space before it;
 * one right after a name (`a[1]`) is left.
 */
export function withoutBareCitations(text: string): string {
  const cited = citedNumbers(text);
  if (!cited.size) return text;
  // After a space, or after anything but a name or a closing bracket: `a[1]` is an index, not a citation.
  return text.replace(/(?:[ \t]|(?<![A-Za-z_\])]))\[(\d{1,2})\](?![(:])/g, (whole, n: string) => (cited.has(Number(n)) ? "" : whole));
}

/**
 * What a turn that ended in plain text is to say, if anything: the text, as a message, for a turn that answers the user.
 * A turn that only a worker's report started may end silent on purpose, and the text it wrote then is not for the user.
 * Pure, so the evaluation asks the same question the completion handler does.
 */
export function answerToDeliver(finalText: string | undefined, prompts: readonly string[]): string | null {
  const text = asMessage(withoutBareCitations(finalText ?? ""));
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
export function turnLostNotice(prompts: readonly string[], why: TurnLostWhy = "failed"): string | null {
  const own = prompts.filter((p) => !p.startsWith(WORK_EVENT_PREFIX));
  if (!own.length) return null;
  const chinese = detectLanguage(own.join("\n")) === "Chinese";
  if (why === "declined") {
    return chinese
      ? "这个请求我不能处理：它可能涉及访问内部地址、凭据或其他不安全的操作，所以我没有执行。换个问题或说明你想达到的目的，我可以继续帮你。进行中的事项不受影响。"
      : "I can't help with that request: it may involve reaching internal addresses, credentials or something else unsafe, so I did not do it. Ask something else or tell me what you want to achieve, and I'll help. Your work items are not affected.";
  }
  return chinese
    ? "刚才这条没有处理成功，请再说一次。进行中的事项不受影响。"
    : "That message did not go through; please say it again. Your work items are not affected.";
}

/** Why a turn that answers the user ended without a word: it failed, or the model declined to answer at all. */
export type TurnLostWhy = "failed" | "declined";

/**
 * What Brain ends a run with when its model answered nothing twice in a row (or on its last turn): no text and no tool call
 * (`EmptyAgentTurnError` in `brain/src/agent/agent-loop.ts`, whose words are the run's final text). On a router turn that is the
 * model declining the request (a refusal comes back empty), not a fault: asking again gets the same, so the user is told it was
 * declined instead of being asked to say it again (2026-11-06 baseline, real-general-sec-136).
 */
export const EMPTY_TURN_TEXT_RE = /\bended (?:its|its last allowed) turn without any text or tool call\b/i;

/** Why the turn ended silent, from how it ended. Pure, for the tests. */
export function lostWhy(end: Pick<RouterTurnEnd, "failed" | "interrupted" | "fromSweeper" | "finalText">): TurnLostWhy {
  return end.failed && !end.interrupted && !end.fromSweeper && EMPTY_TURN_TEXT_RE.test(end.finalText ?? "") ? "declined" : "failed";
}

export async function deliverUnsaidAnswer(end: RouterTurnEnd, deps: SayDeps = {}): Promise<"said" | "skipped"> {
  let out = await deliverUnsaid(end, deps);
  // After what the turn held was released (in `deliverUnsaid`): a say it made about the answer is then the one found.
  if (await tellUnsaidAnswers(end, deps) > 0) out = "said";
  // After the delivery, so the timing counts what it sent; never in its way.
  try {
    const timing = await routerTurnTiming(end);
    if (timing) logger.info({ sessionId: end.sessionId, runIds: end.runIds, ...timing }, "assistant.router_turn_timing");
  } catch (err) {
    logger.warn({ err, sessionId: end.sessionId }, "assistant.router_turn_timing_failed");
  }
  return out;
}

/**
 * The answers this turn was woken to say (a report of kind `answer`, `formatWorkEvent`) that nobody said: the item is closed and
 * answered, and no message about its current need was stored -- not the router's (`say` records the item an answer woke it for even
 * when it names none), not the system's (`storeAnswerWhole`, a long answer or one that came with files). Each is said now in the
 * system's words (`recordNeedsYouFallback`: the silent sweep's message under the same id, so it is said once whoever says it first),
 * however the turn ended. Returns how many were said.
 */
export async function tellUnsaidAnswers(end: Pick<RouterTurnEnd, "sessionId" | "runIds">, deps: SayDeps = {}): Promise<number> {
  const runs = (await db.query(
    `SELECT a.user_id, COALESCE(t.prompt, t.input->>'prompt', '') AS prompt
       FROM claw_tasks t JOIN claw_assistants a ON a.session_id = t.session_id
      WHERE t.session_id = $1 AND t.task_id = ANY($2::text[]) AND t.origin = 'chat'`,
    [end.sessionId, end.runIds],
  )).rows as Array<{ user_id: string; prompt: string }>;
  const items = [...new Set(runs.map((r) => answerEventItemOf(r.prompt)).filter((i): i is string => !!i))];
  if (!items.length) return 0;
  const unsaid = (await db.query(
    `SELECT w.item_id FROM claw_work_items w
      WHERE w.item_id = ANY($1::text[]) AND w.user_id = $2 AND w.kind <> 'remote' AND (${ANSWERED_UNSAID_SQL})
        AND NOT EXISTS (SELECT 1 FROM claw_assistant_says s WHERE s.item_id = w.item_id AND s.item_attention_seq = w.attention_seq)`,
    [items, runs[0].user_id],
  )).rows as Array<{ item_id: string }>;
  let told = 0;
  for (const { item_id: itemId } of unsaid) {
    if (!(await recordNeedsYouFallback({ itemId }, deps))) continue;
    told += 1;
    logger.warn({ sessionId: end.sessionId, runIds: end.runIds, itemId }, "assistant.unsaid_report_answer_told");
    metrics.onAssistantRouterUnsaid("report_answer");
  }
  return told;
}

/**
 * How quickly a router turn that answered the user was heard (B7): from the user's message (the run's creation) to the first message
 * the user got from this turn, and to the last; how many there were, how many were the system's own (a started item's notice, a
 * notice for a lost turn); and whether the turn started an item. One log line per turn (`assistant.router_turn_timing`), the
 * measurement the first-reply target (p90 under 5 s) is read from. Null for a turn that is not a router's answer to the user.
 */
export async function routerTurnTiming(end: Pick<RouterTurnEnd, "sessionId" | "runIds" | "failed" | "interrupted">): Promise<{
  first_reply_ms: number | null; final_reply_ms: number | null; replies: number; system_replies: number; items_started: number;
  failed: boolean; interrupted: boolean;
} | null> {
  const router = (await db.query("SELECT user_id FROM claw_assistants WHERE session_id = $1", [end.sessionId])).rows[0] as
    { user_id: string } | undefined;
  if (!router) return null;
  const runs = (await db.query(
    `SELECT created_at, COALESCE(prompt, input->>'prompt', '') AS prompt
       FROM claw_tasks WHERE session_id = $1 AND task_id = ANY($2::text[]) AND origin = 'chat'`,
    [end.sessionId, end.runIds],
  )).rows as Array<{ created_at: Date; prompt: string }>;
  if (!runs.length || runs.every((r) => r.prompt.startsWith(WORK_EVENT_PREFIX))) return null;
  const asked = new Date(Math.min(...runs.map((r) => new Date(r.created_at).getTime())));
  // Now, not the run's completion: the message delivered for a turn that ended silent is stored just after it.
  const ended = new Date();
  const says = (await db.query(
    `SELECT created_at, fallback FROM claw_assistant_says
      WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at`,
    [router.user_id, asked, ended],
  )).rows as Array<{ created_at: Date; fallback: boolean }>;
  const items = Number((await db.query(
    "SELECT count(*)::int AS n FROM claw_work_items WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3",
    [router.user_id, asked, ended],
  )).rows[0].n);
  const ms = (d: Date | undefined) => (d ? new Date(d).getTime() - asked.getTime() : null);
  return {
    first_reply_ms: ms(says[0]?.created_at), final_reply_ms: ms(says.at(-1)?.created_at), replies: says.length,
    system_replies: says.filter((x) => x.fallback).length, items_started: items, failed: end.failed, interrupted: end.interrupted,
  };
}

/** The tools of a router turn that read (its lookups, the assistant's own reads): what a say written before cannot have answered from. */
function isLookup(tool: string): boolean {
  if (tool === "web_search" || tool === "web_fetch") return true;
  if (tool.startsWith(TOOL_NAME_PREFIX)) return ROUTER_ASSISTANT_READS.includes(tool.slice(TOOL_NAME_PREFIX.length));
  return tool.startsWith("mcp__");
}

/**
 * Whether everything the turn answering `messageIds` said came before its last lookup answered, read from the session's stored
 * events in the order Brain emitted them: the last `say` that went out (not one that failed or was refused) is earlier than the last
 * lookup that ended, whether it answered or failed. False when the turn made no lookup, or its events say nothing either way.
 */
export async function saidOnlyBeforeLookups(sessionId: string, messageIds: ReadonlySet<string>): Promise<boolean> {
  if (!messageIds.size) return false;
  const rows = (await db.query(
    `SELECT id, data->>'tool' AS tool, data->>'status' AS status, data->>'is_error' AS is_error, data->>'description' AS description
       FROM claw_session_events
      WHERE session_id = $1 AND event = 'toolUsed' AND deleted_at IS NULL AND data->>'message_id' = ANY($2::text[])
        AND data->>'status' IS DISTINCT FROM 'start'
      ORDER BY id`,
    [sessionId, [...messageIds]],
  )).rows as Array<{ id: string; tool: string | null; status: string | null; is_error: string | null; description: string | null }>;
  let lastSay = -1;
  let lastLookup = -1;
  rows.forEach((row, i) => {
    if (!row.tool) return;
    const failed = row.status === "error" || row.is_error === "true";
    if (row.tool === `${TOOL_NAME_PREFIX}${ROUTER_SPEAK_TOOL}`) {
      // Only a say that went out is one the person holds.
      if (!failed && !/^\s*\{\s*"ok"\s*:\s*false/.test(row.description ?? "")) lastSay = i;
    } else if (isLookup(row.tool)) {
      // A lookup that failed ended too: what the turn wrote after it (that it could not find out) is still its answer.
      lastLookup = i;
    }
  });
  return lastSay >= 0 && lastLookup > lastSay;
}

/**
 * What the person is told when the turn answering them looked things up and then ended with no word and no text (the 2026-11-06 peer
 * run, bczh-202: eleven web lookups and no reply at all). In the language of what they wrote; the system's words, so they claim nothing
 * the turn found. Null for a turn a report started. Pure, for the tests.
 */
export function silentTurnNotice(prompts: readonly string[]): string | null {
  const own = prompts.filter((p) => !p.startsWith(WORK_EVENT_PREFIX));
  if (!own.length) return null;
  return detectLanguage(own.join("\n")) === "Chinese"
    ? "我查了一些资料，但这次没能整理出答复。请再问我一次，或者把问题说得具体一点。"
    : "I looked into it but could not put an answer together this time. Please ask me again, or narrow the question down.";
}

/** Whether the turn answering `messageIds` made a lookup (any of `isLookup`), read from the session's stored events. */
export async function turnMadeLookup(sessionId: string, messageIds: ReadonlySet<string>): Promise<boolean> {
  if (!messageIds.size) return false;
  const rows = (await db.query(
    `SELECT DISTINCT data->>'tool' AS tool FROM claw_session_events
      WHERE session_id = $1 AND event = 'toolUsed' AND deleted_at IS NULL AND data->>'message_id' = ANY($2::text[])`,
    [sessionId, [...messageIds]],
  )).rows as Array<{ tool: string | null }>;
  return rows.some((r) => !!r.tool && isLookup(r.tool));
}

/**
 * A turn that answers the person, looked something up, and ended with neither a say of its own nor any text: it is told so, once, in
 * the system's words (`silentTurnNotice`). Not when the turn started an item (its start notice is the reply) or handed a review over.
 */
async function sayLookedButSilent(
  end: RouterTurnEnd, userId: string, runs: ReadonlyArray<{ began: Date; message_id: string | null }>, prompts: readonly string[], deps: SayDeps,
): Promise<"said" | "skipped"> {
  const text = silentTurnNotice(prompts);
  if (!text) return "skipped";
  const answered = new Set([end.messageId, ...runs.map((r) => r.message_id)].filter((m): m is string => !!m));
  const began = new Date(Math.min(...runs.map((r) => new Date(r.began).getTime())));
  const spoke = await db.query("SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND NOT fallback AND created_at >= $2 LIMIT 1", [userId, began]);
  if (spoke.rowCount) return "skipped";
  const started = await db.query("SELECT 1 FROM claw_work_items WHERE user_id = $1 AND created_at >= $2 LIMIT 1", [userId, began]);
  if (started.rowCount) return "skipped";
  for (const messageId of answered) {
    if (await turnHandedOffReview((t, p) => db.query(t, p), userId, messageId)) return "skipped";
  }
  if (!(await turnMadeLookup(end.sessionId, answered))) return "skipped";
  const stored = await recordSystemNotice({
    userId, sessionId: end.sessionId, text, key: `turn_silent:${[...end.runIds].sort().join(",")}`,
    ...(end.messageId ? { turnMessageId: end.messageId } : {}),
  }, deps);
  if (stored) {
    logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.silent_turn_notice_delivered");
    metrics.onAssistantRouterUnsaid("silent_notice");
  }
  return stored ? "said" : "skipped";
}

async function deliverUnsaid(end: RouterTurnEnd, deps: SayDeps): Promise<"said" | "skipped"> {
  const lost = end.failed || end.interrupted || end.fromSweeper;
  const router = (await db.query("SELECT user_id FROM claw_assistants WHERE session_id = $1", [end.sessionId])).rows[0] as
    { user_id: string } | undefined;
  if (!router) return "skipped";
  const runs = (await db.query(
    `SELECT COALESCE(started_at, created_at) AS began, COALESCE(prompt, input->>'prompt', '') AS prompt, metadata->>'message_id' AS message_id,
            metadata->>'text_preview' AS text_preview
       FROM claw_tasks WHERE session_id = $1 AND task_id = ANY($2::text[]) AND origin = 'chat'`,
    [end.sessionId, end.runIds],
  )).rows as Array<{ began: Date; prompt: string; message_id: string | null; text_preview?: string | null }>;
  // The turn's own text was shown as it was written (`stream_text_as`, `noteTextPreview`) and is still on screen. Unless it is said now
  // as the answer, it is taken back (`voidStreamedSay`), so a channel does not keep words that never come as a message: a turn that
  // failed, handed a review over, wrote internal text, or met the say limit.
  const shown = runs.some((r) => textShown(r.text_preview));
  const takeBack = async (reason: string): Promise<void> => {
    if (shown) await voidStreamedSay(end.sessionId, end.messageId ?? runs.find((r) => r.message_id)?.message_id ?? undefined, reason, deps.publishSessionEvent);
  };
  // What the turn said while it might still hand a review over (`say-hold.ts`) goes out now: it ended. (A handoff dropped it already.)
  const held = new Set([end.messageId, ...runs.map((r) => r.message_id)].filter((m): m is string => !!m));
  let released = 0;
  for (const messageId of held) {
    for (const say of await releaseHeldSays((t, p) => db.query(t, p), messageId)) {
      released += 1;
      await publishSayEvent(end.sessionId, say.sayId, say.payload, deps, messageId);   // the web client's copy, held with it
    }
  }
  if (released) {
    logger.info({ sessionId: end.sessionId, released }, "assistant.held_says_released");
    await (deps.kick ?? kickDelivery)().catch((err) => logger.warn({ err }, "assistant.held_says_kick_failed"));
  }
  if (!runs.length) return "skipped";
  const prompts = runs.map((r) => r.prompt);
  const why = lostWhy(end);
  let text = lost ? turnLostNotice(prompts, why) : answerToDeliver(end.finalText, prompts);
  if (lost) await takeBack(why === "declined" ? "declined" : "turn_lost");
  if (!text) {
    if (lost) return "skipped";
    await takeBack("no_text");
    return sayLookedButSilent(end, router.user_id, runs, prompts, deps);
  }
  // The message the turn answered, as the completion names it, or as its runs were started for it (a sweeper's completion may not say).
  const answered = new Set([end.messageId, ...runs.map((r) => r.message_id)].filter((m): m is string => !!m));
  for (const messageId of answered) {
    if (await turnHandedOffReview((t, p) => db.query(t, p), router.user_id, messageId)) {
      logger.info({ sessionId: end.sessionId, runIds: end.runIds, lost }, "assistant.unsaid_answer_handed_off");
      await takeBack("handed_off");
      return "skipped";
    }
  }
  // The router's own words with internal text in them (a tool name, an item_id, ...): never shown. The turn is answered with
  // the system's notice instead, as one that said nothing is (`say` would have refused the same text).
  const leaked = !lost && internalTextIn(text, userWordsOf(prompts));
  if (leaked) {
    logger.warn({ sessionId: end.sessionId, runIds: end.runIds, leaked }, "assistant.unsaid_answer_withheld");
    await takeBack("withheld");
    text = turnLostNotice(prompts);
    if (!text) return "skipped";
  }
  const began = new Date(Math.min(...runs.map((r) => new Date(r.began).getTime())));
  // The system's own messages are not the model's, so they do not count as the turn having spoken.
  const spoke = await db.query(
    "SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND NOT fallback AND created_at >= $2 LIMIT 1",
    [router.user_id, began],
  );
  // A turn that said something has answered, and the closing words it wrote after are not a second message. Unless all it said came
  // before its last lookup answered: then the person holds a line that the turn was on it ("查一下 Autopilot 的状态。") and the answer
  // is this text, which they would never get (the parity run's K2, 2026-11-06). Said now, it takes that line's place (`replaces`).
  if (spoke.rowCount && !(!lost && !leaked && await saidOnlyBeforeLookups(end.sessionId, answered))) {
    if (!lost && !leaked) {
      logger.info({ sessionId: end.sessionId, runIds: end.runIds, chars: text.length }, "assistant.unsaid_text_after_say");
      metrics.onAssistantRouterUnsaid("after_say");
      await takeBack("after_say");
    }
    return "skipped";
  }
  const earlyLine = (spoke.rowCount ?? 0) > 0;
  if (earlyLine) {
    // Once: a redelivered completion finds the answer it stored (it is a say, so the turn's events do not change).
    const stored = await db.query(
      "SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND NOT fallback AND created_at >= $2 AND text = $3 LIMIT 1",
      [router.user_id, began, text],
    );
    if (stored.rowCount) return "skipped";
    logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.unsaid_answer_after_early_say");
  }
  if (lost || leaked) {
    // Once per turn: a redelivered completion finds the notice it stored.
    const stored = await recordSystemNotice({
      userId: router.user_id, sessionId: end.sessionId, text, key: `turn_lost:${[...end.runIds].sort().join(",")}`,
    }, deps);
    if (stored) {
      logger.warn({ sessionId: end.sessionId, runIds: end.runIds, why: lost ? why : "leaked" }, "assistant.turn_lost_notice_delivered");
      metrics.onAssistantRouterUnsaid(lost ? "lost_notice" : "withheld");
    }
    return stored ? "said" : "skipped";
  }
  try {
    await recordAssistantSay({ userId: router.user_id, sessionId: end.sessionId, text, turnMessageId: end.messageId, turnBegan: began }, deps);
  } catch (err) {
    // A refusal (the hourly cap) is the same answer the model's own say would have had, and the user was told of the cap
    // when it first refused them (`recordAssistantSay`); only a fault is worth a retry, and it is thrown for the caller's.
    if (err instanceof SayRefused) {
      logger.warn({ sessionId: end.sessionId, code: err.code }, "assistant.unsaid_answer_refused");
      await takeBack(err.code);
      metrics.onAssistantRouterUnsaid("refused");
      return "skipped";
    }
    throw err;
  }
  logger.warn({ sessionId: end.sessionId, runIds: end.runIds }, "assistant.unsaid_answer_delivered");
  metrics.onAssistantRouterUnsaid(earlyLine ? "replaced_early_line" : "delivered");
  return "said";
}
