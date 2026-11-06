// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an assistant says to its user, and how that leaves the system.
 *
 * A message is stored first (`claw_assistant_says`) and only then announced: as a
 * row in the notification outbox for every subscription that asked for the type,
 * and as an `AssistantSay` event in the assistant's session for a web client. The
 * store and the outbox rows are one transaction, so a message exists to be
 * delivered if and only if it exists at all. Delivery is kicked at once rather than
 * left to the poll, and `delivered_at` is written when a receiver answers 2xx, which
 * is the fact "a message nobody received is not a message sent" depends on.
 *
 * Nothing here knows which channel a person reads on.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import { CLAW_ASSISTANT_SAY_MAX_PER_HOUR, CLAW_NOTIFICATIONS_ENABLED } from "../config.js";
import { redactPublicJson } from "../events/redaction.js";
import { publishEvent } from "../events/store.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import {
  ASSISTANT_EVENT_TYPES,
  type AssistantItemSnapshot,
  type AssistantConfirmAction,
  type AssistantSayPayload,
  type WorkItemNeedsYouPayload,
} from "../notifications/assistant-events.js";
import { deterministicEventId, enqueue, kickDelivery, onDelivered } from "../notifications/outbox.js";
import type { ItemRefError } from "./item-ref.js";
import { canAccept, resolveWorkItem } from "./work-items.js";

const logger = pino({ name: "assistant-outbound" });

/** The longest message the assistant may say: about a hundred words. */
export const SAY_TEXT_MAX = 600;

export type SayRefusal = "empty_text" | "text_too_long" | "item_not_found" | ItemRefError | "say_rate_limited";

/** A say that was not stored. `code` is what the caller tells the model. */
export class SayRefused extends Error {
  constructor(readonly code: SayRefusal, message: string) {
    super(message);
    this.name = "SayRefused";
  }
}

export interface SayInput {
  userId: string;
  /** The user's assistant session: where a web client sees the message. */
  sessionId: string;
  text: string;
  /** An item of this user's that the message is about, by its id or its number (`#3`); it is attached to the event as a snapshot. */
  itemId?: string;
  /**
   * Runs first, inside the transaction, before anything is read or written; throwing
   * aborts the say. The place for the check that the caller still holds the turn.
   */
  guard?: (q: Querier) => Promise<void>;
  /** The message id of the turn that says it: on the session's event, it is what tells a reader which message this answers. */
  turnMessageId?: string;
}

export interface SayDeps {
  /** Overrides `CLAW_ASSISTANT_SAY_MAX_PER_HOUR`. */
  maxPerHour?: number;
  publishSessionEvent?: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
  kick?: () => Promise<void>;
}

export interface SayOutcome {
  say_id: string;
  /** Outbox rows written. Zero means no channel can reach the user right now. */
  subscribers: number;
}

interface ItemRow {
  item_id: string;
  user_id: string;
  seq: number;
  title: string;
  board_state: string;
  last_report_kind: string | null;
  pending_question: string | null;
  result_version: number;
  attention_seq: number;
  outcome: string | null;
}

const ITEM_COLUMNS = "item_id, user_id, seq, title, board_state, last_report_kind, pending_question, result_version, attention_seq, outcome";

const snapshot = (item: ItemRow): AssistantItemSnapshot => ({
  item_id: item.item_id,
  seq: item.seq,
  title: redact(item.title),
  board_state: item.board_state,
  result_version: item.result_version,
  can_accept: canAccept(item),
});

/** Text leaves the system for a receiver of the user's choosing: a credential a model repeated is masked on the way. */
const redact = (text: string): string => String(redactPublicJson(text) ?? "");

interface Stored {
  sayId: string;
  sessionId: string | null;
  payload: AssistantSayPayload | WorkItemNeedsYouPayload;
  subscribers: number;
}

interface ToStoreBase {
  sayId: string;
  userId: string;
  sessionId: string | null;
  text: string;
}

type ToStore =
  | (ToStoreBase & { type: "assistant.say"; item: ItemRow | null; fallback?: boolean; confirmAction?: AssistantConfirmAction })
  | (ToStoreBase & { type: "work_item.needs_you"; item: ItemRow });

/** Store the message and queue it for every subscription that asked for its type. `null`: it was stored before. */
async function store(q: Querier, m: ToStore): Promise<Stored | null> {
  const inserted = (await q(
    `INSERT INTO claw_assistant_says (say_id, user_id, item_id, item_attention_seq, text, fallback)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (say_id) DO NOTHING
     RETURNING created_at`,
    [m.sayId, m.userId, m.item?.item_id ?? null, m.item?.attention_seq ?? null, m.text, m.type === "work_item.needs_you" || m.fallback === true],
  )).rows[0];
  if (!inserted) return null;

  const base = { event_id: m.sayId, occurred_at: new Date(inserted.created_at).toISOString(), user_id: m.userId, text: redact(m.text) };
  const payload: AssistantSayPayload | WorkItemNeedsYouPayload = m.type === "work_item.needs_you"
    ? { ...base, type: m.type, fallback: true, item: snapshot(m.item) }
    : { ...base, type: m.type, ...(m.item ? { item: snapshot(m.item) } : {}), ...(m.confirmAction ? { confirm_action: m.confirmAction } : {}) };

  // The subscription's `sources` is about what started a run; an assistant message is not one.
  const subs = CLAW_NOTIFICATIONS_ENABLED
    ? (await q(
      `SELECT subscription_id FROM claw_notification_subscriptions
        WHERE owner_user_id = $1 AND enabled AND $2 = ANY(event_types)`,
      [m.userId, m.type],
    )).rows
    : [];
  const subscribers = await enqueue(m.sayId, subs, payload, q);
  return { sayId: m.sayId, sessionId: m.sessionId, payload, subscribers };
}

/** After the commit: the web client's copy of the message, and the delivery that cannot wait for the poll. */
async function announce(stored: Stored, deps: SayDeps, turnMessageId?: string): Promise<void> {
  if (stored.sessionId) {
    const { payload } = stored;
    try {
      await (deps.publishSessionEvent ?? publishEvent)(stored.sessionId, {
        type: "AssistantSay",
        session_id: stored.sessionId,
        say_id: stored.sayId,
        ...(turnMessageId ? { turn_message_id: turnMessageId } : {}),
        text: payload.text,
        ...(payload.item ? { item: payload.item } : {}),
        fallback: payload.type === "work_item.needs_you",
        ts: Date.parse(payload.occurred_at),
      });
    } catch (err) {
      // The message is stored and queued; a web client that missed the live event reads it later.
      logger.error({ err, sayId: stored.sayId }, "assistant.say_event_publish_failed");
    }
  }
  // Not awaited: the caller is a model's tool call, and a slow receiver is not its wait.
  if (stored.subscribers > 0) void (deps.kick ?? kickDelivery)().catch((err) => logger.error({ err }, "assistant.say_kick_failed"));
}

async function loadItem(q: Querier, itemId: string, userId?: string): Promise<ItemRow | null> {
  const r = await q(
    `SELECT ${ITEM_COLUMNS} FROM claw_work_items WHERE item_id = $1 AND ($2::text IS NULL OR user_id = $2)`,
    [itemId, userId ?? null],
  );
  return (r.rows[0] as ItemRow | undefined) ?? null;
}

/**
 * Whether the user has had `limit` of the assistant's messages in the last hour, which is when `say` refuses another.
 * The system's own messages are not counted: they are what is left when the assistant has failed to speak.
 */
export async function sayCapReached(q: Querier, userId: string, limit: number = CLAW_ASSISTANT_SAY_MAX_PER_HOUR): Promise<boolean> {
  const recent = Number((await q(
    `SELECT COUNT(*) AS n FROM claw_assistant_says
      WHERE user_id = $1 AND NOT fallback AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
  )).rows[0].n);
  return recent >= limit;
}

/**
 * Record a message the assistant chose to say. Throws {@link SayRefused} for an
 * empty or over-long text, for an item that is not this user's or is not named as
 * an item is (`item-ref.ts`), and for a user who
 * has already had `CLAW_ASSISTANT_SAY_MAX_PER_HOUR` messages in the last hour.
 */
export async function recordAssistantSay(input: SayInput, deps: SayDeps = {}): Promise<SayOutcome> {
  const text = input.text.trim();
  if (!text) throw new SayRefused("empty_text", "a message needs text");
  if (text.length > SAY_TEXT_MAX) throw new SayRefused("text_too_long", `a message is at most ${SAY_TEXT_MAX} characters`);
  const limit = deps.maxPerHour ?? CLAW_ASSISTANT_SAY_MAX_PER_HOUR;

  const stored = await inTransaction(async (q) => {
    await input.guard?.(q);
    // One say at a time per user: the cap counts stored rows, and without this a burst
    // all count the same number and all insert.
    await q("SELECT pg_advisory_xact_lock(hashtext('claw_assistant_say'), hashtext($1))", [input.userId]);
    let item: ItemRow | null = null;
    if (input.itemId?.trim()) {
      const named = await resolveWorkItem(q, input.userId, input.itemId);
      if (!named.ok) throw new SayRefused(named.error, named.message);
      item = await loadItem(q, named.item.item_id, input.userId);
      if (!item) throw new SayRefused("item_not_found", "no such item");
    }
    if (await sayCapReached(q, input.userId, limit)) throw new SayRefused("say_rate_limited", `at most ${limit} messages an hour`);
    return store(q, { type: "assistant.say", sayId: randomUUID(), userId: input.userId, sessionId: input.sessionId, text, item });
  }, { retryOnFailover: true });
  if (!stored) throw new Error("a fresh say id was already stored");
  await announce(stored, deps, input.turnMessageId);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

const NEEDS_YOU_TEXT: Record<string, (item: ItemRow) => string> = {
  ready: (i) => `is ready for your review (v${i.result_version}).`,
  waiting: (i) => `needs your answer: ${i.pending_question ?? ""}`,
  blocked: (i) => (i.pending_question ? `is blocked and needs your answer: ${i.pending_question}` : "is blocked and needs your help."),
  failed: () => "failed and needs your attention.",
};

function needsYouText(item: ItemRow): string {
  const what = (NEEDS_YOU_TEXT[item.last_report_kind ?? ""] ?? (() => "needs your attention."))(item);
  return `#${item.seq} "${item.title}" ${what}`;
}

/**
 * Tell a user that an item needs them, in the system's own words, for an item the
 * assistant has not already said so about. The caller decides when that is.
 *
 * Once per `attention_seq`: the message id is derived from the item and the
 * attention it is about, so a second call -- a sweep that overlaps itself, a retry --
 * stores nothing and returns `null`, as it does for an item that stopped needing the
 * user before the call got here. Not counted against the say limit.
 */
export async function recordNeedsYouFallback(input: { itemId: string }, deps: SayDeps = {}): Promise<SayOutcome | null> {
  const stored = await inTransaction(async (q) => {
    const item = await loadItem(q, input.itemId);
    const answered = item?.board_state === "done" && item.outcome === "answered";
    if (!item || (item.board_state !== "needs_you" && !answered)) return null;
    // An answer is said whole, from the report (the item's own summary is cut to a line).
    const answer = answered
      ? ((await q(
          "SELECT summary FROM claw_work_item_events WHERE item_id = $1 AND kind = 'answer' ORDER BY id DESC LIMIT 1", [item.item_id],
        )).rows[0]?.summary as string | undefined) ?? ""
      : "";
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [item.user_id])).rows[0]?.session_id ?? null;
    return store(q, {
      type: "work_item.needs_you",
      sayId: deterministicEventId("work_item.needs_you", item.item_id, String(item.attention_seq)),
      userId: item.user_id,
      sessionId,
      text: answered ? `#${item.seq} "${item.title}": ${answer}` : needsYouText(item),
      item,
    });
  }, { retryOnFailover: true });
  if (!stored) return null;
  await announce(stored, deps);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/**
 * A message in the system's own words, not the model's: stored as a fallback, so it is neither counted against the say
 * limit nor taken for the turn having spoken. Once per `key`: a second call stores nothing and returns `null`.
 */
export async function recordSystemNotice(
  input: { userId: string; sessionId: string; text: string; key: string }, deps: SayDeps = {},
): Promise<SayOutcome | null> {
  const stored = await inTransaction((q) => store(q, {
    type: "assistant.say", fallback: true, item: null,
    sayId: deterministicEventId("assistant.notice", input.userId, input.key),
    userId: input.userId, sessionId: input.sessionId, text: input.text,
  }), { retryOnFailover: true });
  if (!stored) return null;
  await announce(stored, deps);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/**
 * A channel action put to the person instead of run (`channel_action`): a message in the system's own words naming the exact
 * command, carrying the action for a channel to draw as a button. The channel runs it only when the person presses it. Stored
 * in the caller's transaction, as a fallback (not counted against the say limit, not taken for the turn having spoken), once per
 * `key`: `null` when it was stored before. `announce` after the commit.
 */
export async function recordActionConfirm(
  q: Querier, input: { userId: string; sessionId: string; key: string; text: string; action: AssistantConfirmAction }, deps: SayDeps = {},
): Promise<{ sayId: string; subscribers: number; announce: () => Promise<void> } | null> {
  const stored = await store(q, {
    type: "assistant.say", fallback: true, item: null, confirmAction: input.action,
    sayId: deterministicEventId("assistant.confirm_action", input.userId, input.key),
    userId: input.userId, sessionId: input.sessionId, text: input.text,
  });
  if (!stored) return null;
  return { sayId: stored.sayId, subscribers: stored.subscribers, announce: () => announce(stored, deps) };
}

/** Stamp `delivered_at` once a receiver has taken a message. Call once at startup, with the notification worker. */
export function registerAssistantDeliveryHook(): void {
  onDelivered(ASSISTANT_EVENT_TYPES, async ({ eventId }) => {
    await db.query("UPDATE claw_assistant_says SET delivered_at = NOW() WHERE say_id = $1 AND delivered_at IS NULL", [eventId]);
  });
}
