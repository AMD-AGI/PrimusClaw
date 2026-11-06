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
 *   - when the decision, the answer or the end of the wait comes back from Brain, the item goes back to in progress.
 *
 * How long Brain waits is the run's `decision_wait_ms` (`CLAW_ASSISTANT_DECISION_WAIT_SEC`, set on every worker turn in
 * `role-profile.ts`), not the few minutes a person at the console needs.
 *
 * What the item records of the wait is `params.hold`: which request (`tool_use_id`), what kind, and the attention it opened.
 * A hold whose attention is not the item's current one is over (the worker reported since, or the item was reopened), and
 * nothing reads it. Only a task item is held this way: a review's state is read off what it did (`review-items.ts`).
 */
import pino from "pino";
import { CLAW_NOTIFICATIONS_ENABLED, NOTIFY_LINK_BASE } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { approvalTarget, redactCommandSecrets } from "../notifications/approval-target.js";
import {
  clipSummary, deterministicEventId, enqueue, kickDelivery, onDelivered, waitWindow,
  type HeldQuestion, type NotificationPayload,
} from "../notifications/outbox.js";
import { recordNeedsYouFallback } from "./outbound.js";
import { quoted, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "./prompts.js";

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

/** What `params.hold` records. */
export interface Hold {
  tool_use_id: string;
  kind: HoldKind;
  tool: string;
  /** What is asked, as the person is shown it (the call's target, or the first question). */
  target: string;
  /** The item's `attention_seq` the hold opened: a hold is current only while the item's is the same. */
  attention_seq: number;
  expires_at: string;
}

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

/** The item's question while the hold lasts, in the words a board and a needs-you message show. */
export function pendingText(kind: HoldKind, target: string): string {
  return clip(kind === "question" ? `Question for you: ${target}` : `Approve or deny: ${target}`, PENDING_MAX);
}

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
  const done = await inTransaction(async (q): Promise<HoldOutcome | { subscribers: number; itemId: string }> => {
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
    const clock = now();
    const window = waitWindow(input.event, clock);
    if (window.expiresAt <= clock) return "too_late";

    const questions = request.kind === "question" ? heldQuestions(input.event.questions) : [];
    const target = request.kind === "question"
      ? (questions[0]?.question ?? "the worker asks you something")
      : approvalTarget(request.tool, input.event.input);
    const question = pendingText(request.kind, target);
    const attention = Number(item.attention_seq) + 1;
    const recorded: Hold = {
      tool_use_id: request.toolUseId.slice(0, 200), kind: request.kind, tool: request.tool.slice(0, 200), target,
      attention_seq: attention, expires_at: new Date(window.expiresAt).toISOString(),
    };
    await q(
      `UPDATE claw_work_items
          SET board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2,
              attention_seq = $3, params = params || jsonb_build_object('hold', $4::jsonb), updated_at = NOW()
        WHERE item_id = $1`,
      [item.item_id, question, attention, JSON.stringify(recorded)],
    );
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, question, result)
       VALUES ($1, 'waiting', 'hold', $2, $3, $3, jsonb_build_object('tool_use_id', $4::text))`,
      [item.item_id, item.generation, question, recorded.tool_use_id],
    );
    const subscribers = CLAW_NOTIFICATIONS_ENABLED
      ? await announce(q, item, input.sessionId, request, recorded, questions, window.startedAt, input.event)
      : 0;
    return { subscribers, itemId: item.item_id };
  });
  if (typeof done === "string") return done;
  logger.info({ itemId: done.itemId, kind: request.kind, subscribers: done.subscribers }, "assistant.item_held_for_person");
  if (done.subscribers > 0) {
    void holdPorts.kickDelivery().catch((err) => logger.error({ err }, "assistant.hold_kick_failed"));
  } else {
    // No channel of theirs draws the request: the item's needs-you message, now rather than after the silent sweep's wait.
    await holdPorts.recordNeedsYouFallback({ itemId: done.itemId })
      .catch((err) => logger.warn({ err, itemId: done.itemId }, "assistant.hold_needs_you_failed"));
  }
  return "held";
}

/** The `approval.requested` of a hold, one outbox row per subscription that lists the type and the source. */
async function announce(
  q: Querier, item: ItemRow, sessionId: string, request: { toolUseId: string; kind: HoldKind; tool: string }, hold: Hold,
  questions: HeldQuestion[], startedAt: number, event: Record<string, unknown>,
): Promise<number> {
  const subs = (await q(
    `SELECT subscription_id FROM claw_notification_subscriptions
      WHERE owner_user_id = $1 AND enabled AND 'approval.requested' = ANY(event_types) AND $2 = ANY(sources)`,
    [item.user_id, HOLD_SOURCE],
  )).rows as Array<{ subscription_id: string }>;
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
    title: clip(`${request.kind === "question" ? "Question" : "Approval needed"}: #${item.seq} ${title}`, 200),
    summary: request.kind === "question" ? "" : clipSummary(redactCommandSecrets(
      (typeof event.summary === "string" ? event.summary : "") || (typeof event.approval_label === "string" ? event.approval_label : ""))),
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
 * to in progress, if the hold is still its current need. Returns whether the item moved. A request no item holds changes nothing.
 */
export async function releaseHold(input: { sessionId: string; event: Record<string, unknown> }): Promise<boolean> {
  const ended = endedRequest(input.event);
  if (!ended) return false;
  return inTransaction(async (q) => {
    const moved = (await q(
      `UPDATE claw_work_items
          SET board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL,
              params = params - 'hold', updated_at = NOW()
        WHERE worker_session_id = $1 AND board_state = 'needs_you'
          AND params->'hold'->>'tool_use_id' = $2 AND (params->'hold'->>'attention_seq')::int = attention_seq
    RETURNING item_id, generation`,
      [input.sessionId, ended.toolUseId],
    )).rows[0] as { item_id: string; generation: number } | undefined;
    if (!moved) {
      // Over already (the worker reported since, the item was reopened or closed): only the record of it goes.
      await q(
        "UPDATE claw_work_items SET params = params - 'hold' WHERE worker_session_id = $1 AND params->'hold'->>'tool_use_id' = $2",
        [input.sessionId, ended.toolUseId],
      );
      return false;
    }
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, result)
       VALUES ($1, 'progress', 'hold', $2, $3, jsonb_build_object('tool_use_id', $4::text))`,
      [moved.item_id, moved.generation, ended.how, ended.toolUseId],
    );
    return true;
  });
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
      `SELECT user_id, attention_seq, pending_question FROM claw_work_items
        WHERE item_id = $1 AND board_state = 'needs_you' AND params->'hold'->>'tool_use_id' = $2
          AND (params->'hold'->>'attention_seq')::int = attention_seq`,
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
}

/**
 * Every request the user's items hold for them now (`params.hold` of the item's current need, its wait not over), oldest item
 * first. A wait that is over is Brain's refusal, which the worker goes on from: nobody can answer it any more.
 */
export async function heldForPersonManifest(userId: string): Promise<HeldLine[]> {
  const rows = (await db.query(
    `SELECT item_id, seq, title, params->'hold' AS hold FROM claw_work_items
      WHERE user_id = $1 AND board_state = 'needs_you' AND kind = 'task' AND params ? 'hold'
        AND (params->'hold'->>'attention_seq')::int = attention_seq
        AND (params->'hold'->>'expires_at')::timestamptz > NOW()
      ORDER BY seq`,
    [userId],
  )).rows as Array<{ item_id: string; seq: number; title: string; hold: Hold }>;
  return rows.map((r) => ({ itemId: r.item_id, seq: Number(r.seq), title: r.title, hold: r.hold }));
}

/**
 * The block a router turn is given beside the item list: what the user's workers wait for them on. Nothing when nothing
 * waits. Only the person answers these, on the card their channel drew or in the console: the router has no tool that does,
 * and what it says cannot answer one.
 */
export function renderHeldForPerson(lines: readonly HeldLine[]): string {
  if (!lines.length) return "";
  const list = lines.map((l) => `- #${l.seq} (item_id: ${l.itemId}) ${l.hold.kind === "question" ? "question" : "approval"}`
    + ` | waits until ${l.hold.expires_at} | ${quoted(l.hold.target)} | item: ${quoted(l.title)}`).join("\n");
  return `Waiting for you in work items (a worker holds a write for the user's decision, or asks them a question; only the user answers it, on the card in their chat or in the console, and nothing you say or call answers it: when they ask what waits for them, or say yes or no to one of these, tell them where it is and that it waits until the time shown):
${UNTRUSTED_OPEN}
${list}
${UNTRUSTED_CLOSE}`;
}
