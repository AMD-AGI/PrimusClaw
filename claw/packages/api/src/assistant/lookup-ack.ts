// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "On it", said by the server when a router turn starts looking something up and has said nothing yet.
 *
 * The first reply is what a person waits on (the target is p90 under 5 s). A router turn that answers from a lookup (a web search, an
 * MCP read of SaFE or a board) spends most of its time in that lookup: a web search takes several seconds, an MCP server that connects
 * slowly several more. The router is told to put a short line beside a slow lookup (`prompts.ts`, Being quick), and mostly does; when it
 * does not, the person heard nothing until the answer (the 2026-11-06 nightly: first reply p90 8.4 s, cat-safe-edge-002 31.7 s,
 * cat-agent-board-wr-001 7.6 s). So when the turn's first lookup starts and the turn has not spoken, the server says it is on it, in the
 * person's language, once per turn, in its own words (a fallback say: not counted against the say limit, and not taken for the turn having
 * answered, `router-turn-end.ts`). The answer the turn says later takes that line's place (`turnFirstSay`), so a channel that can edit a
 * message shows one message, as it does for the router's own line.
 *
 * Not for a turn a worker's report started (it may end silent on purpose), nor one that may hand a review to the person's channel (that
 * channel answers the message itself, in one message: `say-hold.ts`), nor once anything was said in the turn or the router started its
 * own say. A short wait (`CLAW_ASSISTANT_LOOKUP_ACK_GRACE_MS`) lets a line the router writes beside the lookup, in the same step, arrive
 * first. Best effort: a failure here is logged and never touches the event it was triggered by.
 *
 * Only with notifications on (`CLAW_NOTIFICATIONS_ENABLED`): the answer takes the line's place by its delivery (`turnFirstSay` matches a
 * message to its turn through the outbox), and without them the line would stay beside the answer as a second message. A deployment
 * without channels shows the router's `say` while it is written (`stream_tool_text`) instead.
 *
 * The same line by the clock (`ackFirstReply`): a turn that has said nothing `CLAW_ASSISTANT_FIRST_ACK_MS` after it began is told on it
 * too, whatever it is doing. A lookup is not the only slow first step: 21 turns of the 2026-11-06 baseline never said a word and were
 * answered only at their end (`router-turn-end.ts`), and others thought, or called the assistant's own tools (deliver_text,
 * trigger_create, review_mode_set), for 7 to 22 s before their first say. Same exclusions, same key (one line per turn, whichever says
 * it first), and the answer takes its place the same way. Only for the people `CLAW_ASSISTANT_FIRST_ACK_USERS` names.
 */
import pino from "pino";
import {
  CLAW_ASSISTANT_FIRST_ACK_MS, CLAW_ASSISTANT_FIRST_ACK_USERS, CLAW_ASSISTANT_LOOKUP_ACK, CLAW_ASSISTANT_LOOKUP_ACK_GRACE_MS,
  CLAW_NOTIFICATIONS_ENABLED,
} from "../config.js";
import { db, type Querier } from "../infra/db.js";
import { deterministicEventId } from "../notifications/outbox.js";
import { turnMessage } from "./inbound.js";
import { detectLanguage } from "./language.js";
import { recordSystemNotice, type SayDeps } from "./outbound.js";
import { TOOL_NAME_PREFIX, WORK_EVENT_PREFIX } from "./prompts.js";
import { ROUTER_SPEAK_TOOL } from "./read-tools.js";
import { mayHandOff } from "./say-hold.js";

const logger = pino({ name: "assistant-lookup-ack" });

/** The router's `say`, as Brain names it in a `toolUsed` event. */
const SAY_TOOL = `${TOOL_NAME_PREFIX}${ROUTER_SPEAK_TOOL}`;

/**
 * A lookup that leaves the API and may take seconds: a web search or read, or a tool of an MCP server other than the assistant's own
 * (whose reads answer in tenths of a second).
 */
export function isSlowLookup(tool: string): boolean {
  if (tool === "web_search" || tool === "web_fetch") return true;
  return tool.startsWith("mcp__") && !tool.startsWith(TOOL_NAME_PREFIX);
}

/** What the server says, in the language of the person's message: a web lookup is named as one. Pure, for the tests. */
export function lookupAckText(userWords: string, tool: string): string {
  const web = tool === "web_search" || tool === "web_fetch";
  if (detectLanguage(userWords) === "Chinese") return web ? "收到，我上网查一下。" : "收到，我查一下。";
  return web ? "On it: searching the web now." : "On it: checking now.";
}

/** The key the line is stored under, once per turn: also how `turnFirstSay` finds it, so the turn's answer takes its place. */
export const lookupAckKey = (messageId: string): string => `lookup_ack:${messageId}`;
export const lookupAckSayId = (userId: string, messageId: string): string =>
  deterministicEventId("assistant.notice", userId, lookupAckKey(messageId));

/** Router sessions seen, by id: a session's role never changes, and most `toolUsed` events are a worker's. */
const routerUserOf = new Map<string, string | null>();
const ROUTER_CACHE_MAX = 5_000;

async function routerUser(q: Querier, sessionId: string): Promise<string | null> {
  if (routerUserOf.has(sessionId)) return routerUserOf.get(sessionId)!;
  const row = (await q("SELECT user_id FROM claw_assistants WHERE session_id = $1", [sessionId])).rows[0] as { user_id: string } | undefined;
  if (routerUserOf.size >= ROUTER_CACHE_MAX) routerUserOf.clear();
  routerUserOf.set(sessionId, row?.user_id ?? null);
  return row?.user_id ?? null;
}

/** For the tests: forget which sessions were routers, and which turns' text was noted. */
export function resetLookupAckCacheForTest(): void { routerUserOf.clear(); textPreviewNoted.clear(); }

/** The previews this process has noted, by turn and preview id, and how: a delta every few hundred ms writes the run once. */
const textPreviewNoted = new Map<string, boolean>();

/**
 * Note on the run answering `messageId` that its own text is being shown as its say's (`stream_text_as`: a `toolTextDelta` with
 * `source: "text"`), or that a shown text was taken back (`toolTextVoid`, same source), by the preview's id (`actionId`): the turn has
 * started to answer, so the "on it" line is not said over it (`reasonToStaySilent`), and its end takes back what was shown if it does
 * not say it (`router-turn-end.ts`). The deltas are never stored, and the events of one turn reach every API process in any order, so it
 * is kept on the run as two sets, the ids shown (`text_shown`) and the ids taken back (`text_voided`); a text is on screen while some
 * id is shown and not taken back (`TEXT_SHOWN_SQL`). Sets, so the order the processes write in does not matter: a delta of a text taken
 * back, early or late, never puts it back, and the take-back of a failed model call's text leaves its retry's text (a new id) shown.
 * False when it could not be written: the caller has the event delivered again.
 */
export async function noteTextPreview(
  sessionId: string, messageId: string, previewId: string, showing: boolean, q: Querier = (t, p) => db.query(t, p),
): Promise<boolean> {
  const key = `${messageId}\u0000${previewId}`;
  if (!sessionId || !messageId || !previewId || textPreviewNoted.get(key) === showing) return true;
  if (textPreviewNoted.size >= ROUTER_CACHE_MAX) textPreviewNoted.clear();
  textPreviewNoted.set(key, showing);
  const set = showing ? "text_shown" : "text_voided";
  try {
    await q(
      `UPDATE claw_tasks SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${set}}',
              COALESCE(metadata->'${set}', '[]'::jsonb) || to_jsonb($3::text), true)
        WHERE session_id = $1 AND origin = 'chat' AND metadata->>'message_id' = $2
          AND NOT (COALESCE(metadata->'${set}', '[]'::jsonb) ? $3)`,
      [sessionId, messageId, previewId],
    );
    return true;
  } catch (err) {
    textPreviewNoted.delete(key);
    logger.warn({ err: (err as Error)?.message, sessionId, messageId }, "assistant.text_preview_note_failed");
    return false;
  }
}

/** Whether a `claw_tasks` row's own text is on screen (`noteTextPreview`): an id shown and not taken back. A boolean SQL expression. */
export const TEXT_SHOWN_SQL = `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'text_shown', '[]'::jsonb)) AS shown(id)
    WHERE NOT (COALESCE(metadata->'text_voided', '[]'::jsonb) ? shown.id))`;

/**
 * Why the turn answering `messageId` is not to be told "on it" now, or null when it is: read fresh each time, so the check after the
 * grace sees a line the router wrote meanwhile.
 */
async function reasonToStaySilent(
  q: Querier, sessionId: string, userId: string, messageId: string, pendingSince?: Date,
): Promise<string | null> {
  let run = (await q(
    `SELECT COALESCE(started_at, created_at) AS began, status, COALESCE(prompt, input->>'prompt', '') AS prompt,
            ${TEXT_SHOWN_SQL} AS text_shown
       FROM claw_tasks WHERE session_id = $1 AND origin = 'chat' AND metadata->>'message_id' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId, messageId],
  )).rows[0] as { began: Date; status: string; prompt: string; text_shown?: boolean } | undefined;
  // A message still queued behind another turn (a worker's report being read): no run yet, and the person has waited since it came in.
  if (!run && pendingSince) {
    const pending = /^claw-pending-(\d+)$/.exec(messageId);
    const queued = pending && (await q("SELECT 1 FROM claw_pending_messages WHERE id = $1 AND session_id = $2", [pending[1], sessionId])).rowCount;
    if (queued) run = { began: pendingSince, status: "queued", prompt: "" };
  }
  if (!run) return "no_run";
  if (run.prompt.startsWith(WORK_EVENT_PREFIX)) return "report_turn";
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return "turn_ended";
  // Anything said to the person since the turn began: the router's line, an item's start notice, this line itself. A turn that has not
  // begun (its message queued behind another turn, or its run not yet claimed) has said nothing of its own but this line: what was said
  // meanwhile is the turn in front's, answering something else (2026-11-08 E249 sim-safe-mt-007: a follow-up sent while the turn before
  // it was still answering heard nothing for 7.8 s, held back by that turn's answer).
  const said = run.status === "queued"
    ? await q("SELECT 1 FROM claw_assistant_says WHERE say_id = $1 LIMIT 1", [lookupAckSayId(userId, messageId)])
    : await q("SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND created_at >= $2 LIMIT 1", [userId, run.began]);
  if (said.rowCount) return "spoke";
  // Its own text is on the person's screen as it is written (`noteTextPreview`): the turn has started to answer, as with a say.
  if (run.text_shown) return "writing";
  // A say the router has started and that has not ended (written beside the lookup, still being stored). One that ended stored a row
  // (`spoke`) or was refused: a refused say holds nothing back, the router writes it again a few seconds later (2026-11-07 run:
  // cat-memory-ro-001 and cat-items-ro-001, a say refused at 3.2 s and said again at 5.3 s and 5.9 s).
  const saying = (await q(
    `SELECT count(*) FILTER (WHERE data->>'status' = 'start')::int AS started,
            count(*) FILTER (WHERE data->>'status' IS DISTINCT FROM 'start')::int AS ended
       FROM claw_session_events
      WHERE session_id = $1 AND event = 'toolUsed' AND deleted_at IS NULL AND data->>'message_id' = $2 AND data->>'tool' = $3`,
    [sessionId, messageId, SAY_TOOL],
  )).rows[0] as { started: number; ended: number } | undefined;
  if (saying && saying.started > saying.ended) return "saying";
  return null;
}

/** Whether the line is said at all: the flag, and a channel's delivery for the answer to take its place in. */
export const lookupAckOn = (): boolean => CLAW_ASSISTANT_LOOKUP_ACK && CLAW_NOTIFICATIONS_ENABLED;

export interface LookupAckDeps extends SayDeps {
  graceMs?: number;
  enabled?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Say "on it" for the router turn this event belongs to, if it is the start of a slow lookup in a turn that answers the person and has
 * said nothing. Returns what it did, for the tests and the log: `said`, or why not.
 */
export async function ackBeforeLookup(sessionId: string, event: Record<string, unknown>, deps: LookupAckDeps = {}): Promise<string> {
  if (!(deps.enabled ?? lookupAckOn())) return "off";
  if (event.type !== "toolUsed" || event.status !== "start") return "not_a_start";
  const tool = typeof event.tool === "string" ? event.tool : "";
  const messageId = typeof event.message_id === "string" ? event.message_id : "";
  if (!messageId || !isSlowLookup(tool)) return "not_a_lookup";
  const q: Querier = (text, params) => db.query(text, params);
  const userId = await routerUser(q, sessionId);
  if (!userId) return "not_a_router";
  const message = await turnMessage(q, sessionId, messageId);
  if (!message) return "no_message";
  if (mayHandOff(message)) return "may_hand_off";
  let why = await reasonToStaySilent(q, sessionId, userId, messageId);
  if (why) return why;
  const grace = deps.graceMs ?? CLAW_ASSISTANT_LOOKUP_ACK_GRACE_MS;
  if (grace > 0) {
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(grace);
    why = await reasonToStaySilent(q, sessionId, userId, messageId);
    if (why) return why;
  }
  let late: string | null = null;
  const stored = await recordSystemNotice({
    userId, sessionId, text: lookupAckText(message.content, tool), key: lookupAckKey(messageId), turnMessageId: messageId,
    onlyIf: async (tq) => !(late = await reasonToStaySilent(tq, sessionId, userId, messageId)),
  }, deps);
  if (late) return late;
  if (!stored) return "said_before";
  logger.info({ sessionId, messageId, tool }, "assistant.lookup_ack_said");
  return "said";
}

/** What the server says when the turn has said nothing by the deadline, in the language of the person's message. Pure, for the tests. */
export function firstAckText(userWords: string): string {
  return detectLanguage(userWords) === "Chinese" ? "收到，我看一下。" : "On it: looking into it now.";
}

/** Whether `userId` is one the clock's line is said to: `*` names everyone, otherwise the comma-separated ids. Pure, for the tests. */
export function firstAckFor(userId: string, users: string = CLAW_ASSISTANT_FIRST_ACK_USERS): boolean {
  const names = users.split(",").map((u) => u.trim()).filter(Boolean);
  return names.includes("*") || names.includes(userId);
}

/** Whether the clock's line is said to anyone: someone named, and a channel's delivery for the answer to take its place in. */
export const firstAckOn = (): boolean => CLAW_ASSISTANT_FIRST_ACK_USERS.trim() !== "" && CLAW_NOTIFICATIONS_ENABLED;

export interface FirstAckDeps extends SayDeps {
  enabled?: boolean;
  users?: string;
}

/**
 * Say "on it" for the router turn answering `messageId` if it has still said nothing: called once the deadline has passed. Returns what
 * it did, for the tests and the log: `said`, or why not.
 */
export async function ackFirstReply(sessionId: string, messageId: string, deps: FirstAckDeps = {}): Promise<string> {
  if (!(deps.enabled ?? firstAckOn())) return "off";
  if (!messageId) return "no_message";
  const q: Querier = (text, params) => db.query(text, params);
  const userId = await routerUser(q, sessionId);
  if (!userId) return "not_a_router";
  if (!firstAckFor(userId, deps.users)) return "not_named";
  const message = await turnMessage(q, sessionId, messageId);
  if (!message) return "no_message";
  if (mayHandOff(message)) return "may_hand_off";
  const why = await reasonToStaySilent(q, sessionId, userId, messageId, new Date(message.receivedAt));
  if (why) return why;
  // (asked again under the say lock, where the answer is stored: an answer stored since the look above keeps the line unsaid)
  let late: string | null = null;
  const stored = await recordSystemNotice({
    userId, sessionId, text: firstAckText(message.content), key: lookupAckKey(messageId), turnMessageId: messageId,
    onlyIf: async (tq) => !(late = await reasonToStaySilent(tq, sessionId, userId, messageId, new Date(message.receivedAt))),
  }, deps);
  if (late) return late;
  if (!stored) return "said_before";
  logger.info({ sessionId, messageId }, "assistant.first_ack_said");
  return "said";
}

/**
 * Called when the person's message is accepted (`routes/sessions.ts`, whether it starts a turn or waits behind one) and when a chat run
 * is opened (`openChatRun`): after `delayMs` the turn is told on it if it has said nothing by then. A message queued behind a worker's
 * report waits from when it came in, not from when its run opens (2026-11-07 run: cat-items-wr-006 queued 5.5 s, first reply 7.8 s).
 * Whichever timer fires first says it; the other finds it said. A timer of this process, never awaited and never throwing: a restart
 * in between loses one line, which the turn's own answer still follows. Only for the people the setting names (`userId`, when known).
 */
export function armFirstAck(
  sessionId: string, messageId: string, delayMs: number = CLAW_ASSISTANT_FIRST_ACK_MS, deps: FirstAckDeps = {}, userId?: string,
): void {
  if (!(deps.enabled ?? firstAckOn()) || !messageId) return;
  if (userId !== undefined && !firstAckFor(userId, deps.users)) return;
  const timer = setTimeout(() => {
    void ackFirstReply(sessionId, messageId, deps)
      .then((out) => { if (out !== "said") logger.debug({ sessionId, messageId, out }, "assistant.first_ack_skipped"); })
      .catch((err) => logger.warn({ err, sessionId, messageId }, "assistant.first_ack_failed"));
  }, delayMs);
  timer.unref?.();
}

/** The event consumer's call: never awaited by it and never throwing into it. */
export function ackBeforeLookupInBackground(sessionId: string, event: Record<string, unknown>): void {
  if (!lookupAckOn() || event.type !== "toolUsed" || event.status !== "start") return;
  void ackBeforeLookup(sessionId, event).catch((err) => logger.warn({ err, sessionId }, "assistant.lookup_ack_failed"));
}
