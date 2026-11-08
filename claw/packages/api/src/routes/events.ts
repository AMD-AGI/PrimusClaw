// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import { canAccessSessionAsOperator } from "../auth/models.js";
import { db } from "../infra/db.js";
import { createSessionSubscription } from "../events/store.js";
import { AppEventOrder, appEventIdentity, appEventKey } from "../events/app-events.js";
import { redactPublicJson } from "../events/redaction.js";
import { TOOL_TEXT_DELTA_EVENT } from "../events/consumer.js";
import { TOOL_TEXT_VOID_EVENT } from "../assistant/router-speed.js";
import { SSE_HISTORY_TAIL } from "../config.js";
/**
 * V2-native SSE event stream: Brain events are forwarded verbatim (raw V2
 * `type` as the SSE `event` field, full payload as `data`); the historical V1
 * compat mapping was removed (see sse-v1-compat-removal.md). Query
 * params `subagent_id` / `fold_subagents` / `include_subagents` control
 * sub-agent event filtering — see `shouldForward` below for the exact rules.
 */

/** V2 event types that should NOT be forwarded to the frontend. */
const SKIP_EVENTS = new Set(["exec_complete"]);
/** Sub-agent lifecycle events that ARE forwarded even when sub events are folded. */
const SUBAGENT_LIFECYCLE_PASSTHROUGH = new Set(["subagentStart", "subagentEnd", "subagentProgress"]);

function eventName(evt: Record<string, unknown>): string | null {
  const t = evt.type;
  if (typeof t !== "string" || !t) return null;
  if (SKIP_EVENTS.has(t)) return null;
  return t;
}

interface ForwardOpts {
  /** When set, return ONLY this sub-agent's events. */
  subagentFilter?: string;
  /** When true, drop sub-agent internal events (keep only lifecycle). */
  foldSubagents: boolean;
}

/**
 * Decide whether an event should be forwarded over SSE.
 *
 * - subagentFilter set → only that sub's events (any type).
 * - foldSubagents true → forward main-agent events + sub lifecycle only.
 * - default → forward everything (preserves real-time SubagentCard UX).
 */
function shouldForward(evt: Record<string, unknown>, opts: ForwardOpts): boolean {
  const subId = typeof evt.subagent_id === "string" ? evt.subagent_id : undefined;
  if (opts.subagentFilter) {
    return subId === opts.subagentFilter;
  }
  if (!opts.foldSubagents) return true;
  if (!subId) return true;
  return SUBAGENT_LIFECYCLE_PASSTHROUGH.has((evt.type as string) ?? "");
}

/**
 * The event name for the marker that closes the history segment.
 *
 * Not a Brain event type -- the API is the only thing that knows where history
 * ends, because it is the one that stops reading the table and starts reading
 * the subscription.
 */
/**
 * True when `evt` (live, as stream message `liveId`) is a repeat of an app event
 * the database already holds under another stream sequence. The database is the
 * authority on what was already stored, whichever connection this is and however
 * long ago the first copy was published (hosting design 5.7). Names no `data`
 * column: it asks only for the kept row's event_id.
 */
export async function isRepeatOfStoredAppEvent(
  sessionId: string, evt: Record<string, unknown>, liveId: string,
): Promise<boolean> {
  const identity = appEventIdentity(evt);
  if (!identity) return false;
  const r = await db.query(
    `SELECT event_id FROM claw_session_events
      WHERE session_id = $1 AND event = 'appEvent' AND deleted_at IS NULL
        AND data->>'app_task_id' = $2 AND COALESCE(data->>'epoch', '0') = $3 AND (data->'event')->>'id' = $4
      ORDER BY id LIMIT 1`,
    [sessionId, identity.appTaskId, identity.epoch, identity.eventId],
  );
  const kept = r.rows[0] as { event_id: string } | undefined;
  return kept !== undefined && kept.event_id !== liveId;
}

export const HISTORY_COMPLETE_EVENT = "historyComplete";

interface HistorySegment {
  frames: string[];
  /** Ids the live loop must dedup against. */
  seenIds: string[];
}

/**
 * The frames a client receives before the live stream begins.
 *
 * The marker at the end is the only thing on the wire that separates a session
 * with no history from one whose history has not arrived yet. Both used to look
 * identical: nothing at all, until a keepalive *comment* 15 seconds later, which
 * fires no EventSource handler. So a client had nothing to stop waiting on, and
 * a session with no events -- a session created but never spoken to -- rendered
 * as a spinner that never resolved while its request sat open in the network
 * tab, which is exactly what it looks like when a server has hung.
 *
 * It carries no `id:` on purpose. That field sets the client's Last-Event-ID,
 * which `?after=` resumes from, so a synthetic id there would make a reconnect
 * either skip real events or ask for ones it already has.
 */
export function historySegment(
  rows: Array<{ event_id: unknown; data: unknown }>,
  opts: ForwardOpts,
  /** App events already shown, by identity (see events/app-events.ts); filled as frames are made. */
  seenAppEvents: Set<string> = new Set(),
  /** Older events of the session were not sent (see {@link historyCompleteFrame}). */
  hasMore = false,
): HistorySegment {
  const segment = historyFrames(rows, opts, seenAppEvents);
  segment.frames.push(historyCompleteFrame(segment.frames.length, hasMore));
  return segment;
}

/**
 * The marker that ends the history segment. `count`: the events it sent. `has_more`: the history was cut to the session's
 * last events (a stream that does not say where it resumes gets the last `SSE_HISTORY_TAIL`) and older ones were not
 * sent; `?history=all` asks for all of them, and `?mode=replay&after=` / `&tail=` reads them as JSON. Always present on
 * this stream, so a client can tell this server from one that predates it (whose `after` compared ids as text).
 */
export function historyCompleteFrame(count: number, hasMore: boolean): string {
  return `event: ${HISTORY_COMPLETE_EVENT}\n`
    + `data: ${JSON.stringify({ type: HISTORY_COMPLETE_EVENT, count, has_more: hasMore })}\n\n`;
}

/** One page of history as SSE frames, with no marker. */
function historyFrames(
  rows: Array<{ event_id: unknown; data: unknown }>,
  opts: ForwardOpts,
  seenAppEvents: Set<string>,
): HistorySegment {
  const frames: string[] = [];
  const seenIds: string[] = [];
  for (const row of rows) {
    const data = redactPublicJson(
      (typeof row.data === "object" && row.data) ? row.data : {},
    ) as Record<string, unknown>;
    const name = eventName(data);
    if (!name) continue;
    if (!shouldForward(data, opts)) continue;
    const appKey = appEventKey(data);
    if (appKey !== null) {
      if (seenAppEvents.has(appKey)) continue;
      seenAppEvents.add(appKey);
    }
    const eid = row.event_id as string;
    seenIds.push(eid);
    frames.push(`id: ${eid}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  return { frames, seenIds };
}

/**
 * A turn's streamed `say` text after it was taken back (`toolTextVoid`, `assistant/router-speed.ts`): not forwarded. The void says
 * that turn's say is not going to be said (refused, or the turn handed a review to the person's channel), so a later preview of it
 * would only put words on screen that never come. Per connection, as the live stream is; remembers the newest few turns only.
 */
export class StreamVoided {
  private readonly turns = new Set<string>();
  /** The router's own text taken back (`source: "text"`, Brain's `stream_text_as`), by turn and preview id: only that preview. */
  private readonly texts = new Set<string>();

  constructor(private readonly max = 64) {}

  /**
   * False for a `toolTextDelta` of a turn voided before it on this stream; true for everything else. A void of the turn's own text
   * (`source: "text"`, a tool call followed it) takes back that text only: the say the turn writes next is still its say, and streams.
   */
  forward(evt: Record<string, unknown>): boolean {
    const turn = typeof evt.message_id === "string" ? evt.message_id : "";
    if (!turn) return true;
    const preview = evt.source === "text" && typeof evt.actionId === "string" ? `${turn}\u0000${evt.actionId}` : null;
    if (evt.type === TOOL_TEXT_VOID_EVENT) {
      const set = preview ? this.texts : this.turns;
      set.add(preview ?? turn);
      if (set.size > this.max) set.delete(set.values().next().value as string);
      return true;
    }
    if (evt.type !== TOOL_TEXT_DELTA_EVENT) return true;
    return !this.turns.has(turn) && !(preview && this.texts.has(preview));
  }
}

/** The most events one windowed `mode=replay` read returns; a larger `tail` or `limit` is cut to this. */
export const REPLAY_WINDOW_MAX = 5000;

export interface ReplayWindow {
  /** The last `tail` events of the range. */
  tail?: number;
  /** The first `limit` events of the range. */
  limit?: number;
  /** The range starts after this event id (an `event_id` of the session). */
  after?: string;
}

function windowCount(value: string | undefined, name: string): number | undefined | { error: string } {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < 1) return { error: `${name} must be a positive integer` };
  return Math.min(REPLAY_WINDOW_MAX, Number(value));
}

/**
 * The window a `mode=replay` request asks for. With none of `tail`, `limit` or `after` the reply is the whole
 * history, as it always was; with any of them only the rows asked for are read from the table, so a session of
 * tens of thousands of events costs its caller (and this process) a page, not the whole session.
 */
export function parseReplayWindow(q: { tail?: string; limit?: string; after?: string }): ReplayWindow | { error: string } {
  const tail = windowCount(q.tail, "tail");
  if (typeof tail === "object") return tail;
  const limit = windowCount(q.limit, "limit");
  if (typeof limit === "object") return limit;
  if (tail !== undefined && limit !== undefined) return { error: "tail and limit cannot be combined" };
  const after = q.after === undefined || q.after === "" ? undefined : lastEventIdOf(q.after);
  if (after === null) return { error: "after is not an event id" };
  return { tail, limit, after };
}

/** `shouldForward` as a SQL predicate on `claw_session_events.data` (its parameters appended to `params`); null: all rows. */
function forwardFilterSql(opts: ForwardOpts, params: unknown[]): string | null {
  // A sub-agent event is one whose subagent_id is a non-empty string.
  const isSub = "COALESCE(jsonb_typeof(data->'subagent_id') = 'string' AND data->>'subagent_id' <> '', false)";
  if (opts.subagentFilter) {
    params.push(opts.subagentFilter);
    return `${isSub} AND data->>'subagent_id' = $${params.length}`;
  }
  if (opts.foldSubagents) {
    params.push([...SUBAGENT_LIFECYCLE_PASSTHROUGH]);
    return `(NOT ${isSub} OR COALESCE(data->>'type' = ANY($${params.length}::text[]), false))`;
  }
  return null;
}

/** Rows one page of an SSE history reads: what the stream holds in memory at once, however long the history is. */
export const HISTORY_PAGE_ROWS = 500;

/**
 * Where an SSE history starts: after the row `afterId` (0: from the first), and whether older events were left out.
 * `upTo`: the newest row when it was asked, where the first reading of the history ends (see the route).
 */
export interface HistoryStart {
  afterId: number;
  /** Only rows after this cursor (`?after=` / Last-Event-ID); null: no cursor. */
  after: AfterCursor | null;
  upTo: number;
  hasMore: boolean;
}

/**
 * The rows a stream's history can send: the caller's sub-agent filter (`shouldForward`), and an event with a name that is
 * not skipped (`eventName`), so the tail is counted in events the client is shown. Its parameters are appended to `params`.
 */
function shownSql(opts: ForwardOpts, params: unknown[]): string {
  params.push([...SKIP_EVENTS]);
  const named = `jsonb_typeof(data->'type') = 'string' AND data->>'type' <> '' AND data->>'type' <> ALL($${params.length}::text[])`;
  const filter = forwardFilterSql(opts, params);
  return filter ? `${named} AND ${filter}` : named;
}

/**
 * The stream id pattern: `claw-<seq>` with at most 12 digits. A user message's id is `claw-<Date.now()>`
 * (sessions/dispatch.ts newChatMessageId), 13 digits, and is no stream sequence: read as one it would sort after every
 * stream event. One pattern for SQL and for the cursor, so both read the same ids as stream ids.
 */
const STREAM_SEQ_DIGITS = 12;
const STREAM_ID = new RegExp(`^claw-([0-9]{1,${STREAM_SEQ_DIGITS}})$`);
/** A stream event id's sequence (`claw-<seq>`) in SQL; NULL for any other id. Cast only where it matches. */
const STREAM_SEQ_SQL = `(CASE WHEN event_id ~ '^claw-[0-9]{1,${STREAM_SEQ_DIGITS}}$' THEN substr(event_id, 6)::bigint END)`;

/**
 * What follows an `after` cursor. A stream id (`claw-<seq>`) is followed by every stream event of a higher sequence,
 * wherever its row is: several API replicas pull from one consumer, so `claw-101` can be stored before `claw-100`, and
 * reading by row from `claw-100` would leave it out. An id that is no stream id (the turn's own rows) is followed by
 * what was stored after its row, as are such rows after a stream cursor. Comparing ids as text put `claw-10` before
 * `claw-9`. `seq` null: no stream cursor.
 */
export interface AfterCursor {
  seq: number | null;
  row: number;
}

/**
 * The cursor `after` stands for in this session. A stream id the table does not hold yet (the live event reached the
 * client before its row was written) still has its sequence; its row is the last stored stream event at or before it.
 * Null: not an event this session can place.
 */
async function afterCursor(sessionId: string, after: string): Promise<AfterCursor | null> {
  const m = STREAM_ID.exec(after);
  const seq = m ? Number(m[1]) : null;
  const exact = (await db.query(
    "SELECT id FROM claw_session_events WHERE session_id = $1 AND event_id = $2",
    [sessionId, after],
  )).rows[0] as { id: number | string } | undefined;
  if (exact) return { seq, row: Number(exact.id) };
  if (seq === null) return null;
  const before = (await db.query(
    `SELECT COALESCE(MAX(id), 0) AS id FROM claw_session_events WHERE session_id = $1 AND ${STREAM_SEQ_SQL} <= $2::bigint`,
    [sessionId, seq],
  )).rows[0] as { id: number | string } | undefined;
  return { seq, row: Number(before?.id ?? 0) };
}

/** The rows after `cursor` (see AfterCursor) as a SQL predicate, its parameters appended to `params`. */
function afterSql(cursor: AfterCursor, params: unknown[]): string {
  params.push(cursor.row);
  const row = `id > $${params.length}`;
  if (cursor.seq === null) return row;
  params.push(cursor.seq);
  return `(${STREAM_SEQ_SQL} > $${params.length}::bigint OR (${STREAM_SEQ_SQL} IS NULL AND ${row}))`;
}

/** The newest row of the session (0: none). */
async function newestRowId(sessionId: string): Promise<number> {
  const newest = (await db.query(
    "SELECT COALESCE(MAX(id), 0) AS id FROM claw_session_events WHERE session_id = $1",
    [sessionId],
  )).rows[0] as { id: number | string } | undefined;
  return Number(newest?.id ?? 0);
}

/**
 * Where an SSE connection's history starts. After `after` when it names a place in this session; otherwise the
 * whole history when `all`, else the last `tail` events the caller is shown (the sub-agent filter applies), with
 * `hasMore` when older ones exist. Reads ids only.
 */
export async function historyStart(
  sessionId: string, after: string | null, all: boolean, tail: number, opts: ForwardOpts,
): Promise<HistoryStart> {
  const upTo = await newestRowId(sessionId);
  if (after) {
    const cursor = await afterCursor(sessionId, after);
    if (cursor !== null) {
      // Pages are read by row from the first row after the cursor (a stream event of a higher sequence can sit before it).
      const params: unknown[] = [sessionId];
      const first = (await db.query(
        `SELECT MIN(id) AS id FROM claw_session_events WHERE session_id = $1 AND ${afterSql(cursor, params)}`,
        params,
      )).rows[0] as { id: number | string | null } | undefined;
      const afterId = first?.id == null ? cursor.row : Number(first.id) - 1;
      return { afterId, after: cursor, upTo, hasMore: false };
    }
  }
  if (all) return { afterId: 0, after: null, upTo, hasMore: false };
  const params: unknown[] = [sessionId, upTo];
  const where = ["session_id = $1", "deleted_at IS NULL", "id <= $2", shownSql(opts, params)];
  params.push(tail);
  const edge = (await db.query(
    `SELECT id FROM claw_session_events WHERE ${where.join(" AND ")} ORDER BY id DESC OFFSET $${params.length} LIMIT 1`,
    params,
  )).rows[0] as { id: number | string } | undefined;
  return edge ? { afterId: Number(edge.id), after: null, upTo, hasMore: true } : { afterId: 0, after: null, upTo, hasMore: false };
}

/**
 * The next page of history after row `afterId` and up to row `upTo`, oldest first, at most HISTORY_PAGE_ROWS rows; with
 * `after`, only rows after that cursor.
 */
export async function historyPage(
  sessionId: string, afterId: number, upTo: number, opts: ForwardOpts, after: AfterCursor | null = null,
): Promise<Array<{ id: number | string; event_id: unknown; data: unknown }>> {
  const params: unknown[] = [sessionId, afterId, upTo];
  const where = ["session_id = $1", "deleted_at IS NULL", "id > $2", "id <= $3", shownSql(opts, params)];
  if (after) where.push(afterSql(after, params));
  params.push(HISTORY_PAGE_ROWS);
  return (await db.query(
    `SELECT id, event_id, event, data FROM claw_session_events WHERE ${where.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
    params,
  )).rows as Array<{ id: number | string; event_id: unknown; data: unknown }>;
}

/**
 * Resolves when `res` can take more (true), or once it is closed (false), so that a slow client is not buffered for:
 * `backlog` is what the last `res.write` said (false: its buffer is full, and `drain` follows once it is not).
 */
export function drained(res: ServerResponse, backlog: boolean): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (!backlog) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(ok);
    };
    const onDrain = (): void => done(true);
    const onClose = (): void => done(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/**
 * One window of a session's stored events, oldest first, in the row shape of the whole replay
 * (`event_id, event_type, data, created_at`), redacted the same way. The sub-agent filter is applied in SQL, so
 * `tail=N` is the last N events the caller would have been shown, not the last N rows with some filtered out.
 * `hasMore`: events outside the window remain on the side it was cut (before it for `tail`, after it otherwise).
 */
export async function readReplayWindow(
  sessionId: string, window: ReplayWindow, opts: ForwardOpts,
): Promise<{ rows: Array<Record<string, unknown>>; hasMore: boolean } | { error: string }> {
  const params: unknown[] = [sessionId];
  const where = ["session_id = $1", "deleted_at IS NULL"];
  if (window.after !== undefined) {
    // By row order, not by comparing ids as text ('claw-10' sorts before 'claw-9').
    const cursor = (await db.query(
      "SELECT id FROM claw_session_events WHERE session_id = $1 AND event_id = $2",
      [sessionId, window.after],
    )).rows[0] as { id: number | string } | undefined;
    if (!cursor) return { error: "after is not an event of this session" };
    params.push(cursor.id);
    where.push(`id > $${params.length}`);
  }
  const filter = forwardFilterSql(opts, params);
  if (filter) where.push(filter);
  const count = window.tail ?? window.limit ?? REPLAY_WINDOW_MAX;
  params.push(count + 1);
  const rows = (await db.query(
    `SELECT event_id, event_type, data, created_at FROM (
       SELECT id, event_id, event AS event_type, data, created_at FROM claw_session_events
        WHERE ${where.join(" AND ")}
        ORDER BY id ${window.tail !== undefined ? "DESC" : "ASC"} LIMIT $${params.length}
     ) w ORDER BY id`,
    params,
  )).rows as Array<{ data: unknown; [key: string]: unknown }>;
  const hasMore = rows.length > count;
  const kept = hasMore ? (window.tail !== undefined ? rows.slice(rows.length - count) : rows.slice(0, count)) : rows;
  return {
    hasMore,
    rows: kept
      .filter((row) => shouldForward((typeof row.data === "object" && row.data) ? row.data as Record<string, unknown> : {}, opts))
      .map((row) => ({ ...row, data: redactPublicJson(row.data) })),
  };
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {

  // SSE event stream (supports ?mode=replay for history JSON: the whole history,
  // or with ?tail=N / ?after=<event_id>&limit=N one window of it).
  app.get<{
    Params: { id: string };
    Querystring: {
      after?: string;
      mode?: string;
      /** `mode=replay` only: the last N events (oldest first), read as N rows from the table. */
      tail?: string;
      /** `mode=replay` only: at most N events after `after` (or from the start). */
      limit?: string;
      /** SSE only: `all` replays the whole history; without it a stream that does not resume gets the last SSE_HISTORY_TAIL events. */
      history?: string;
      subagent_id?: string;
      fold_subagents?: string;
      // Legacy alias kept for back-compat: when callers pass it explicitly
      // they wanted "forward everything", which is now the default.
      include_subagents?: string;
    };
  }>(
    "/v1/chat/sessions/:id/messages",
    async (req, reply) => {
      const sessionId = req.params.id;

      const mode = req.query.mode;
      const fwdOpts: ForwardOpts = {
        subagentFilter: req.query.subagent_id || undefined,
        // Default: forward everything. Opt-in folding via ?fold_subagents=1
        // for clients that implement a lazy-load SubagentCard.
        foldSubagents: req.query.fold_subagents === "1" || req.query.fold_subagents === "true",
      };

      const session = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
      if (!session) return reply.status(404).send({ ok: false, error: "session not found" });
      if (!canAccessSessionAsOperator(session.user_id, getUser(req))) {
        return reply.status(403).send({ ok: false, error: "access denied" });
      }

      if (mode === "replay") {
        const window = parseReplayWindow(req.query);
        if ("error" in window) return reply.status(400).send({ ok: false, error: window.error });
        if (window.tail !== undefined || window.limit !== undefined || window.after !== undefined) {
          const page = await readReplayWindow(sessionId, window, fwdOpts);
          if ("error" in page) return reply.status(400).send({ ok: false, error: page.error });
          return { ok: true, data: page.rows, has_more: page.hasMore };
        }
        const events = (await db.query(
          "SELECT event_id, event as event_type, data, created_at FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL ORDER BY id",
          [sessionId],
        )).rows;
        // Apply the same subagent-fold filter to replay mode so the
        // frontend can request a single sub's history via
        // ?subagent_id=sub-xxx&mode=replay (used to populate the expanded
        // sub-agent card without subscribing to a live SSE).
        const filtered = events
          .filter((row: { data: unknown }) => {
            const data = (typeof row.data === "object" && row.data) ? row.data as Record<string, unknown> : {};
            return shouldForward(data, fwdOpts);
          })
          .map((row: { data: unknown; [key: string]: unknown }) => ({
            ...row,
            data: redactPublicJson(row.data),
          }));
        return { ok: true, data: filtered };
      }

      // SSE mode — long-lived connection
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let backlog = false;   // the last write was buffered past the response's limit (see drained)
      const sseWrite = (frame: string): boolean => {
        try { backlog = !res.write(frame); return true; }
        catch { return false; }
      };

      // Subscribe to NATS FIRST (before DB query) so no events are lost
      // in the window between DB read and subscription start.
      const subscription = createSessionSubscription(sessionId);
      const seenIds = new Set<string>();
      const seenAppEvents = new Set<string>();
      const appEventOrder = new AppEventOrder();
      const streamVoided = new StreamVoided();

      // Keepalive and the close handler, set up before the history is sent: a client that leaves while it is still
      // being sent closes the subscription (and stops the history) too.
      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* client gone */ }
      }, 15_000);

      req.raw.on("close", () => {
        clearInterval(keepAlive);
        subscription.close();
      });

      // 1. Push history from DB — one SSE frame per row, read a page at a time
      // (then 2., the live events, deduped against it via seenIds).
      // `Last-Event-ID` too: it is what a browser's EventSource sends when it
      // reconnects by itself -- after a pod drain ended the stream with a
      // `retry:` (infra/graceful-shutdown.ts), say -- to the same URL, which
      // has no `?after=`. Without it the reconnect replays the history again.
      // Without either, only the last SSE_HISTORY_TAIL events are sent (the marker says `has_more`), unless the client
      // asks for `?history=all`: a long session's whole history was read into this process on every connection.
      // The history is read up to the newest row when it starts (`start.upTo`), then once more up to the newest row
      // when that is sent (what was stored meanwhile), and no further: a session written to faster than its history is
      // sent still reaches its live events. The live consumer is made first, so an event stored after the second read
      // was published after the consumer began and arrives live; one published before it began is stored, in practice
      // within milliseconds, before the second read. (The consumer used to be made after the history, and an event
      // published between the read and the consumer was in neither.) What comes both ways is sent once (seenIds).
      await subscription.ready();
      const afterEventId = req.query.after || lastEventIdOf(req.headers["last-event-id"]) || null;
      const start = await historyStart(sessionId, afterEventId, req.query.history === "all", SSE_HISTORY_TAIL, fwdOpts);
      let cursor = start.afterId;
      let upTo = start.upTo;
      let sent = 0;
      let open = true;
      for (let pass = 0; pass < 2 && open; pass++) {
        if (pass === 1) {
          const newest = await newestRowId(sessionId);
          if (newest <= upTo) break;
          upTo = newest;
        }
        for (;;) {
          const rows = await historyPage(sessionId, cursor, upTo, fwdOpts, start.after);
          const page = historyFrames(rows, fwdOpts, seenAppEvents);
          for (const eid of page.seenIds) seenIds.add(eid);
          for (const frame of page.frames) sseWrite(frame);
          sent += page.frames.length;
          if (!(await drained(res, backlog))) { open = false; break; }
          if (rows.length < HISTORY_PAGE_ROWS) break;
          cursor = Number(rows[rows.length - 1].id);
        }
        cursor = upTo;
      }
      sseWrite(historyCompleteFrame(sent, start.hasMore));

      try {
        // Live path uses eventsWithSeq() so the SSE `id:` field carries the
        // JetStream streamSequence — same format as event_id in DB. Result:
        // history-from-DB and live-from-NATS segments use a single
        // monotonically-increasing id space, so `?after=<id>` and seenIds
        // dedup are correct across the boundary.
        for await (const item of subscription.eventsWithSeq()) {
          if (!item) continue;
          // Already redacted: events/store.ts::sanitizeSessionEvent masks live
          // events at the subscription, so every consumer inherits it.
          const { event: evt, seq } = item;
          const name = eventName(evt);
          if (!name) continue;
          if (!shouldForward(evt, fwdOpts)) continue;
          if (!streamVoided.forward(evt)) continue;
          const liveId = `claw-${seq}`;
          if (seenIds.has(liveId)) continue;
          seenIds.add(liveId);
          // A forwarded app event published twice has two stream sequences and one identity.
          const appKey = appEventKey(evt);
          if (appKey !== null) {
            if (seenAppEvents.has(appKey)) continue;
            seenAppEvents.add(appKey);
            const identity = appEventIdentity(evt);
            if (identity && appEventOrder.mayBeRepeat(identity) && await isRepeatOfStoredAppEvent(sessionId, evt, liveId).catch(() => false)) continue;
          }
          if (!sseWrite(`id: ${liveId}\nevent: ${name}\ndata: ${JSON.stringify(evt)}\n\n`)) break;
        }
      } catch { /* subscription ended or client disconnected */ }

      clearInterval(keepAlive);
      res.end();
      return reply;
    },
  );
}

/** The `Last-Event-ID` header, if it is one of the ids this stream hands out. */
export function lastEventIdOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(trimmed) ? trimmed : null;
}
