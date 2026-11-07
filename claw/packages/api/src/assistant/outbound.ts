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
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_SAY_MAX_PER_HOUR, CLAW_NOTIFICATIONS_ENABLED } from "../config.js";
import { redactPublicJson } from "../events/redaction.js";
import { publishEvent } from "../events/store.js";
import { HOLD_SECONDS, heldStatus, turnAnnouncedStart, turnToldStart } from "./say-hold.js";
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
import { detectLanguage, languageToAnswerIn } from "./language.js";
import { canAccept, resolveWorkItem } from "./work-items.js";

const logger = pino({ name: "assistant-outbound" });

/**
 * The longest message the assistant may say, and the longest answer the system says for it: three chat messages of 3000
 * characters, which is how a channel shows a long one (whole, never cut). The prompt still asks for about a hundred words
 * (`SAY_BRIEF_CHARS`) unless the user asked for more; this is the bound, not the norm.
 */
export const SAY_TEXT_MAX = 9000;

export type SayRefusal = "empty_text" | "text_too_long" | "item_not_found" | ItemRefError | "say_rate_limited" | "handed_off" | "already_announced";

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
  /** Its deliveries are held until this turn (a message id) ends or hands a review over (`say-hold.ts`). */
  holdForTurn?: string;
  /**
   * When the turn that says it began. After the system's start notice in that turn (`turnAnnouncedStart`) a message is refused
   * (`already_announced`: the turn's unsaid final text), unless `amendNotice`: then it is stored as an addition to that notice
   * (`amends`), which the channel shows in the same message.
   */
  turnBegan?: Date | string;
  amendNotice?: boolean;
  /** The replies it suggests, already checked (`suggested.ts`): carried by its event as `suggested_replies`. */
  suggested?: string[];
  /**
   * The item the report that woke this turn is about, when that report said the item came from a session the user deleted
   * (`earlierConversationItemOf`): a message about that item starts with where it came from (`MOVED_PREFIX_ZH`/`_EN`), as the system's
   * own message about it does, added here when the router left it out.
   */
  fromEarlierConversationItem?: string;
}

export interface SayDeps {
  /** Overrides `CLAW_ASSISTANT_SAY_MAX_PER_HOUR`. */
  maxPerHour?: number;
  publishSessionEvent?: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
  kick?: () => Promise<void>;
  /** Where a refused say's streamed text is taken back (`router-speed.ts`, `voidStreamedSay`); the session's event stream by default. */
  publishStreamVoid?: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
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
  /** Held deliveries (`say-hold.ts`). */
  hold?: { status: string; seconds: number };
}

type ToStore =
  | (ToStoreBase & {
    type: "assistant.say"; item: ItemRow | null; fallback?: boolean; confirmAction?: AssistantConfirmAction; confirmWrite?: AssistantConfirmWrite;
    sources?: AssistantSaySource[]; files?: AssistantFile[]; amends?: string; replaces?: string; suggested?: string[];
    /** A system notice's turn (the message it answers): kept on its payload, so a later say of that turn finds it (`turnAnnouncedStart`). */
    noticeOfTurn?: string;
    /** A router say's turn, kept on its payload the same way, so a later say of that turn finds it (`turnFirstSay`). */
    turnMessageId?: string;
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
      ...(m.suggested?.length ? { suggested_replies: m.suggested.map(redact) } : {}),
      ...(m.confirmWrite ? { confirm_write: m.confirmWrite } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
      ...(m.amends ? { amends: m.amends } : {}),
      ...(m.replaces ? { replaces: m.replaces } : {}),
      ...((m.noticeOfTurn ?? m.turnMessageId) ? { turn_message_id: m.noticeOfTurn ?? m.turnMessageId } : {}),
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
  const subscribers = await enqueue(m.sayId, subs, payload, q, m.hold);
  return { sayId: m.sayId, sessionId: m.sessionId, payload, subscribers };
}

/**
 * Messages this process has announced lately, newest last: what keeps a message looked up again in the background
 * (`settleLater`) from being announced a second time when something else here stored and announced it meanwhile.
 */
const announcedHere = new Set<string>();
const ANNOUNCED_HERE_MAX = 1_000;

/**
 * After the commit: the web client's copy of the message, and the delivery that cannot wait for the poll. A say whose deliveries are
 * held (`say-hold.ts`) is not shown to the web client either until they are released (`publishSayEvent` then), and never if the turn
 * hands a review over: the session must not show a message the channel never gets.
 */
async function announce(stored: Stored, deps: SayDeps, turnMessageId?: string, held = false): Promise<void> {
  announcedHere.add(stored.sayId);
  if (announcedHere.size > ANNOUNCED_HERE_MAX) announcedHere.delete(announcedHere.values().next().value as string);
  if (stored.subscribers === 0 && CLAW_NOTIFICATIONS_ENABLED) await reportUnreachable(stored);
  if (stored.sessionId && !(held && stored.subscribers > 0)) await publishSayEvent(stored.sessionId, stored.sayId, stored.payload, deps, turnMessageId);
  // Not awaited: the caller is a model's tool call, and a slow receiver is not its wait.
  if (stored.subscribers > 0) void (deps.kick ?? kickDelivery)().catch((err) => logger.error({ err }, "assistant.say_kick_failed"));
}

/** The session's `AssistantSay` event for a stored message (`announce`; a held say's when it is released, `router-turn-end.ts`). */
export async function publishSayEvent(
  sessionId: string, sayId: string, payload: AssistantSayPayload | WorkItemNeedsYouPayload, deps: SayDeps, turnMessageId?: string,
): Promise<void> {
  // Shown in a session that is still there is what tells a user with no channel (the silent sweep's `told`): the message is claimed
  // for the session first, so it is published there at most once whoever else tries (`reshowFallback`, another replica), and the claim
  // is let go when the publish fails. A message another publish claimed is not published again. A session deleted meanwhile is read
  // by nobody: published unrecorded, as is everything when the claim cannot be made at all.
  let claimed = false;
  try {
    claimed = ((await db.query(
      `UPDATE claw_assistant_says SET session_id = $2
        WHERE say_id = $1 AND session_id IS NULL
          AND EXISTS (SELECT 1 FROM claw_sessions WHERE session_id = $2 AND deleted_at IS NULL)`,
      [sayId, sessionId],
    )).rowCount ?? 0) > 0;
    if (!claimed && (await db.query(
      "SELECT 1 FROM claw_assistant_says WHERE say_id = $1 AND session_id IS NOT NULL", [sayId],
    )).rowCount) return;
  } catch (err) {
    logger.warn({ err, sayId }, "assistant.say_shown_record_failed");
  }
  try {
    await sendSayEvent(sessionId, sayId, payload, deps, turnMessageId);
  } catch (err) {
    // The message is stored and queued; a web client that missed the live event reads it later.
    logger.error({ err, sayId }, "assistant.say_event_publish_failed");
    if (claimed) await releaseShown(sayId, sessionId);
  }
}

/** A claim to have shown the message in the session, let go: nothing was shown. */
async function releaseShown(sayId: string, sessionId: string): Promise<void> {
  await db.query("UPDATE claw_assistant_says SET session_id = NULL WHERE say_id = $1 AND session_id = $2", [sayId, sessionId])
    .catch((err) => logger.error({ err, sayId }, "assistant.say_shown_release_failed"));
}

/** The event itself; throws when it was not published. */
async function sendSayEvent(
  sessionId: string, sayId: string, payload: AssistantSayPayload | WorkItemNeedsYouPayload, deps: SayDeps, turnMessageId?: string,
): Promise<void> {
  await (deps.publishSessionEvent ?? publishEvent)(sessionId, {
    type: "AssistantSay",
    session_id: sessionId,
    say_id: sayId,
    ...(turnMessageId ? { turn_message_id: turnMessageId } : {}),
    text: payload.text,
    ...(payload.item ? { item: payload.item } : {}),
    ...(payload.type === "assistant.say" && payload.sources ? { sources: payload.sources } : {}),
    ...(payload.type === "assistant.say" && payload.suggested_replies ? { suggested_replies: payload.suggested_replies } : {}),
    // What the message puts to the person to press, as a channel gets it: a web client, and an evaluation reading the session,
    // must see the card the channel draws, not only its words.
    ...(payload.type === "assistant.say" && payload.confirm_action ? { confirm_action: payload.confirm_action } : {}),
    ...(payload.type === "assistant.say" && payload.confirm_write ? { confirm_write: payload.confirm_write } : {}),
    ...(payload.type === "assistant.say" && payload.files ? { files: payload.files } : {}),
    ...(payload.type === "assistant.say" && payload.amends ? { amends: payload.amends } : {}),
    ...(payload.type === "assistant.say" && payload.replaces ? { replaces: payload.replaces } : {}),
    fallback: payload.type === "work_item.needs_you",
    ts: Date.parse(payload.occurred_at),
  });
}

/** Where the unreachable-message warning goes: a seam, so a test can see which messages were warned about. */
export const outboundLog = {
  unreachable(fields: { user_id: string; item_id: string | null; say_id: string; type: string }): void {
    logger.warn(
      fields,
      "assistant.say_unreachable (stored with no notification subscription for its type: no channel the user reads on was sent it)",
    );
  },
};

/**
 * A message stored with no subscription to carry it: counted every time, and said in the log -- with the user and the
 * item -- once per user per clock hour, so one user whose channel is missing (an evaluation identity that says a lot)
 * does not fill the log. The one said is the hour's earliest such message of that user, decided from the stored rows,
 * so four replicas agree on it without a lock: at most one line per user an hour, fleet-wide. Never throws: the
 * message is stored and announced whatever this finds.
 */
async function reportUnreachable(stored: Stored): Promise<void> {
  const { payload } = stored;
  metrics.onAssistantSayUnreachable(payload.type);
  try {
    const first = (await db.query(
      `SELECT s.say_id::text AS say_id FROM claw_assistant_says s
        WHERE s.user_id = $1
          AND s.created_at >= date_trunc('hour', (SELECT created_at FROM claw_assistant_says WHERE say_id = $2::uuid))
          AND NOT EXISTS (SELECT 1 FROM claw_notification_outbox o WHERE o.event_id = s.say_id::text)
        ORDER BY s.created_at, s.say_id
        LIMIT 1`,
      [payload.user_id, stored.sayId],
    )).rows[0] as { say_id: string } | undefined;
    if (first?.say_id !== stored.sayId) return;
    outboundLog.unreachable({ user_id: payload.user_id, item_id: payload.item?.item_id ?? null, say_id: stored.sayId, type: payload.type });
  } catch (err) {
    logger.error({ err, sayId: stored.sayId }, "assistant.say_unreachable_check_failed");
  }
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
      // The turn's unsaid final text after a start notice is refused whether or not a channel got the notice (`turnToldStart`); a say
      // of the router's is added to the notice, matched by the turn on its delivery (`turnAnnouncedStart`), or is a message of its own.
      if (!input.amendNotice && input.turnBegan && await turnToldStart(q, input.userId, input.turnBegan)) {
        throw new SayRefused("already_announced", ALREADY_ANNOUNCED_REFUSAL);
      }
      const notice = input.amendNotice && input.turnBegan && input.turnMessageId
        ? await turnAnnouncedStart(q, input.userId, input.turnBegan, input.turnMessageId) : null;
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
      const replaces = input.turnMessageId && input.turnBegan ? await turnFirstSay(q, input.userId, input.turnBegan, input.turnMessageId) : null;
      const said = item && item.item_id === input.fromEarlierConversationItem ? withMovedPrefix(text) : text;
      return storeOne({
        type: "assistant.say", sayId, userId: input.userId, sessionId: input.sessionId, text: said, item, sources: input.sources, suggested: input.suggested,
        ...(input.turnMessageId ? { turnMessageId: input.turnMessageId } : {}),
        // After the turn's start notice a say adds to that notice (`amends`); otherwise a later say takes the place of the turn's first one.
        ...(notice ? { amends: notice } : replaces ? { replaces } : {}),
        ...(input.holdForTurn ? { hold: { status: heldStatus(input.holdForTurn), seconds: HOLD_SECONDS } } : {}),
      });
    }, (late) => announce(late, deps, input.turnMessageId, !!input.holdForTurn));
  } catch (err) {
    if (err instanceof SayCapped) throw await refusedByCap(input, text, err, deps);
    throw err;
  }
  if (!stored) throw new Error("a fresh say id was already stored");
  await announce(stored, deps, input.turnMessageId, !!input.holdForTurn);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/**
 * The router's first message in the turn that answers `messageId` (begun at `since`), by its say id; null when it has said nothing yet.
 * A later say of the turn takes that message's place (`AssistantSayPayload.replaces`): the release gate found an answer followed by a
 * second message correcting it ("更正上一条…", 2026-11-06), where the person should have had one message, right. Matched by the turn
 * kept on the message's delivery, never by time alone: turns of one user can overlap. Without notifications there is no channel to
 * replace a message in, and no outbox to match by.
 */
export async function turnFirstSay(q: Querier, userId: string, since: Date | string, messageId: string): Promise<string | null> {
  if (!CLAW_NOTIFICATIONS_ENABLED) return null;
  const row = (await q(
    `SELECT s.say_id::text AS say_id FROM claw_assistant_says s
      WHERE s.user_id = $1 AND NOT s.fallback AND s.created_at >= $2
        AND EXISTS (SELECT 1 FROM claw_notification_outbox o WHERE o.event_id = s.say_id::text AND o.payload->>'turn_message_id' = $3)
      ORDER BY s.created_at, s.say_id LIMIT 1`,
    [userId, since, messageId],
  )).rows[0] as { say_id: string } | undefined;
  return row?.say_id ?? null;
}

const NEEDS_YOU_TEXT: Record<string, (item: ItemRow) => string> = {
  ready: (i) => `is ready for your review (v${i.result_version}).`,
  waiting: (i) => `needs your answer: ${i.pending_question ?? ""}`,
  blocked: (i) => (i.pending_question ? `is blocked and needs your answer: ${i.pending_question}` : "is blocked and needs your help."),
  failed: () => "failed and needs your attention.",
};
/** The same, for a person who writes Chinese (`personWritesChinese`). */
const NEEDS_YOU_TEXT_ZH: Record<string, (item: ItemRow) => string> = {
  ready: (i) => `已完成，等你验收（v${i.result_version}）。`,
  waiting: (i) => `需要你回复：${i.pending_question ?? ""}`,
  blocked: (i) => (i.pending_question ? `卡住了，需要你回复：${i.pending_question}` : "卡住了，需要你帮忙。"),
  failed: () => "失败了，需要你看一下。",
};

function needsYouText(item: ItemRow, zh = false): string {
  if (zh) {
    const what = (NEEDS_YOU_TEXT_ZH[item.last_report_kind ?? ""] ?? (() => "需要你处理。"))(item);
    return `#${item.seq} ${item.title} ${what}`;
  }
  const what = (NEEDS_YOU_TEXT[item.last_report_kind ?? ""] ?? (() => "needs your attention."))(item);
  return `#${item.seq} "${item.title}" ${what}`;
}

/** How many of the person's latest messages to their assistant say which language they write in. */
const PERSON_LANGUAGE_LOOKBACK = 5;

/**
 * Whether the person writes to their assistant in Chinese: their latest messages to it, newest first, as the router's reply language is
 * worked out (`languageToAnswerIn`); failing that, `fallback` (what they named the work, an item's title). A message the system sends
 * them on its own (an item that needs them, a write to approve) is in their language, not in English.
 */
export async function personWritesChinese(q: Querier, userId: string, fallback = ""): Promise<boolean> {
  const language = await languageToAnswerIn(null, async () => ((await q(
    `SELECT m.content FROM claw_assistant_messages m JOIN claw_assistants a ON a.session_id = m.session_id
      WHERE a.user_id = $1 ORDER BY m.received_at DESC LIMIT $2`,
    [userId, PERSON_LANGUAGE_LOOKBACK],
  )).rows as Array<{ content: string }>).map((r) => r.content));
  return (language ?? (fallback ? detectLanguage(fallback) : null)) === "Chinese";
}

/** A write a worker holds for the person, as `holds.ts` records it: what it would do in their words, and the text it would write. */
interface HeldWrite { kind?: string; attention_seq?: number; action?: string; detail?: string; zh?: boolean; expires_at?: string }

/**
 * The message for an item whose worker holds a write for the person, in the language the hold was recorded in: what it would do, in
 * plain words, the text it would write (a comment), and where to answer it; never the tool's name alone (2026-11-06 parity run, G2:
 * "needs your answer: Approve or deny: mcp__github__issue_comment …" was all a Chinese user saw). Null when the item holds no such write
 * now, or the hold predates these words.
 */
function heldWriteText(item: ItemRow, params: Record<string, unknown> | null): string | null {
  if (item.board_state !== "needs_you") return null;
  const holds = (Array.isArray(params?.holds) ? params!.holds : []) as HeldWrite[];
  const current = holds.filter((h) => h && h.kind === "approval" && Number(h.attention_seq) === Number(item.attention_seq) && h.action);
  const h = current.at(-1);
  if (!h) return null;
  const until = h.expires_at ? new Date(h.expires_at) : null;
  const time = until && !Number.isNaN(until.getTime()) ? `${until.toISOString().slice(11, 16)} UTC` : "";
  if (h.zh) {
    return [
      `#${item.seq} ${item.title} 需要你批准一个操作：${h.action}。`,
      ...(h.detail ? ["内容如下：", "---", h.detail, "---"] : []),
      `在聊天里这条请求的卡片上，或在控制台的这个任务里批准或拒绝${time ? `，${time} 前有效，过时自动拒绝` : ""}。`,
    ].join("\n");
  }
  return [
    `#${item.seq} "${item.title}" needs your approval to: ${h.action}.`,
    ...(h.detail ? ["It would write:", "---", h.detail, "---"] : []),
    `Approve or deny it on its card in your chat, or in this task in the console${time ? `, before ${time}; after that it is refused` : ""}.`,
  ].join("\n");
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
  await ensureLiveAssistant(input.itemId);
  const stored = await storeSettled(async (q, storeOne) => {
    const m = await needsYouMessage(q, input.itemId);
    return m ? storeOne(m) : null;
  }, (late) => announce(late, deps));
  if (!stored) return null;
  await announce(stored, deps);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/**
 * Show again, in the item's session, the system's message about its current need that was stored but shown in no session (its
 * publish failed, or the user had no session then): the silent sweep's, for a user no channel tells (`silent-sweep.ts`). The same
 * message, under the same id. At most once: the message is claimed for the session first (`session_id`, set only while unset), so of
 * two sweeps only one publishes, and the claim is let go when the publish fails, for a later sweep to try again; an event the session's
 * stream already holds (a publish whose claim was lost) is not published again. True when it is shown now.
 */
export async function reshowFallback(input: { itemId: string }, deps: SayDeps = {}): Promise<boolean> {
  await ensureLiveAssistant(input.itemId);
  const item = await loadItem((t, p) => db.query(t, p), input.itemId);
  if (!item) return false;
  const sayId = deterministicEventId("work_item.needs_you", item.item_id, String(item.attention_seq));
  const where = await itemSession((t, p) => db.query(t, p), item.item_id);
  if (!where?.sessionId) return false;
  const claimed = (await db.query(
    `UPDATE claw_assistant_says SET session_id = $2
      WHERE say_id = $1 AND fallback AND session_id IS NULL
        AND EXISTS (SELECT 1 FROM claw_sessions WHERE session_id = $2 AND deleted_at IS NULL)
      RETURNING text, created_at`,
    [sayId, where.sessionId],
  )).rows[0] as { text: string; created_at: Date } | undefined;
  if (!claimed) return false;
  const m: ToStore = { type: "work_item.needs_you", sayId, userId: item.user_id, sessionId: where.sessionId, text: claimed.text, item };
  try {
    if (!(await eventInSession(where.sessionId, sayId))) await sendSayEvent(where.sessionId, sayId, payloadOf(m, claimed.created_at), deps);
    return true;
  } catch (err) {
    logger.error({ err, sayId }, "assistant.say_event_publish_failed");
    await releaseShown(sayId, where.sessionId);
    return false;
  }
}

/** What the router is told when the system already told the user, in this turn, that the item they asked for started. */
export const ALREADY_ANNOUNCED_REFUSAL = "the system has already told the user in this turn that the item started (its number and title): "
  + "nothing was sent, as a second message would repeat it. Say nothing more in this turn: end it.";

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

/** What a message about an item from a session the user deleted starts with: it is said in the session they have now, once. */
export const MOVED_PREFIX_ZH = "（之前的对话里开始的事项）";
export const MOVED_PREFIX_EN = "(From an earlier conversation) ";

/** A message about an item from a deleted session, starting with where it came from: unchanged when it already says so anywhere. */
export function withMovedPrefix(text: string): string {
  if (text.includes(MOVED_PREFIX_ZH) || text.toLowerCase().includes(MOVED_PREFIX_EN.trim().toLowerCase())) return text;
  return `${detectLanguage(text) === "Chinese" ? MOVED_PREFIX_ZH : MOVED_PREFIX_EN}${text}`;
}

/**
 * Where the system says something about an item on its own: the assistant session the item was started from. When the user deleted
 * that session, the one that replaced it, and `moved`: the message says where the item came from. It is still said once (its id is
 * the item's and the need's), and only when nothing told the user before (the silent sweep's `told`). An item made before its session
 * was recorded goes to the current session, as before. A user with no assistant at all has only their channels (no session). Null when
 * the user's assistant has no session that is still there: nobody would read it.
 */
async function itemSession(q: Querier, itemId: string): Promise<{ sessionId: string | null; moved: boolean } | null> {
  const row = (await q(
    `SELECT w.router_session_id AS own, a.session_id AS current,
            EXISTS (SELECT 1 FROM claw_sessions s WHERE s.session_id = w.router_session_id AND s.deleted_at IS NULL) AS own_live,
            EXISTS (SELECT 1 FROM claw_sessions s WHERE s.session_id = a.session_id AND s.deleted_at IS NULL) AS current_live
       FROM claw_work_items w LEFT JOIN claw_assistants a ON a.user_id = w.user_id
      WHERE w.item_id = $1`,
    [itemId],
  )).rows[0] as { own: string | null; current: string | null; own_live: boolean; current_live: boolean } | undefined;
  if (!row) return null;
  if (row.current === null) return { sessionId: null, moved: false };
  if (row.own && row.own_live) return { sessionId: row.own, moved: false };
  if (row.current && row.current_live) return { sessionId: row.current, moved: row.own !== null && row.own !== row.current };
  return null;
}

/**
 * Before the system says something about an item on its own: a user whose assistant session was deleted and not yet made again gets
 * it made now, as their next visit would (`getOrCreateAssistant`), so the message has a session that is read. Otherwise it would be
 * shown nowhere and, for a user with no channel, never be said.
 */
async function ensureLiveAssistant(itemId: string): Promise<void> {
  const row = (await db.query(
    `SELECT w.user_id, EXISTS (SELECT 1 FROM claw_sessions s WHERE s.session_id = a.session_id AND s.deleted_at IS NULL) AS live
       FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id WHERE w.item_id = $1`,
    [itemId],
  )).rows[0] as { user_id: string; live: boolean } | undefined;
  if (!row || row.live) return;
  const { getOrCreateAssistant } = await import("./assistant.js");
  await getOrCreateAssistant(row.user_id);
}

/** The system's message for an item that needs the user or was answered (`recordNeedsYouFallback`), or null when it is neither. */
async function needsYouMessage(q: Querier, itemId: string): Promise<Extract<ToStore, { type: "work_item.needs_you" }> | null> {
  const item = await loadItem(q, itemId);
  const answered = item?.board_state === "done" && item.outcome === "answered";
  if (!item || (item.board_state !== "needs_you" && !answered)) return null;
  // An answer is said whole, from the report (the item's own summary is cut to a line).
  const answer = answered
    ? ((await q(
        "SELECT summary FROM claw_work_item_events WHERE item_id = $1 AND kind = 'answer' ORDER BY id DESC LIMIT 1", [item.item_id],
      )).rows[0]?.summary as string | undefined) ?? ""
    : "";
  const where = await itemSession(q, item.item_id);
  // No session is read: nothing is stored, so a later call (the sweep's, once a session exists) says it.
  if (!where) return null;
  const params = answered ? null
    : ((await q("SELECT params FROM claw_work_items WHERE item_id = $1", [item.item_id])).rows[0]?.params as Record<string, unknown> | null) ?? null;
  const zh = await personWritesChinese(q, item.user_id, item.title);
  const said = answered
    ? (zh ? `#${item.seq} ${item.title}：${answer}` : `#${item.seq} "${item.title}": ${answer}`)
    : heldWriteText(item, params) ?? needsYouText(item, zh);
  const text = where.moved ? `${zh ? MOVED_PREFIX_ZH : MOVED_PREFIX_EN}${said}` : said;
  return {
    type: "work_item.needs_you",
    sayId: deterministicEventId("work_item.needs_you", item.item_id, String(item.attention_seq)),
    userId: item.user_id,
    sessionId: where.sessionId,
    text,
    item,
  };
}

/**
 * The answer that just closed an item, whole, in the system's words, stored in the transaction of the report that closed it
 * (`reports.ts`): the router is told it was sent in full only when it is stored for sending, never before. The same message,
 * under the same id, as the silent sweep's (`recordNeedsYouFallback`), so it is said once. Null when the item is not answered
 * or the message was stored before. `announce` after the commit; `settle` instead when the COMMIT met a failover and its answer
 * was lost (it may have taken effect): the message is looked up in the background and announced if it is there and no session
 * event holds it yet, as a say's is (`settleLater`), since the report sent again is then a duplicate that announces nothing.
 */
export async function storeAnswerWhole(
  q: Querier, itemId: string, deps: SayDeps = {},
): Promise<{ sayId: string; announce: () => Promise<void>; settle: () => void } | null> {
  const m = await needsYouMessage(q, itemId);
  if (!m || m.item.board_state !== "done") return null;
  const stored = await store(q, m);
  return stored
    ? {
      sayId: stored.sayId,
      announce: () => announce(stored, deps),
      settle: () => settleLater(m, async (late) => {
        // The COMMIT may have rolled back and the report sent again landed on another replica, which stored and announced it:
        // `announcedHere` is this process's alone, so what the session's stream already holds is not published a second time.
        if (late.sessionId && await eventInSession(late.sessionId, late.sayId)) return;
        await announce(late, deps);
      }),
    }
    : null;
}

/** Whether the session's stream holds the message's event (published by any replica, persisted by the event consumer). */
async function eventInSession(sessionId: string, sayId: string): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM claw_session_events WHERE session_id = $1 AND event = 'AssistantSay' AND data->>'say_id' = $2 LIMIT 1",
    [sessionId, sayId],
  );
  return (r.rowCount ?? 0) > 0;
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
    ...(input.turnMessageId ? { noticeOfTurn: input.turnMessageId } : {}),
  }), (late) => announce(late, deps, input.turnMessageId));
  if (!stored) return null;
  await announce(stored, deps, input.turnMessageId);
  return { say_id: stored.sayId, subscribers: stored.subscribers };
}

/**
 * `recordSystemNotice` in the caller's transaction, so it is queued before whatever the caller queues after it in that transaction (a
 * worker's findings before the write it holds for the person, `holds.ts`). Once per `key`: `null` when it was stored before.
 * `announce` after the commit.
 */
export async function storeSystemNotice(
  q: Querier, input: { userId: string; sessionId: string; text: string; key: string; itemId?: string }, deps: SayDeps = {},
): Promise<{ sayId: string; announce: () => Promise<void> } | null> {
  const stored = await store(q, {
    type: "assistant.say", fallback: true, item: input.itemId ? await loadItem(q, input.itemId, input.userId) : null,
    sayId: deterministicEventId("assistant.notice", input.userId, input.key),
    userId: input.userId, sessionId: input.sessionId, text: input.text,
  });
  return stored ? { sayId: stored.sayId, announce: () => announce(stored, deps) } : null;
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

/** An item closed by its answer, recently enough that saying it still helps (over `claw_work_items w`). */
export const ANSWERED_UNSAID_SQL = "w.board_state = 'done' AND w.outcome = 'answered' AND w.closed_at > NOW() - INTERVAL '1 day'";

/**
 * The event type a stored say `s` goes out as: `work_item.needs_you` for the fallback `recordNeedsYouFallback` stores, told
 * by its id -- `deterministicEventId("work_item.needs_you", item_id, attention_seq)`, computed here the same way -- and
 * `assistant.say` for every other say, a system notice about an item included.
 */
export const SAY_EVENT_TYPE_SQL = `CASE WHEN s.fallback AND s.item_id IS NOT NULL AND s.item_attention_seq IS NOT NULL
             AND s.say_id = substr(encode(sha256(
                   convert_to('work_item.needs_you', 'UTF8') || '\\x00'::bytea || convert_to(s.item_id, 'UTF8')
                   || '\\x00'::bytea || convert_to(s.item_attention_seq::text, 'UTF8')), 'hex'), 1, 32)::uuid
           THEN 'work_item.needs_you' ELSE 'assistant.say' END`;

/**
 * A say, `s`, that has not reached its user and is not on its way: not delivered, and no outbox row for it delivered or
 * still queued without a failure. One whose sends all failed or were dropped (a 410, a day of retries) is unreached too.
 */
const SAY_UNREACHED_SQL = `s.delivered_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM claw_notification_outbox o
                WHERE o.event_id = s.say_id::text
                  AND (o.delivered_at IS NOT NULL OR (o.dropped_at IS NULL AND o.last_status IS NULL)))`;

/**
 * A subscription, `n`, of the say's owner that can carry the say `s` and was never handed it: enabled, taking its
 * type, with no outbox row for it. A subscription that was handed it once is not handed it again, so a resend ends.
 */
const SAY_SENDABLE_SQL = `EXISTS (
               SELECT 1 FROM claw_notification_subscriptions n
                WHERE n.owner_user_id = s.user_id AND n.enabled AND (${SAY_EVENT_TYPE_SQL}) = ANY(n.event_types)
                  AND NOT EXISTS (
                    SELECT 1 FROM claw_notification_outbox o2
                     WHERE o2.event_id = s.say_id::text AND o2.subscription_id = n.subscription_id))`;

/**
 * The says about an item's current need, over `claw_work_items w`, that reached nobody and that a subscription of the
 * user's can now be handed: what `resendUnreachedSays` sends.
 */
export const UNREACHED_SAY_SQL = `
          SELECT 1 FROM claw_assistant_says s
           WHERE s.item_id = w.item_id AND s.item_attention_seq = w.attention_seq
             AND ${SAY_UNREACHED_SQL}
             AND ${SAY_SENDABLE_SQL}`;

/**
 * Send again what was said to a user while no subscription could carry it, now that one can: for each of the user's
 * items that still needs them (`needs_you`) or was answered within the day (the answer the sweep says), the newest say
 * about that need that reached nobody and that a subscription can be handed, queued for every enabled subscription that
 * takes its type and was never handed it. Once per subscription: the outbox row it writes is what marks it handed.
 * Called when a subscription starts taking the assistant's events, and by the silent sweep for an item whose fallback
 * was stored when nothing could carry it. `itemId` narrows it to one item. Returns how many outbox rows were written;
 * the delivery poll sends them (within `POLL_MS`), as nobody is waiting on this call.
 */
export async function resendUnreachedSays(input: { userId: string; itemId?: string }): Promise<number> {
  if (!CLAW_NOTIFICATIONS_ENABLED || !CLAW_ASSISTANT_ENABLED) return 0;
  const says = (await db.query(
    `SELECT DISTINCT ON (s.item_id) s.say_id::text AS say_id, s.text, (${SAY_EVENT_TYPE_SQL}) AS type, s.created_at, s.item_id
       FROM claw_work_items w
       JOIN claw_assistant_says s ON s.item_id = w.item_id AND s.item_attention_seq = w.attention_seq
      WHERE w.user_id = $1 AND ($2::text IS NULL OR w.item_id = $2) AND (w.board_state = 'needs_you' OR (${ANSWERED_UNSAID_SQL}))
        AND ${SAY_UNREACHED_SQL}
        AND ${SAY_SENDABLE_SQL}
      ORDER BY s.item_id, s.created_at DESC, s.say_id DESC
      LIMIT 100`,
    [input.userId, input.itemId ?? null],
  )).rows as Array<{ say_id: string; text: string; type: string; created_at: Date; item_id: string }>;
  let written = 0;
  for (const say of says) {
    const item = await loadItem(db.query, say.item_id, input.userId);
    if (!item) continue;
    const m: ToStore = say.type === "work_item.needs_you"
      ? { type: "work_item.needs_you", sayId: say.say_id, userId: input.userId, sessionId: null, text: say.text, item }
      : { type: "assistant.say", sayId: say.say_id, userId: input.userId, sessionId: null, text: say.text, item };
    const subs = (await db.query(
      `SELECT subscription_id FROM claw_notification_subscriptions
        WHERE owner_user_id = $1 AND enabled AND $2 = ANY(event_types)`,
      [input.userId, m.type],
    )).rows;
    const rows = await enqueue(m.sayId, subs, payloadOf(m, say.created_at));
    if (rows > 0) logger.info({ userId: input.userId, itemId: say.item_id, sayId: say.say_id, rows }, "assistant.say_resent");
    written += rows;
  }
  return written;
}

/** Stamp `delivered_at` once a receiver has taken a message. Call once at startup, with the notification worker. */
export function registerAssistantDeliveryHook(): void {
  onDelivered(ASSISTANT_EVENT_TYPES, async ({ eventId }) => {
    await db.query("UPDATE claw_assistant_says SET delivered_at = NOW() WHERE say_id = $1 AND delivered_at IS NULL", [eventId]);
  });
}
