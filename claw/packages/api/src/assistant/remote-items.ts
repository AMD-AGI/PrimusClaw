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
 * Who is told: an instruction the assistant sent (`origin: "assistant"`) is the user's errand, and only three things are ever said of it,
 * each once (`recordSystemNotice`, keyed by the event): it finished (`done`), it needs the user (`needs_you`: a permission request,
 * carried whole so a channel can put its options to them as buttons), or it failed (`error`: the turn ended in an error or a refusal,
 * the machine refused the instruction, or the session ended first). Nothing else: no progress, no "answered, going on", and a stop the
 * user asked for is not news to them. Each message names its session and kind (`AssistantRemoteNotice`), so a channel that shows the
 * session itself (a chat attached to it) can tell it already did. One the user typed into an attached chat is not said: they are
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
import { storableJsonText } from "@claw/utils";
import {
  REMOTE_AGENT_LIMITS, REMOTE_COMMANDS, REMOTE_EVENT_PERMISSION_PARKED, REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED,
  REMOTE_EVENT_SESSION_CLOSED, REMOTE_EVENT_TERMINAL_TURN_END, REMOTE_EVENT_USER_PROMPT, REMOTE_ORIGIN_TERMINAL_HOOK, TERMINAL_ASKS, type TerminalAsks,
} from "@claw/protocol";
import { CLAW_ASSISTANT_ENABLED, CLAW_REMOTE_AGENTS_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { approvalsEnabled, DELIVERY_UNCONFIRMED, findSession, issueCommand, onlineSql, terminalMuted, wakeConnector } from "../remote-agents/store.js";
import { newWorkItemId } from "../tasks/ids.js";
import type { AssistantRemoteAsk, AssistantRemoteNotice, AssistantTerminalEnd } from "../notifications/assistant-events.js";
import { ensureLiveAssistant, itemSession, personWritesChinese, recordSystemNotice, storeAnswerWhole } from "./outbound.js";
import { inertMd } from "./inert-md.js";
import { asksPerson, gather, type TerminalDigest } from "./terminal-digest.js";
import { applyWorkerReport, clipOneLine, clipWords, graphemes, TITLE_MAX } from "./work-items.js";

const logger = pino({ name: "assistant-remote-items" });

export const REMOTE_EVENT_TURN_END = "turn_end";
export const REMOTE_EVENT_COMMAND_REJECTED = "command_rejected";
/** The events that move a remote item. */
const MOVING = [
  REMOTE_EVENT_TURN_END, REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED,
  REMOTE_EVENT_COMMAND_REJECTED, REMOTE_EVENT_TERMINAL_TURN_END,
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
/**
 * How many prompts ended as `delivery_unconfirmed` an item remembers (their late ends still count). More than one sweep can end at
 * once: a user issues at most `commandsPerMinute` (60) commands a minute, over the 6 minutes a command waits before it is ended.
 */
const UNCONFIRMED_KEPT = 400;
/** At most this many of a session's moving events are applied in one pass; the next post applies the rest. */
const EVENTS_PER_PASS = 100;
/**
 * How many of one terminal conversation's requests are put to the user one by one in a minute; past that one message says how many
 * wait (once a minute), so a session that asks for everything does not fill the chat.
 */
export const TERMINAL_ASKS_PER_MINUTE = 5;
/**
 * How long after telling the user that a terminal's turn ended the next end of that conversation is said again: one that works on its
 * own (background tasks waking it, a loop) is not said every turn. The item still records every end.
 */
export const TERMINAL_END_GAP_MS = 5 * 60_000;
/** How much of what the agent last said an end's card carries whole ("show all"): all the connector posts. */
const END_FULL_MAX = 2000;
/** The earlier ends a connector folded into one (`earlier`) that are read: its own most. */
const EARLIER_KEPT = 5;
const MINUTE_MS = 60_000;
/** The newest message chunks of a turn its answer is read from. */
const ANSWER_CHUNKS = 400;

export const remoteItemsOn = (): boolean => CLAW_ASSISTANT_ENABLED && CLAW_REMOTE_AGENTS_ENABLED;

/** The worker session id a remote session's item is filed under. Never a Claw session, so no run, sweep or watchdog finds it. */
export const remoteWorkerSessionId = (remoteSessionId: string): string => `remote:${remoteSessionId}`;

/**
 * Who the session's work is from: the user in an attached chat, the assistant for them, or (`terminal`) the person at a terminal on the
 * machine, whose conversation's approvals its hook carries to the phone (a terminal-hook session, `store.openTerminalSession`).
 */
export type RemoteOrigin = "chat" | "assistant" | "terminal";
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
  /** A terminal's item: the conversation's title (its name, or the start of its first prompt) and folder, as its connector said them. */
  title?: string;
  /**
   * A terminal's item: which tool asked (`claude`, `codex`, `cursor`: the `agent` its connector put on the session's `session_started`,
   * connector 0.2.0 and newer), said to the user by its own name ({@link TERMINAL_TOOL_NAMES}). Absent otherwise: the agent's id is said.
   */
  tool?: TerminalTool;
  cwd?: string;
  /** A terminal's item: when (ms) each of its requests was put to the user one by one within the last minute (`TERMINAL_ASKS_PER_MINUTE`). */
  asked_at?: number[];
  /** A terminal's item: when (ms) the user was last told that more were waiting than are put one by one. */
  summarized_at?: number;
  /** A terminal's item: the requests put to the user as cards and not yet ended, so their end elsewhere is said (`resolved`). */
  carded?: string[];
  /** A terminal's item: when (ms) the user was last told that one of its turns ended ({@link TERMINAL_END_GAP_MS}). */
  end_told_at?: number;
  /** A terminal's item: the ends gathered for its next summary instead of being pushed one by one (terminal-digest.ts). */
  digest?: TerminalDigest;
  /** A terminal's item: when (ms) its last summary was said. */
  summary_told_at?: number;
  /** A terminal's item: the conversation's own name, as its connector lists it (`capabilities.resumable` title), when it has one. */
  name?: string;
  /** Prompts (`cmd_seq`) Claw ended as `delivery_unconfirmed`: an end of the machine's own for one of them still ends the item. */
  unconfirmed?: number[];
  /** What each of those asked (`asked` when it was ended), by `cmd_seq`: said with its answer should that come once the item moved on. */
  unconfirmed_asked?: Record<string, string>;
  /** The prompt whose `delivery_unconfirmed` end closed the item, while nothing later has: its own end closes the item instead. */
  closed_by_unconfirmed?: number | null;
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

/** The tools whose terminals a connector's hooks carry the questions of, by the names their users know them by. */
export const TERMINAL_TOOL_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
export type TerminalTool = keyof typeof TERMINAL_TOOL_NAMES;
export const terminalToolOf = (v: unknown): TerminalTool | undefined =>
  typeof v === "string" && Object.hasOwn(TERMINAL_TOOL_NAMES, v) ? (v as TerminalTool) : undefined;

/** Who a remote item's agent is to the user: the tool by its name for a terminal's item that says which, else the agent's id. */
export const remoteAgentName = (p: Partial<Pick<RemoteParams, "agent_id" | "tool">>): string => {
  const tool = terminalToolOf(p.tool);
  return tool ? TERMINAL_TOOL_NAMES[tool] : String(p.agent_id ?? "").trim();
};

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

/** What a title keeps of what was asked (with its "…") even when the machine's and the agent's names already fill `TITLE_MAX`. */
const TITLE_ASKED_MIN = 16;

/**
 * `head` whole (a machine's or a tool's name is never cut), then as much of `asked` as fits, cut after a whole word; at least
 * `TITLE_ASKED_MIN` characters of it, the word that crosses that kept whole, so the title may run past `TITLE_MAX`.
 */
const titled = (head: string, asked: string): string => {
  const h = head.replace(/\s+/g, " ").trimStart();
  const room = Math.max(TITLE_MAX - graphemes(h).length, TITLE_ASKED_MIN);
  return `${h}${clipWords(asked, room, TITLE_ASKED_MIN - 1)}`.trimEnd();
};

/** The item's title: machine, agent, and the start of what it was asked. */
export function remoteTitle(machine: string, agent: string, asked: string, lang: RemoteLang): string {
  return titled(lang === "zh" ? `${machine} ${agent}：` : `${machine} ${agent}: `, asked);
}

/** The title an item made before titles were cut on a word boundary carries: the whole line cut at `TITLE_MAX` code points. */
export function legacyRemoteTitle(machine: string, agent: string, asked: string, lang: RemoteLang): string {
  return clipOneLine(lang === "zh" ? `${machine} ${agent}：${asked}` : `${machine} ${agent}: ${asked}`, TITLE_MAX);
}

/** The same title with no machine: agent, and the start of what it was asked (an item whose machine is no longer the user's). */
export function remoteTitleWithoutMachine(p: Partial<RemoteParams>): string {
  const agent = remoteAgentName(p);
  const asked = String(p.asked ?? "").trim();
  return titled(p.lang === "zh" ? `${agent}：` : `${agent}: `, asked);
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
      [item.item_id, storableJsonText({ cancels })]);
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
        [itemId, p.owner, seq, title, worker, storableJsonText(params)],
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
      ...(open.board_state === "done" ? { waiting: [], closed_event_id: 0, last_event_id: from, closed_by_unconfirmed: null } : {}),
    };
    await q(
      `UPDATE claw_work_items
          SET board_state = CASE WHEN board_state = 'needs_you' THEN 'needs_you' ELSE 'in_progress' END,
              title = $2, summary = '', last_report_kind = 'progress', outcome = NULL, closed_at = NULL,
              pending_question = CASE WHEN board_state = 'needs_you' THEN pending_question ELSE NULL END,
              generation = generation + 1, params = params || $3::jsonb, updated_at = NOW()
        WHERE item_id = $1`,
      [open.item_id, title, storableJsonText(patch)],
    );
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
       SELECT item_id, 'progress', 'remote', generation, $2 FROM claw_work_items WHERE item_id = $1`,
      [open.item_id, asked],
    );
    return { itemId: open.item_id, seq: Number(open.seq) };
  });
}

interface MovingEvent { id: number; type: string; occurred_at: string; data: Record<string, unknown> }

/** Nothing open on a closed item: no turn counted, and, while prompts are followed by name, none listed. */
function clearOpen(p: RemoteParams): void {
  p.open_turns = 0;
  if (Array.isArray(p.open_cmd_seqs)) p.open_cmd_seqs = [];
}

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

export type RemoteNoticeKind = "done" | "waiting" | "closed" | "refused" | "failed" | "undelivered";

/** Which of the three kinds of news a session's message is (`AssistantRemoteNotice.kind`). */
export const remoteNoticeKind = (kind: RemoteNoticeKind): AssistantRemoteNotice["kind"] =>
  kind === "done" ? "done" : kind === "waiting" ? "needs_you" : "error";

/** How a turn ended badly enough to be an error, not a finish: the agent failed or refused (`stopReason`, ACP and the connector's own). */
const FAILED_STOPS = new Set(["error", "refusal"]);

/** What a remote item's end says to the user, in the language they asked in (the system's own words around the agent's). */
export function remoteNotice(
  kind: RemoteNoticeKind, p: Pick<RemoteParams, "machine" | "agent_id" | "asked" | "lang" | "session_id">,
  seq: number, detail: string,
): string {
  const zh = p.lang === "zh";
  const who = zh ? `${p.machine} 上的 ${p.agent_id}` : `${p.agent_id} on ${p.machine}`;
  if (kind === "failed") {
    return zh ? `${who} 出错了，#${seq} 没有做完：${p.asked}\n${detail}` : `${who} failed on #${seq}: ${p.asked}\n${detail}`;
  }
  if (kind === "waiting") {
    return zh
      ? `${who} 在等你批准：${detail}（#${seq} ${p.asked}）。发 /agent attach ${p.session_id} 切过去处理。`
      : `${who} is waiting for your approval: ${detail} (#${seq} ${p.asked}). Send /agent attach ${p.session_id} to answer it there.`;
  }
  if (kind === "refused") {
    return zh ? `${who} 没有接下 #${seq}（${p.asked}）：${detail}` : `${who} refused #${seq} (${p.asked}): ${detail}`;
  }
  if (kind === "undelivered") {
    return zh
      ? `${who} 没有确认收到 #${seq}（${p.asked}）：那台机器在这条指令发出前后断开了（比如笔记本合盖了），可能没有执行。它重新连上后如果做完了，我会再告诉你。`
      : `${who} did not confirm it got #${seq} (${p.asked}): the machine went just as it was sent (a laptop closed, for one), so it may not have run. If it finishes once the machine is back, I will tell you.`;
  }
  if (kind === "closed") {
    return zh ? `${who} 的会话已关闭，#${seq}（${p.asked}）没有做完。` : `The session of ${who} closed before #${seq} (${p.asked}) finished.`;
  }
  return zh ? `${who} 做完了 #${seq}：${p.asked}\n${detail}` : `${who} finished #${seq}: ${p.asked}\n${detail}`;
}

/** An end Claw wrote for a prompt its machine never acknowledged (`store.expireUndelivered`), not one the machine sent. */
const undelivered = (e: MovingEvent): boolean => e.data.by === "claw" && e.data.error === DELIVERY_UNCONFIRMED;

/** How a turn ended, said beside its answer when it did not simply end. */
/**
 * A message the connector would not type into a terminal (connector session.ts `pumpTerminal`): what to do about it, with the
 * terminal's permission mode when the connector named it (`terminal_mode`). Anything else is said by its code, as before.
 */
export function terminalRefusal(error: string, mode: string, lang: RemoteLang): string | null {
  const m = mode || (lang === "zh" ? "未知模式" : "an unknown mode");
  if (error === "terminal_mode_not_allowed") {
    return lang === "zh"
      ? `终端会话处于 ${m}，按你的审批设置不能从手机直接输入；在终端切到安全模式（Claude Code 里按 shift+tab，如 manual 或 plan），或把这个 agent 的审批设置改为 approval = "never" 后再试`
      : `the terminal's conversation is in ${m}, which your approval setting does not allow from the phone; switch the terminal to a safe mode (shift+tab in Claude Code, e.g. manual or plan), or set approval = "never" for this agent, then try again`;
  }
  if (error === "terminal_mode_unknown") {
    return lang === "zh"
      ? "看不出终端会话现在处于哪种权限模式，没有输入；确认那台机器上的 Claude Code 在输入框下方显示模式后再试"
      : "could not tell which permission mode the terminal's conversation is in, so nothing was typed; make sure Claude Code there shows its mode below the input box, then try again";
  }
  if (error === "terminal_screen_unknown") {
    return lang === "zh"
      ? "连接器 30 秒内都认不出那个终端的画面（不是 Claude Code 的输入框，它也没说自己在忙），没有输入；看一眼终端、关掉上面的东西后再发"
      : "the connector could not read the terminal's screen for 30 seconds (no Claude Code input box, and it did not say it was busy), so nothing was typed; look at the terminal, close whatever is on it, then send again";
  }
  if (error === "terminal_command_refused") {
    return lang === "zh"
      ? "以 ! 或 / 开头的消息会在终端里直接执行命令，不从手机输入；换个说法，或在终端里执行"
      : "a message starting with ! or / would run a command in the terminal, so it is not typed from the phone; rephrase it, or run it at the terminal";
  }
  return null;
}

/**
 * A turn the connector ended because it restarted mid-turn (connector manager.ts `recover`): the person is told what happened and how to
 * carry on rather than the code. It never says the session is back: `recover` ends the turn of a session that is no longer active too
 * (it then sends no `session_recovered`). Anything else is said by its code, as before.
 */
function interruption(error: string, lang: RemoteLang): string | null {
  if (error !== "connector_restarted") return null;
  return lang === "zh"
    ? "（被打断：那台机器上的连接器重启了，这一轮没有做完；再发一次这条指令，或发“继续”让它接着做）"
    : "(interrupted: the connector on that machine restarted, so this turn did not finish; send the instruction again, or say \"continue\", to carry on)";
}

function stopWords(stop: string, error: string, lang: RemoteLang, mode = ""): string {
  if (stop === "end_turn" || !stop) return "";
  const terminal = stop === "error" ? terminalRefusal(error, mode, lang) : null;
  if (terminal) return lang === "zh" ? `（没有输入：${terminal}）` : `(not typed: ${terminal})`;
  const cut = stop === "error" ? interruption(error, lang) : null;
  if (cut) return cut;
  if (lang === "zh") return stop === "cancelled" ? "（已取消）" : stop === "error" ? `（出错：${error || "未知"}）` : `（结束原因：${stop}）`;
  return stop === "cancelled" ? "(cancelled)" : stop === "error" ? `(failed: ${error || "unknown"})` : `(ended: ${stop})`;
}

interface Notice { userId: string; routerSid: string; itemId: string | undefined; key: string; text: string; remote: AssistantRemoteNotice }

/** The options a permission request offered, as its connector posted them: ids kept as given, words cut to one line. */
function offeredOptions(v: unknown): AssistantRemoteAsk["options"] {
  if (!Array.isArray(v)) return [];
  const out: AssistantRemoteAsk["options"] = [];
  for (const o of v.slice(0, 8)) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (typeof r.optionId !== "string" || !r.optionId || r.optionId.length > 128) continue;
    out.push({ optionId: r.optionId, name: flat(r.name, 80), kind: flat(r.kind, 32) });
  }
  return out;
}

/** The permission request event `e` as a channel puts it to the person; null when it offered nothing that can be answered. */
function askOf(e: MovingEvent, actionId: string, tool: string): AssistantRemoteAsk | null {
  let options = offeredOptions(e.data.options);
  if (!options.length) return null;
  const timeout = Number(e.data.timeout_ms);
  const at = Date.parse(e.occurred_at);
  const expires = Number.isFinite(timeout) && timeout > 0 && timeout <= 24 * 3_600_000 && Number.isFinite(at)
    ? new Date(at + timeout).toISOString() : null;
  const ask: AssistantRemoteAsk = { action_id: actionId, tool, options, ...(expires ? { expires_at: expires } : {}) };
  if (e.data.origin !== REMOTE_ORIGIN_TERMINAL_HOOK) return ask;
  // A terminal's request goes whole: what it would do is what the person approves. One too large to carry whole keeps only the
  // options that refuse, so nothing is approved from a card that did not show all of it.
  ask.origin = "terminal";
  const kind = flat(e.data.kind, 32);
  if (kind) ask.kind = kind;
  const input = e.data.input;
  if (input !== undefined && input !== null) {
    if (Buffer.byteLength(JSON.stringify(input) ?? "") <= TERMINAL_ASK_INPUT_MAX) ask.input = input;
    else options = options.filter((o) => o.kind.startsWith("reject"));
  }
  ask.options = options;
  const asks = terminalAsksOf(e.data.terminal_asks);
  if (asks) ask.terminal_asks = asks;
  for (const f of ["question_index", "question_count"] as const) {
    const n = e.data[f];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 100) ask[f] = n;
  }
  return options.length ? ask : null;
}

/** When the terminal asks a request too, as its connector said (`terminal_asks`); undefined: alongside the card (Claude Code). */
export function terminalAsksOf(v: unknown): TerminalAsks | undefined {
  return TERMINAL_ASKS.find((t) => t === v);
}

/** How large a terminal's request may be (its `input`, as JSON) to be carried whole on a card: the connector keeps it to 12 KB. */
export const TERMINAL_ASK_INPUT_MAX = 16 * 1024;

/**
 * The owner's sessions gained events: each one's item takes the moving ones it has not applied, in order (its `last_event_id`), so
 * an event applied once is never applied again, and a post that failed to reach here is caught up by the next. Notices go out after
 * the commit. Returns how many items changed.
 */
export async function noteRemoteEvents(owner: string, sessionIds: readonly string[]): Promise<number> {
  if (!remoteItemsOn() || !sessionIds.length) return 0;
  let changed = 0;
  for (const sessionId of new Set(sessionIds)) {
    // A seat's tasks running in this session first: the events they own are theirs, and the session's own item passes over them.
    if (await noteErrandEvents(owner, sessionId)) changed += 1;
    try {
      const notices = await applySession(owner, sessionId);
      if (notices === null) continue;
      changed += 1;
      for (const n of notices) {
        await recordSystemNotice({ userId: n.userId, sessionId: n.routerSid, text: n.text, key: n.key, itemId: n.itemId, remote: n.remote })
          .catch((err) => logger.warn({ err, itemId: n.itemId }, "assistant.remote_notice_failed"));
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "assistant.remote_item_update_failed");
    }
  }
  // A seat whose session has nothing of its tasks left running takes the next one waiting for it (`seat-dispatch.ts`).
  try {
    const { drainSeatsOf } = await import("./seat-dispatch.js");
    await drainSeatsOf(owner, [...new Set(sessionIds)]);
  } catch (err) {
    logger.warn({ err }, "assistant.seat_drain_failed");
  }
  return changed;
}

/**
 * A terminal-hook session's item, made when its first request or its first told end comes (a session that never does has none): filed under the session as
 * every remote item is, origin `terminal`, titled with the machine, the agent and the conversation. Null for any other session, or
 * when the owner has no assistant to file it under.
 */
async function terminalItem(q: Querier, owner: string, sessionId: string): Promise<boolean> {
  const s = (await q(
    `SELECT s.connector_id::text AS connector_id, s.agent_id, s.cwd, c.name, st.title, st.tool
       FROM claw_remote_sessions s JOIN claw_remote_connectors c ON c.connector_id = s.connector_id
       LEFT JOIN LATERAL (SELECT e.data->>'title' AS title, e.data->>'agent' AS tool FROM claw_remote_events e
                           WHERE e.session_id = s.session_id AND e.type = 'session_started' ORDER BY e.id DESC LIMIT 1) st ON TRUE
      WHERE s.session_id = $1 AND s.owner_user_id = $2 AND s.origin = $3`,
    [sessionId, owner, REMOTE_ORIGIN_TERMINAL_HOOK],
  )).rows[0];
  if (!s) return false;
  const asks = (await q(
    `SELECT 1 FROM claw_remote_events WHERE session_id = $1 AND type = ANY($2::text[]) LIMIT 1`,
    [sessionId, [REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_TERMINAL_TURN_END]],
  )).rows.length > 0;
  if (!asks) return false;
  const assistant = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [owner])).rows[0];
  if (!assistant) return false;
  const machine = flat(s.name, 60) || `machine-${String(s.connector_id).slice(0, 8)}`;
  const title = flat(s.title, 80);
  const cwd = flat(s.cwd, 300);
  const lang: RemoteLang = (await personWritesChinese(q, owner, title)) ? "zh" : "en";
  const asked = title || cwdTail(cwd) || (lang === "zh" ? "终端会话" : "terminal conversation");
  const tool = terminalToolOf(s.tool);
  const params: RemoteParams = {
    connector_id: String(s.connector_id), session_id: sessionId, agent_id: String(s.agent_id), machine, asked, origin: "terminal", lang,
    open_turns: 0, open_cmd_seqs: [], waiting: [], last_event_id: 0, title, cwd, ...(tool ? { tool } : {}),
  };
  const seq = Number((await q("SELECT COALESCE(MAX(seq), 0)::int + 1 AS next FROM claw_work_items WHERE user_id = $1", [owner])).rows[0].next);
  const itemId = newWorkItemId();
  await q(
    `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, last_report_kind, worker_session_id, kind, params)
     VALUES ($1, $2, $3, $4, 'in_progress', 'progress', $5, 'remote', $6::jsonb) ON CONFLICT (worker_session_id) DO NOTHING`,
    [itemId, owner, seq, remoteTitle(machine, remoteAgentName(params), asked, lang), remoteWorkerSessionId(sessionId), storableJsonText(params)],
  );
  await q(`INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
           SELECT $1, 'created', 'remote', 0, NULL WHERE EXISTS (SELECT 1 FROM claw_work_items WHERE item_id = $1)`, [itemId]);
  return true;
}

/** The last two parts of a folder, which is how a person names their project. */
export function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join("/");
}

/**
 * What a terminal's request says to the user, in their language: where it waits, what for, and how the terminal asks it too
 * (`asks`, the request's `terminal_asks`): alongside the card, the first answer counting (Claude Code); only once the card is
 * answered or its time is up, the card offering to decline or to hand it back (Cursor, `after_card`); or only once someone types in
 * that terminal, which takes it back from the card (Codex, `on_input`).
 */
export function terminalAskNotice(
  p: Pick<RemoteParams, "machine" | "agent_id" | "tool" | "lang" | "title" | "cwd">, what: string, answerable = true, asks?: TerminalAsks,
): string {
  const agent = remoteAgentName(p);
  const where = [flat(p.title, 80), cwdTail(String(p.cwd ?? ""))].filter(Boolean).join(p.lang === "zh" ? "，" : ", ");
  const zh = p.lang === "zh";
  const how = (zh ? HOW_ZH : HOW_EN)[asks ?? "alongside"][answerable ? "answerable" : "cut"];
  return zh
    ? `${p.machine} 上终端里的 ${agent}${where ? `（${where}）` : ""}在等你回答：${what}。${how}`
    : `${agent} in a terminal on ${p.machine}${where ? ` (${where})` : ""} is waiting for you: ${what}. ${how}`;
}

type HowWords = Record<TerminalAsks | "alongside", { answerable: string; cut: string }>;
const HOW_EN: HowWords = {
  alongside: {
    answerable: "Choose below, or answer in the terminal; whichever comes first counts.",
    cut: "It cannot be shown here in full: answer it in the terminal.",
  },
  after_card: {
    answerable: "Decline it below, or hand it back to the terminal: the terminal asks only after that (or once this wait is over), and you approve it there.",
    cut: "It cannot be shown here in full: the terminal asks once its wait for the phone is over; answer it there.",
  },
  on_input: {
    answerable: "Choose below; to answer in the terminal instead, type anything there, and the question goes back to it.",
    cut: "It cannot be shown here in full: type anything in the terminal, and it asks you there.",
  },
};
const HOW_ZH: HowWords = {
  alongside: {
    answerable: "在下面选，或直接在终端里回答，先答的算数。",
    cut: "这个请求没法在这里完整显示，请到终端里回答。",
  },
  after_card: {
    answerable: "可以在下面拒绝，或交回终端：终端要等这里答完（或等待时间到了）才会问，批准请在终端里。",
    cut: "这个请求没法在这里完整显示：终端等手机的时间一过就会问你，请到终端里回答。",
  },
  on_input: {
    answerable: "在下面选；想改在终端里回答，就在终端里随便输入点什么，问题就回到终端。",
    cut: "这个请求没法在这里完整显示：在终端里随便输入点什么，它就会在终端里问你。",
  },
};

/** The most of what the agent last said that an end's message quotes, in code points: two or three lines of a phone's chat. */
export const END_SUMMARY_MAX = 200;
/** A sentence's end: a full stop, an exclamation or question mark, a semicolon (CJK or Latin, a Latin one before a space or the end). */
const SENTENCE_END = /[。！？；]|[.!?;](?=\s|$)/gu;
/** A clause's end, where a sentence too long for the message is cut when it must be. */
const CLAUSE_END = /[，、：,:]/gu;
/** A block that says it sums the answer up: a heading or a bold lead such as "Summary", "TL;DR", "总结", "结论". */
const SUMMARY_HEAD = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:summary|tl;?dr|in short|conclusion|总结|小结|结论)\s*(?:\*\*)?\s*(?:[:：]\s*(?:\*\*)?\s*|$)/iu;

/** A line that ends in a CJK character or mark, after which the next line of the same paragraph follows with no space. */
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]$/u;
/** One line of an answer as a message shows it plainly: no heading marks, no emphasis or code ticks, spaces folded. */
const plainLine = (line: string): string =>
  line.replace(/^#{1,6}\s+/u, "").replace(/\*\*|__|`/gu, "").replace(/\s+/gu, " ").trim();

/**
 * What a turn's end says of what the agent last said (`message`, at most the last 2000 characters of its last answer, the connector's
 * `TURN_END_MESSAGE_MAX`, with a "…" first when cut there): a few whole sentences, never a tail that starts mid-sentence. An answer
 * that came whole is read from its start, where an answer says what it did; one the connector cut is read from a block that sums it
 * up, else from its last paragraph. Whole sentences of that block are kept while they fit in `max` (a first sentence longer than that
 * is cut after a clause, with "…"); `more` says whether anything of the answer was left out, so the message can point at the rest.
 * The words are the agent's: plain text, never instructions.
 */
export function terminalEndSummary(message: string, max: number = END_SUMMARY_MAX): { summary: string; more: boolean } {
  const text = message.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/gu, " ").trim();
  if (!text) return { summary: "", more: false };
  const cut = text.startsWith("…");
  const blocks = text.split(/\n\s*\n/u).map((b) => b.trim()).filter(Boolean);
  if (cut && blocks.length > 1) blocks.shift(); // (its first block starts in the middle of something)
  let at = blocks.findIndex((b) => SUMMARY_HEAD.test(b.split("\n", 1)[0] ?? ""));
  let block: string;
  if (at >= 0) {
    const [first = "", ...rest] = (blocks[at] ?? "").split("\n");
    const after = first.replace(SUMMARY_HEAD, "").trim();
    block = [after, ...rest].filter((l) => l.trim()).join("\n");
    if (!block && blocks[at + 1]) block = blocks[++at] ?? "";
  } else {
    at = cut ? blocks.length - 1 : 0;
    block = blocks[at] ?? "";
  }
  if (cut && blocks.length === 1) {
    // One block cut at its start: from its first sentence that starts whole.
    SENTENCE_END.lastIndex = 0;
    const m = SENTENCE_END.exec(block);
    block = m && m.index + m[0].length < block.length ? block.slice(m.index + m[0].length) : block.replace(/^…/u, "");
  }
  const lines = block.split("\n").map(plainLine).filter(Boolean);
  const listed = lines.length > 1 && lines.every((l, i) => i === 0 || /^(?:[-*•]|\d+[.)])\s/u.test(l));
  // A list keeps its lines (three at most); a paragraph is one run of sentences.
  const shown = listed ? lines.slice(0, 3) : [lines.reduce((all, l) => (all ? `${all}${CJK_END.test(all) ? "" : " "}${l}` : l), "")];
  const kept: string[] = [];
  let room = max;
  let dropped = listed && lines.length > 3;
  for (const line of shown) {
    const fit = fitSentences(line, room);
    if (!fit.text) { dropped = true; break; }
    kept.push(fit.text);
    room -= Array.from(fit.text).length + 1;
    if (fit.cut) { dropped = true; break; }
  }
  const more = dropped || blocks.length > 1 || cut;
  return { summary: kept.join("\n"), more };
}

/** As many whole sentences of `line` as fit in `max` code points; a first one too long is cut after a clause (or a word), with "…". */
function fitSentences(line: string, max: number): { text: string; cut: boolean } {
  const chars = Array.from(line);
  if (chars.length <= max) return { text: line, cut: false };
  if (max < 8) return { text: "", cut: true };
  const ends = (re: RegExp): number[] => {
    const out: number[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(Array.from(line.slice(0, m.index + m[0].length)).length);
    return out;
  };
  const whole = ends(SENTENCE_END).filter((n) => n <= max).pop();
  if (whole) return { text: chars.slice(0, whole).join("").trim(), cut: true };
  const clause = ends(CLAUSE_END).filter((n) => n <= max - 1 && n >= max / 3).pop();
  if (clause) return { text: `${chars.slice(0, clause - 1).join("").trim()}…`, cut: true };
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return { text: `${(space >= max / 3 ? head.slice(0, space) : head).trim()}…`, cut: true };
}

/** What names a conversation in its end's message: its own name (the connector's list), else its title, else the tool. */
export function terminalEndName(p: Pick<RemoteParams, "agent_id" | "tool" | "title" | "name">): string {
  return flat(p.name, 80) || flat(p.title, 80) || remoteAgentName(p);
}

/**
 * What a terminal's turn that ended while nobody was at it says, in the user's language, in three parts. First one line that says
 * which conversation at a glance: its name (the connector's list, as Claude Code's own session list shows it; else its title, else the
 * tool), finished or stopped with an error (and why), then the machine, the folder, that the terminal sat idle, and the item number
 * last. Then what the agent did, from what it last said ({@link terminalEndSummary}), and where the rest is when that was not all of it.
 * Then the commands for it: attach the chat to that conversation (`/agent attach <ref>`, when its connector lists it) and mute it
 * (`/approvals mute #<item>`). The agent's words are quoted text, never instructions.
 */
export function terminalEndNotice(
  p: Pick<RemoteParams, "machine" | "agent_id" | "tool" | "lang" | "title" | "cwd" | "name">, seq: number, failed: boolean, error: string,
  said: { summary: string; more: boolean }, attach: string | null,
): string {
  const zh = p.lang === "zh";
  // Every word the machine or the agent wrote is made inert: a channel reads this text as markdown, and none of it may become a
  // link, an image or markup there.
  const name = inertMd(terminalEndName(p));
  const reason = inertMd(error);
  const status = failed ? (zh ? `出错停下（${reason}）` : `stopped with an error (${reason})`) : (zh ? "做完了" : "finished");
  const where = [inertMd(p.machine), inertMd(cwdTail(String(p.cwd ?? ""))), zh ? "终端空闲" : "terminal idle", `#${seq}`]
    .filter(Boolean).join(" · ");
  const head = zh ? `【${name}】${status} · ${where}` : `[${name}] ${status} · ${where}`;
  const body = said.summary
    ? `${inertMd(said.summary)}${said.more ? (zh ? "（全文见终端）" : " (the rest is in the terminal)") : ""}`
    : "";
  const commands = zh
    ? [attach ? `接入：${attach}` : "", `静音：/approvals mute #${seq}`]
    : [attach ? `Attach: ${attach}` : "", `Mute: /approvals mute #${seq}`];
  return [head, body, commands.filter(Boolean).join(zh ? "　" : "  ·  ")].filter(Boolean).join("\n");
}

/** The attach command a turn's end offers for a conversation its connector lists (`capabilities.resumable`), by the start of its ref. */
export const TERMINAL_ATTACH_REF_MIN = 8;
export function terminalAttachCommand(ref: string | null | undefined): string | null {
  const r = String(ref ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{6,128}$/u.test(r)) return null;
  // The channel attaches a listed conversation by the first characters of its ref (six at least); eight say it among a machine's own.
  return `/agent attach ${r.length > TERMINAL_ATTACH_REF_MIN ? r.slice(0, TERMINAL_ATTACH_REF_MIN) : r}`;
}

/** Said instead of each request once more of one conversation's wait than are put one by one in a minute. */
export function terminalBusyNotice(p: Pick<RemoteParams, "machine" | "agent_id" | "tool" | "lang" | "title" | "cwd">, waiting: number): string {
  const agent = remoteAgentName(p);
  const where = [flat(p.title, 80), cwdTail(String(p.cwd ?? ""))].filter(Boolean).join(p.lang === "zh" ? "，" : ", ");
  return p.lang === "zh"
    ? `${p.machine} 上终端里的 ${agent}${where ? `（${where}）` : ""}一分钟内问了很多次，现在有 ${waiting} 个在等你；不再逐条推送，请到终端里处理（发 /approvals off 可关掉终端审批推送）。`
    : `${agent} in a terminal on ${p.machine}${where ? ` (${where})` : ""} asked many times within a minute and ${waiting} wait for you now; they are no longer sent one by one: answer them in the terminal (/approvals off stops approvals from terminals).`;
}

async function applySession(owner: string, sessionId: string): Promise<Notice[] | null> {
  return inTransaction(async (q) => {
    const find = async () => (await q(
      `SELECT w.item_id, w.seq, w.board_state, w.attention_seq, w.params, a.session_id AS router_sid
         FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
        WHERE w.worker_session_id = $1 AND w.user_id = $2 AND w.kind = 'remote' FOR UPDATE OF w`,
      [remoteWorkerSessionId(sessionId), owner],
    )).rows[0] as { item_id: string; seq: number; board_state: string; attention_seq: number; params: RemoteParams; router_sid: string } | undefined;
    const found = (await find()) ?? (await terminalItem(q, owner, sessionId) ? await find() : undefined);
    if (!found) return null;
    const item = found;
    const events = (await q(
      `SELECT id, type, occurred_at, data FROM claw_remote_events
        WHERE session_id = $1 AND id > $2 AND type = ANY($3::text[]) AND COALESCE(data->>'replay', '') <> 'true'
        ORDER BY id LIMIT $4`,
      [sessionId, Number(item.params.last_event_id) || 0, MOVING, EVENTS_PER_PASS],
    )).rows.map((r) => ({
      id: Number(r.id), type: String(r.type), occurred_at: new Date(r.occurred_at).toISOString(), data: (r.data ?? {}) as Record<string, unknown>,
    })) as MovingEvent[];
    if (!events.length) return null;

    const p: RemoteParams = { ...item.params, waiting: Array.isArray(item.params.waiting) ? [...item.params.waiting] : [] };
    let board = item.board_state;
    const notices: Notice[] = [];
    // Said only of an instruction the assistant sent: the user typed theirs into an attached chat, which showed it.
    const tell = (key: string, kind: RemoteNoticeKind, text: string, ask?: AssistantRemoteAsk) => {
      if (p.origin !== "assistant") return;
      const remote: AssistantRemoteNotice = {
        kind: remoteNoticeKind(kind), session_id: sessionId, machine: p.machine, agent: p.agent_id, ...(ask ? { ask } : {}),
      };
      notices.push({ userId: owner, routerSid: item.router_sid, itemId: item.item_id, key: `remote:${item.item_id}:${key}`, text, remote });
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
        [item.item_id, ev.kind, ev.summary, ev.question ?? null, ev.result === undefined ? null : storableJsonText(ev.result)],
      );
    };
    // The item ends with this turn's end: answered, with the end of the agent's answer.
    const closeAnswered = async (e: MovingEvent) => {
      if (undelivered(e)) {
        await closeUndelivered(e);
        return;
      }
      const stop = flat(e.data.stopReason, 40);
      const said = stopWords(stop, flat(e.data.error, 200), p.lang, flat(e.data.terminal_mode, 40));
      const whole = await answerOf(q, sessionId, e.id);
      const answer = tailOf(whole, ANSWER_EVENT_MAX);
      const summary = [said, tailOf(answer, SUMMARY_MAX)].filter(Boolean).join(" ") || (p.lang === "zh" ? "已结束，没有回答文字" : "ended with no answer text");
      await write(
        `board_state = 'done', outcome = 'answered', last_report_kind = 'answer', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + $3::int`,
        [summary, p.origin === "assistant" ? 1 : 0],
        { kind: "answer", summary: [said, answer].filter(Boolean).join(" ") || summary, result: { stop_reason: stop || null, remote_event_id: e.id } },
      );
      // A turn that failed is an error, said as one; one that ended (or the agent cancelled by itself) finished. The user's own stop is
      // not said: their stop button closed the item before its end came, and an attached chat's stop is theirs to see.
      const kind: RemoteNoticeKind = FAILED_STOPS.has(stop) ? "failed" : "done";
      tell(`end:${e.id}`, kind, remoteNotice(kind, p, item.seq, [said, tailLines(whole, NOTICE_ANSWER_MAX)].filter(Boolean).join(" ") || summary));
    };
    // The item ends with the refusal of the last prompt open, which never ran.
    const closeRefused = async (e: MovingEvent, reason: string) => {
      const summary = p.lang === "zh" ? `指令被拒绝：${reason}` : `the instruction was refused: ${reason}`;
      await write(
        `board_state = 'done', outcome = 'dropped', last_report_kind = 'dropped', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + $3::int`,
        [summary, p.origin === "assistant" ? 1 : 0], { kind: "dropped", summary },
      );
      tell(`refused:${e.id}`, "refused", remoteNotice("refused", p, item.seq, reason));
    };
    // The machine never got the instruction (`store.expireUndelivered`: its prompt or its session's start was too old to deliver):
    // nothing ran, and that is said as such, never as an answer or an error of the agent's.
    const closeUndelivered = async (e: MovingEvent) => {
      // Claw could not tell whether the machine took it just before it went: said so, and its own end, if it comes, still counts.
      const seq = Number.isSafeInteger(e.data.cmd_seq) ? Number(e.data.cmd_seq) : null;
      p.closed_by_unconfirmed = seq;
      const summary = p.lang === "zh" ? "机器在确认收到前断开了，这条指令可能没有执行" : "the machine went before confirming it had the instruction; it may not have run";
      await write(
        `board_state = 'done', outcome = 'dropped', last_report_kind = 'dropped', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + $3::int`,
        [summary, p.origin === "assistant" ? 1 : 0], { kind: "dropped", summary },
      );
      tell(`undelivered:${e.id}`, "undelivered", remoteNotice("undelivered", p, item.seq, ""));
    };
    if (p.origin === "terminal") {
      // An item made before Claw read the tool (or before its session said it): learned from the session's session_started now.
      if (!terminalToolOf(p.tool)) {
        const tool = terminalToolOf((await q(
          `SELECT data->>'agent' AS tool FROM claw_remote_events WHERE session_id = $1 AND type = 'session_started' ORDER BY id DESC LIMIT 1`,
          [sessionId],
        )).rows[0]?.tool);
        if (tool) {
          p.tool = tool;
          // Its title named the agent's id: named by the tool now, unless it is no longer the title it was made with.
          await q("UPDATE claw_work_items SET title = $3 WHERE item_id = $1 AND title IN ($2, $4)", [
            item.item_id, remoteTitle(p.machine, p.agent_id, p.asked, p.lang), remoteTitle(p.machine, remoteAgentName(p), p.asked, p.lang),
            legacyRemoteTitle(p.machine, p.agent_id, p.asked, p.lang),
          ]);
        }
      }
      // The owner's switch for every push of their terminals, and their mute of this one conversation.
      const where = (await q(
        `SELECT s.connector_id::text AS connector_id, s.ref,
                EXISTS (SELECT 1 FROM claw_remote_agents a
                   CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(a.capabilities->'resumable') = 'array' THEN a.capabilities->'resumable' ELSE '[]'::jsonb END) r(value)
                  WHERE a.connector_id = s.connector_id AND jsonb_typeof(r.value) = 'object' AND r.value->>'ref' = s.ref) AS listed,
                (SELECT r.value->>'title' FROM claw_remote_agents a
                   CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(a.capabilities->'resumable') = 'array' THEN a.capabilities->'resumable' ELSE '[]'::jsonb END) r(value)
                  WHERE a.connector_id = s.connector_id AND jsonb_typeof(r.value) = 'object' AND r.value->>'ref' = s.ref
                  LIMIT 1) AS name
           FROM claw_remote_sessions s WHERE s.session_id = $1`,
        [sessionId],
      )).rows[0] as { connector_id: string; ref: string | null; listed: boolean; name: string | null } | undefined;
      const muted = !!where?.ref && await terminalMuted(owner, where.connector_id, where.ref, q);
      const name = flat(where?.name, 80);
      if (name) p.name = name;
      // (attached by the start of its ref, which the channel finds among the conversations its connector lists)
      const attach = where?.listed ? terminalAttachCommand(where.ref) : null;
      const said = await applyTerminal(events, p, board, write, !muted && await approvalsEnabled(owner, q), item.seq, attach);
      // A message filed under the item is the one that told the user of its current wait (one per `attention_seq`): the last request
      // said in this pass. The others (an earlier request of the same pass, a card marked resolved) are said without it.
      const filed = said.map((n) => !n.resolved).lastIndexOf(true);
      const tool = terminalToolOf(p.tool);
      for (const [i, n] of said.entries()) {
        notices.push({
          userId: owner, routerSid: item.router_sid, itemId: i === filed ? item.item_id : undefined, key: `remote:${item.item_id}:${n.key}`, text: n.text,
          remote: {
            kind: n.resolved ? "resolved" : n.end ?? "needs_you", session_id: sessionId, machine: p.machine, agent: p.agent_id,
            ...(tool ? { tool } : {}),
            ...(n.ask ? { ask: n.ask } : {}), ...(n.resolved ? { resolved: n.resolved } : {}), ...(n.endCard ? { end: n.endCard } : {}),
          },
        });
      }
      await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1", [item.item_id, storableJsonText(p)]);
      return notices;
    }
    // What a seat's task sent this session, and whether one runs there now: its events are its own, never this item's. (Read only
    // for a session a task was ever sent to.)
    const hadErrand = (await q(
      "SELECT 1 FROM claw_work_items WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND params->>'session_id' = $2 LIMIT 1",
      [owner, sessionId],
    )).rows.length > 0;
    const errandSeqs = hadErrand ? await errandSeqsOf(q, sessionId) : new Set<number>();
    const errandRunning = hadErrand && await errandRunningOn(q, owner, sessionId);
    for (const e of events) {
      p.last_event_id = e.id;
      if (errandOwns(e, errandSeqs, errandRunning)) continue;
      // The end of a turn the agent took by itself ends no instruction of the item's (`agentInitiated`).
      if (agentInitiated(e)) continue;
      // A connector that names the prompt a turn's end ends (`cmd_seq`, null for a cancel that found nothing running) is followed by
      // name, while the item knows every prompt open by its number. A turn's end, or a refusal of a prompt that never runs, that names
      // none (an older connector) makes the item count them instead, as it did before names were kept.
      const seq = Number.isSafeInteger(e.data.cmd_seq) ? Number(e.data.cmd_seq) : null;
      // Every instruction Claw ends as unconfirmed is remembered, whether or not it closes the item (others may still be open), with what
      // it asked when that is known (the newest one open is `asked`; an earlier one is said as "an earlier instruction").
      if (e.type === REMOTE_EVENT_TURN_END && undelivered(e) && seq !== null) {
        const opened = Array.isArray(p.open_cmd_seqs) ? p.open_cmd_seqs : [];
        const newest = !opened.length || opened[opened.length - 1] === seq;
        p.unconfirmed = [...(Array.isArray(p.unconfirmed) ? p.unconfirmed : []).filter((c) => c !== seq), seq].slice(-UNCONFIRMED_KEPT);
        const asked = { ...(p.unconfirmed_asked ?? {}), [String(seq)]: newest ? p.asked : "" };
        p.unconfirmed_asked = Object.fromEntries(Object.entries(asked).filter(([k]) => p.unconfirmed!.includes(Number(k))));
      }
      // The machine's own end of an instruction Claw could not confirm it had (`delivery_unconfirmed`): it had, and this is its end.
      if (e.type === REMOTE_EVENT_TURN_END && !undelivered(e) && seq !== null && Array.isArray(p.unconfirmed) && p.unconfirmed.includes(seq)) {
        const asked = p.unconfirmed_asked?.[String(seq)] || (p.lang === "zh" ? "之前的一条指令" : "an earlier instruction");
        p.unconfirmed = p.unconfirmed.filter((c) => c !== seq);
        if (p.unconfirmed_asked) delete p.unconfirmed_asked[String(seq)];
        if (board === "done" && p.closed_by_unconfirmed === seq) {
          p.closed_by_unconfirmed = null;
          p.closed_event_id = e.id;
          await closeAnswered(e);
        } else {
          // The item has moved on to a later instruction (open, or ended since): that one is left as it is, and this end is told with
          // its own instruction and answer.
          const stop = flat(e.data.stopReason, 40);
          const said = stopWords(stop, flat(e.data.error, 200), p.lang, flat(e.data.terminal_mode, 40));
          const whole = await answerOf(q, sessionId, e.id);
          await q(
            `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, result)
             SELECT item_id, 'answer', 'remote', generation, $2, $3::jsonb FROM claw_work_items WHERE item_id = $1`,
            [item.item_id, [said, tailOf(whole, ANSWER_EVENT_MAX)].filter(Boolean).join(" ") || null, storableJsonText({ stop_reason: stop || null, remote_event_id: e.id, cmd_seq: seq })],
          );
          // (one notice per time the item needs the user: this is another)
          if (p.origin === "assistant") await q("UPDATE claw_work_items SET attention_seq = attention_seq + 1, updated_at = NOW() WHERE item_id = $1", [item.item_id]);
          const kind: RemoteNoticeKind = FAILED_STOPS.has(stop) ? "failed" : "done";
          tell(`late:${e.id}`, kind, remoteNotice(kind, { ...p, asked }, item.seq, [said, tailLines(whole, NOTICE_ANSWER_MAX)].filter(Boolean).join(" ")
            || (p.lang === "zh" ? "已结束，没有回答文字" : "ended with no answer text")));
        }
        continue;
      }
      const reason = e.type === REMOTE_EVENT_COMMAND_REJECTED && e.data.type === "prompt" ? flat(e.data.reason, 80) : "";
      // A refusal ends its prompt only when the prompt never runs; one refused as its turn starts ends with that turn's end.
      const refusedUnrun = PROMPT_REFUSED_UNQUEUED.has(reason) || reason === PROMPT_DROPPED_BY_CANCEL;
      const named = (e.type === REMOTE_EVENT_TURN_END && Object.hasOwn(e.data, "cmd_seq")) || (refusedUnrun && seq !== null);
      if ((e.type === REMOTE_EVENT_TURN_END || refusedUnrun) && !named) p.open_cmd_seqs = null;
      if (Array.isArray(p.open_cmd_seqs) && named) {
        if (board === "done") {
          // A closed item has nothing open. One closed from outside its events (the stop button, work_stop) still lists the prompt
          // that was running; the end that turn brings (cancelled, or finished on its own as the stop was on its way) clears it. The
          // cancels pending are left as they are: the next prompt passes over those whose ends have come (`notePrompt`).
          if (e.type === REMOTE_EVENT_TURN_END) clearOpen(p);
          continue;
        }
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
      if (board === "done" && e.type !== REMOTE_EVENT_SESSION_CLOSED) {
        // Counted, the same: a turn's end that reaches a closed item leaves no turn open on it (the cancels were taken above).
        if (e.type === REMOTE_EVENT_TURN_END) clearOpen(p);
        continue;
      }
      if (e.type === REMOTE_EVENT_PERMISSION_REQUEST) {
        const actionId = flat(e.data.actionId, 128);
        if (!actionId || p.waiting.includes(actionId)) continue;
        p.waiting.push(actionId);
        const tool = flat(e.data.tool, 120);
        const what = tool || (p.lang === "zh" ? "一个操作" : "an action");
        const question = p.lang === "zh" ? `等你批准：${what}` : `Waiting for your approval: ${what}`;
        board = "needs_you";
        await write(
          "board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2, attention_seq = attention_seq + $3::int",
          [question, p.origin === "assistant" ? 1 : 0], { kind: "waiting", summary: question, question },
        );
        tell(`ask:${e.id}`, "waiting", remoteNotice("waiting", p, item.seq, what), askOf(e, actionId, what) ?? undefined);
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
        if (unfinished) tell(`closed:${e.id}`, "closed", remoteNotice("closed", p, item.seq, ""));
      }
    }
    await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1", [item.item_id, storableJsonText(p)]);
    return notices;
  });
}

type ItemWrite = (set: string, values: unknown[], ev: { kind: string; summary: string | null; question?: string | null; result?: unknown }) => Promise<void>;

/** What a terminal's item says: a request put to the user (`ask`), one line that more wait, or that a card's request ended elsewhere. */
interface TerminalSaid {
  key: string;
  text: string;
  ask?: AssistantRemoteAsk;
  resolved?: { action_id: string; by: string };
  /** The request it is about, so a request answered in the same pass is never put to the user. */
  actionId?: string;
  /** A turn's end told: finished, or ended in an error. */
  end?: "done" | "error";
  /** That end, as a channel's card shows it. */
  endCard?: AssistantTerminalEnd;
}

/** Who ended a request when the person did not answer it on the phone: their terminal, or nobody (it stopped waiting). */
const ENDED_ELSEWHERE = new Set(["terminal", "timeout", "session_end", "connector_restart"]);
/** How many requests put to the user as cards a terminal's item remembers, to say their end. */
const CARDED_KEPT = 50;

/**
 * A terminal's item (`origin: "terminal"`) takes its session's events: a request puts it in front of the user (needs_you) and is put to
 * them with its options, so a channel shows them as buttons; an answer, from the phone or at the terminal, takes it back, and the item
 * is done once nothing waits; a closed session closes it. A request answered at the terminal (or that stopped waiting) after its card
 * went out is said as `resolved`, so the channel marks that card; one answered before its card went out (the same pass) is never put to
 * the user. More than {@link TERMINAL_ASKS_PER_MINUTE} requests of one conversation in a minute are not put one by one: once a minute
 * one message says how many wait. With the owner's approvals off (`/approvals off`) nothing new is put to them. `p` is changed in place
 * (the caller writes it).
 */
async function applyTerminal(
  events: MovingEvent[], p: RemoteParams, board: string, write: ItemWrite, enabled: boolean, seq: number, attach: string | null = null,
  now: number = Date.now(),
): Promise<TerminalSaid[]> {
  const zh = p.lang === "zh";
  const said: TerminalSaid[] = [];
  const carded = new Set(Array.isArray(p.carded) ? p.carded : []);
  const ended = (actionId: string, by: string) => {
    const pending = said.findIndex((n) => n.actionId === actionId);
    if (pending >= 0) { said.splice(pending, 1); return; } // its card never went out: nothing to mark
    if (!carded.delete(actionId) || !ENDED_ELSEWHERE.has(by)) return;
    const text = by === "terminal"
      ? (zh ? "（这个请求已在终端里回答）" : "(that request was answered in the terminal)")
      : (zh ? "（这个请求不再等待回答）" : "(that request is no longer waiting)");
    said.push({ key: `resolved:${actionId}`, text, resolved: { action_id: actionId, by } });
  };
  for (const e of events) {
    p.last_event_id = e.id;
    if (e.type === REMOTE_EVENT_PERMISSION_REQUEST) {
      const actionId = flat(e.data.actionId, 128);
      if (!actionId || p.waiting.includes(actionId)) continue;
      p.waiting.push(actionId);
      const what = flat(e.data.tool, 120) || (zh ? "一个操作" : "an action");
      const question = zh ? `等你回答：${what}` : `Waiting for your answer: ${what}`;
      const reopen = board === "done";
      board = "needs_you";
      await write(
        `board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2, attention_seq = attention_seq + 1,
         outcome = NULL, closed_at = NULL${reopen ? ", generation = generation + 1" : ""}`,
        [question], { kind: "waiting", summary: question, question },
      );
      if (!enabled) continue;
      const recent = (Array.isArray(p.asked_at) ? p.asked_at : []).filter((t) => Number.isFinite(t) && now - t < MINUTE_MS);
      const ask = askOf(e, actionId, what);
      if (ask) {
        // Where it asks: the conversation's name, and the folder the request names (the session's own when it names none).
        const title = flat(p.title, 80);
        const cwd = flat(e.data.cwd, 300) || flat(p.cwd, 300);
        if (title) ask.title = title;
        if (cwd) ask.cwd = cwd;
      }
      if (recent.length < TERMINAL_ASKS_PER_MINUTE) {
        p.asked_at = [...recent, now];
        // Nothing that can be answered from a card (no option, or none that may be chosen without seeing all of it): said, to the terminal.
        const asks = terminalAsksOf(e.data.terminal_asks);
        said.push(ask
          ? { key: `ask:${e.id}`, text: terminalAskNotice(p, what, true, asks), ask, actionId }
          : { key: `ask:${e.id}`, text: terminalAskNotice(p, what, false, asks), actionId });
      } else {
        p.asked_at = recent;
        if (!(Number(p.summarized_at) > now - MINUTE_MS)) {
          p.summarized_at = now;
          said.push({ key: `busy:${e.id}`, text: terminalBusyNotice(p, p.waiting.length) });
        }
      }
    } else if (e.type === REMOTE_EVENT_PERMISSION_RESOLVED) {
      const actionId = flat(e.data.actionId, 128);
      if (!p.waiting.includes(actionId)) continue;
      p.waiting = p.waiting.filter((a) => a !== actionId);
      // The connector says who answered: the terminal, the phone, or nobody (it timed out, the conversation or the connector ended).
      const by = flat(e.data.by, 64);
      ended(actionId, by);
      if (p.waiting.length || board === "done") continue;
      board = "done";
      const summary = by === "terminal" ? (zh ? "已在终端里回答" : "answered in the terminal")
        : ["timeout", "session_end", "connector_restart"].includes(by) ? (zh ? "不再等待" : "no longer waiting")
          : (zh ? "已回答" : "answered");
      await write(
        `board_state = 'done', outcome = 'answered', last_report_kind = 'answer', summary = $2, pending_question = NULL, closed_at = NOW()`,
        [summary], { kind: "answer", summary, result: { by: by || null, remote_event_id: e.id } },
      );
    } else if (e.type === REMOTE_EVENT_TERMINAL_TURN_END) {
      // A turn ended while nobody was at that terminal (its connector waited a minute without input to say so). The item is done
      // with it, and the user is told once (at most every TERMINAL_END_GAP_MS for one conversation), unless pushes are off or muted.
      const failed = e.data.outcome === "error";
      const error = failed ? flat(e.data.error, 40) || "unknown" : "";
      const message = typeof e.data.message === "string" ? e.data.message : "";
      const told = terminalEndSummary(message);
      const summary = [
        failed ? (zh ? `出错停下了（${error}）` : `stopped with an error (${error})`) : (zh ? "已完成" : "finished"),
        clipOneLine(told.summary.replace(/\s+/g, " "), 80),
      ].filter(Boolean).join(" ");
      board = "done";
      p.waiting = [];
      await write(
        `board_state = 'done', outcome = 'answered', last_report_kind = 'answer', summary = $2, pending_question = NULL,
         closed_at = NOW(), attention_seq = attention_seq + 1`,
        [summary], { kind: "answer", summary, result: { outcome: failed ? "error" : "done", error: error || null, remote_event_id: e.id } },
      );
      if (!enabled) continue;
      // Pushed at once only when the person has a reason to hear it now: they started the turn (or the connector is too old to
      // say who did), it asks them something, or it failed. An end of a turn another session or a schedule started, and an end
      // held back by the gap, are gathered for the conversation's next summary instead (terminal-digest.ts): never lost, never
      // said twice.
      const origin = e.data.origin === "automation" ? "automation" : e.data.origin === "person" ? "person" : null;
      const asks = !failed && asksPerson(message);
      const turns = Number.isSafeInteger(e.data.turns) && Number(e.data.turns) > 1 ? Math.min(Number(e.data.turns), 10_000) : 1;
      const earlier = Array.isArray(e.data.earlier)
        ? e.data.earlier.filter((x): x is string => typeof x === "string").slice(-EARLIER_KEPT).map((x) => terminalEndSummary(x.slice(-END_FULL_MAX)).summary)
        : [];
      const failedEarlier = Number.isSafeInteger(e.data.failed_earlier) && Number(e.data.failed_earlier) > 0
        ? Math.min(Number(e.data.failed_earlier), turns - 1) : 0;
      const gathered = { turns, failed: (failed ? 1 : 0) + failedEarlier, asks, said: [...earlier, told.summary] };
      if (origin === "automation" && !asks && !failed && !failedEarlier) { gather(p, now, gathered); continue; }
      if (Number(p.end_told_at) > now - TERMINAL_END_GAP_MS) { gather(p, now, gathered); continue; }
      p.end_told_at = now;
      // Told now: the newest end. The earlier turns folded into it (none of them told) go to the summary, so none is lost.
      if (turns > 1) gather(p, now, { turns: turns - 1, failed: failedEarlier, asks: false, said: earlier });
      said.push({
        key: `end:${e.id}`, text: terminalEndNotice(p, seq, failed, error, told, attach), end: failed ? "error" : "done",
        endCard: {
          item_seq: seq, name: terminalEndName(p), folder: cwdTail(String(p.cwd ?? "")), ...(failed ? { error } : {}),
          summary: told.summary, full: tailLines(message, END_FULL_MAX), more: told.more, ...(attach ? { attach } : {}),
        },
      });
    } else if (e.type === REMOTE_EVENT_SESSION_CLOSED) {
      const unanswered = p.waiting.length > 0;
      for (const a of p.waiting) ended(a, "session_end");
      p.waiting = [];
      if (board === "done") continue;
      board = "done";
      const summary = zh ? "终端会话已结束" : "the terminal conversation ended";
      await write(
        `board_state = 'done', outcome = $2, last_report_kind = 'dropped', summary = $3, pending_question = NULL, closed_at = NOW()`,
        [unanswered ? "dropped" : "answered", summary], { kind: "dropped", summary },
      );
    }
  }
  for (const n of said) if (n.ask && n.actionId) carded.add(n.actionId);
  p.carded = [...carded].slice(-CARDED_KEPT);
  return said;
}

/**
 * What the router's item list says of a remote item beside its row: where it runs, and whether that machine is online now. `removed`:
 * its machine is no longer one of the user's (no connector of theirs that is not revoked has its name), so it names none (`machine` is
 * empty and `title` is the item's without it): the machines the user has are what `devenv_list` reads, and a name from anywhere else
 * was said as one of them.
 */
export interface RemoteManifest {
  machine: string; agent: string; session: string; online: boolean; removed?: true; title?: string;
  /** A task handed to a seat: which (its alias when the user confirmed one), why it waits if it does, and its latest step (untrusted). */
  errand?: { seat_id: string; alias: string | null; waiting?: ErrandQueue; progress?: { current: string; done: number; total: number } };
}

/** The remote items among `items`, by item id, with whether their machine is online now, or removed. */
export async function remoteManifest(
  userId: string, items: ReadonlyArray<{ item_id: string; kind: string; params: unknown }>, onlineWindowMs: number,
): Promise<Map<string, RemoteManifest>> {
  const out = new Map<string, RemoteManifest>();
  const remote = items.filter((i) => i.kind === "remote");
  if (!remote.length || !CLAW_REMOTE_AGENTS_ENABLED) return out;
  // The user's machines now: their connectors that are not revoked, each with whether it is online, by id and by name (a machine set
  // up again under its name is a new row: the items of the old one are still those of a machine of theirs).
  const rows = (await db.query(
    `SELECT c.connector_id::text AS connector_id, c.name, ${onlineSql(2)} AS online FROM claw_remote_connectors c
      WHERE c.owner_user_id = $1 AND c.revoked_at IS NULL`,
    [userId, onlineWindowMs / 1000],
  )).rows as Array<{ connector_id: string; name: string; online: boolean }>;
  const byId = new Map(rows.map((r) => [r.connector_id, r.online === true]));
  const byName = new Map<string, boolean>();
  for (const r of rows) {
    const name = flat(r.name, 60);
    byName.set(name, (byName.get(name) ?? false) || r.online === true);
  }
  for (const i of remote) {
    const p = (i.params ?? {}) as Partial<RemoteParams>;
    const e = p as Partial<ErrandParams>;
    const errand = e.errand === true ? {
      seat_id: String(e.seat_id ?? ""), alias: typeof e.alias === "string" ? e.alias : null,
      ...(e.queued ? { waiting: e.queued } : {}),
      ...(e.progress && e.progress.current ? { progress: { current: e.progress.current, done: Number(e.progress.done) || 0, total: Number(e.progress.total) || 0 } } : {}),
    } : undefined;
    // A task still waiting for its card names no machine yet.
    if (errand && !p.connector_id) {
      out.set(i.item_id, { machine: "", agent: String(p.agent_id ?? ""), session: "", online: false, errand });
      continue;
    }
    const connectorId = String(p.connector_id ?? "");
    const machine = String(p.machine ?? "");
    const online = byId.has(connectorId) ? byId.get(connectorId) : machine && byName.has(machine) ? byName.get(machine) : undefined;
    if (online === undefined) {
      out.set(i.item_id, {
        machine: "", agent: String(p.agent_id ?? ""), session: String(p.session_id ?? ""), online: false, removed: true,
        ...(errand ? { errand } : { title: remoteTitleWithoutMachine(p) }),
      });
      continue;
    }
    out.set(i.item_id, { machine, agent: String(p.agent_id ?? ""), session: String(p.session_id ?? ""), online: online === true, ...(errand ? { errand } : {}) });
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
  const errand = (params as Partial<ErrandParams> | null)?.errand === true ? params as Partial<ErrandParams> : null;
  if (errand) {
    await cancelErrand(userId, errand);
    return;
  }
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

// --- Tasks handed to a seat (errands) ---------------------------------------------------------------------------------------

/**
 * A task the assistant handed to one of the user's seats (`seat-dispatch.ts`): a remote item of its own (`params.errand`), one per task,
 * its `worker_session_id` `errand:<item id>` (no Claw session). It runs in a session of the seat's, as prompts sent as
 * {@link ERRAND_CLIENT}; which of that session's events are its own is read by the prompt they name (`cmd_seq` in `open_cmd_seqs`), and
 * the session's own item (`remote:<session>`) never takes them, nor the other way round.
 *
 * Its end is a report (`ingestReport`, source `remote`): a turn that finished closes it with the end of the agent's answer and wakes the
 * router to say it (no `done` notice of its own); one that failed, a refusal, a session that closed, or an approval nobody answered in
 * time, fails it, said as an `error` notice too. A permission request is a `needs_you` notice with its buttons; a parked one is said once
 * more (`ask.parked`). A task that has run an hour is said in one line each hour, with its latest step.
 */
export const ERRAND_CLIENT = "assistant_seat";
export const errandWorkerSessionId = (itemId: string): string => `errand:${itemId}`;
/** Why a task waits rather than runs: its card, or its seat (busy, used in a terminal, or its machine offline). */
export type ErrandQueue = "card" | "seat_busy" | "in_terminal" | "machine_offline";
export const SEAT_QUEUE_REASONS: readonly ErrandQueue[] = ["seat_busy", "in_terminal", "machine_offline"];

export interface ErrandParams extends RemoteParams {
  errand: true;
  /** The seat it is for; "" while a choice card waits. */
  seat_id: string;
  /** The seat's name as the user confirmed it, when it has one. */
  alias?: string | null;
  /** What the router wrote for the seat's agent (sent behind the fixed opening, `errandText`). */
  brief: string;
  queued?: ErrandQueue;
  queued_at?: string;
  /** A task waiting for its machine to come back: when it fails instead (24 hours). */
  queue_expires_at?: string;
  confirmation_id?: string;
  /** A choice card's options: seat ids, or `sandbox`. */
  choices?: string[];
  /** In a new session in the seat's folder, even when its conversation is open in a terminal. */
  new_session?: true;
  dispatched_at?: string;
  /** When `work_send` (or a card pressed) last opened it again: a reopening not yet sent is under way for a while after (`reopenErrand`). */
  reopened_at?: string;
  /** The latest step of the agent's plan (untrusted, one line, cut), and how far along the plan is. */
  progress?: { current: string; done: number; total: number; at: string };
  progress_told_at?: string;
  /** The hours of running already said (one line per hour). */
  progress_told_h?: number;
  offline_told?: true;
  /** The seat's agent runs in a mode that asks nothing (`unattended`). */
  unattended?: true;
  /**
   * How the user let it through: `auto`, without a card (the seat took tasks directly then), or `card`, pressing one for it, which said
   * whether its agent runs unattended (`approved_unattended`). Checked again when it leaves the queue (`seat-dispatch.ts`).
   */
  approved?: "auto" | "card";
  approved_unattended?: boolean;
  /** The last turn its agent took by itself that was read here (said as a late word of this task, or of another of its session), as kept before `agent_turn_seen_in`: read only, dropped once that is written. */
  agent_turn_seen?: number;
  /** The same by session: how far it read the agent's own turns of each session it was on (`applyAgentTurns`). */
  agent_turn_seen_in?: Record<string, number>;
  /** An end recorded and not yet reported (`ingestReport` runs after the commit; the sweep retries what it missed). */
  report_due?: { kind: "answer" | "failed"; summary: string; generation: number };
  /** The instructions `work_send` let through to it in one router turn (`task`), by their words' key (`seat-dispatch.ts`). */
  turn_sends?: { task: string; keys: string[] };
}

/** How much of the agent's answer an errand's report carries (its end). */
const ERRAND_ANSWER_MAX = 4000;
/** A plan step as an errand keeps it. */
const STEP_MAX = 80;
/** Errand asks put to the user one by one in a minute, across all their seats; past that one line says how many wait. */
export const ERRAND_ASKS_PER_MINUTE = 5;
/** The events an errand reads. */
const ERRAND_EVENTS = [...MOVING, REMOTE_EVENT_PERMISSION_PARKED, "plan"];

/** The fixed opening of every task sent to a seat, in the user's language, then the brief. */
export function errandText(seq: number, brief: string, lang: RemoteLang): string {
  return lang === "zh"
    ? `（你的助手 代你交代的任务，事项 #${seq}。完成时用一段话总结：结果、改了什么、还剩什么。）\n\n${brief}`
    : `(A task your assistant hands over for you, item #${seq}. When you finish, sum up in one paragraph: the result, what you changed, what is left.)\n\n${brief}`;
}

/** Who a seat's task is with, as the user knows it: the alias they confirmed, else machine/agent. */
export const errandWho = (p: Partial<ErrandParams>): string =>
  (typeof p.alias === "string" && p.alias) || `${String(p.machine ?? "") || "?"}/${String(p.agent_id ?? "")}`;

export type ErrandNoticeKind = "needs_you" | "parked" | "failed" | "progress" | "offline" | "asks_waiting";

/** What a seat's task says to the user, in their language. Words of the agent's (`detail`) are quoted text. */
export function errandNotice(kind: ErrandNoticeKind, p: Partial<ErrandParams>, seq: number, detail = "", extra: { hours?: number; waiting?: number } = {}): string {
  const zh = p.lang === "zh";
  const who = errandWho(p);
  switch (kind) {
    case "needs_you":
      return zh ? `#${seq} ${who} 在等你批准：${detail}。在下面选，或发 /agent attach ${p.session_id} 切过去处理。`
        : `#${seq} ${who} is waiting for your approval: ${detail}. Choose below, or send /agent attach ${p.session_id} to answer it there.`;
    case "parked":
      return zh ? `#${seq} ${who} 还在等你批准：${detail}。它会一直等你回答（最多 24 小时）。`
        : `#${seq} ${who} is still waiting for your approval: ${detail}. It keeps waiting for your answer (24 hours at most).`;
    case "failed":
      return zh ? `#${seq} ${who} 没有做完：${detail}。回复“继续”重发，或说“改交沙箱”。`
        : `#${seq} ${who} did not finish: ${detail}. Reply "continue" to send it again, or "use the sandbox instead".`;
    case "progress": {
      const h = extra.hours ?? 1;
      const step = p.progress?.current ? `${zh ? "：" : ": "}“${p.progress.current}”${p.progress.total ? (zh ? `（${p.progress.done}/${p.progress.total}）` : ` (${p.progress.done}/${p.progress.total})`) : ""}`
        : detail ? `${zh ? "：" : ": "}“${detail}”` : "";
      return zh ? `#${seq} ${who} 已进行 ${h} 小时${step}` : `#${seq} ${who} has been at it for ${h} hour${h === 1 ? "" : "s"}${step}`;
    }
    case "offline":
      return zh ? `#${seq} ${who} 所在的机器离线超过 1 小时了，上线后会接着做。` : `#${seq}: the machine of ${who} has been offline for over an hour; it goes on when the machine is back.`;
    case "asks_waiting":
      return zh ? `还有 ${extra.waiting ?? 0} 个交给工位的事项在等你批准，见事项列表。` : `${extra.waiting ?? 0} more seat tasks are waiting for your approval; see your items.`;
  }
}

/**
 * A `turn_end` of a turn the agent took by itself (connector 0.3.3 and later, session.ts `agentTurn`): the agent answering a command
 * it put in the background, once that finished. It names no prompt (`cmd_seq: null`) and ends none.
 */
const agentInitiated = (e: MovingEvent): boolean => e.type === REMOTE_EVENT_TURN_END && e.data.agent_initiated === true;

/**
 * How far a session's turns of the agent's own were read (`$1` the session, `$2` the owner): the furthest any seat task noted for it
 * (`agent_turn_seen_in`), or, from before that was kept by session, the furthest a task still on it noted (`agent_turn_seen`).
 */
const AGENT_TURN_SEEN_SQL = `SELECT COALESCE(MAX(GREATEST(COALESCE((w.params->'agent_turn_seen_in'->>$1::text)::bigint, 0),
      CASE WHEN w.params->>'session_id' = $1::text THEN COALESCE((w.params->>'agent_turn_seen')::bigint, 0) ELSE 0 END)), 0)
    FROM claw_work_items w
   WHERE w.user_id = $2 AND w.kind = 'remote' AND w.params->>'errand' = 'true'
     AND (w.params->>'session_id' = $1::text OR w.params->'agent_turn_seen_in' ? $1::text)`;

/**
 * The ends of the turns the agent took by itself on session `$1` (owner `$2`) not yet read, oldest first, at most `$5`, each with the
 * `cmd_id` of the prompt whose turn ended last before it (`$3` `turn_end`, `$4` `user_prompt`). Only those after a seat task's prompt:
 * one after anyone else's says nothing here, so it is never what a pass is spent on.
 */
const AGENT_TURN_ENDS_SQL = `SELECT x.id, x.cmd_id FROM (
    SELECT e.id,
           (SELECT u.data->>'cmd_id' FROM claw_remote_events t
              JOIN claw_remote_events u ON u.session_id = t.session_id AND u.type = $4 AND u.data->>'cmd_seq' = t.data->>'cmd_seq'
             WHERE t.session_id = e.session_id AND t.type = $3 AND t.id < e.id AND jsonb_typeof(t.data->'cmd_seq') = 'number'
             ORDER BY t.id DESC LIMIT 1) AS cmd_id
      FROM claw_remote_events e
     WHERE e.session_id = $1::uuid AND e.type = $3 AND e.data->>'agent_initiated' = 'true' AND COALESCE(e.data->>'replay', '') <> 'true'
       AND e.id > (${AGENT_TURN_SEEN_SQL})
  ) x
  WHERE x.cmd_id LIKE 'k:errand:%'
  ORDER BY x.id LIMIT $5`;

/** How many of a session's turns the agent took by itself one pass reads, and how much of each one's answer a message says. */
const AGENT_TURNS_PER_PASS = 20;
const AGENT_TURN_ANSWER_MAX = 1500;

/**
 * The turns the seat's agent took by itself after a task's turn ended (a command it put in the background finished, and it answered
 * that): each one's answer is said once, as a late word of the task whose turn ended last before it (the prompt that turn's end names,
 * `cmd_id` `k:errand:<item>:…`), and kept on that item, whatever that task is doing now (opened again and waiting for the seat,
 * which that very turn keeps busy, or sent to a new session). A turn with no answer text, or one after a prompt that was no task's,
 * says nothing. Read from the session's events after the last one any task read of it (`agent_turn_seen_in`).
 */
async function applyAgentTurns(owner: string, sessionId: string): Promise<Notice[]> {
  // Most posts bring none: looked at without a lock first.
  const any = (await db.query(
    `SELECT 1 FROM (${AGENT_TURN_ENDS_SQL}) x LIMIT 1`,
    [sessionId, owner, REMOTE_EVENT_TURN_END, REMOTE_EVENT_USER_PROMPT, 1],
  )).rows.length > 0;
  if (!any) return [];
  return inTransaction(async (q) => {
    // One pass a session at a time (the tasks that keep its cursor can all have moved on to other sessions).
    await q("SELECT pg_advisory_xact_lock(hashtext('claw_errand_agent_turns'), hashtext($1))", [sessionId]);
    const items = (await q(
      `SELECT w.item_id, w.seq, w.board_state, w.params, a.session_id AS router_sid
         FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
        WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND w.params->>'session_id' = $2
        ORDER BY w.seq FOR UPDATE OF w`,
      [owner, sessionId],
    )).rows as Array<{ item_id: string; seq: number; board_state: string; params: ErrandParams; router_sid: string }>;
    const ends = (await q(AGENT_TURN_ENDS_SQL, [sessionId, owner, REMOTE_EVENT_TURN_END, REMOTE_EVENT_USER_PROMPT, AGENT_TURNS_PER_PASS]))
      .rows as Array<{ id: string; cmd_id: string | null }>;
    if (!ends.length) return [];
    // A task named by a turn's prompt that is not among them now (moved to a new session of its own since): read by its id, so the
    // turn is still said as its word and is never passed over unsaid. Only one that no longer exists is.
    const named = (end: { cmd_id: string | null }) => /^k:errand:([^:]+):/.exec(String(end.cmd_id ?? ""))?.[1];
    const elsewhere = [...new Set(ends.map(named).filter((id): id is string => !!id && !items.some((i) => i.item_id === id)))];
    if (elsewhere.length) {
      items.push(...(await q(
        `SELECT w.item_id, w.seq, w.board_state, w.params, a.session_id AS router_sid
           FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
          WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND w.item_id::text = ANY($2::text[])
          ORDER BY w.seq FOR UPDATE OF w`,
        [owner, elsewhere],
      )).rows as typeof items);
    }
    const notices: Notice[] = [];
    // How far the session's turns of the agent's own were read: kept on the task sent there last (when one still is there).
    const latest = items.filter((i) => i.params.session_id === sessionId)
      .sort((a, b) => String(a.params.dispatched_at ?? "").localeCompare(String(b.params.dispatched_at ?? "")) || a.seq - b.seq).at(-1);
    const touched = new Map<string, number>(latest ? [[latest.item_id, Number(ends.at(-1)!.id)]] : []);
    for (const end of ends) {
      const id = Number(end.id);
      // Whose it is: the task the prompt of the last turn that ended before it was sent for. One that follows anyone else's prompt (one
      // typed into a chat attached to the session) is not a task's, and is not said here: that chat shows it.
      const item = items.find((i) => i.item_id === named(end));
      if (!item) continue;
      touched.set(item.item_id, Math.max(touched.get(item.item_id) ?? 0, id));
      // Read before (a cursor kept as before `agent_turn_seen_in`, on a task that has moved on since): not said or kept again.
      if ((await q(
        "SELECT 1 FROM claw_work_item_events WHERE item_id = $1 AND kind = 'answer' AND result->>'agent_initiated' = 'true' AND result->>'remote_event_id' = $2 LIMIT 1",
        [item.item_id, String(id)],
      )).rows.length) continue;
      const whole = await answerOf(q, sessionId, id);
      const answer = tailLines(whole, AGENT_TURN_ANSWER_MAX);
      if (!answer) continue;
      const p = item.params;
      const zh = p.lang === "zh";
      await q(
        `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, result)
         SELECT item_id, 'answer', 'remote', generation, $2, $3::jsonb FROM claw_work_items WHERE item_id = $1`,
        [item.item_id, tailOf(whole, ANSWER_EVENT_MAX), storableJsonText({ agent_initiated: true, remote_event_id: id })],
      );
      // A task that is over keeps the last thing its agent said of it, so the item list answers "did it finish?".
      if (item.board_state === "done") {
        await q("UPDATE claw_work_items SET summary = $2, updated_at = NOW() WHERE item_id = $1", [item.item_id, tailOf(whole, SUMMARY_MAX)]);
      }
      const seat = p.seat_id ? { seat_id: p.seat_id, alias: typeof p.alias === "string" ? p.alias : null } : undefined;
      notices.push({
        userId: owner, routerSid: item.router_sid, itemId: undefined, key: `remote:${item.item_id}:agent-turn:${id}`,
        text: zh ? `#${item.seq} ${errandWho(p)} 在后台的工作结束后又回复了：\n${answer}` : `#${item.seq} ${errandWho(p)} followed up once its background work finished:\n${answer}`,
        remote: { kind: "done", session_id: sessionId, machine: p.machine, agent: p.agent_id, item_seq: Number(item.seq), ...(seat ? { seat } : {}) },
      });
    }
    // Each task that read them keeps how far, by session (`agent_turn_seen_in`): one moved to another session since still holds this one's.
    for (const [itemId, id] of touched) {
      await q(
        `UPDATE claw_work_items
            SET params = (params - 'agent_turn_seen')
                  || jsonb_build_object('agent_turn_seen_in', COALESCE(params->'agent_turn_seen_in', '{}'::jsonb) || jsonb_build_object($3::text, $2::bigint))
          WHERE item_id = $1`,
        [itemId, id, sessionId],
      );
    }
    return notices;
  });
}

/** The seq numbers of the prompts sent to this session as seat tasks (from their `user_prompt` events): never the session item's. */
async function errandSeqsOf(q: Querier, sessionId: string): Promise<Set<number>> {
  const rows = (await q(
    `SELECT (data->>'cmd_seq')::bigint AS seq FROM claw_remote_events
      WHERE session_id = $1 AND type = $2 AND data->>'client' = $3 AND data ? 'cmd_seq'`,
    [sessionId, REMOTE_EVENT_USER_PROMPT, ERRAND_CLIENT],
  )).rows as Array<{ seq: string }>;
  return new Set(rows.map((r) => Number(r.seq)));
}

/** Whether the session has a seat task running now (a prompt of it open). */
async function errandRunningOn(q: Querier, owner: string, sessionId: string): Promise<boolean> {
  return (await q(
    `SELECT 1 FROM claw_work_items WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND params->>'session_id' = $2
        AND board_state <> 'done' AND jsonb_array_length(COALESCE(params->'open_cmd_seqs', '[]'::jsonb)) > 0 LIMIT 1`,
    [owner, sessionId],
  )).rows.length > 0;
}

/**
 * Whether a session event that names no prompt is one of a seat task's: only when its connector does not name prompts at all (no
 * `cmd_seq` key: an older connector) and a task runs there. One that says it names none (`cmd_seq: null`, such as the end a cancel
 * brings when nothing was running) is never a task's.
 */
const unnamedIsErrands = (e: MovingEvent, running: boolean): boolean => running && !Object.hasOwn(e.data, "cmd_seq");

/**
 * Whether a session event belongs to a seat task, so the session's own item passes over it: a turn's end, a refusal or a permission
 * event naming a task's prompt, or naming none from a connector that names no prompts while a task runs there.
 */
function errandOwns(e: MovingEvent, seqs: ReadonlySet<number>, running: boolean): boolean {
  const seq = Number.isSafeInteger(e.data.cmd_seq) ? Number(e.data.cmd_seq) : null;
  const moving = e.type === REMOTE_EVENT_TURN_END || e.type === REMOTE_EVENT_COMMAND_REJECTED || e.type === REMOTE_EVENT_PERMISSION_REQUEST
    || e.type === REMOTE_EVENT_PERMISSION_RESOLVED || e.type === REMOTE_EVENT_PERMISSION_PARKED;
  if (!moving) return false;
  return seq !== null ? seqs.has(seq) : unnamedIsErrands(e, running);
}

export interface NoteErrandPrompt {
  owner: string; itemId: string; sessionId: string; connectorId: string; agentId: string; machine: string; cmdSeq: number; since?: number;
}

/**
 * A seat task's prompt was queued: the item is running in that session, the prompt one of its own. One more instruction that reached it
 * just after its turn ended is a new turn of it: the end still to be reported is reported in the same transaction, and an item that end
 * closed is opened again (a new generation), so neither answer is lost.
 */
export async function noteErrandPrompt(p: NoteErrandPrompt): Promise<void> {
  const reports = await import("./reports.js");
  const woke = await inTransaction(async (q) => {
    const row = (await q(
      "SELECT board_state, outcome, params FROM claw_work_items WHERE item_id = $1 AND user_id = $2 AND kind = 'remote' FOR UPDATE", [p.itemId, p.owner],
    )).rows[0] as { board_state: string; outcome: string | null; params: ErrandParams } | undefined;
    if (!row) return null;
    // An end recorded and not yet reported is reported here, in this transaction, before the item is opened again for this prompt: its
    // answer reaches the router, and the report made of it elsewhere afterwards finds the item moved on (a new generation) and does nothing.
    // As `ingestReport` does it: a long answer stored to be said whole, the router woken, and, when it cannot be, the system says it.
    let wake: { sessionId: string; userId: string } | null = null;
    let whole: { announce: () => Promise<void> } | null = null;
    // An end the router cannot be woken to say and that nothing here could store (the user's assistant session was deleted: no session
    // to store it in): said after the commit, in a session made again for it. A seat task is never swept for later, so it is said now.
    let untold: { kind: "answer" | "failed"; summary: string; generation: number } | null = null;
    const due = row.params.report_due;
    if (due) {
      const applied = await applyWorkerReport({ query: q }, {
        itemId: p.itemId, generation: Number(due.generation), workerSessionId: errandWorkerSessionId(p.itemId), source: "remote", runId: null,
        report: { kind: due.kind, summary: String(due.summary) },
      });
      if (applied.applied) {
        whole = reports.answerSentWhole(due.kind, String(due.summary)) ? await storeAnswerWhole(q, p.itemId, reports.reportPorts.sayDeps) : null;
      }
      if (applied.applied && applied.wake) {
        const queued = await reports.queueRouterWake({ query: q }, {
          itemId: p.itemId, userId: applied.userId, eventId: applied.eventId, kind: due.kind, version: applied.resultVersion,
          summary: String(due.summary), question: null, sentInFull: whole !== null,
        });
        if (queued.status === "queued") wake = { sessionId: queued.sessionId, userId: queued.userId };
        // The router cannot be woken to say it: the system says the answer itself, stored now, while the item still stands answered.
        else if (queued.status === "refused" && !whole) whole = await storeAnswerWhole(q, p.itemId, reports.reportPorts.sayDeps);
        // (A failure is also said by its own error notice, in the session it was recorded for: said again only when that one is gone.)
        if (queued.status === "refused" && !whole && !(await itemSession(q, p.itemId))?.sessionId) {
          untold = { kind: due.kind, summary: String(due.summary), generation: Number(due.generation) };
        }
      }
      row.board_state = applied.applied ? applied.boardState : row.board_state;
      if (applied.applied && due.kind === "answer") row.outcome = "answered";
    }
    if ((row.board_state === "done" && row.outcome === "answered") || due) {
      await q(
        `UPDATE claw_work_items SET board_state = 'in_progress', outcome = NULL, closed_at = NULL, last_report_kind = 'progress', summary = '',
                generation = generation + 1, params = params - 'report_due', updated_at = NOW()
          WHERE item_id = $1`,
        [p.itemId],
      );
    }
    const was = row.params;
    const same = was.session_id === p.sessionId && Array.isArray(was.open_cmd_seqs) && was.open_cmd_seqs.length > 0;
    const since = p.since !== undefined ? Math.max(0, Number(p.since) || 0) : Number((await q(
      "SELECT COALESCE(MAX(id), 0) AS id FROM claw_remote_events WHERE session_id = $1", [p.sessionId],
    )).rows[0].id);
    const patch = {
      session_id: p.sessionId, connector_id: p.connectorId, agent_id: p.agentId, machine: p.machine,
      open_cmd_seqs: same ? [...was.open_cmd_seqs!, p.cmdSeq] : [p.cmdSeq], open_turns: same ? (Number(was.open_turns) || 0) + 1 : 1,
      ...(same ? {} : { last_event_id: since, waiting: [], dispatched_at: new Date().toISOString() }),
    };
    await q(
      `UPDATE claw_work_items SET params = (params - 'queued' - 'queued_at' - 'queue_expires_at' - 'progress_told_at' - 'progress_told_h' - 'offline_told') || $2::jsonb,
              board_state = CASE WHEN board_state = 'needs_you' AND last_report_kind = 'waiting' THEN board_state ELSE 'in_progress' END,
              updated_at = NOW()
        WHERE item_id = $1`,
      [p.itemId, storableJsonText(patch)],
    );
    await q(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
       SELECT item_id, 'progress', 'remote', generation, $2 FROM claw_work_items WHERE item_id = $1`,
      [p.itemId, p.machine],
    );
    return { wake, whole, untold };
  });
  if (!woke) return;
  if (woke.whole) await woke.whole.announce().catch((err) => logger.warn({ err, itemId: p.itemId }, "assistant.errand_answer_not_announced"));
  if (woke.untold) await tellUntold(p.owner, p.itemId, woke.untold).catch((err) => logger.warn({ err, itemId: p.itemId }, "assistant.errand_end_not_told"));
  if (woke.wake) {
    const { drainSessionIfIdle } = await import("./messages.js");
    await drainSessionIfIdle(woke.wake.sessionId, woke.wake.userId).catch((err) => logger.warn({ err, itemId: p.itemId }, "assistant.errand_wake_failed"));
  }
}

/**
 * A seat task's end that its router could not be woken to say, and that had no session to be stored in, said by the system in the
 * user's assistant session (made again when they deleted it, as `recordNeedsYouFallback` does). Once per end (its key).
 */
async function tellUntold(owner: string, itemId: string, end: { kind: "answer" | "failed"; summary: string; generation: number }): Promise<void> {
  await ensureLiveAssistant(itemId);
  const row = (await db.query(
    `SELECT w.seq, w.title, w.params->>'lang' AS lang, a.session_id
       FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
      WHERE w.item_id = $1 AND w.user_id = $2`,
    [itemId, owner],
  )).rows[0] as { seq: number; title: string; lang: string | null; session_id: string | null } | undefined;
  if (!row?.session_id) return;
  const zh = row.lang === "zh";
  const text = end.kind === "answer"
    ? (zh ? `#${row.seq} ${row.title}：${end.summary}` : `#${row.seq} "${row.title}": ${end.summary}`)
    : (zh ? `#${row.seq} ${row.title} 没有完成：${end.summary}` : `#${row.seq} "${row.title}" did not finish: ${end.summary}`);
  await recordSystemNotice({ userId: owner, sessionId: row.session_id, text, key: `errand-untold:${itemId}:${end.generation}`, itemId });
}

interface ErrandPass { notices: Notice[]; reports: Array<{ itemId: string; generation: number; kind: "answer" | "failed"; summary: string }> }

/** The open seat tasks running in this session take the events they have not applied (`last_event_id`), each in its own order. */
async function applyErrands(owner: string, sessionId: string): Promise<ErrandPass | null> {
  return inTransaction(async (q) => {
    const items = (await q(
      `SELECT w.item_id, w.seq, w.generation, w.board_state, w.last_report_kind, w.params, a.session_id AS router_sid
         FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
        WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND w.params->>'session_id' = $2
          AND w.board_state <> 'done' AND w.params ? 'dispatched_at' AND NOT (w.params ? 'queued')
        ORDER BY w.seq FOR UPDATE OF w`,
      [owner, sessionId],
    )).rows as Array<{ item_id: string; seq: number; generation: number; board_state: string; last_report_kind: string | null; params: ErrandParams; router_sid: string }>;
    if (!items.length) return null;
    const pass: ErrandPass = { notices: [], reports: [] };
    for (const item of items) {
      const events = (await q(
        `SELECT id, type, occurred_at, data FROM claw_remote_events
          WHERE session_id = $1 AND id > $2 AND type = ANY($3::text[]) AND COALESCE(data->>'replay', '') <> 'true'
          ORDER BY id LIMIT $4`,
        [sessionId, Number(item.params.last_event_id) || 0, ERRAND_EVENTS, EVENTS_PER_PASS],
      )).rows.map((r) => ({
        id: Number(r.id), type: String(r.type), occurred_at: new Date(r.occurred_at).toISOString(), data: (r.data ?? {}) as Record<string, unknown>,
      })) as MovingEvent[];
      if (!events.length) continue;
      const p: ErrandParams = {
        ...item.params, waiting: Array.isArray(item.params.waiting) ? [...item.params.waiting] : [],
        open_cmd_seqs: Array.isArray(item.params.open_cmd_seqs) ? [...item.params.open_cmd_seqs] : [],
      };
      let board = item.board_state;
      const seat = p.seat_id ? { seat_id: p.seat_id, alias: typeof p.alias === "string" ? p.alias : null } : undefined;
      const tell = (key: string, kind: AssistantRemoteNotice["kind"], text: string, ask?: AssistantRemoteAsk, attach = true) => {
        pass.notices.push({
          userId: owner, routerSid: item.router_sid, itemId: attach ? item.item_id : undefined, key: `remote:${item.item_id}:${key}`, text,
          remote: {
            kind, session_id: sessionId, machine: p.machine, agent: p.agent_id, item_seq: Number(item.seq), ...(seat ? { seat } : {}), ...(ask ? { ask } : {}),
          },
        });
      };
      const write = async (set: string, values: unknown[], ev: { kind: string; summary: string | null; question?: string | null }) => {
        await q(`UPDATE claw_work_items SET ${set}, updated_at = NOW() WHERE item_id = $1`, [item.item_id, ...values]);
        await q(
          `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, question)
           SELECT item_id, $2, 'remote', generation, $3, $4 FROM claw_work_items WHERE item_id = $1`,
          [item.item_id, ev.kind, ev.summary, ev.question ?? null],
        );
      };
      const fail = (key: string, reason: string) => {
        p.open_cmd_seqs = [];
        p.open_turns = 0;
        p.waiting = [];
        p.report_due = { kind: "failed", summary: reason, generation: Number(item.generation) };
        tell(key, "error", errandNotice("failed", p, item.seq, reason), undefined, false);
      };
      for (const e of events) {
        p.last_event_id = e.id;
        const seq = Number.isSafeInteger(e.data.cmd_seq) ? Number(e.data.cmd_seq) : null;
        const open = p.open_cmd_seqs ?? [];
        const running = open.length > 0;
        const mine = seq !== null ? open.includes(seq) : unnamedIsErrands(e, running);
        if (e.type === REMOTE_EVENT_TURN_END) {
          if (!mine) continue;
          p.open_cmd_seqs = seq !== null ? open.filter((c) => c !== seq) : [];
          p.open_turns = p.open_cmd_seqs.length;
          if (p.open_cmd_seqs.length) continue;
          const stop = flat(e.data.stopReason, 40);
          p.waiting = [];
          if (undelivered(e)) {
            fail(`undelivered:${e.id}`, p.lang === "zh" ? "机器在确认收到前断开了，可能没有执行" : "the machine went before confirming it had the task; it may not have run");
          } else if (stop === "cancelled") {
            // Stopped where it runs (its terminal, or the session's own stop): the user's doing, not a failure, and not news to them.
            const summary = p.lang === "zh" ? "在终端里停止" : "stopped on the machine";
            board = "done";
            await write(
              "board_state = 'done', outcome = 'stopped', last_report_kind = 'dropped', summary = $2, pending_question = NULL, closed_at = NOW()",
              [summary], { kind: "stopped", summary },
            );
          } else if (FAILED_STOPS.has(stop)) {
            fail(`end:${e.id}`, stopWords(stop, flat(e.data.error, 200), p.lang, flat(e.data.terminal_mode, 40)) || stop);
          } else {
            const whole = await answerOf(q, sessionId, e.id);
            const answer = tailLines(whole, ERRAND_ANSWER_MAX) || (p.lang === "zh" ? "已结束，没有回答文字" : "ended with no answer text");
            p.report_due = { kind: "answer", summary: answer, generation: Number(item.generation) };
          }
        } else if (e.type === REMOTE_EVENT_COMMAND_REJECTED) {
          const reason = e.data.type === "prompt" ? flat(e.data.reason, 80) : "";
          if (!mine || seq === null || !(PROMPT_REFUSED_UNQUEUED.has(reason) || reason === PROMPT_DROPPED_BY_CANCEL)) continue;
          p.open_cmd_seqs = open.filter((c) => c !== seq);
          p.open_turns = p.open_cmd_seqs.length;
          if (!p.open_cmd_seqs.length) fail(`refused:${e.id}`, p.lang === "zh" ? `机器拒绝了这条指令（${reason}）` : `the machine refused it (${reason})`);
        } else if (e.type === REMOTE_EVENT_PERMISSION_REQUEST) {
          const actionId = flat(e.data.actionId, 128);
          if (!mine || !actionId || p.waiting.includes(actionId)) continue;
          p.waiting.push(actionId);
          const what = flat(e.data.tool, 120) || (p.lang === "zh" ? "一个操作" : "an action");
          const question = p.lang === "zh" ? `等你批准：${what}` : `Waiting for your approval: ${what}`;
          board = "needs_you";
          await write(
            "board_state = 'needs_you', last_report_kind = 'waiting', pending_question = $2, attention_seq = attention_seq + 1",
            [question], { kind: "waiting", summary: question, question },
          );
          // At most ERRAND_ASKS_PER_MINUTE asks a minute across the user's seats; past that, one line a minute says how many wait.
          const recent = Number((await q(
            `SELECT COUNT(*)::int AS n FROM claw_work_item_events e JOIN claw_work_items w ON w.item_id = e.item_id
              WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND e.kind = 'waiting' AND e.source = 'remote'
                AND e.created_at > NOW() - INTERVAL '1 minute'`,
            [owner],
          )).rows[0].n);
          if (recent <= ERRAND_ASKS_PER_MINUTE) {
            tell(`ask:${e.id}`, "needs_you", errandNotice("needs_you", p, item.seq, what), askOf(e, actionId, what) ?? undefined);
          } else {
            const waiting = Number((await q(
              `SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true'
                  AND board_state = 'needs_you' AND last_report_kind = 'waiting'`,
              [owner],
            )).rows[0].n);
            pass.notices.push({
              userId: owner, routerSid: item.router_sid, itemId: undefined,
              key: `remote:errand-asks:${owner}:${Math.floor(Date.now() / MINUTE_MS)}`,
              text: errandNotice("asks_waiting", p, item.seq, "", { waiting }),
              remote: { kind: "needs_you", session_id: sessionId, machine: p.machine, agent: p.agent_id, item_seq: Number(item.seq), ...(seat ? { seat } : {}) },
            });
          }
        } else if (e.type === REMOTE_EVENT_PERMISSION_PARKED) {
          const actionId = flat(e.data.actionId, 128);
          if (!actionId || !p.waiting.includes(actionId)) continue;
          // The request itself, for its options: the reminder is a card as the request was, once per request.
          const asked = (await q(
            `SELECT id, type, occurred_at, data FROM claw_remote_events WHERE session_id = $1 AND type = $2 AND data->>'actionId' = $3
              ORDER BY id DESC LIMIT 1`,
            [sessionId, REMOTE_EVENT_PERMISSION_REQUEST, actionId],
          )).rows[0];
          const req: MovingEvent | null = asked
            ? { id: Number(asked.id), type: String(asked.type), occurred_at: new Date(asked.occurred_at).toISOString(), data: asked.data ?? {} } : null;
          const what = flat(req?.data.tool, 120) || (p.lang === "zh" ? "一个操作" : "an action");
          const ask = req ? askOf(req, actionId, what) : null;
          const until = typeof e.data.parked_until === "string" && Number.isFinite(Date.parse(e.data.parked_until)) ? new Date(e.data.parked_until).toISOString() : undefined;
          if (ask) {
            ask.parked = true;
            if (until) ask.expires_at = until;
          }
          // (Not filed under the item: the request's own notice is its one message for this wait.)
          tell(`parked:${actionId}`, "needs_you", errandNotice("parked", p, item.seq, what), ask ?? undefined, false);
        } else if (e.type === REMOTE_EVENT_PERMISSION_RESOLVED) {
          const actionId = flat(e.data.actionId, 128);
          if (!p.waiting.includes(actionId)) continue;
          p.waiting = p.waiting.filter((a) => a !== actionId);
          const by = flat(e.data.by, 64);
          if (by === "timeout" || by === "park_expired") {
            fail(`timeout:${e.id}`, p.lang === "zh"
              ? (by === "timeout" ? "因审批超时停了" : "审批等了 24 小时没有人回答，停了")
              : (by === "timeout" ? "it stopped: the approval timed out" : "it stopped: nobody answered the approval in 24 hours"));
            continue;
          }
          if (board === "needs_you" && !p.waiting.length) {
            board = "in_progress";
            await write("board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL", [],
              { kind: "progress", summary: p.lang === "zh" ? "已批准，继续" : "answered, going on" });
          }
        } else if (e.type === REMOTE_EVENT_SESSION_CLOSED) {
          if (!running && !p.waiting.length) continue;
          fail(`closed:${e.id}`, p.lang === "zh" ? "它的会话关闭了" : "its session closed");
        } else if (e.type === "plan" && running) {
          const entries = Array.isArray((e.data.update as Record<string, unknown> | undefined)?.entries)
            ? ((e.data.update as Record<string, unknown>).entries as unknown[])
            : Array.isArray(e.data.entries) ? (e.data.entries as unknown[]) : [];
          const steps = entries.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
          if (!steps.length) continue;
          const doneN = steps.filter((x) => x.status === "completed").length;
          const current = steps.find((x) => x.status !== "completed");
          p.progress = { current: flat(current?.content, STEP_MAX), done: doneN, total: steps.length, at: e.occurred_at };
        }
      }
      await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1", [item.item_id, storableJsonText(p)]);
      if (p.report_due && p.report_due !== item.params.report_due) {
        pass.reports.push({ itemId: item.item_id, generation: p.report_due.generation, kind: p.report_due.kind, summary: p.report_due.summary });
      }
    }
    return pass;
  });
}

/** A seat task's end, reported: the router is woken to say it (or the answer is said whole). Then nothing is due any more. */
export async function reportErrand(r: { itemId: string; generation: number; kind: "answer" | "failed"; summary: string }): Promise<void> {
  const { ingestReport } = await import("./reports.js");
  // (Applied, or stale: a newer instruction or a stop moved the item on. Either way nothing is due; a failure leaves it for the sweep.)
  await ingestReport({ itemId: r.itemId, workerSessionId: errandWorkerSessionId(r.itemId), generation: r.generation, runId: null },
    { kind: r.kind, summary: r.summary }, "remote");
  await db.query("UPDATE claw_work_items SET params = params - 'report_due' WHERE item_id = $1 AND (params->'report_due'->>'generation')::int = $2",
    [r.itemId, r.generation]);
}

/** The session's seat tasks take their events, their ends are reported, and what they say is said. Never throws. */
async function noteErrandEvents(owner: string, sessionId: string): Promise<boolean> {
  let pass: ErrandPass | null = null;
  try {
    pass = await applyErrands(owner, sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, "assistant.errand_update_failed");
    return false;
  }
  const late = await applyAgentTurns(owner, sessionId).catch((err) => {
    logger.warn({ err, sessionId }, "assistant.errand_agent_turn_failed");
    return [] as Notice[];
  });
  for (const n of late) {
    await recordSystemNotice({ userId: n.userId, sessionId: n.routerSid, text: n.text, key: n.key, itemId: n.itemId, remote: n.remote })
      .catch((err) => logger.warn({ err, key: n.key }, "assistant.errand_notice_failed"));
  }
  if (!pass) return late.length > 0;
  for (const n of pass.notices) {
    await recordSystemNotice({ userId: n.userId, sessionId: n.routerSid, text: n.text, key: n.key, itemId: n.itemId, remote: n.remote })
      .catch((err) => logger.warn({ err, itemId: n.itemId }, "assistant.errand_notice_failed"));
  }
  for (const r of pass.reports) await reportErrand(r).catch((err) => logger.warn({ err, itemId: r.itemId }, "assistant.errand_report_failed"));
  return true;
}

/**
 * A seat's task the user stopped (`work_stop`, its stop button), already closed: a card it waited on is closed unanswered, and a turn of
 * it running is cancelled on its machine. One waiting in its seat's queue simply leaves it: nothing was sent there.
 */
async function cancelErrand(userId: string, p: Partial<ErrandParams>): Promise<void> {
  try {
    if (p.confirmation_id) {
      await db.query(
        `UPDATE claw_assistant_confirmations SET status = 'expired', decided_via = 'item_stopped', decided_at = NOW(),
                result = jsonb_build_object('voided_reason', 'item_stopped')
          WHERE confirmation_id = $1 AND user_id = $2 AND status = 'pending'`,
        [p.confirmation_id, userId],
      );
    }
    const sessionId = String(p.session_id ?? "");
    if (!sessionId || !Array.isArray(p.open_cmd_seqs) || !p.open_cmd_seqs.length) return;
    const s = await findSession(userId, sessionId);
    if (!s || s.status !== "active") return;
    // (Not noted on the session's own item: the end this cancel brings names the task's prompt, which that item passes over.)
    const out = await inRemoteSessionOrder(sessionId, () => issueCommand({
      owner: userId, client: ERRAND_CLIENT, connectorId: s.connector_id, agentId: s.agent_id, sessionId, type: "cancel",
      cmdId: randomUUID(), payload: {}, auditDetail: REMOTE_COMMANDS.cancel.audit({}), closesSession: false,
      commandsPerMinute: REMOTE_AGENT_LIMITS.commandsPerMinute,
    }));
    if (out.status === "queued") wakeConnector(s.connector_id);
  } catch (err) {
    logger.warn({ err }, "assistant.errand_cancel_failed");
  }
}
