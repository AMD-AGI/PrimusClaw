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
import { db, FAILOVER_RETRY_DELAY_MS, inTransaction, isFailoverError, neverCommitted, type Querier } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import {
  ASSISTANT_EVENT_TYPES,
  type AssistantFile,
  type AssistantItemSnapshot,
  type AssistantConfirmAction,
  type AssistantConfirmWrite,
  type AssistantSayPayload,
  type AssistantSaySource,
  type WorkItemNeedsYouPayload,
} from "../notifications/assistant-events.js";
import { deterministicEventId, enqueue, kickDelivery, onDelivered } from "../notifications/outbox.js";
import type { ItemRefError } from "./item-ref.js";
import { detectLanguage } from "./language.js";
import { canAccept, resolveWorkItem } from "./work-items.js";

const logger = pino({ name: "assistant-outbound" });

/**
 * The longest message the assistant may say, and the longest answer the system says for it: three chat messages of 3000
 * characters, which is how a channel shows a long one (whole, never cut). The prompt still asks for about a hundred words
 * (`SAY_BRIEF_CHARS`) unless the user asked for more; this is the bound, not the norm.
 */
export const SAY_TEXT_MAX = 9000;

export type SayRefusal = "empty_text" | "text_too_long" | "item_not_found" | ItemRefError | "say_rate_limited" | "handed_off";

/** A say that was not stored. `code` is what the caller tells the model. */
export class SayRefused extends Error {
  constructor(readonly code: SayRefusal, message: string) {
    super(message);
    this.name = "SayRefused";
  }
}

/** A say refused by the hourly cap. */
class SayCapped extends SayRefused {
  constructor(readonly limit: number) {
    super("say_rate_limited", `at most ${limit} messages an hour`);
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
  /**
   * The message id of the turn that says it: on the session's event, it is what tells a reader which message this answers. A turn that
   * handed a review to the person's channel says nothing more (`turnHandedOffReview`): its say is refused.
   */
  turnMessageId?: string;
  /** What the message cites, already checked (`citations.ts`): carried by its event to the channel and the web client. */
  sources?: AssistantSaySource[];
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
  | (ToStoreBase & {
    type: "assistant.say"; item: ItemRow | null; fallback?: boolean; confirmAction?: AssistantConfirmAction; confirmWrite?: AssistantConfirmWrite;
    sources?: AssistantSaySource[]; files?: AssistantFile[];
  })
  | (ToStoreBase & { type: "work_item.needs_you"; item: ItemRow });

/** What a stored message is, to a receiver and to the web client. */
function payloadOf(m: ToStore, createdAt: Date | string): AssistantSayPayload | WorkItemNeedsYouPayload {
  const base = { event_id: m.sayId, occurred_at: new Date(createdAt).toISOString(), user_id: m.userId, text: redact(m.text) };
  return m.type === "work_item.needs_you"
    ? { ...base, type: m.type, fallback: true, item: snapshot(m.item) }
    : {
      ...base, type: m.type, ...(m.item ? { item: snapshot(m.item) } : {}), ...(m.confirmAction ? { confirm_action: m.confirmAction } : {}),
      ...(m.sources?.length ? { sources: m.sources } : {}),
      ...(m.confirmWrite ? { confirm_write: m.confirmWrite } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
    };
}

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
  const payload = payloadOf(m, inserted.created_at);

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

/**
 * Messages this process has announced lately, newest last: what keeps a message looked up again in the background
 * (`settleLater`) from being announced a second time when something else here stored and announced it meanwhile.
 */
const announcedHere = new Set<string>();
const ANNOUNCED_HERE_MAX = 1_000;

/** After the commit: the web client's copy of the message, and the delivery that cannot wait for the poll. */
async function announce(stored: Stored, deps: SayDeps, turnMessageId?: string): Promise<void> {
  announcedHere.add(stored.sayId);
  if (announcedHere.size > ANNOUNCED_HERE_MAX) announcedHere.delete(announcedHere.values().next().value as string);
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
        ...(payload.type === "assistant.say" && payload.sources ? { sources: payload.sources } : {}),
        // What the message puts to the person to press, as a channel gets it: a web client, and an evaluation reading the session,
        // must see the card the channel draws, not only its words.
        ...(payload.type === "assistant.say" && payload.confirm_action ? { confirm_action: payload.confirm_action } : {}),
        ...(payload.type === "assistant.say" && payload.confirm_write ? { confirm_write: payload.confirm_write } : {}),
        ...(payload.type === "assistant.say" && payload.files ? { files: payload.files } : {}),
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
 * The cap's notice is stored under the hour it was sent in, by the database's clock, so the only ones that can be less
 * than an hour old are this hour's and the last hour's (and, to a transaction that waited, the next hour's). Not the stretch since the user reached the cap: under a steady
 * overload the cap lets one message through each time the oldest turns an hour old, and every such stretch would be
 * told again.
 */
const capNoticeKey = (hour: number) => `say_capped:${hour}`;

/** For tests: what the hour read from the database is taken as, so that two notices can be put on either side of an hour. */
let capNoticeHourHook: ((hour: number) => number | Promise<number>) | null = null;
export function setCapNoticeHourForTest(hook: ((hour: number) => number | Promise<number>) | null): void {
  capNoticeHourHook = hook;
}

/**
 * The cap's notice, unless the user has had one in the last hour: `null` then. Under the lock `say` takes for the user,
 * so two refusals at once -- on either side of an hour, on two replicas -- see each other's notice instead of storing
 * one each.
 */
async function storeCapNotice(input: SayInput, text: string, deps: SayDeps): Promise<Stored | null> {
  return storeSettled(async (q, storeOne) => {
    await q("SELECT pg_advisory_xact_lock(hashtext('claw_assistant_say'), hashtext($1))", [input.userId]);
    // The transaction's own time, which is what the notice's created_at will say: one clock for the hour, the age and
    // the row. A transaction that waited for the lock may be an hour behind one that stored a notice meanwhile, so the
    // next hour's notice is looked for as well.
    const read = Number((await q("SELECT floor(extract(epoch FROM now()) / 3600)::bigint AS h")).rows[0].h);
    const hour = capNoticeHourHook ? await capNoticeHourHook(read) : read;
    const id = (h: number) => deterministicEventId("assistant.notice", input.userId, capNoticeKey(h));
    const told = await q(
      "SELECT 1 FROM claw_assistant_says WHERE say_id = ANY($1::uuid[]) AND created_at > now() - INTERVAL '1 hour'",
      [[hour + 1, hour, hour - 1].map(id)],
    );
    if (told.rowCount) return null;
    return storeOne({
      type: "assistant.say", fallback: true, item: null, sayId: id(hour),
      userId: input.userId, sessionId: input.sessionId, text: sayCapNotice(text),
    });
  }, (stored) => announce(stored, deps));
}

/** What the user is told when the cap first refuses the assistant a message: short, in the language of that message. */
export function sayCapNotice(refused: string): string {
  return detectLanguage(refused) === "Chinese"
    ? "回复太频繁，已达到每小时的消息上限，请稍后再试。进行中的事项不受影响。"
    : "Too many replies: the hourly message limit is reached. Please try again later; your work items are not affected.";
}

/** What the model is told when the cap refused its message. */
function sayCapRefusal(limit: number, told: boolean): string {
  return `NOT delivered: the user has had ${limit} messages in the last hour, the most allowed, and every say is refused until ` +
    `fewer have. ${told ? "The user has been told their replies are paused for now. " : ""}Do not call say again in this turn.`;
}

/**
 * A say the cap refused is not a silence: the first one in an hour tells the user, in the system's words
 * (`sayCapNotice`, a fallback the cap does not count), and every one is counted. The ones after it in that hour find
 * the notice there and tell the user nothing more, so a client that keeps writing, or a model that keeps trying, gets
 * one notice and not one per message. The refusal goes back to the caller, for the model, in words that say the
 * message did not go out.
 */
async function refusedByCap(input: SayInput, text: string, refused: SayCapped, deps: SayDeps): Promise<SayRefused> {
  let told = true;
  try {
    const notice = await storeCapNotice(input, text, deps);
    metrics.onAssistantSayRateLimited(notice ? "sent" : "already_sent");
    if (notice) {
      logger.warn({ userId: input.userId, limit: refused.limit, sayId: notice.sayId }, "assistant.say_cap_notice_sent");
      await announce(notice, deps);
    }
  } catch (err) {
    told = false;
    metrics.onAssistantSayRateLimited("failed");
    logger.error({ err, userId: input.userId }, "assistant.say_cap_notice_failed");
    capNoticeLater(input, text, deps);
  }
  return new SayRefused("say_rate_limited", sayCapRefusal(refused.limit, told));
}

/**
 * The cap's notice when storing it failed (a failover, most likely): tried again in the background, a few times over
 * the next minute, until it is stored and announced or the user is found told. Safe to repeat: each try is the same
 * locked check-and-store. The timers do not hold the process open.
 */
function capNoticeLater(input: SayInput, text: string, deps: SayDeps): void {
  const attempt = (i: number): void => {
    setTimeout(() => {
      storeCapNotice(input, text, deps).then(
        async (notice) => {
          if (!notice) return;
          logger.warn({ userId: input.userId, sayId: notice.sayId }, "assistant.say_cap_notice_sent_later");
          await announce(notice, deps);
        },
        (err) => {
          if (i + 1 < SETTLE_LATER_DELAYS.length) attempt(i + 1);
          else logger.error({ err, userId: input.userId }, "assistant.say_cap_notice_never_sent");
        },
      ).catch((err) => logger.error({ err, userId: input.userId }, "assistant.say_cap_notice_announce_failed"));
    }, SETTLE_LATER_DELAYS[i] * FAILOVER_RETRY_DELAY_MS).unref();
  };
  attempt(0);
}

/**
 * A say a failover left unsettled: its COMMIT went out and no answer came back, and the database could not tell
 * whether it took effect. The message may be stored, or be yet; a second say of it may be a second message.
 */
export class SayOutcomeUnknown extends Error {
  constructor(readonly sayId: string) {
    super("it is not known whether the message was stored");
    this.name = "SayOutcomeUnknown";
  }
}

/** How often the database is asked whether an unsettled say was stored, before it is called unknown. */
const SAY_LOOKUP_ATTEMPTS = 3;

/**
 * The message `m`, if it is stored after all, as `store` would have returned it; `null` if it is not stored now. Asked
 * on connections made since the failover, a few times over its first seconds; {@link SayOutcomeUnknown} if no answer
 * came.
 */
async function storedAfterAll(m: ToStore): Promise<Stored | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const row = (await db.query(
        `SELECT created_at, (SELECT COUNT(*) FROM claw_notification_outbox WHERE event_id = $2) AS subscribers
           FROM claw_assistant_says WHERE say_id = $1`,
        [m.sayId, m.sayId],
      )).rows[0] as { created_at: Date; subscribers: string } | undefined;
      return row ? { sayId: m.sayId, sessionId: m.sessionId, payload: payloadOf(m, row.created_at), subscribers: Number(row.subscribers) } : null;
    } catch (err) {
      if (!isFailoverError(err) || attempt >= SAY_LOOKUP_ATTEMPTS) throw new SayOutcomeUnknown(m.sayId);
      await new Promise((resolve) => setTimeout(resolve, FAILOVER_RETRY_DELAY_MS));
    }
  }
}

/** How long after an unknown outcome a message is looked up again in the background: in retry delays. */
const SETTLE_LATER_DELAYS = [5, 15, 45];

/**
 * A message whose outcome the database could not tell, looked up again in the background, a few times over the next
 * minute, and announced once it is found stored. Not found by the last look, it was not. The timers do not hold the
 * process open.
 */
function settleLater(m: ToStore, announceStored: (stored: Stored) => Promise<void>): void {
  const attempt = (i: number): void => {
    setTimeout(() => {
      const again = () => {
        if (i + 1 < SETTLE_LATER_DELAYS.length) attempt(i + 1);
        else logger.warn({ sayId: m.sayId }, "assistant.say_not_stored_after_all");
      };
      storedAfterAll(m).then(
        async (stored) => {
          if (!stored) return again();
          if (announcedHere.has(m.sayId)) return;
          logger.warn({ sayId: m.sayId }, "assistant.say_settled_later");
          await announceStored(stored);
        },
        again,
      ).catch((err) => logger.error({ err, sayId: m.sayId }, "assistant.say_settle_failed"));
    }, SETTLE_LATER_DELAYS[i] * FAILOVER_RETRY_DELAY_MS).unref();
  };
  attempt(0);
}

/**
 * A transaction that ends by storing one message, with what a failover can leave unsettled settled: a COMMIT that took
 * effect and whose answer was lost. The message `run` stored is then looked up ({@link storedAfterAll}) and, when it is
 * there, returned as if the COMMIT had answered, for the caller to announce -- a message stored and never announced is
 * one a web client never sees, and one a later call finds stored and takes as told. When the database cannot be asked,
 * {@link SayOutcomeUnknown} is thrown and the message is looked up again later (`settleLater`), to be announced with
 * `announceStored` if it is there. Retried on a failover the way `inTransaction` retries a transaction that says it may
 * run twice.
 */
async function storeSettled(
  run: (q: Querier, storeOne: (m: ToStore) => Promise<Stored | null>) => Promise<Stored | null>,
  announceStored: (stored: Stored) => Promise<void>,
): Promise<Stored | null> {
  let inserted: ToStore | null = null;
  try {
    return await inTransaction(async (q) => {
      inserted = null;
      return run(q, async (m) => {
        const out = await store(q, m);
        if (out) inserted = m;
        return out;
      });
    }, { retryOnFailover: true });
  } catch (err) {
    const pending = inserted as ToStore | null;
    if (!pending || !isFailoverError(err) || neverCommitted(err)) throw err;
    // The COMMIT itself met the failover. It may have taken effect, or may yet: a backend whose client lost the
    // connection can still be finishing it. A row found is stored; a row not found is not proof of the opposite.
    let stored: Stored | null;
    try {
      stored = await storedAfterAll(pending);
    } catch (unknown) {
      settleLater(pending, announceStored);
      throw unknown;
    }
    if (!stored) {
      settleLater(pending, announceStored);
      throw new SayOutcomeUnknown(pending.sayId);
    }
    logger.warn({ sayId: stored.sayId, code: (err as { code?: unknown }).code }, "assistant.say_commit_answer_lost");
    return stored;
  }
}

/**
 * Record a message the assistant chose to say. Throws {@link SayRefused} for an
 * empty or over-long text, for an item that is not this user's or is not named as
 * an item is (`item-ref.ts`), and for a user who
 * has already had `CLAW_ASSISTANT_SAY_MAX_PER_HOUR` messages in the last hour, who
 * is then told so once (`refusedByCap`).
 */
export async function recordAssistantSay(input: SayInput, deps: SayDeps = {}): Promise<SayOutcome> {
  const text = input.text.trim();
  if (!text) throw new SayRefused("empty_text", "a message needs text");
  if (text.length > SAY_TEXT_MAX) throw new SayRefused("text_too_long", `a message is at most ${SAY_TEXT_MAX} characters`);
  const limit = deps.maxPerHour ?? CLAW_ASSISTANT_SAY_MAX_PER_HOUR;

  // One id for every attempt: what tells, after a failover took the COMMIT's answer, whether the message was stored.
  const sayId = randomUUID();
  let stored: Stored | null;
  try {
    stored = await storeSettled(async (q, storeOne) => {
      await input.guard?.(q);
      if (await turnHandedOffReview(q, input.userId, input.turnMessageId)) {
        throw new SayRefused("handed_off", HANDED_OFF_REFUSAL);
      }
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
      // The system's own messages are not counted: they are what is left when the assistant has failed to speak.
      const recent = Number((await q(
        `SELECT COUNT(*) AS n FROM claw_assistant_says
          WHERE user_id = $1 AND NOT fallback AND created_at > NOW() - INTERVAL '1 hour'`,
        [input.userId],
      )).rows[0].n);
      if (recent >= limit) throw new SayCapped(limit);
      return storeOne({ type: "assistant.say", sayId, userId: input.userId, sessionId: input.sessionId, text, item, sources: input.sources });
    }, (late) => announce(late, deps, input.turnMessageId));
  } catch (err) {
    if (err instanceof SayCapped) throw await refusedByCap(input, text, err, deps);
    throw err;
  }
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
  const stored = await storeSettled(async (q, storeOne) => {
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
    return storeOne({
      type: "work_item.needs_you",
      sayId: deterministicEventId("work_item.needs_you", item.item_id, String(item.attention_seq)),
      userId: item.user_id,
      sessionId,
      text: answered ? `#${item.seq} "${item.title}": ${answer}` : needsYouText(item),
      item,
    });
  }, (late) => announce(late, deps));
  if (!stored) return null;
  await announce(stored, deps);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/** What the router is told when its turn handed a review to the person's channel and then tried to speak. */
export const HANDED_OFF_REFUSAL = "this turn handed a review to the user's chat, which answers this message about it itself, in one message: "
  + "nothing was sent. Say nothing more in this turn: end it.";

/**
 * Whether the router turn answering this message of the person handed a review to their channel (`recordReviewHandoff` with its
 * `messageId`, `review-items.ts`). The channel then answers that message about the review itself, in one message: whether it started,
 * on which model, and how its merge is made, which only the started review knows. So the turn says nothing more: its say is refused,
 * and a turn that ends in plain text, or fails, delivers nothing (`deliverUnsaidAnswer`). Anything else the person asked is said before
 * the handoff, which the router's prompt asks.
 */
export async function turnHandedOffReview(q: Querier, userId: string, messageId: string | undefined): Promise<boolean> {
  if (!messageId) return false;
  return (await q(
    "SELECT 1 FROM claw_assistant_review_handoffs WHERE user_id = $1 AND message_id = $2 LIMIT 1",
    [userId, messageId],
  )).rows.length > 0;
}

/**
 * A message in the system's own words, not the model's: stored as a fallback, so it is neither counted against the say
 * limit nor taken for the turn having spoken. Once per `key`: a second call stores nothing and returns `null`.
 */
export async function recordSystemNotice(
  input: {
    userId: string; sessionId: string; text: string; key: string;
    /** The item it is about, attached as a say's is; and the message of the turn it answers, as on a say's event. */
    itemId?: string; turnMessageId?: string;
    /** Files the user gets with it (a worker's deliveries, `deliveries.ts`). */
    files?: AssistantFile[];
  }, deps: SayDeps = {},
): Promise<SayOutcome | null> {
  const stored = await storeSettled(async (q, storeOne) => storeOne({
    type: "assistant.say", fallback: true, item: input.itemId ? await loadItem(q, input.itemId, input.userId) : null,
    sayId: deterministicEventId("assistant.notice", input.userId, input.key),
    userId: input.userId, sessionId: input.sessionId, text: input.text,
    ...(input.files?.length ? { files: input.files } : {}),
  }), (late) => announce(late, deps, input.turnMessageId));
  if (!stored) return null;
  await announce(stored, deps, input.turnMessageId);
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

/**
 * A write the router proposed, put to the person with a button (`schedules.ts`): a message in the system's own words saying what
 * would be done, carrying the confirmation for a channel to draw as a card. Stored in the caller's transaction, as a fallback, once per
 * confirmation: `null` when it was stored before. `announce` after the commit.
 */
export async function recordWriteConfirm(
  q: Querier, input: { userId: string; sessionId: string; text: string; confirm: AssistantConfirmWrite }, deps: SayDeps = {},
): Promise<{ sayId: string; subscribers: number; announce: () => Promise<void> } | null> {
  const stored = await store(q, {
    type: "assistant.say", fallback: true, item: null, confirmWrite: input.confirm,
    sayId: deterministicEventId("assistant.confirm_write", input.userId, input.confirm.confirmation_id),
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
