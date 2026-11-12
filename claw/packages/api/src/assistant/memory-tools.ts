// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's long-term memory, as the assistant reads and keeps it (`CLAW_ASSISTANT_MEMORY_TOOLS=on`).
 *
 * The same entries, gates and store as the chat's memory (`memory/service.ts`); what differs is who may write. In a
 * chat the person types every message, so the chat's tools ask that the model quote them, and a delete is a fixed
 * phrase. The assistant's messages are not all the person's: a worker's report wakes it too, and a model in any
 * sandbox of theirs holds their key and can send it a message. So the router's write tools ask, in code:
 *
 *  - the person is behind this turn: it answers a message they sent signed in, a few minutes ago (`attendedTurn`,
 *    the design's §3.8, the same check the review tools make), asked again inside the transaction that writes;
 *  - what it touches was named by the person: an entry's number is in their message, or in what the assistant said to
 *    them just before it (`claw_assistant_says`, written by the server when it delivered the words); a quote is from
 *    their message;
 *  - the conversation is theirs alone: a session marked `memory: "off"` (a group's) never writes personal memory.
 *
 * Reading is not acting for anyone: the router recalls in any live turn, a task item's worker is shown a read-only index
 * and may recall, and a review item's session is shown only what the person bound to that item. A task item's worker that
 * may answer on a pull request without asking (`itemPostsUnasked`) is shown and may recall only what is bound to its item:
 * what it reads, a comment on that pull request can ask it to post there. And a worker's session keeps what it read from run
 * to run, so a worker that was ever shown more than its item's entries (`memoryReached`) never answers unasked (`prReply`).
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_MEMORY_TOOLS, CLAW_MEMORY_TURN_RECALL, CLAW_MEMORY_TURN_RECALL_USERS } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import {
  buildMemoryCatalogue, citationsOf, expandAlongLinks, forgetMemory, getMemoryPreference, listMemories, memoriesForMessage, memoriesOfItem, memoryAvailable, memoryPorts, recallMemory, undoMemory,
  updateMemory, writeMemory, type MemoryActor, type MemoryRow, type WriteResult,
} from "../memory/service.js";
import {
  ITEM_MEMORY_INTRO, ROUTER_MEMORY_OFF, ROUTER_MEMORY_PREAMBLE, ROUTER_MEMORY_PROMPT, WORKER_MEMORY_PREAMBLE, renderItemMemories, renderTurnRecall, fitTurnRecall, TURN_RECALL_MAX_ENTRIES,
} from "./prompts.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, attendedTurn, ToolRefused } from "./tools.js";
import type { ChosenLanguage } from "./language.js";
import { commandLanguageOf, typedCommand, type CommandLanguage } from "./typed-commands.js";
import { resolveWorkItemNow } from "./work-items.js";

const logger = pino({ name: "assistant-memory" });

/** How long before the person's message something the assistant said to them still counts as just shown. */
export const SHOWN_WINDOW_SEC = 600;
/** The says read back for numbers the person may point at. */
const SHOWN_SAYS_MAX = 20;

/** The assistant has the user's memory on this deployment. Per user, their own opt-in still decides. */
export function assistantMemoryOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_MEMORY_TOOLS && memoryAvailable();
}

/** The person's message a router turn answers, as far as acting on it goes. */
export interface AttendedMessage {
  userId: string;
  content: string;
  receivedAt: Date;
  /** The language the person chose in their channel (`ChannelContext.reply_language`), when they chose one. */
  replyLanguage?: ChosenLanguage;
}

/** The ways out of this module, so a test can stand in for one turn's answer. */
export const memoryToolPorts = {
  /**
   * The person behind this turn, or a refusal. The review tools own the question (`attendedTurn`: the turn answers a
   * message the route recorded as carried by an identity-provider token, fresh, and not one whose turn has read a
   * worker's words); memory asks the same one, so the two can never disagree about who is there.
   */
  attended: async (q: Querier, claims: AssistantTokenClaims): Promise<AttendedMessage> => {
    const turn = await attendedTurn(q, claims);
    return {
      userId: turn.userId, content: turn.message.content, receivedAt: new Date(turn.message.receivedAt),
      ...(turn.message.context.reply_language ? { replyLanguage: turn.message.context.reply_language } : {}),
    };
  },
};

// --- Grounding: pure, so the tests ask the same question the tools do ------------------------------------------

/** Whether the number stands on its own in the person's text: `3`, `#3`, `第3条`, `3号`; not `13` or `30`. */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text);
}

/** Whether the assistant's words show the entry by its number: `#12`, not `#123`, not `repo#12`. */
export function showsEntry(text: string, n: number): boolean {
  return new RegExp(`(?<![A-Za-z0-9_.-])#${n}(?![0-9])`).test(text);
}

// --- Checks -------------------------------------------------------------------------------------------------------

function requireRouter(claims: AssistantTokenClaims): void {
  if (claims.role !== "router") throw new ToolRefused("not_allowed", `this tool is for the router, not the ${claims.role}`);
}

/** The user has memory, and this session is one where theirs may be kept: never one others read (a group's). */
async function requireMemoryHere(q: Querier, sessionId: string, userId: string): Promise<void> {
  if (!assistantMemoryOn() || !(await getMemoryPreference(userId))) {
    throw new ToolRefused("memory_off", "long-term memory is off for this user: tell them they can turn it on in their settings");
  }
  const row = (await q("SELECT config->'memory' AS memory FROM claw_sessions WHERE session_id = $1", [sessionId])).rows[0] as
    { memory: unknown } | undefined;
  if (!row || row.memory === "off" || row.memory === false) {
    throw new ToolRefused("memory_not_here", "this conversation is not one where the user's personal memory is kept");
  }
}

/** The turn's user and the person's message, checked in one transaction; the write asks again in its own (`stillActing`). */
async function actingTurn(claims: AssistantTokenClaims): Promise<{ userId: string; message: AttendedMessage }> {
  requireRouter(claims);
  return inTransaction(async (q) => {
    const { userId } = await assertLiveRun(q, claims);
    const message = await memoryToolPorts.attended(q, claims);
    if (message.userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
    await requireMemoryHere(q, claims.sid, userId);
    return { userId, message };
  });
}

/** The same question, inside the transaction that writes: a turn interrupted since the first asking writes nothing. */
function stillActing(claims: AssistantTokenClaims, userId: string): (q: Querier) => Promise<void> {
  return async (q) => {
    if ((await assertLiveRun(q, claims)).userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
    if ((await memoryToolPorts.attended(q, claims)).userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
  };
}

/** The entry's number is in the person's message, or in what the assistant said to them just before they sent it. */
async function requireEntryNamed(userId: string, message: AttendedMessage, id: number): Promise<void> {
  if (mentionsNumber(message.content, id)) return;
  const says = (await db.query(
    `SELECT text FROM claw_assistant_says
      WHERE user_id = $1 AND NOT fallback AND created_at <= $2::timestamptz
        AND created_at > $2::timestamptz - make_interval(secs => $3::int)
      ORDER BY created_at DESC LIMIT $4`,
    [userId, message.receivedAt.toISOString(), SHOWN_WINDOW_SEC, SHOWN_SAYS_MAX],
  )).rows as Array<{ text: string }>;
  if (says.some((s) => showsEntry(s.text, id))) return;
  throw new ToolRefused(
    "entry_not_grounded",
    `memory #${id} is not in the user's message nor in what you just said to them: show them the entry with its number and let them say which`,
  );
}

function entryId(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim().replace(/^#/, "")) : v;
  if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) return n;
  throw new ToolRefused("invalid_arguments", "id is the entry's number, such as 12 or #12");
}

function refused(r: Extract<WriteResult, { ok: false }>): never {
  throw new ToolRefused(r.error, r.similar ? `${r.message} (similar: #${r.similar.id} "${r.similar.title}")` : r.message);
}

function actorOf(claims: AssistantTokenClaims, message: AttendedMessage, quote: unknown): MemoryActor {
  // The person's message of this turn is all a write may quote: a report, a recalled item or an earlier turn is not.
  return { kind: "model", sessionId: claims.sid, quote: typeof quote === "string" ? quote : "", humanMessages: [message.content] };
}

async function announce(sessionId: string, r: Extract<WriteResult, { ok: true }>): Promise<void> {
  if (r.op === "existing") return;
  await memoryPorts.publishSessionEvent(sessionId, {
    type: "memory_saved", memory_id: r.id, op: r.op, title: r.title, undo: `undo memory #${r.id}`,
  }).catch((err) => logger.warn({ err: (err as Error)?.message, sessionId }, "assistant.memory_notice_publish_failed"));
}

/** What a save or an update answers: the undo command in the language of the message that asked for it (`typed-commands.ts`). */
function written(r: Extract<WriteResult, { ok: true }>, lang: CommandLanguage): Record<string, unknown> {
  if (r.op === "existing") return { ok: true, id: r.id, op: r.op, title: r.title, note: `already remembered as #${r.id}; nothing new was stored` };
  const undo = typedCommand("undo", r.id, lang);
  return {
    ok: true, id: r.id, op: r.op, title: r.title, undo,
    note: `${r.op === "update" ? "updated" : "remembered"} as #${r.id}: tell the user in one line, with #${r.id}, and that they can say ${undo} to undo it`,
  };
}

// --- Tools --------------------------------------------------------------------------------------------------------

const line = (r: MemoryRow): string => `#${r.id} [${r.type}] ${r.title}`;

function full(r: MemoryRow): Record<string, unknown> {
  return {
    id: r.id, type: r.type, title: r.title, body: r.body, why: r.why, how_to_apply: r.how_to_apply,
    recorded_at: r.recorded_at, review_by: r.expires_at, due_for_review: r.due_for_review, work_item_id: r.work_item_id,
  };
}

/**
 * Whether the item's worker may post on GitHub without the person: one of its subscriptions allows answers. Such a worker reads
 * what strangers write and can be talked into posting it, so it reaches only memory bound to its item. Asked on every call, so
 * answers turned on during a run take the rest of the memory away from the next call. A failed read is not "no": it throws.
 */
export async function itemPostsUnasked(q: Querier, itemId: string): Promise<boolean> {
  return ((await q(
    "SELECT 1 FROM claw_work_item_subscriptions WHERE item_id = $1 AND reply_allowed LIMIT 1", [itemId],
  )).rowCount ?? 0) > 0;
}

/**
 * Written before the worker is shown anything of the user's memory beyond its item (the index, or a recalled entry that is not
 * bound to it): the session keeps what it read, so from then on the item never answers on GitHub without asking (`prReply`).
 * A failed write shows nothing: it throws.
 */
async function memoryReached(itemId: string): Promise<void> {
  await db.query("UPDATE claw_work_items SET memory_reached_at = COALESCE(memory_reached_at, NOW()) WHERE item_id = $1", [itemId]);
}

/**
 * Read the user's memory: one entry by number, a search, or every entry one line each. Any live turn of the assistant's,
 * in a session where their memory is kept. A worker reads what holds everywhere and what is bound to its own item, never
 * another item's: that is what it is shown, and recall must not reach further.
 */
export async function memoryRecall(
  claims: AssistantTokenClaims, args: { id?: unknown; query?: unknown },
): Promise<Record<string, unknown>> {
  if (claims.role !== "router" && claims.role !== "worker") throw new ToolRefused("not_allowed", `this tool is not for the ${claims.role}`);
  // A worker's reach is asked of the store itself, so another item's entries are neither among its results nor counted as read.
  const item = claims.role === "router" ? undefined : (claims.item_id ?? "");
  const { userId, boundOnly } = await inTransaction(async (q) => {
    const turn = await assertLiveRun(q, claims);
    await requireMemoryHere(q, claims.sid, turn.userId);
    return { userId: turn.userId, boundOnly: item !== undefined && await itemPostsUnasked(q, item) };
  });
  const visible = (r: MemoryRow): boolean => item === undefined || r.work_item_id === item || (r.work_item_id === null && !boundOnly);
  const note = boundOnly
    ? { note: "this item may answer on its pull request without asking the user, so only what the user bound to this item can be read here" }
    : {};
  // What a worker is about to read beyond its item is recorded first (`memoryReached`).
  const reading = async (rows: MemoryRow[]): Promise<MemoryRow[]> => {
    if (item !== undefined && rows.some((r) => r.work_item_id !== item)) await memoryReached(item);
    return rows;
  };
  if (args.id !== undefined && args.id !== null && args.id !== "") {
    const rows = await reading(await recallMemory(userId, { id: entryId(args.id), item, boundOnly }));
    return rows.length ? { ok: true, entry: full(rows[0]) } : { ok: false, error: "not_found", message: "no such entry", ...note };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query) return { ok: true, entries: (await reading(await recallMemory(userId, { query, item, boundOnly }))).map(full), ...note };
  // Waiting for the user's confirmation, or the profile earlier versions generated: not the model's to read (`readEntry`).
  const rows = await reading((await listMemories(userId)).filter((r) => r.status === "active" && r.category !== "user_profile" && visible(r)));
  return { ok: true, count: rows.length, entries: rows.map(line), ...note };
}

export async function memorySave(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, message } = await actingTurn(claims);
  let workItemId: string | null = null;
  if (args.item_id !== undefined && args.item_id !== null && args.item_id !== "") {
    const lookup = await resolveWorkItemNow(userId, args.item_id);
    if (!lookup.ok) throw new ToolRefused(lookup.error, lookup.message);
    workItemId = lookup.item.item_id;
  }
  const r = await writeMemory(userId, args, actorOf(claims, message, args.evidence_quote), { workItemId, guard: stillActing(claims, userId) });
  if (!r.ok) refused(r);
  await announce(claims.sid, r);
  return written(r, await commandLanguageOf(message.content, undefined, message.replyLanguage ?? null));
}

export async function memoryUpdate(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, message } = await actingTurn(claims);
  const id = entryId(args.id);
  await requireEntryNamed(userId, message, id);
  const r = await updateMemory(userId, id, args, actorOf(claims, message, args.evidence_quote), { guard: stillActing(claims, userId) });
  if (!r.ok) refused(r);
  await announce(claims.sid, r);
  return written(r, await commandLanguageOf(message.content, undefined, message.replyLanguage ?? null));
}

export async function memoryForget(claims: AssistantTokenClaims, args: { id?: unknown }): Promise<Record<string, unknown>> {
  const { userId, message } = await actingTurn(claims);
  const id = entryId(args.id);
  await requireEntryNamed(userId, message, id);
  if (!await forgetMemory(userId, id, "model", stillActing(claims, userId))) throw new ToolRefused("not_found", `no memory #${id}`);
  return { ok: true, id, op: "deleted" };
}

export async function memoryUndo(claims: AssistantTokenClaims, args: { id?: unknown }): Promise<Record<string, unknown>> {
  const { userId, message } = await actingTurn(claims);
  const id = entryId(args.id);
  await requireEntryNamed(userId, message, id);
  const done = await undoMemory(userId, id, "model", stillActing(claims, userId));
  if (done === "not_found") throw new ToolRefused("not_found", `no memory #${id}`);
  return { ok: true, id, op: done };
}

// --- What a turn is shown -------------------------------------------------------------------------------------------

/**
 * Each work item that an entry is bound to, labelled as the router names items (`item #3`). One whose row is gone (or is
 * not the user's) is still listed, as such, so the entry stays in the router's index where the person can see and forget it.
 */
async function boundItemLabels(userId: string): Promise<Map<string, string>> {
  const rows = (await db.query(
    `SELECT DISTINCT e.work_item_id AS item_id, w.seq FROM claw_memory_entries e
       LEFT JOIN claw_work_items w ON w.item_id = e.work_item_id AND w.user_id = e.user_id
      WHERE e.user_id = $1 AND e.work_item_id IS NOT NULL AND e.deleted_at IS NULL`,
    [userId],
  )).rows as Array<{ item_id: string; seq: number | null }>;
  return new Map(rows.map((r) => [r.item_id, r.seq === null || r.seq === undefined ? "an item no longer on the board" : `item #${Number(r.seq)}`]));
}

/** A memory read that fails costs the turn its memory, never the turn: it is background. Said in the log, not hidden. */
async function orNothing<T>(what: string, sessionId: string, read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logger.error({ err, sessionId }, `assistant.memory_${what}_read_failed`);
    return null;
  }
}

/** Whether the session is one other people read (`memory: "off"`, a group's), where no one's personal memory is shown. */
async function sessionWithoutMemory(sessionId: string): Promise<boolean> {
  const row = (await db.query("SELECT config->'memory' AS memory FROM claw_sessions WHERE session_id = $1", [sessionId])).rows[0] as
    { memory: unknown } | undefined;
  return !row || row.memory === "off" || row.memory === false;
}

/** The router's memory section and the user's index, or null where the assistant has no memory. */
export async function routerMemoryBlock(userId: string, sessionId: string): Promise<string | null> {
  const parts = await routerMemoryParts(userId, sessionId);
  return parts && (parts.entries ? `${parts.prompt}\n\n${parts.entries}` : parts.prompt);
}

/**
 * The router's memory in its two parts: what the memory tools are and how to use them (`prompt`, the same on every turn), and the
 * user's entries as of now (`entries`, empty when memory is off), which a turn is given with its message so that a save does not
 * change the system prompt of every later turn.
 */
export async function routerMemoryParts(userId: string, sessionId: string): Promise<{ prompt: string; entries: string } | null> {
  if (!assistantMemoryOn()) return null;
  return orNothing("router", sessionId, async () => {
    if (await sessionWithoutMemory(sessionId)) return null;
    if (!(await getMemoryPreference(userId))) return { prompt: ROUTER_MEMORY_OFF, entries: "" };
    const catalogue = await buildMemoryCatalogue(userId, { preamble: ROUTER_MEMORY_PREAMBLE, boundItems: await boundItemLabels(userId) });
    return { prompt: ROUTER_MEMORY_PROMPT, entries: catalogue?.text ?? "## Long-term Memory\n(no entries yet)" };
  });
}

export interface TurnRecallSettings { all: boolean; users: ReadonlySet<string> }

/** Who has the turn's recall (`CLAW_MEMORY_TURN_RECALL`, `CLAW_MEMORY_TURN_RECALL_USERS`). */
export const turnRecallSettings: TurnRecallSettings = { all: CLAW_MEMORY_TURN_RECALL, users: CLAW_MEMORY_TURN_RECALL_USERS };

/** Whether this user's router turns recall their memory for the message before the model answers. */
export function memoryTurnRecallOn(userId: string | null | undefined, settings: TurnRecallSettings = turnRecallSettings): boolean {
  return settings.all || (!!userId && settings.users.has(userId));
}

/**
 * The router turn's recall: the user's entries the message is about, in full (`memoriesForMessage`, `renderTurnRecall`), or
 * null. Asked only where the turn is shown the user's index (`routerMemoryParts` gave entries), so it reaches no further than the
 * index and memory_recall already do: this user's own entries, in a session their memory serves, with their memory on. A failed
 * read costs the turn its recall, never the turn (`orNothing`).
 */
export async function routerTurnRecall(userId: string, sessionId: string, message: string): Promise<{ text: string; ids: number[] } | null> {
  if (!message.trim()) return null;
  return orNothing("turn_recall", sessionId, async () => {
    const rows = await memoriesForMessage(userId, message);
    if (!rows.length) return null;
    // What the matched entries' links reach, two hops at most (E242): a chain's second entry seldom shares the message's words.
    const linked = await expandAlongLinks(userId, rows, TURN_RECALL_MAX_ENTRIES - rows.length);
    const entries = fitTurnRecall([...rows, ...linked.map((l) => ({ ...l.row, via: l.via }))]);
    const ids = entries.map((e) => e.id);
    return { text: renderTurnRecall(entries, await citationsOf(userId, ids)), ids };
  });
}

/**
 * A task item's worker: what the user bound to the item, in full, and the read-only index. Null when there is neither. A worker
 * that may post on its pull request unasked (`itemPostsUnasked`) is not shown the index: only what is bound to its item.
 */
export async function workerMemoryBlock(userId: string, itemId: string, sessionId: string): Promise<string | null> {
  if (!assistantMemoryOn()) return null;
  return orNothing("worker", sessionId, async () => {
    if (await sessionWithoutMemory(sessionId) || !(await getMemoryPreference(userId))) return null;
    const bound = await memoriesOfItem(userId, itemId);
    const catalogue = await itemPostsUnasked((text, params) => db.query(text, params), itemId)
      ? null
      : await buildMemoryCatalogue(userId, { preamble: WORKER_MEMORY_PREAMBLE });
    // Shown the index: recorded before it is, and a failed write shows nothing (`orNothing`).
    if (catalogue) await memoryReached(itemId);
    const parts = [bound.length ? renderItemMemories(bound, ITEM_MEMORY_INTRO) : "", catalogue?.text ?? ""].filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  });
}

/**
 * A review item's session: only what the user bound to that item, never the index. It acts as a GitHub user and reads
 * what strangers wrote (`sessionWithholdsMemory`), so it is shown the person's words about this review and nothing else.
 */
export async function reviewMemoryBlock(sessionId: string): Promise<string | null> {
  if (!assistantMemoryOn()) return null;
  return orNothing("review", sessionId, async () => {
    const item = (await db.query(
      "SELECT item_id, user_id FROM claw_work_items WHERE worker_session_id = $1 AND kind = 'review'", [sessionId],
    )).rows[0] as { item_id: string; user_id: string } | undefined;
    // The same marker every other turn of the assistant's honours: a session marked as one no personal memory is shown in.
    if (!item || await sessionWithoutMemory(sessionId) || !(await getMemoryPreference(item.user_id))) return null;
    const bound = await memoriesOfItem(item.user_id, item.item_id);
    return bound.length ? renderItemMemories(bound, ITEM_MEMORY_INTRO) : null;
  });
}
