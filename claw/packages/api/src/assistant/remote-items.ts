// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Work on the user's development environments as work items (`kind = 'remote'`), so the assistant knows about it: "did the one I
 * just ran finish?" is answered from the item list, whether the user typed the instruction into a session they attached their chat
 * to, or asked the assistant to send it (`devenv_send`).
 *
 * One item per remote session (`claw_remote_sessions`), its `worker_session_id` `remote:<session id>`. Claw writes it, from what
 * passes through it anyway, and nothing else does:
 *  - every prompt a session is sent (`noteRemotePrompt`): the item is (re)opened in progress, titled with the machine, the agent and
 *    the start of the instruction;
 *  - the events its connector posts (`noteRemoteEvents`): a permission request puts the item in front of the user, its answer takes it
 *    back, a turn's end closes it with the end of the agent's answer as its summary, a closed session closes it.
 *
 * Which prompt a turn's end ends: a connector that names it (`turn_end.cmd_seq`, and `command_rejected.cmd_seq` for a prompt it
 * dropped unrun) is followed by name (`open_cmd_seqs`). The command's `cmd_seq`, not its `cmd_id`: an id is text a client may choose
 * (an `Idempotency-Key`), which a credential scrub on the way may mask, and a number never is. One that does not name it (an older
 * connector) is counted (`open_turns`, with the cancels pending), as it always was.
 *
 * Who is told: an instruction the assistant sent (`origin: "assistant"`) is the user's errand, and its end, or a permission it waits
 * on, is said to them once (`recordSystemNotice`, keyed by the event). One the user typed into an attached chat is not: they are
 * watching it, and their chat showed it. Either way the item is on the list the router reads every turn.
 *
 * What an agent wrote (its answer, a tool's title) and what a connector reported (the machine's name) were written by no one the
 * user vetted: they go into the item as a worker's summary does, which the router reads as quoted data (`UNTRUSTED_PREAMBLE`).
 *
 * Only while both the assistant and remote agents are on. Never a reason to refuse the prompt or the events: the item is the
 * assistant's view of them, written after them, and a failure to write it is logged and dropped.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import {
  REMOTE_AGENT_LIMITS, REMOTE_COMMANDS, REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED,
} from "@claw/protocol";
import { CLAW_ASSISTANT_ENABLED, CLAW_REMOTE_AGENTS_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { findSession, issueCommand, wakeConnector } from "../remote-agents/store.js";
import { newWorkItemId } from "../tasks/ids.js";
import { recordSystemNotice } from "./outbound.js";
import { clipOneLine, TITLE_MAX } from "./work-items.js";

const logger = pino({ name: "assistant-remote-items" });

export const REMOTE_EVENT_TURN_END = "turn_end";
export const REMOTE_EVENT_COMMAND_REJECTED = "command_rejected";
/** The events that move a remote item. */
const MOVING = [
  REMOTE_EVENT_TURN_END, REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED,
  REMOTE_EVENT_COMMAND_REJECTED,
];
/**
 * Why a connector refuses a prompt before it is queued (`connector/src/session.ts` `enqueuePrompt`): that prompt never gets a
 * `turn_end`, so its refusal is its end. A prompt refused when its turn starts (the attach preflight) also posts a `turn_end`,
 * which ends it, so its refusal is not counted twice.
 */
const PROMPT_REFUSED_UNQUEUED = new Set(["too_many_queued_prompts", "session_closed"]);
/** A queued prompt a cancel dropped unrun: refused by name by a connector that names its prompts, never by one that does not. */
const PROMPT_DROPPED_BY_CANCEL = "cancelled";

/** How much of an instruction an item keeps (its title is shorter), and of an answer its summary and its event. */
const ASKED_MAX = 120;
const SUMMARY_MAX = 80;
const ANSWER_EVENT_MAX = 600;
const NOTICE_ANSWER_MAX = 400;
/** At most this many of a session's moving events are applied in one pass; the next post applies the rest. */
const EVENTS_PER_PASS = 100;
/** The newest message chunks of a turn its answer is read from. */
const ANSWER_CHUNKS = 400;

export const remoteItemsOn = (): boolean => CLAW_ASSISTANT_ENABLED && CLAW_REMOTE_AGENTS_ENABLED;

/** The worker session id a remote session's item is filed under. Never a Claw session, so no run, sweep or watchdog finds it. */
export const remoteWorkerSessionId = (remoteSessionId: string): string => `remote:${remoteSessionId}`;

export type RemoteOrigin = "chat" | "assistant";
export type RemoteLang = "zh" | "en";

/** What a remote item keeps beside the row (`claw_work_items.params`). */
export interface RemoteParams {
  connector_id: string;
  session_id: string;
  agent_id: string;
  /** The machine's name as its connector reported it (untrusted). */
  machine: string;
  /** The start of the instruction now under way, or last run. */
  asked: string;
  /** Who sent the instruction now under way: the user in an attached chat, or the assistant for them (told when it ends). */
  origin: RemoteOrigin;
  lang: RemoteLang;
  /** Instructions sent and not yet ended: the item closes when the last one ends. */
  open_turns: number;
  /**
   * The `cmd_seq` of those instructions, while every one of them is known (from the item's first prompt, or from it reopening): a
   * turn's end that names its prompt ends that one only. Null once a turn's end or a refusal came that named none (an older
   * connector), and absent on items from before it was kept: the item is then counted (`open_turns`) until it next reopens.
   */
  open_cmd_seqs?: number[] | null;
  /** Permission requests asked and not yet answered. */
  waiting: string[];
  /** The newest session event this item has applied (`claw_remote_events.id`). */
  last_event_id: number;
  /** The session event that ended the item (a turn's end, a refusal, the session closing); 0 while open, or when stopped from Claw. */
  closed_event_id?: number;
  /** Cancels sent whose turn_end has not come yet, oldest first (`PendingCancel`). */
  cancels?: PendingCancel[];
}

/** A cancel sent to the session whose end (one turn_end, `stopReason: "cancelled"`) has not come yet. */
export interface PendingCancel {
  /** The newest session event before it was queued: its end comes after this. */
  after: number;
  /** Turns that may be running when it reaches the agent and may still end on their own first (at most one). */
  before: number;
  /** Prompts sent after it (and before the next cancel): they run once it is done. */
  n: number;
  /**
   * The `cmd_seq` of the prompts open when it was sent (the item's `open_cmd_seqs` then): its end ends every one of them still open,
   * named or not. A prompt whose turn's end never comes (the connector restarted mid-turn: the prompt is not delivered again and the
   * session's queue starts empty) is then ended by the next stop, whose cancel finds nothing running and names no prompt. Absent on
   * a cancel noted before it was kept: what it had open is then every prompt open but the last ones sent after it (`n`, its own and
   * those of the cancels after it), which are the newest the item has.
   */
  seqs?: number[];
}

const pendingCancels = (p: Partial<RemoteParams> | null | undefined): PendingCancel[] =>
  Array.isArray(p?.cancels)
    ? p!.cancels!.map((c) => ({
      after: Number(c.after) || 0, before: Number(c.before) || 0, n: Number(c.n) || 0,
      ...(Array.isArray(c.seqs) ? { seqs: c.seqs.filter((x) => Number.isSafeInteger(x)) } : {}),
    }))
    : [];

export const langOf = (text: string): RemoteLang => (/\p{Script=Han}/u.test(text) ? "zh" : "en");

const flat = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  return clipOneLine(v.replace(/[\u0000-\u001f\u007f]+/g, " "), max);
};
/** The end of a text, which is where an answer says how it went. */
const tailOf = (v: string, max: number): string => {
  const one = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join("")}` : one;
};

/** The end of an answer as the user reads it in a message: its line breaks kept (a list, a table), other control characters dropped. */
const tailLines = (v: string, max: number): string => {
  const text = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chars = Array.from(text);
  return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join("")}` : text;
};

/** The item's title: machine, agent, and the start of what it was asked. */
export function remoteTitle(machine: string, agent: string, asked: string, lang: RemoteLang): string {
  return clipOneLine(lang === "zh" ? `${machine} ${agent}：${asked}` : `${machine} ${agent}: ${asked}`, TITLE_MAX);
}

export interface NotePrompt {
  owner: string;
  sessionId: string;
  connectorId: string;
  agentId: string;
  text: string;
  origin: RemoteOrigin;
  /** The language the user asked in; the instruction's own when not given. */
  lang?: RemoteLang;
  /** The prompt's command number (`claw_remote_commands.cmd_seq`), which a connector names in that prompt's `turn_end`. */
  cmdSeq: number;
  /**
   * The session's newest event before the prompt was queued (`remoteEventMark`): what the session posts after it is this prompt's,
   * even when it reached Claw before this note did (the connector may run a short turn, or refuse the prompt, that fast). Not
   * known: the newest event now.
   */
  since?: number;
}

/**
 * Queue a prompt or a cancel for a remote session and note it on its item, one at a time per session (a transaction-scoped advisory
 * lock, across API replicas): the item then sees prompts and cancels in the order they were queued, which is the order the
 * connector runs them, never a prompt noted between a cancel being queued and that cancel being noted.
 */
export async function inRemoteSessionOrder<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  if (!remoteItemsOn()) return run();
  return inTransaction(async (q) => {
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`claw-remote-item:${sessionId}`]);
    return run();
  });
}

/**
 * A cancel was just queued for one of the owner's remote sessions (`mark`: its newest event before it was queued; a retry that
 * queued nothing notes nothing): the turn_end it brings ends what was open before it, and a prompt sent after it (stop, then a new
 * instruction at once) is not ended by it. Not noted when that turn_end has already been posted (it ended what was open then).
 */
export async function noteRemoteCancel(owner: string, sessionId: string, mark: number): Promise<void> {
  if (!remoteItemsOn()) return;
  await inTransaction(async (q) => {
    const item = (await q(
      "SELECT item_id, params FROM claw_work_items WHERE worker_session_id = $1 AND user_id = $2 AND kind = 'remote' FOR UPDATE",
      [remoteWorkerSessionId(sessionId), owner],
    )).rows[0] as { item_id: string; params: RemoteParams } | undefined;
    if (!item) return;
    const cancels = pendingCancels(item.params);
    const openSeqs = Array.isArray(item.params?.open_cmd_seqs) ? item.params.open_cmd_seqs : null;
    // Its end already posted (with no cancel before it still pending): it ended what was open then, and nothing is pending. Followed
    // by name, only once that end was applied: one posted and not yet applied is this cancel's, and ends what was open before it.
    if (!cancels.length && (await q(
      `SELECT 1 FROM claw_remote_events WHERE session_id = $1 AND id > $2 AND type = 'turn_end' AND data->>'stopReason' = 'cancelled'
          AND ($3::bigint IS NULL OR id <= $3::bigint) LIMIT 1`,
      [sessionId, mark, openSeqs ? Number(item.params?.last_event_id) || 0 : null],
    )).rows[0]) return;
    // What may be running when it reaches the agent: with an earlier cancel pending, one of the prompts sent after that one; else
    // one of those open now. At most one runs; queued ones are dropped with no end of theirs.
    const last = cancels.at(-1);
    const before = Math.min(1, last ? last.n : Math.max(0, Number(item.params?.open_turns) || 0));
    cancels.push({ after: mark, before, n: 0, seqs: openSeqs ? [...openSeqs] : [] });
    await q("UPDATE claw_work_items SET params = params || $2::jsonb, updated_at = NOW() WHERE item_id = $1",
      [item.item_id, JSON.stringify({ cancels })]);
  });
}

/** The newest event a remote session has posted so far: taken before a prompt is queued, as its `NotePrompt.since`. */
export async function remoteEventMark(sessionId: string): Promise<number> {
  if (!remoteItemsOn()) return 0;
  return Number((await db.query("SELECT COALESCE(MAX(id), 0) AS id FROM claw_remote_events WHERE session_id = $1", [sessionId])).rows[0].id);
}

/**
 * A prompt was queued for one of the owner's remote sessions: its item is opened (made the first time) and in progress, titled
 * with what it was asked. Null when the owner has no assistant (nothing to file it under), or when this deployment has no remote
 * items. Its own transaction, under the lock the user's other item writes take (`insertWorkItem`), so two items never take one
 * number.
 */
export async function noteRemotePrompt(p: NotePrompt): Promise<{ itemId: string; seq: number } | null> {
  if (!remoteItemsOn()) return null;
  const noted = await notePrompt(p);
  // What the session posted between the prompt being queued and this note found no item open for it: it is applied now.
  if (noted) await noteRemoteEvents(p.owner, [p.sessionId]);
  return noted;
}

async function notePrompt(p: NotePrompt): Promise<{ itemId: string; seq: number } | null> {
  return inTransaction(async (q) => {
    const assistant = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [p.owner])).rows[0];
    if (!assistant) return null;
    const machine = flat((await q(
      "SELECT name FROM claw_remote_connectors WHERE connector_id = $1 AND owner_user_id = $2", [p.connectorId, p.owner],
    )).rows[0]?.name, 60) || `machine-${p.connectorId.slice(0, 8)}`;
    const lang = p.lang ?? langOf(p.text);
    const asked = flat(p.text, ASKED_MAX);
    const title = remoteTitle(machine, p.agentId, asked, lang);
    const worker = remoteWorkerSessionId(p.sessionId);
    const open = (await q(
      "SELECT item_id, seq, board_state, params FROM claw_work_items WHERE worker_session_id = $1 AND user_id = $2 FOR UPDATE",
      [worker, p.owner],
    )).rows[0] as { item_id: string; seq: number; board_state: string; params: RemoteParams } | undefined;
    // What the session said before this prompt was queued (a conversation taken over replays its history) is not this prompt's.
    const last = p.since !== undefined ? Math.max(0, Number(p.since) || 0) : Number((await q(
      "SELECT COALESCE(MAX(id), 0) AS id FROM claw_remote_events WHERE session_id = $1", [p.sessionId],
    )).rows[0].id);
    if (!open) {
      const params: RemoteParams = {
        connector_id: p.connectorId, session_id: p.sessionId, agent_id: p.agentId, machine, asked, origin: p.origin, lang,
        open_turns: 1, open_cmd_seqs: [p.cmdSeq], waiting: [], last_event_id: last,
      };
      const seq = Number((await q(
        "SELECT COALESCE(MAX(seq), 0)::int + 1 AS next FROM claw_work_items WHERE user_id = $1", [p.owner],
      )).rows[0].next);
      const itemId = newWorkItemId();
      await q(
        `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, last_report_kind, worker_session_id, kind, params)
         VALUES ($1, $2, $3, $4, 'in_progress', 'progress', $5, 'remote', $6::jsonb)`,
        [itemId, p.owner, seq, title, worker, JSON.stringify(params)],
      );
      await q(
        `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
         VALUES ($1, 'created', 'remote', 0, NULL), ($1, 'progress', 'remote', 0, $2)`,
        [itemId, asked],
      );
      return { itemId, seq };
    }
    // An item that ended is opened again for the next instruction; one under way counts one more.
    const turns = open.board_state === "done" ? 1 : Math.max(0, Number(open.params?.open_turns) || 0) + 1;
    // An item that ended skipped what the session posted since. What came after this prompt was queued is this prompt's, but never
    // the event that ended the item, nor any before it: those belong to the turns before (one that ended as this prompt was queued,
    // or one whose end was stored but not yet applied when the item was stopped). The end of a pending cancel after that point is
    // still a pending cancel's; the cancels whose ends lie before it are passed over with the rest, and are no longer pending.
    const closedBy = Number(open.params?.closed_event_id) || 0;
    const from = Math.max(last, closedBy);
    const cancels = pendingCancels(open.params);
    if (open.board_state === "done" && cancels.length) {
      const passed = Number((await q(
        `SELECT COUNT(*)::int AS n FROM claw_remote_events WHERE session_id = $1 AND id > $2 AND id <= $3 AND type = 'turn_end'
            AND data->>'stopReason' = 'cancelled'`,
        [p.sessionId, cancels[0].after, from],
      )).rows[0].n);
      cancels.splice(0, passed);
    }
    // A prompt sent while a cancel is pending runs after it.
    if (cancels.length) cancels[cancels.length - 1].n += 1;
    // Its number joins those open, while all of them are known; an item that ended starts over from this one.
    const openSeqs = open.board_state === "done" ? [p.cmdSeq]
      : Array.isArray(open.params?.open_cmd_seqs) ? [...open.params.open_cmd_seqs, p.cmdSeq] : null;
    const patch = {
      asked, origin: p.origin, lang, open_turns: turns, cancels, open_cmd_seqs: openSeqs,
      ...(open.board_state === "done" ? { waiting: [], closed_event_id: 0, last_event_id: from } : {}),
    };
    await q(
      `UPDATE claw_work_items
          SET board_state = CASE WHEN board_state = 'needs_you' THEN 'needs_you' ELSE 'in_progress' END,
              title = $2, summary = '', last_report_kind = 'progress', outcome = NULL, closed_at = NULL,
              pending_question = CASE WHEN board_state = 'needs_you' THEN pending_question ELSE NULL END,
              generation = generation + 1, params = params || $3::jsonb, updated_at = NOW()
        WHERE item_id = $1`,
      [open.item_id, title, JSON.stringify(patch)],
    );
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
       SELECT item_id, 'progress', 'remote', generation, $2 FROM claw_work_items WHERE item_id = $1`,
      [open.item_id, asked],
    );
    return { itemId: open.item_id, seq: Number(open.seq) };
  });
}

interface MovingEvent { id: number; type: string; data: Record<string, unknown> }

/** What the agent answered in the turn that ended with event `endId`: its message chunks since the turn before it ended. */
async function answerOf(q: Querier, sessionId: string, endId: number): Promise<string> {
  const rows = (await q(
    `SELECT COALESCE(e.data->'update'->'content'->>'text', '') AS text FROM claw_remote_events e
      WHERE e.session_id = $1 AND e.id < $2 AND e.type = 'agent_message_chunk' AND COALESCE(e.data->>'replay', '') <> 'true'
        AND e.id > COALESCE((SELECT MAX(p.id) FROM claw_remote_events p
                              WHERE p.session_id = $1 AND p.id < $2 AND p.type = 'turn_end'), 0)
      ORDER BY e.id DESC LIMIT $3`,
    [sessionId, endId, ANSWER_CHUNKS],
  )).rows as Array<{ text: string }>;
  return rows.reverse().map((r) => r.text).join("");
}

/** What a remote item's end says to the user, in the language they asked in (the system's own words around the agent's). */
export function remoteNotice(
  kind: "done" | "waiting" | "closed" | "refused", p: Pick<RemoteParams, "machine" | "agent_id" | "asked" | "lang" | "session_id">,
  seq: number, detail: string,
): string {
  const zh = p.lang === "zh";
  const who = zh ? `${p.machine} 上的 ${p.agent_id}` : `${p.agent_id} on ${p.machine}`;
  if (kind === "waiting") {
    return zh
      ? `${who} 在等你批准：${detail}（#${seq} ${p.asked}）。发 /agent attach ${p.session_id} 切过去处理。`
      : `${who} is waiting for your approval: ${detail} (#${seq} ${p.asked}). Send /agent attach ${p.session_id} to answer it there.`;
  }
  if (kind === "refused") {
    return zh ? `${who} 没有接下 #${seq}（${p.asked}）：${detail}` : `${who} refused #${seq} (${p.asked}): ${detail}`;
  }
  if (kind === "closed") {
    return zh ? `${who} 的会话已关闭，#${seq}（${p.asked}）没有做完。` : `The session of ${who} closed before #${seq} (${p.asked}) finished.`;
  }
  return zh ? `${who} 做完了 #${seq}：${p.asked}\n${detail}` : `${who} finished #${seq}: ${p.asked}\n${detail}`;
}

/** How a turn ended, said beside its answer when it did not simply end. */
function stopWords(stop: string, error: string, lang: RemoteLang): string {
  if (stop === "end_turn" || !stop) return "";
  if (lang === "zh") return stop === "cancelled" ? "（已取消）" : stop === "error" ? `（出错：${error || "未知"}）` : `（结束原因：${stop}）`;
  return stop === "cancelled" ? "(cancelled)" : stop === "error" ? `(failed: ${error || "unknown"})` : `(ended: ${stop})`;
}

interface Notice { userId: string; routerSid: string; itemId: string; key: string; text: string }

/**
 * The owner's sessions gained events: each one's item takes the moving ones it has not applied, in order (its `last_event_id`), so
 * an event applied once is never applied again, and a post that failed to reach here is caught up by the next. Notices go out after
 * the commit. Returns how many items changed.
 */
export async function noteRemoteEvents(owner: string, sessionIds: readonly string[]): Promise<number> {
  if (!remoteItemsOn() || !sessionIds.length) return 0;
  let changed = 0;
  for (const sessionId of new Set(sessionIds)) {
    try {
      const notices = await applySession(owner, sessionId);
      if (notices === null) continue;
      changed += 1;
      for (const n of notices) {
        await recordSystemNotice({ userId: n.userId, sessionId: n.routerSid, text: n.text, key: n.key, itemId: n.itemId })
          .catch((err) => logger.warn({ err, itemId: n.itemId }, "assistant.remote_notice_failed"));
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "assistant.remote_item_update_failed");
    }
  }
  return changed;
}

async function applySession(owner: string, sessionId: string): Promise<Notice[] | null> {
  return inTransaction(async (q) => {
    const item = (await q(
      `SELECT w.item_id, w.seq, w.board_state, w.attention_seq, w.params, a.session_id AS router_sid
         FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
        WHERE w.worker_session_id = $1 AND w.user_id = $2 AND w.kind = 'remote' FOR UPDATE OF w`,
      [remoteWorkerSessionId(sessionId), owner],
    )).rows[0] as { item_id: string; seq: number; board_state: string; attention_seq: number; params: RemoteParams; router_sid: string } | undefined;
    if (!item) return null;
    const events = (await q(
      `SELECT id, type, data FROM claw_remote_events
        WHERE session_id = $1 AND id > $2 AND type = ANY($3::text[]) AND COALESCE(data->>'replay', '') <> 'true'
        ORDER BY id LIMIT $4`,
      [sessionId, Number(item.params.last_event_id) || 0, MOVING, EVENTS_PER_PASS],
    )).rows.map((r) => ({ id: Number(r.id), type: String(r.type), data: (r.data ?? {}) as Record<string, unknown> })) as MovingEvent[];
    if (!events.length) return null;

    const p: RemoteParams = { ...item.params, waiting: Array.isArray(item.params.waiting) ? [...item.params.waiting] : [] };
    let board = item.board_state;
    const notices: Notice[] = [];
    // Said only of an instruction the assistant sent: the user typed theirs into an attached chat, which showed it.
    const tell = (key: string, text: string) => {
      if (p.origin !== "assistant") return;
      notices.push({ userId: owner, routerSid: item.router_sid, itemId: item.item_id, key: `remote:${item.item_id}:${key}`, text });
    };
    // Each change is one statement on the row and one event row, in order.
    const write = async (set: string, values: unknown[], ev: { kind: string; summary: string | null; question?: string | null; result?: unknown }) => {
      await q(
        `UPDATE claw_work_items SET ${set}, updated_at = NOW() WHERE item_id = $1`,
        [item.item_id, ...values],
      );
      await q(
        `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, question, result)
         SELECT item_id, $2, 'remote', generation, $3, $4, $5::jsonb FROM claw_work_items WHERE item_id = $1`,
        [item.item_id, ev.kind, ev.summary, ev.question ?? null, ev.result === undefined ? null : JSON.stringify(ev.result)],
      );
    };
    // The item ends with this turn's end: answered, with the end of the agent's answer.
    const closeAnswered = async (e: MovingEvent) => {
      const stop = flat(e.data.stopReason, 40);
      const said = stopWords(stop, flat(e.data.error, 200), p.lang);
      const whole = await answerOf(q, sessionId, e.id);
      const answer = tailOf(whole, ANSWER_EVENT_MAX);
      const summary = [said, tailOf(answer, SUMMARY_MAX)].filter(Boolean).join(" ") || (p.lang === "zh" ? "已结束，没有回答文字" : "ended with no answer text");
      await write(
        `board_state = 'done', outcome = 'answered', last_report_kind = 'answer', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + $3::int`,
        [summary, p.origin === "assistant" ? 1 : 0],
        { kind: "answer", summary: [said, answer].filter(Boolean).join(" ") || summary, result: { stop_reason: stop || null, remote_event_id: e.id } },
      );
      tell(`end:${e.id}`, remoteNotice("done", p, item.seq, [said, tailLines(whole, NOTICE_ANSWER_MAX)].filter(Boolean).join(" ") || summary));
    };
    // The item ends with the refusal of the last prompt open, which never ran.
    const closeRefused = async (e: MovingEvent, reason: string) => {
      const summary = p.lang === "zh" ? `指令被拒绝：${reason}` : `the instruction was refused: ${reason}`;
      await write(
        `board_state = 'done', outcome = 'dropped', last_report_kind = 'dropped', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + $3::int`,
        [summary, p.origin === "assistant" ? 1 : 0], { kind: "dropped", summary },
      );
      tell(`refused:${e.id}`, remoteNotice("refused", p, item.seq, reason));
    };
    for (const e of events) {
      p.last_event_id = e.id;
      // A connector that names the prompt a turn's end ends (`cmd_seq`, null for a cancel that found nothing running) is followed by
      // name, while the item knows every prompt open by its number. A turn's end, or a refusal of a prompt that never runs, that names
      // none (an older connector) makes the item count them instead, as it did before names were kept.
      const seq = Number.isSafeInteger(e.data.cmd_seq) ? Number(e.data.cmd_seq) : null;
      const reason = e.type === REMOTE_EVENT_COMMAND_REJECTED && e.data.type === "prompt" ? flat(e.data.reason, 80) : "";
      // A refusal ends its prompt only when the prompt never runs; one refused as its turn starts ends with that turn's end.
      const refusedUnrun = PROMPT_REFUSED_UNQUEUED.has(reason) || reason === PROMPT_DROPPED_BY_CANCEL;
      const named = (e.type === REMOTE_EVENT_TURN_END && Object.hasOwn(e.data, "cmd_seq")) || (refusedUnrun && seq !== null);
      if ((e.type === REMOTE_EVENT_TURN_END || refusedUnrun) && !named) p.open_cmd_seqs = null;
      if (Array.isArray(p.open_cmd_seqs) && named) {
        if (board === "done") continue;
        const ended = new Set<number>(seq !== null ? [seq] : []);
        // The end a cancel brings (`cancelled`, after the oldest cancel pending was sent): nothing sent before that cancel is left to
        // run, so every prompt open when it was sent ends with it, whether it names the turn it cancelled or none (it found nothing
        // running: a prompt whose turn's end never came, lost when the connector restarted mid-turn, ends here). A cancel pending
        // that does not have the cancelled prompt open was sent before that prompt and its end is not coming any more (the turn it
        // was sent for finished on its own as it was on its way): it is passed over, and what it had open the later one has too.
        const pending = pendingCancels(p);
        if (e.type === REMOTE_EVENT_TURN_END && flat(e.data.stopReason, 40) === "cancelled" && pending.length && e.id > pending[0].after) {
          if (seq !== null) while (pending.length && pending[0].seqs && !pending[0].seqs.includes(seq)) pending.shift();
          const sentAfter = pending.reduce((sum, c) => sum + c.n, 0);
          const head = pending.shift();
          const open = p.open_cmd_seqs;
          for (const c of head ? head.seqs ?? open.slice(0, Math.max(0, open.length - sentAfter)) : []) ended.add(c);
          p.cancels = pending;
        }
        const left = p.open_cmd_seqs.filter((c) => !ended.has(c));
        if (left.length === p.open_cmd_seqs.length) continue;
        p.open_cmd_seqs = left;
        p.open_turns = left.length;
        if (p.open_turns > 0) continue;
        board = "done";
        p.closed_event_id = e.id;
        p.waiting = [];
        // Nothing is open for a cancel still pending to end: the next prompt starts over.
        p.cancels = [];
        if (e.type === REMOTE_EVENT_TURN_END) await closeAnswered(e);
        else await closeRefused(e, reason);
        continue;
      }
      // The end a cancel sent from here brings: what was open before the cancel is over, and only the prompts sent after it remain.
      // Before it, a turn that was running when the cancel was sent may still end on its own (it finished as the cancel was on its
      // way): that end is the turn's from before the cancel, never one sent after it. A further end with none of those left means the
      // cancel found nothing to end and brought no end of its own, and the count goes on from the prompts sent after it.
      // Several cancels pending are taken in the order they were sent: each end is the oldest one's.
      let afterCancel: number | null = null;
      let beforeCancelEnd = false;
      let stillPending = false;
      const cancels = pendingCancels(p);
      if (e.type === REMOTE_EVENT_TURN_END && cancels.length && e.id > cancels[0].after) {
        const head = cancels[0];
        if (flat(e.data.stopReason, 40) !== "cancelled" && head.before > 0) {
          head.before -= 1;
          beforeCancelEnd = true;
        } else {
          cancels.shift();
          // No end of its own came (it found nothing to end): this one is of a prompt sent after it, no longer running for the next.
          if (flat(e.data.stopReason, 40) !== "cancelled" && cancels.length && cancels[0].before > 0) cancels[0].before -= 1;
          if (cancels.length) stillPending = true;
          else afterCancel = head.n;
        }
        p.cancels = cancels;
      }
      const sentAfter = cancels.reduce((sum, c) => sum + c.n, 0);
      if (board === "done" && e.type !== REMOTE_EVENT_SESSION_CLOSED) continue;
      if (e.type === REMOTE_EVENT_PERMISSION_REQUEST) {
        const actionId = flat(e.data.actionId, 128);
        if (!actionId || p.waiting.includes(actionId)) continue;
        p.waiting.push(actionId);
        const what = flat(e.data.tool, 120) || (p.lang === "zh" ? "一个操作" : "an action");
        const question = p.lang === "zh" ? `等你批准：${what}` : `Waiting for your approval: ${what}`;
        board = "needs_you";
        await write(
          "board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2, attention_seq = attention_seq + $3::int",
          [question, p.origin === "assistant" ? 1 : 0], { kind: "waiting", summary: question, question },
        );
        tell(`ask:${e.id}`, remoteNotice("waiting", p, item.seq, what));
      } else if (e.type === REMOTE_EVENT_PERMISSION_RESOLVED) {
        const actionId = flat(e.data.actionId, 128);
        p.waiting = p.waiting.filter((a) => a !== actionId);
        if (board === "needs_you" && !p.waiting.length) {
          board = "in_progress";
          await write("board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL", [],
            { kind: "progress", summary: p.lang === "zh" ? "已批准，继续" : "answered, going on" });
        }
      } else if (e.type === REMOTE_EVENT_TURN_END) {
        const stop = flat(e.data.stopReason, 40);
        // A cancel ends the running turn and drops every queued prompt with no turn_end of their own: nothing sent before it is open.
        // The turn from before the cancel ended on its own: with nothing sent after the cancel, the item ends with it.
        if ((beforeCancelEnd && sentAfter > 0) || stillPending) continue;
        p.open_turns = beforeCancelEnd ? 0 : afterCancel !== null
          ? (stop === "cancelled" ? afterCancel : Math.max(0, afterCancel - 1))
          : stop === "cancelled" ? 0 : Math.max(0, (Number(p.open_turns) || 0) - 1);
        if (p.open_turns > 0) continue;
        board = "done";
        p.closed_event_id = e.id;
        p.waiting = [];
        await closeAnswered(e);
      } else if (e.type === REMOTE_EVENT_COMMAND_REJECTED) {
        const reason = flat(e.data.reason, 80);
        if (e.data.type !== "prompt" || !PROMPT_REFUSED_UNQUEUED.has(reason)) continue;
        p.open_turns = Math.max(0, (Number(p.open_turns) || 0) - 1);
        if (p.open_turns > 0) continue;
        board = "done";
        p.closed_event_id = e.id;
        p.waiting = [];
        await closeRefused(e, reason);
      } else if (e.type === REMOTE_EVENT_SESSION_CLOSED) {
        if (board === "done") continue;
        board = "done";
        p.closed_event_id = e.id;
        const summary = p.lang === "zh" ? "会话已关闭" : "the session closed";
        const unfinished = (Number(p.open_turns) || 0) > 0;
        p.open_turns = 0;
        p.waiting = [];
        p.cancels = [];
        await write(
          `board_state = 'done', outcome = 'dropped', last_report_kind = 'dropped', summary = $2, pending_question = NULL,
           closed_at = NOW(), attention_seq = attention_seq + $3::int`,
          [summary, unfinished && p.origin === "assistant" ? 1 : 0], { kind: "dropped", summary },
        );
        if (unfinished) tell(`closed:${e.id}`, remoteNotice("closed", p, item.seq, ""));
      }
    }
    await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1", [item.item_id, JSON.stringify(p)]);
    return notices;
  });
}

/** What the router's item list says of a remote item beside its row: where it runs, and whether that machine is online now. */
export interface RemoteManifest { machine: string; agent: string; session: string; online: boolean }

/** The remote items among `items`, by item id, with whether their machine is online now. */
export async function remoteManifest(
  userId: string, items: ReadonlyArray<{ item_id: string; kind: string; params: unknown }>, onlineWindowMs: number,
): Promise<Map<string, RemoteManifest>> {
  const out = new Map<string, RemoteManifest>();
  const remote = items.filter((i) => i.kind === "remote");
  if (!remote.length || !CLAW_REMOTE_AGENTS_ENABLED) return out;
  const online = new Set(((await db.query(
    `SELECT connector_id::text AS connector_id FROM claw_remote_connectors c
      WHERE c.owner_user_id = $1 AND c.revoked_at IS NULL
        AND c.heartbeat_at > NOW() - make_interval(secs => $2::float8) AND c.stream_seen_at > NOW() - make_interval(secs => $2::float8)`,
    [userId, onlineWindowMs / 1000],
  )).rows as Array<{ connector_id: string }>).map((r) => r.connector_id));
  for (const i of remote) {
    const p = (i.params ?? {}) as Partial<RemoteParams>;
    out.set(i.item_id, {
      machine: String(p.machine ?? ""), agent: String(p.agent_id ?? ""), session: String(p.session_id ?? ""),
      online: online.has(String(p.connector_id ?? "")),
    });
  }
  return out;
}

/** The end of what the agent last answered in a remote item's session, for `work_recall`'s `worker_tail` (untrusted). */
export async function remoteAnswerTail(sessionId: string, max: number): Promise<string> {
  const end = (await db.query(
    "SELECT MAX(id) AS id FROM claw_remote_events WHERE session_id = $1 AND type = 'turn_end'", [sessionId],
  )).rows[0]?.id;
  // A turn under way: what it has said so far.
  const upTo = Number((await db.query("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM claw_remote_events WHERE session_id = $1", [sessionId])).rows[0].id);
  const running = await answerOf((t, p) => db.query(t, p), sessionId, upTo);
  const text = running || (end ? await answerOf((t, p) => db.query(t, p), sessionId, Number(end)) : "");
  return tailOf(text, max);
}

/**
 * A remote item the user stopped (`work_stop`, the item's stop button): the turn its agent is on is cancelled, as an attached chat's
 * stop does. Best effort: the item is closed whether or not the machine hears it, and a session already closed needs nothing.
 */
export async function cancelRemoteItem(userId: string, params: unknown): Promise<void> {
  const sessionId = String((params as Partial<RemoteParams> | null)?.session_id ?? "");
  if (!sessionId) return;
  try {
    const s = await findSession(userId, sessionId);
    if (!s || s.status !== "active") return;
    const queued = await inRemoteSessionOrder(sessionId, async () => {
      const mark = await remoteEventMark(sessionId);
      const out = await issueCommand({
        owner: userId, client: "assistant", connectorId: s.connector_id, agentId: s.agent_id, sessionId, type: "cancel",
        cmdId: randomUUID(), payload: {}, auditDetail: REMOTE_COMMANDS.cancel.audit({}), closesSession: false,
        commandsPerMinute: REMOTE_AGENT_LIMITS.commandsPerMinute,
      });
      if (out.status !== "queued") return false;
      await noteRemoteCancel(userId, sessionId, mark);
      return true;
    });
    if (queued) wakeConnector(s.connector_id);
  } catch (err) {
    logger.warn({ err, sessionId }, "assistant.remote_cancel_failed");
  }
}
