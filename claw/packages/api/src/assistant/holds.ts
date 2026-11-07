// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A work item's worker waiting for its person: a tool call held for their decision (`permissionRequest`), or a question it
 * asked them (`userQuestion`, from `ask_user_question`).
 *
 * Nobody watches a worker's session: the person talks to their assistant, on a channel, and the worker runs behind it. So
 * a wait there used to reach nobody, and the item said "in progress" until Brain gave up and refused the call. Now the wait
 * is the item's:
 *
 *   - the item moves to needs_you, with what it waits for as its question, and a new attention (`attention_seq`), so the
 *     board, the router and the silent sweep all see that the person is needed;
 *   - the request goes out as an `approval.requested` with the source `assistant_item`, to every subscription of the
 *     owner that lists that type and that source, carrying the item and, for a question, the questions. The person answers
 *     it on the card the channel draws, through the same routes any approval or question is answered by; nothing here
 *     takes an answer;
 *   - when no subscription takes it (a channel that cannot draw it yet), the item's needs-you message is sent at once
 *     instead of after the silent sweep's wait, so the person still hears of it within seconds;
 *   - when the decision, the answer or the end of the wait comes back from Brain, or the run that waited ends without one
 *     (an aborted wait sends no decision), the item goes back to in progress.
 *
 * How long Brain waits is the run's `decision_wait_ms` (`CLAW_ASSISTANT_DECISION_WAIT_SEC`, set on every worker turn in
 * `role-profile.ts`), not the few minutes a person at the console needs.
 *
 * What the item records of the wait is `params.holds`, one entry per request: which request (`tool_use_id`), what kind, the
 * run that waits on it, and the attention it is current under. A worker's sub-agents run side by side and share its
 * approvals, so more than one request can wait at once: each new one moves the attention on and carries the ones still
 * waiting with it, and the item goes back to in progress only when none is left. A hold is current only while the item
 * needs the user under the attention the hold carries; once the worker reported since (a new attention) or the item was
 * sent back to work (no longer needs_you), the hold is over and nothing reads it. Only a task item is held this way: a
 * review's state is read off what it did (`review-items.ts`).
 */
import pino from "pino";
import { CLAW_NOTIFICATIONS_ENABLED, NOTIFY_LINK_BASE } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { approvalAction, approvalTarget, redactCommandSecrets } from "../notifications/approval-target.js";
import {
  clipSummary, deterministicEventId, enqueue, kickDelivery, onDelivered, waitWindow,
  type HeldQuestion, type NotificationPayload,
} from "../notifications/outbox.js";
import { personWritesChinese, recordNeedsYouFallback, storeSystemNotice } from "./outbound.js";
import { quoted, toldNote, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "./prompts.js";
import { toldNeedAt, toldNeeds } from "./told.js";

const logger = pino({ name: "assistant-holds" });

/** The tool whose wait is a question, answered rather than decided. */
export const QUESTION_TOOL = "ask_user_question";
/** The source an item's `approval.requested` is sent under: a subscription has to list it. */
export const HOLD_SOURCE = "assistant_item";

const QUESTION_TEXT_MAX = 500;
const OPTION_LABEL_MAX = 120;
const QUESTIONS_MAX = 5;
const OPTIONS_MAX = 10;
/** The item's question while it waits: one line a board and a needs-you message show. */
const PENDING_MAX = 300;

export type HoldKind = "approval" | "question";

/** One entry of `params.holds`. */
export interface Hold {
  tool_use_id: string;
  kind: HoldKind;
  tool: string;
  /** What is asked, as the person is shown it (the call's target, or the first question). */
  target: string;
  /** The item's `attention_seq` the hold is current under: only while the item's is the same and the item needs the user. */
  attention_seq: number;
  expires_at: string;
  /** The run (`claw_tasks.task_id`) whose turn waits on it, or null when that could not be told: its end ends the wait. */
  run_id: string | null;
  /** Whether the person writes Chinese (`personWritesChinese`): what they are told of it is in their language. */
  zh?: boolean;
  /** For a write: what it would do, in plain words of their language, and the text it would write (`approvalAction`). */
  action?: string;
  detail?: string;
}

/** The entries of `params.holds`, whatever else is there. */
function holdsOf(params: Record<string, unknown> | null | undefined): Hold[] {
  const raw = params?.holds;
  return Array.isArray(raw)
    ? raw.filter((h): h is Hold => !!h && typeof h === "object" && typeof (h as Hold).tool_use_id === "string")
    : [];
}

/** The holds the item waits on now: under its attention, while it needs the user. */
function currentHolds(item: { board_state: string; attention_seq: number; params: Record<string, unknown> | null }): Hold[] {
  if (item.board_state !== "needs_you") return [];
  return holdsOf(item.params).filter((h) => Number(h.attention_seq) === Number(item.attention_seq));
}

/**
 * SQL: the entries of `params.holds` of the item `w` while it needs the user, as rows (`jsonb_array_elements`); none otherwise.
 * The attention test (`currentHolds`) is the caller's, beside it.
 */
const HOLDS_WHILE_NEEDED = (w: string) => `jsonb_array_elements(CASE WHEN ${w}.board_state = 'needs_you' AND jsonb_typeof(${w}.params->'holds') = 'array'
  THEN ${w}.params->'holds' ELSE '[]'::jsonb END)`;

/** What a request from Brain is, when it is one a person answers: null for any other event. */
function requestOf(event: Record<string, unknown>): { toolUseId: string; kind: HoldKind; tool: string } | null {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (event.type === "permissionRequest") {
    const toolUseId = str(event.tool_use_id) || str(event.actionId);
    const tool = str(event.tool);
    return toolUseId && tool ? { toolUseId, kind: "approval", tool } : null;
  }
  if (event.type === "userQuestion") {
    const toolUseId = str(event.actionId);
    return toolUseId ? { toolUseId, kind: "question", tool: QUESTION_TOOL } : null;
  }
  return null;
}

/** The id of the request an event ends, when it ends one: a decision taken (or refused on time), a question's tool result. */
function endedRequest(event: Record<string, unknown>): { toolUseId: string; how: string } | null {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (event.type === "decisionResult") {
    const toolUseId = str(event.tool_use_id) || str(event.actionId);
    if (!toolUseId) return null;
    const allowed = event.decision === "allow" || event.action === "allow";
    return { toolUseId, how: event.by === "timeout" ? "no decision in time" : allowed ? "approved" : "denied" };
  }
  if (event.type === "toolUsed" && event.tool === QUESTION_TOOL && event.status !== "start") {
    const toolUseId = str(event.actionId);
    return toolUseId ? { toolUseId, how: event.status === "success" ? "answered" : "not answered" } : null;
  }
  return null;
}

/** Whether the event store has the end of this request on this session (what `endedRequest` reads as one). */
async function endWasSeen(q: Querier, sessionId: string, toolUseId: string): Promise<boolean> {
  const found = await q(
    `SELECT 1 FROM claw_session_events
      WHERE session_id = $1 AND deleted_at IS NULL
        AND ((event = 'decisionResult' AND $2 IN (btrim(data->>'tool_use_id'), btrim(data->>'actionId')))
          OR (event = 'toolUsed' AND data->>'tool' = $3 AND btrim(data->>'actionId') = $2
              AND COALESCE(data->>'status', '') <> 'start'))
      LIMIT 1`,
    [sessionId, toolUseId, QUESTION_TOOL],
  );
  return (found.rowCount ?? 0) > 0;
}

/** The run a request of this session was made in: Brain stamps every event with its turn's message id. Null when unknown. */
async function runOf(q: Querier, sessionId: string, messageId: unknown): Promise<string | null> {
  if (typeof messageId !== "string" || !messageId.trim()) return null;
  const row = (await q(
    `SELECT task_id FROM claw_tasks WHERE session_id = $1 AND metadata->>'message_id' = $2 ORDER BY created_at DESC LIMIT 1`,
    [sessionId, messageId.trim()],
  )).rows[0] as { task_id: string } | undefined;
  return row?.task_id ?? null;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const masked = (v: unknown, max: number): string => clip(redactCommandSecrets(typeof v === "string" ? v : ""), max);

/** The questions of a `userQuestion`, as a channel shows them: masked and clipped, and only those with an id and a text. */
export function heldQuestions(raw: unknown): HeldQuestion[] {
  const out: HeldQuestion[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim().slice(0, 100) : "";
    const question = masked(r.question, QUESTION_TEXT_MAX);
    if (!id || !question) continue;
    const options = (Array.isArray(r.options) ? r.options : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && typeof (o as Record<string, unknown>).id === "string")
      .map((o) => ({ id: String(o.id).trim().slice(0, 100), label: masked(o.label ?? o.id, OPTION_LABEL_MAX) }))
      .filter((o) => o.id)
      .slice(0, OPTIONS_MAX);
    out.push({ id, question, options, allow_multiple: r.allow_multiple === true });
    if (out.length >= QUESTIONS_MAX) break;
  }
  return out;
}

/**
 * The item's question while the hold lasts, in the words a board and a needs-you message show: in Chinese for a person who writes it,
 * a write said as what it would do (`action`), not as the tool's name.
 */
export function pendingText(kind: HoldKind, target: string, zh = false, action?: string): string {
  if (zh) return clip(kind === "question" ? `需要你回答：${target}` : `需要你批准：${action || target}`, PENDING_MAX);
  return clip(kind === "question" ? `Question for you: ${target}` : `Approve or deny: ${action || target}`, PENDING_MAX);
}

/** A worker's report, at most this long, said to the person before the write it holds for them (`holdForPerson`). */
const FINDINGS_MAX = 3000;

interface ItemRow {
  item_id: string;
  user_id: string;
  seq: number;
  title: string;
  board_state: string;
  kind: string;
  attention_seq: number;
  generation: number;
  result_version: number;
  params: Record<string, unknown> | null;
}

export type HoldOutcome =
  /** Not a task item's worker session: the caller treats the request as any session's. */
  | "not_an_item"
  /** A task item's request, recorded (or recorded before: a redelivery). */
  | "held"
  /** A task item's request that nobody can answer any more: the item is closed, or the wait was over before it got here. */
  | "too_late";

/** Seams for a test: the after-commit steps, which reach the outbox's delivery and the needs-you message. */
export const holdPorts = { kickDelivery, recordNeedsYouFallback };

/**
 * A worker asked its person something (`permissionRequest`, `userQuestion`): hold its item for them and tell them. Idempotent
 * per request: the same request seen again (a redelivered event, a resumed run) changes nothing and sends nothing more.
 */
export async function holdForPerson(
  input: { sessionId: string; event: Record<string, unknown> }, now: () => number = Date.now,
): Promise<HoldOutcome> {
  const request = requestOf(input.event);
  if (!request) return "not_an_item";
  const done = await inTransaction(async (q): Promise<HoldOutcome | { subscribers: number; itemId: string; told: Array<{ announce: () => Promise<void> }> }> => {
    const item = (await q(
      `SELECT item_id, user_id, seq, title, board_state, kind, attention_seq, generation, result_version, params
         FROM claw_work_items WHERE worker_session_id = $1 FOR UPDATE`,
      [input.sessionId],
    )).rows[0] as ItemRow | undefined;
    if (!item || item.kind !== "task") return "not_an_item";
    // Seen before, whatever became of it since: a redelivered request that was answered meanwhile must not hold the item again.
    const seen = await q(
      `SELECT 1 FROM claw_work_item_events
        WHERE item_id = $1 AND source = 'hold' AND kind = 'waiting' AND result->>'tool_use_id' = $2 LIMIT 1`,
      [item.item_id, request.toolUseId.slice(0, 200)],
    );
    if (seen.rowCount) return "held";
    if (item.board_state === "done") return "too_late";
    // Its end got here first: a request whose recording failed and came back after it was answered, or one another replica
    // took its time over. The event store has every event before it is acted on (`consumer.ts`), so the end is there.
    if (await endWasSeen(q, input.sessionId, request.toolUseId)) return "too_late";
    const clock = now();
    const window = waitWindow(input.event, clock);
    if (window.expiresAt <= clock) return "too_late";

    const questions = request.kind === "question" ? heldQuestions(input.event.questions) : [];
    const target = request.kind === "question"
      ? (questions[0]?.question ?? "the worker asks you something")
      : approvalTarget(request.tool, input.event.input);
    const zh = await personWritesChinese(q, item.user_id, item.title);
    const said = request.kind === "approval" ? approvalAction(request.tool, input.event.input, zh) : null;
    const question = pendingText(request.kind, target, zh, said?.action);
    const attention = Number(item.attention_seq) + 1;
    const recorded: Hold = {
      tool_use_id: request.toolUseId.slice(0, 200), kind: request.kind, tool: request.tool.slice(0, 200), target,
      attention_seq: attention, expires_at: new Date(window.expiresAt).toISOString(),
      run_id: await runOf(q, input.sessionId, input.event.message_id),
      zh, ...(said ? { action: said.action, ...(said.detail ? { detail: said.detail } : {}) } : {}),
    };
    // What the worker found before it asked (its last progress report since it was last given work): the person is told it first,
    // then asked, so they decide knowing it (2026-11-06 parity run, G2: a write was asked for and none of the answers were said).
    const findings = request.kind === "approval" ? (await q(
      `SELECT e.id, e.summary FROM claw_work_item_events e
        WHERE e.item_id = $1 AND e.source = 'worker' AND e.kind = 'progress' AND e.generation = $2
          AND COALESCE(e.summary, '') <> ''
          AND NOT EXISTS (SELECT 1 FROM claw_work_item_events r WHERE r.item_id = e.item_id AND r.source = 'router' AND r.id > e.id)
        ORDER BY e.id DESC LIMIT 1`,
      [item.item_id, item.generation],
    )).rows[0] as { id: number; summary: string } | undefined : undefined;
    // Another request still waiting (a sub-agent beside this one asked too) waits on under the new attention: it is not over.
    const holds = [...currentHolds(item).map((h) => ({ ...h, attention_seq: attention })), recorded];
    await q(
      `UPDATE claw_work_items
          SET board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2,
              attention_seq = $3, params = (params - 'hold') || jsonb_build_object('holds', $4::jsonb), updated_at = NOW()
        WHERE item_id = $1`,
      [item.item_id, question, attention, JSON.stringify(holds)],
    );
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id, summary, question, result)
       VALUES ($1, 'waiting', 'hold', $2, $3, $4, $4, jsonb_build_object('tool_use_id', $5::text))`,
      [item.item_id, item.generation, recorded.run_id, question, recorded.tool_use_id],
    );
    // Queued before the request, in its transaction: the person reads what was found, then is asked. A card a channel draws shows the
    // write's target cut to a line, so when one will be drawn for a write that posts a text (a comment, an issue), what it does and the
    // text, whole, are said here too; without a card the item's needs-you message says them (`outbound.ts`).
    const cards = CLAW_NOTIFICATIONS_ENABLED ? await cardSubscriptions(q, item.user_id) : [];
    const told = [
      findings ? await storeFindings(q, item, { id: Number(findings.id), summary: findings.summary }, zh) : null,
      cards.length && said?.detail ? await storeHeldWrite(q, item, recorded) : null,
    ].filter((t): t is { announce: () => Promise<void> } => t !== null);
    const subscribers = cards.length
      ? await announce(q, item, input.sessionId, request, recorded, questions, window.startedAt, input.event, cards)
      : 0;
    return { subscribers, itemId: item.item_id, told };
  });
  if (typeof done === "string") return done;
  logger.info({ itemId: done.itemId, kind: request.kind, subscribers: done.subscribers }, "assistant.item_held_for_person");
  for (const t of done.told) {
    await t.announce().catch((err: unknown) => logger.warn({ err, itemId: done.itemId }, "assistant.hold_notice_announce_failed"));
  }
  if (done.subscribers > 0) {
    void holdPorts.kickDelivery().catch((err) => logger.error({ err }, "assistant.hold_kick_failed"));
  } else {
    // No channel of theirs draws the request: the item's needs-you message, now rather than after the silent sweep's wait.
    await holdPorts.recordNeedsYouFallback({ itemId: done.itemId })
      .catch((err) => logger.warn({ err, itemId: done.itemId }, "assistant.hold_needs_you_failed"));
  }
  return "held";
}

/**
 * What the worker found, said to its person in the system's words before the write it holds for them is put to them: stored in the hold's
 * transaction, ahead of the request, and once per report (the notice's key), so a redelivered request or a second write after the same
 * report says nothing more. Null when there is no assistant session to say it in, or it was said before.
 */
async function storeFindings(
  q: Querier, item: ItemRow, f: { id: number; summary: string }, zh: boolean,
): Promise<{ announce: () => Promise<void> } | null> {
  const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [item.user_id])).rows[0]?.session_id as string | undefined;
  if (!sessionId) return null;
  const summary = f.summary.length > FINDINGS_MAX ? `${f.summary.slice(0, FINDINGS_MAX - 1)}…` : f.summary;
  const text = zh
    ? `#${item.seq} ${item.title} 查到的结果：\n${summary}\n\n接下来它要做一个需要你批准的操作，见下一条。`
    : `#${item.seq} "${item.title}" found:\n${summary}\n\nNext it asks you to approve a write, in the next message.`;
  // Not attached to the item: a system message attached to it is its needs-you message for that attention (one per attention), and
  // this one is not; that one follows.
  return storeSystemNotice(q, { userId: item.user_id, sessionId, text, key: `hold_findings:${item.item_id}:${f.id}` });
}

/** The owner's subscriptions that draw an item's requests as cards: they list the type and the source. */
async function cardSubscriptions(q: Querier, userId: string): Promise<Array<{ subscription_id: string }>> {
  return (await q(
    `SELECT subscription_id FROM claw_notification_subscriptions
      WHERE owner_user_id = $1 AND enabled AND 'approval.requested' = ANY(event_types) AND $2 = ANY(sources)`,
    [userId, HOLD_SOURCE],
  )).rows as Array<{ subscription_id: string }>;
}

/**
 * The write a card is about to ask for, said in full ahead of the card: what it does and the text it would post, in the person's
 * language. The card's target is the call cut to a line, and the person approves exactly what is posted. Once per request.
 */
async function storeHeldWrite(q: Querier, item: ItemRow, hold: Hold): Promise<{ announce: () => Promise<void> } | null> {
  const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [item.user_id])).rows[0]?.session_id as string | undefined;
  if (!sessionId || !hold.action) return null;
  const text = hold.zh
    ? [`#${item.seq} ${item.title} 要做的操作：${hold.action}。`, ...(hold.detail ? ["内容如下：", "---", hold.detail, "---"] : []), "在下面的卡片上批准或拒绝。"].join("\n")
    : [`#${item.seq} "${item.title}" asks to: ${hold.action}.`, ...(hold.detail ? ["It would write:", "---", hold.detail, "---"] : []), "Approve or deny it on the card below."].join("\n");
  // Not attached to the item, for the same reason as the findings (`storeFindings`).
  return storeSystemNotice(q, { userId: item.user_id, sessionId, text, key: `hold_write:${item.item_id}:${hold.tool_use_id}` });
}

/** The `approval.requested` of a hold, one outbox row per subscription that lists the type and the source. */
async function announce(
  q: Querier, item: ItemRow, sessionId: string, request: { toolUseId: string; kind: HoldKind; tool: string }, hold: Hold,
  questions: HeldQuestion[], startedAt: number, event: Record<string, unknown>, subs: Array<{ subscription_id: string }>,
): Promise<number> {
  if (!subs.length) return 0;
  const eventId = deterministicEventId("approval.requested", sessionId, request.toolUseId);
  const title = String(redactCommandSecrets(item.title));
  const payload: NotificationPayload = {
    event_id: eventId,
    type: "approval.requested",
    occurred_at: new Date(startedAt).toISOString(),
    user_id: item.user_id,
    session_id: sessionId,
    task_id: typeof event.message_id === "string" ? event.message_id : "",
    trigger_id: null,
    title: clip(hold.zh
      ? `${request.kind === "question" ? "需要你回答" : "需要你批准"}：#${item.seq} ${title}`
      : `${request.kind === "question" ? "Question" : "Approval needed"}: #${item.seq} ${title}`, 200),
    // What the write would do, in the person's words, when Brain gave no reason of its own (a channel shows it as the why).
    summary: request.kind === "question" ? "" : clipSummary(redactCommandSecrets(
      (typeof event.summary === "string" ? event.summary : "") || (typeof event.approval_label === "string" ? event.approval_label : "")
      || (hold.action ?? ""))),
    link: `${NOTIFY_LINK_BASE}/sessions/${sessionId}`,
    approval: { tool_use_id: hold.tool_use_id, tool: masked(hold.tool, 200), target: hold.target, expires_at: hold.expires_at },
    source: HOLD_SOURCE,
    item: {
      item_id: item.item_id, seq: Number(item.seq), title, board_state: "needs_you",
      result_version: Number(item.result_version), can_accept: false,
    },
    ...(request.kind === "question" ? { questions } : {}),
  };
  return enqueue(eventId, subs, payload, q);
}

/**
 * Brain stopped waiting on a request (`decisionResult`; an `ask_user_question` that returned): the item that held it goes back
 * to in progress, if the hold was its current need and none is left waiting. Returns whether the item moved. A request no
 * item holds changes nothing.
 */
export async function releaseHold(input: { sessionId: string; event: Record<string, unknown> }): Promise<boolean> {
  const ended = endedRequest(input.event);
  if (!ended) return false;
  return inTransaction((q) => endHolds(q, input.sessionId, (h) => h.tool_use_id === ended.toolUseId, ended.how));
}

/** What the item records when a run ended with a request of it still held: Brain waits on nothing of a run that is over. */
export const RUN_ENDED_HOW = "the run ended before an answer";

/**
 * A worker's run ended (its completion, or the sweep for one whose completion never came): whatever of it the item still held
 * is over, since an aborted or lost wait sends no decision. A hold whose run could not be told is ended by any run's end of the
 * session: a worker session runs one turn at a time. Returns whether the item moved.
 */
export async function releaseRunHolds(sessionId: string, runIds: readonly string[]): Promise<boolean> {
  if (!runIds.length) return false;
  return inTransaction((q) => endHolds(q, sessionId, (h) => h.run_id === null || runIds.includes(h.run_id), RUN_ENDED_HOW));
}

/** A run whose completion the completion handler had: this long after it ended, a hold of it the handler left is the sweep's. */
const RUN_HOLD_GRACE_SECONDS = 60;
const RUN_HOLD_BATCH = 20;

/**
 * The sweep's half of `releaseRunHolds`: items that need the user for a request whose run is over and was not seen to end (Brain
 * died while it waited). Every row it selects loses those holds, so none is selected again. Returns how many items moved.
 */
export async function releaseHoldsOfEndedRuns(): Promise<number> {
  let rows: Array<{ worker_session_id: string; task_id: string }>;
  try {
    rows = (await db.query(
      `SELECT DISTINCT w.worker_session_id, t.task_id
         FROM claw_work_items w
        CROSS JOIN LATERAL ${HOLDS_WHILE_NEEDED("w")} AS h(value)
         JOIN claw_tasks t ON t.task_id = h.value->>'run_id' AND t.session_id = w.worker_session_id
        WHERE w.board_state = 'needs_you' AND w.kind = 'task'
          AND t.status IN ('completed', 'failed', 'cancelled')
          AND t.completed_at < NOW() - make_interval(secs => $1::int)
        LIMIT $2`,
      [RUN_HOLD_GRACE_SECONDS, RUN_HOLD_BATCH],
    )).rows as Array<{ worker_session_id: string; task_id: string }>;
  } catch (err) {
    // Not allowed to stop the rest of the sweep: the next tick asks again.
    logger.warn({ err }, "assistant.run_hold_sweep_failed");
    return 0;
  }
  let moved = 0;
  for (const r of rows) {
    try {
      if (await releaseRunHolds(r.worker_session_id, [r.task_id])) moved += 1;
    } catch (err) {
      logger.warn({ err, sessionId: r.worker_session_id, runId: r.task_id }, "assistant.run_hold_release_failed");
    }
  }
  if (moved) logger.warn({ moved }, "assistant.released_holds_of_ended_runs");
  return moved;
}

/**
 * End the holds `ending` picks, under the item's row lock. When one of them was the item's current need and none of its current
 * holds is left, the item goes back to in progress, with an event of the run that waited (so the run's end, `turn-end.ts`, reads
 * the release as its last word and records what the run did after it). When another is still waiting, the item stays with the
 * user, for that one. A hold that was over already is only dropped from the record.
 */
async function endHolds(q: Querier, sessionId: string, ending: (h: Hold) => boolean, how: string): Promise<boolean> {
  const item = (await q(
    `SELECT item_id, generation, board_state, attention_seq, params FROM claw_work_items WHERE worker_session_id = $1 FOR UPDATE`,
    [sessionId],
  )).rows[0] as Pick<ItemRow, "item_id" | "generation" | "board_state" | "attention_seq" | "params"> | undefined;
  if (!item) return false;
  const all = holdsOf(item.params);
  const ended = all.filter(ending);
  if (!ended.length) return false;
  const current = currentHolds(item);
  const endedNow = current.filter(ending);
  const left = current.filter((h) => !ending(h));
  const record = left.length
    ? "(params - 'hold') || jsonb_build_object('holds', $2::jsonb)"
    : "params - 'hold' - 'holds'";
  if (!endedNow.length) {
    // Over already (the worker reported since, the item was sent back to work or closed): only the record of it goes.
    await q(`UPDATE claw_work_items SET params = ${record} WHERE item_id = $1`, left.length ? [item.item_id, JSON.stringify(left)] : [item.item_id]);
    return false;
  }
  const event = (summary: string, runId: string | null, toolUseId: string) => q(
    `INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id, summary, result)
     VALUES ($1, 'progress', 'hold', $2, $3, $4, jsonb_build_object('tool_use_id', $5::text))`,
    [item.item_id, item.generation, runId, summary, toolUseId],
  );
  if (left.length) {
    // Another request of the worker's still waits: the item needs the user for that one, and says which.
    const next = left[left.length - 1]!;
    await q(
      `UPDATE claw_work_items SET pending_question = $3, params = ${record}, updated_at = NOW() WHERE item_id = $1`,
      [item.item_id, JSON.stringify(left), pendingText(next.kind, next.target, next.zh === true, next.action)],
    );
    for (const h of endedNow) await event(how, h.run_id, h.tool_use_id);
    return false;
  }
  await q(
    `UPDATE claw_work_items
        SET board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL, params = ${record}, updated_at = NOW()
      WHERE item_id = $1`,
    [item.item_id],
  );
  for (const h of endedNow) await event(how, h.run_id, h.tool_use_id);
  return true;
}

/**
 * Once a channel has taken an item's request (a 2xx), the item's need has been told: it is recorded as the item's needs-you
 * message for that attention, under the very id the silent sweep would give its own, so the sweep does not say it again.
 * Call once at startup, with the notification worker.
 */
export function registerHoldDeliveryHook(): void {
  onDelivered(["approval.requested"], async ({ payload }) => {
    const p = payload as NotificationPayload;
    if (p.source !== HOLD_SOURCE || !p.item?.item_id || !p.approval?.tool_use_id) return;
    const item = (await db.query(
      `SELECT w.user_id, w.attention_seq, w.pending_question FROM claw_work_items w
        WHERE w.item_id = $1
          AND EXISTS (SELECT 1 FROM ${HOLDS_WHILE_NEEDED("w")} AS h(value)
                       WHERE h.value->>'tool_use_id' = $2 AND (h.value->>'attention_seq')::int = w.attention_seq)`,
      [p.item.item_id, p.approval.tool_use_id],
    )).rows[0] as { user_id: string; attention_seq: number; pending_question: string | null } | undefined;
    if (!item) return;
    await db.query(
      `INSERT INTO claw_assistant_says (say_id, user_id, item_id, item_attention_seq, text, fallback, delivered_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW()) ON CONFLICT DO NOTHING`,
      [
        deterministicEventId("work_item.needs_you", p.item.item_id, String(item.attention_seq)), item.user_id, p.item.item_id,
        Number(item.attention_seq), `#${p.item.seq} "${p.item.title}" ${item.pending_question ?? "needs you."}`,
      ],
    );
  });
}

/** A request an item of the user's holds for them now, as the router is shown it. */
export interface HeldLine {
  itemId: string;
  seq: number;
  title: string;
  hold: Hold;
  /** When the user was told of the item under the hold's attention (`told.ts`), if they were. */
  toldAt?: Date;
}

/**
 * Every request the user's items hold for them now (`params.holds` of the item's current need, its wait not over), oldest item
 * first and, within an item, in the order asked. A wait that is over is Brain's refusal, which the worker goes on from: nobody
 * can answer it any more.
 */
export async function heldForPersonManifest(userId: string): Promise<HeldLine[]> {
  const rows = (await db.query(
    `SELECT w.item_id, w.seq, w.title, h.value AS hold FROM claw_work_items w
      CROSS JOIN LATERAL ${HOLDS_WHILE_NEEDED("w")} WITH ORDINALITY AS h(value, n)
      WHERE w.user_id = $1 AND w.board_state = 'needs_you' AND w.kind = 'task'
        AND (h.value->>'attention_seq')::int = w.attention_seq
        AND (h.value->>'expires_at')::timestamptz > NOW()
      ORDER BY w.seq, h.n`,
    [userId],
  )).rows as Array<{ item_id: string; seq: number; title: string; hold: Hold }>;
  const lines = rows.map((r) => ({ itemId: r.item_id, seq: Number(r.seq), title: r.title, hold: r.hold }));
  const told = await toldNeeds((t, p) => db.query(t, p), userId, lines.map((l) => ({ itemId: l.itemId, attentionSeq: Number(l.hold.attention_seq) })));
  return lines.map((l) => {
    const toldAt = toldNeedAt(told, { itemId: l.itemId, attentionSeq: Number(l.hold.attention_seq) });
    return toldAt ? { ...l, toldAt } : l;
  });
}

/**
 * The block a router turn is given beside the item list: what the user's workers wait for them on. Nothing when nothing
 * waits. Only the person answers these, on the card their channel drew or in the console: the router has no tool that does,
 * and what it says cannot answer one.
 */
export function renderHeldForPerson(lines: readonly HeldLine[]): string {
  if (!lines.length) return "";
  const list = lines.map((l) => `- #${l.seq} (item_id: ${l.itemId}) ${l.hold.kind === "question" ? "question" : "approval"}`
    + ` | waits until ${l.hold.expires_at}${toldNote(l.toldAt)} | ${quoted(l.hold.target)} | item: ${quoted(l.title)}`).join("\n");
  return `Waiting for you in work items (a worker holds a write for the user's decision, or asks them a question; only the user answers it, on the card in their chat or in the console, and nothing you say or call answers it: when they ask what waits for them, or say yes or no to one of these, tell them where it is and that it waits until the time shown):
${UNTRUSTED_OPEN}
${list}
${UNTRUSTED_CLOSE}`;
}
