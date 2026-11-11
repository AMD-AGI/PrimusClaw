// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn of the assistant the gateway refused because of the user's key -- it has no binding to the upstream subscription, or the
 * subscription key it is bound to is refused as invalid (`key-refusal.ts`) -- run again once on the fallback model, which needs none.
 *
 * Claw calls a model with the user's own key. A key with no subscription binding is refused by the gateway for a model behind that
 * subscription, before the model runs: the turn fails with nothing done, and its whole text is the gateway's refusal. The gateway's
 * own model list may still name the model (`model-choice.ts` cannot tell beforehand), so this is where such a turn is caught: at its
 * end, for a task item's worker, a review item's session and the user's router alike.
 *
 * Once per refused turn (`claw_assistant_model_fallbacks`, keyed by the turn's message), and never for a turn that already ran on the
 * fallback: its failure is reported as any other. A task or review item moves to the fallback model for good (its session's model and
 * `params.model`, with `params.model_asked` the one refused); the router's model is the deployment's, so only the turn run again takes
 * the fallback (`rerunModelOf`, read when that turn's request is finished). The user is told once, in the language of the turn, which
 * model ran instead and where to bind the key (`CLAW_ASSISTANT_KEY_BINDING_URL`).
 *
 * Which turns are run again:
 *  - a worker's, with the words of its run (the brief or the instruction it was given);
 *  - a review item's first turn only, the one the person's request made; a later turn of a review was the person's own message in the
 *    session, which only they can send again;
 *  - a router's turn that answers a message the user sent: the message is queued again, and what the route wrote down about it (how it
 *    was authenticated, when, its context) is copied to the new turn's id, so the turn acts for the person exactly as the refused one
 *    would have and goes stale at the same moment. A turn a worker's report started is not run again: the report is on its item, which
 *    the next turn lists.
 *
 * Only with model choice on (`modelChoiceOn`) and a fallback model on the allow-list; otherwise this asks nothing of the database.
 */
import pino from "pino";
import { CLAW_ASSISTANT_KEY_BINDING_URL } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { queuedMessageId } from "../tasks/chat-run.js";
import { detectLanguage } from "./language.js";
import { drainSessionIfIdle, queueServerMessage, type QueuedServerMessage } from "./messages.js";
import { fallbackModel, modelChoiceOn } from "./model-choice.js";
import { keyRefusalOf, type KeyRefusal } from "./key-refusal.js";
import { recordSystemNotice, type SayDeps } from "./outbound.js";
import { queueReviewFirstTurnAgain } from "./review-items.js";
import { redactStoredText } from "@claw/utils";

const logger = pino({ name: "assistant-model-fallback" });

/** Whether a failed turn's text is the gateway's refusal of a key with no subscription binding (`key-refusal.ts`). */
export function isMissingKeyRefusal(text: unknown): boolean {
  return keyRefusalOf(text) === "missing";
}

/** The model the turn under `messageId` runs on when it is a router turn run again here, or null. */
export async function rerunModelOf(sessionId: string, messageId: string): Promise<string | null> {
  if (!modelChoiceOn() || !messageId) return null;
  const row = (await db.query(
    "SELECT model FROM claw_assistant_model_fallbacks WHERE session_id = $1 AND rerun_message_id = $2", [sessionId, messageId],
  )).rows[0] as { model: string } | undefined;
  return row?.model ?? null;
}

export interface FailedTurn {
  sessionId: string;
  /** The runs the completion closed. */
  runIds: string[];
  messageId?: string;
  failed: boolean;
  interrupted: boolean;
  finalText?: string;
  failureReason?: string;
}

type Whose =
  | { kind: "router"; ownerId: string }
  | { kind: "task" | "review"; ownerId: string; itemId: string; seq: number };

async function whoseSession(sessionId: string): Promise<Whose | null> {
  const router = (await db.query("SELECT user_id FROM claw_assistants WHERE session_id = $1", [sessionId])).rows[0] as { user_id: string } | undefined;
  if (router) return { kind: "router", ownerId: router.user_id };
  const item = (await db.query(
    "SELECT item_id, user_id, kind, seq FROM claw_work_items WHERE worker_session_id = $1", [sessionId],
  )).rows[0] as { item_id: string; user_id: string; kind: string; seq: number } | undefined;
  if (!item || (item.kind !== "task" && item.kind !== "review")) return null;
  return { kind: item.kind, ownerId: item.user_id, itemId: item.item_id, seq: Number(item.seq) };
}

function notice(whose: Whose, refusal: KeyRefusal, from: string | null, to: string, words: string): string {
  const zh = detectLanguage(words) === "Chinese";
  const url = CLAW_ASSISTANT_KEY_BINDING_URL;
  const was = from ?? (zh ? "默认模型" : "the default model");
  const invalid = refusal === "invalid";
  const why = invalid
    ? (zh ? "你绑定的 APIM Key 无效或已过期" : "the APIM key bound to your key is invalid or expired")
    : (zh ? "你的 key 还没有绑定 APIM Key" : "your key has no APIM key bound");
  const cure = invalid
    ? (zh ? "重新上传有效的 APIM Key 后" : "Upload a valid APIM key")
    : (zh ? "上传 APIM Key 后" : "Upload an APIM key");
  if (whose.kind === "router") {
    return zh
      ? `${why}，用不了 ${was}，这条消息改用 ${to} 处理。${url ? `${cure}即可使用 ${was}：\n${url}` : ""}`
      : `${why[0].toUpperCase()}${why.slice(1)}, so ${was} could not answer; ${to} handled this message instead.${url ? ` ${cure} to use ${was}:\n${url}` : ""}`;
  }
  return zh
    ? `#${whose.seq} 用 ${was} 时被拒：${why}。已改用 ${to} 重新运行。${url ? `${cure}再说一次即可改回 ${was}：\n${url}` : ""}`
    : `#${whose.seq} was refused on ${was}: ${why}. It runs again on ${to}.${url ? ` ${cure}, then ask again to use ${was}:\n${url}` : ""}`;
}

/**
 * The completion handler's hook, before it records how the turn ended: `rerun` when the turn was queued again on the fallback model (the
 * caller then records nothing of the refused turn, which is not over for the user), `skipped` otherwise.
 */
export async function rerunOnFallback(end: FailedTurn, deps: SayDeps = {}): Promise<"rerun" | "skipped"> {
  if (!modelChoiceOn() || !end.failed || end.interrupted || !end.runIds.length) return "skipped";
  const refusal = keyRefusalOf(end.finalText) ?? keyRefusalOf(end.failureReason);
  if (!refusal) return "skipped";
  const to = fallbackModel();
  if (!to) return "skipped";
  const run = (await db.query(
    `SELECT t.task_id, t.metadata->>'message_id' AS message_id, COALESCE(t.prompt, t.input->>'prompt', '') AS prompt,
            COALESCE(t.input->>'model', s.model) AS model
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.session_id = $1 AND t.task_id = ANY($2::text[]) AND t.origin = 'chat' AND s.deleted_at IS NULL
      ORDER BY t.created_at LIMIT 1`,
    [end.sessionId, end.runIds],
  )).rows[0] as { task_id: string; message_id: string | null; prompt: string; model: string | null } | undefined;
  const messageId = end.messageId || run?.message_id || "";
  if (!run || !messageId || run.model === to) return "skipped";
  const whose = await whoseSession(end.sessionId);
  if (!whose) return "skipped";

  const queued = await inTransaction(async (query): Promise<{ words: string } | null> => {
    // A turn that is itself a re-run is not run again: its failure is the answer.
    const isRerun = await query(
      "SELECT 1 FROM claw_assistant_model_fallbacks WHERE session_id = $1 AND rerun_message_id = $2", [end.sessionId, messageId],
    );
    if (isRerun.rowCount) return null;
    const once = await query(
      `INSERT INTO claw_assistant_model_fallbacks (session_id, message_id, model, from_model) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [end.sessionId, messageId, to, run.model],
    );
    if (!once.rowCount) return null;
    const dedupeKey = `model-fallback:${messageId}`;
    if (whose.kind === "router") return rerunRouterTurn(query, end.sessionId, whose.ownerId, messageId, dedupeKey, run.prompt);
    // The item's row, held to the end of this transaction, as a stop and a restart hold it (`stopWorkItem`, `restartReview`): one that was
    // stopped or restarted since it was read above is not run again, and none can be stopped between this check and the queueing.
    const open = (await query("SELECT board_state FROM claw_work_items WHERE item_id = $1 FOR UPDATE", [whose.itemId])).rows[0] as
      { board_state: string } | undefined;
    if (!open || open.board_state === "done") throw new NotRerun();
    const content = run.prompt;
    if (!content) return null;
    const q = { query };
    const out: QueuedServerMessage | null = whose.kind === "review"
      ? await queueReviewFirstTurnAgain(q, end.sessionId, whose.ownerId, content, dedupeKey)
      : await queueServerMessage(q, { sessionId: end.sessionId, userId: whose.ownerId, content, dedupeKey });
    if (!out || !out.ok || out.pendingId === null) throw new NotRerun();
    await query("UPDATE claw_assistant_model_fallbacks SET rerun_message_id = $3 WHERE session_id = $1 AND message_id = $2",
      [end.sessionId, messageId, queuedMessageId(out.pendingId)]);
    // The item runs on the fallback from now on; the model it was to run on is kept as the one asked for.
    await query("UPDATE claw_sessions SET model = $2, updated_at = NOW() WHERE session_id = $1", [end.sessionId, to]);
    await query(
      `UPDATE claw_work_items SET params = params || jsonb_build_object('model', $2::text, 'model_asked', COALESCE(params->>'model_asked', $3::text)),
              updated_at = NOW() WHERE item_id = $1`,
      [whose.itemId, to, run.model],
    );
    await query(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
       SELECT item_id, 'model_fallback', 'policy', generation, $2 FROM claw_work_items WHERE item_id = $1`,
      [whose.itemId, `The gateway refused ${run.model ?? "the default model"} ${refusal === "invalid" ? "for an invalid subscription key" : "for want of a key binding"}; running again on ${to}.`],
    );
    return { words: content };
  }).catch((err) => {
    if (err instanceof NotRerun) return null;
    throw err;
  });
  if (!queued) return "skipped";
  await drainSessionIfIdle(end.sessionId, whose.ownerId);
  const router = whose.kind === "router"
    ? end.sessionId
    : ((await db.query("SELECT session_id FROM claw_assistants WHERE user_id = $1", [whose.ownerId])).rows[0] as { session_id: string } | undefined)?.session_id;
  if (router) {
    await recordSystemNotice({
      userId: whose.ownerId, sessionId: router, text: notice(whose, refusal, run.model, to, queued.words), key: `model_fallback:${end.sessionId}:${messageId}`,
    }, deps).catch((err) => logger.warn({ err, sessionId: end.sessionId }, "assistant.model_fallback_notice_failed"));
  }
  logger.warn({ sessionId: end.sessionId, kind: whose.kind, from: run.model, to }, "assistant.model_fallback_rerun");
  return "rerun";
}

/** Thrown inside the re-run's transaction when nothing could be queued: the record of the attempt is rolled back with it. */
class NotRerun extends Error {}

/**
 * The user's message queued again on their router session, with what the route wrote down about it copied to the new turn's id: the same
 * words, the same authentication, the same moment received (so it goes stale when the first would have), and whether it had read what a
 * worker wrote. Nothing for a turn that answers no message of the user's.
 *
 * The stored message has credential-shaped content masked (`recordAssistantMessage`), and the model is not to be given a different message
 * the second time: when the refused run's prompt is that same message as the user wrote it (masking it gives the stored words), the
 * prompt is what is queued. Otherwise the stored words are.
 */
async function rerunRouterTurn(
  query: Querier, sessionId: string, userId: string, messageId: string, dedupeKey: string, prompt: string,
): Promise<{ words: string } | null> {
  const message = (await query(
    "SELECT content FROM claw_assistant_messages WHERE session_id = $1 AND message_id = $2", [sessionId, messageId],
  )).rows[0] as { content: string } | undefined;
  if (!message) throw new NotRerun();
  const words = prompt && redactStoredText(prompt).text === message.content ? prompt : message.content;
  const out = await queueServerMessage({ query }, { sessionId, userId, content: words, dedupeKey });
  if (!out.ok || out.pendingId === null) throw new NotRerun();
  const rerunId = queuedMessageId(out.pendingId);
  await query(
    `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at, untrusted_read_at)
     SELECT session_id, $3, user_id, user_name, content, attended_via, channel_context, received_at, untrusted_read_at
       FROM claw_assistant_messages WHERE session_id = $1 AND message_id = $2
     ON CONFLICT (session_id, message_id) DO NOTHING`,
    [sessionId, messageId, rerunId],
  );
  await query("UPDATE claw_assistant_model_fallbacks SET rerun_message_id = $3 WHERE session_id = $1 AND message_id = $2", [sessionId, messageId, rerunId]);
  return { words };
}
