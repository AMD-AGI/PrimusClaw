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
 */
import pino from "pino";
import { CLAW_ASSISTANT_LOOKUP_ACK, CLAW_ASSISTANT_LOOKUP_ACK_GRACE_MS } from "../config.js";
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

/** For the tests: forget which sessions were routers. */
export function resetLookupAckCacheForTest(): void { routerUserOf.clear(); }

/**
 * Why the turn answering `messageId` is not to be told "on it" now, or null when it is: read fresh each time, so the check after the
 * grace sees a line the router wrote meanwhile.
 */
async function reasonToStaySilent(q: Querier, sessionId: string, userId: string, messageId: string): Promise<string | null> {
  const run = (await q(
    `SELECT COALESCE(started_at, created_at) AS began, status, COALESCE(prompt, input->>'prompt', '') AS prompt
       FROM claw_tasks WHERE session_id = $1 AND origin = 'chat' AND metadata->>'message_id' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId, messageId],
  )).rows[0] as { began: Date; status: string; prompt: string } | undefined;
  if (!run) return "no_run";
  if (run.prompt.startsWith(WORK_EVENT_PREFIX)) return "report_turn";
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return "turn_ended";
  // Anything said to the person since the turn began: the router's line, an item's start notice, this line itself.
  const said = await q("SELECT 1 FROM claw_assistant_says WHERE user_id = $1 AND created_at >= $2 LIMIT 1", [userId, run.began]);
  if (said.rowCount) return "spoke";
  // A say the router has started (written beside the lookup, still being stored).
  const saying = await q(
    `SELECT 1 FROM claw_session_events
      WHERE session_id = $1 AND event = 'toolUsed' AND deleted_at IS NULL AND data->>'message_id' = $2 AND data->>'tool' = $3 LIMIT 1`,
    [sessionId, messageId, SAY_TOOL],
  );
  if (saying.rowCount) return "saying";
  return null;
}

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
  if (!(deps.enabled ?? CLAW_ASSISTANT_LOOKUP_ACK)) return "off";
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
  const stored = await recordSystemNotice({
    userId, sessionId, text: lookupAckText(message.content, tool), key: lookupAckKey(messageId), turnMessageId: messageId,
  }, deps);
  if (!stored) return "said_before";
  logger.info({ sessionId, messageId, tool }, "assistant.lookup_ack_said");
  return "said";
}

/** The event consumer's call: never awaited by it and never throwing into it. */
export function ackBeforeLookupInBackground(sessionId: string, event: Record<string, unknown>): void {
  if (!CLAW_ASSISTANT_LOOKUP_ACK || event.type !== "toolUsed" || event.status !== "start") return;
  void ackBeforeLookup(sessionId, event).catch((err) => logger.warn({ err, sessionId }, "assistant.lookup_ack_failed"));
}
