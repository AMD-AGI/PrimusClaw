// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A user's message to their assistant, as the turn that answers it may act on it.
 *
 * The tools that act for the person (start or restart a review, answer a held write, change the review mode, run a
 * channel's setting) need the person behind the turn, not a key: a model in any sandbox of theirs holds their key and
 * can send their assistant a message with it, and a worker's report reaches the router as a message too. So what the
 * route saw is written down when the message is accepted, in the same transaction, under the id of the turn that will
 * carry it: how the request was authenticated (`attended.ts`), the words, and what the channel sent beside them. A
 * turn reads the row for its own message id and no other, so a report's turn, which has no row, can never borrow the
 * standing of a message before it.
 *
 * What the channel sends (`channel_context`) is bounded here and trusted only for grounding: a name it lists can be
 * asked to review, but whether that person lets anyone act for them is still theirs to say (`acting_as`'s consent).
 */
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { CLAW_ASSISTANT_ATTENDED_TTL_SEC } from "../config.js";
import { classifyAttendedCaller } from "../github-review/attended.js";
import { readGithubReviewSettings } from "../github-review/settings.js";
import type { DecidedVia } from "../github-review/store.js";
import { db, type Querier } from "../infra/db.js";
import { stopTurnRuns } from "../tasks/chat-run.js";
import { WORK_EVENT_PREFIX } from "./prompts.js";

const logger = pino({ name: "assistant-inbound" });

/** At most this many entries of each list, and characters of each string: longer is cut, never refused. */
export const CONTEXT_LIST_MAX = 50;
export const CONTEXT_STRING_MAX = 200;
/** How long a message is kept for the turn that answers it. Far longer than any turn may wait in the queue. */
const MESSAGE_RETENTION = "7 days";

export interface ChannelPerson { name: string; user_id?: string; email?: string }
export interface ChannelAction { name: string; usage?: string; summary?: string }
export interface ChannelContext {
  channel?: string;
  channel_message_id?: string;
  people: ChannelPerson[];
  actions: ChannelAction[];
  repos: string[];
}

export type AttendedVia = { kind: "person" } | { kind: "service"; client_id: string; act_sub: string };

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, CONTEXT_STRING_MAX);
  return t || undefined;
};

const objects = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .slice(0, CONTEXT_LIST_MAX);

/** What the channel sent beside the text, kept to the fields Claw reads and bounded. Never a reason to refuse the message. */
export function parseChannelContext(raw: unknown): ChannelContext {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const people: ChannelPerson[] = [];
  for (const p of objects(c.people)) {
    const name = str(p.name);
    if (!name) continue;
    const userId = str(p.user_id);
    const email = str(p.email);
    people.push({ name, ...(userId ? { user_id: userId } : {}), ...(email ? { email } : {}) });
  }
  const actions: ChannelAction[] = [];
  for (const a of objects(c.actions)) {
    const name = str(a.name)?.replace(/^\/+/, "");
    if (!name) continue;
    const usage = str(a.usage);
    const summary = str(a.summary);
    actions.push({ name, ...(usage ? { usage } : {}), ...(summary ? { summary } : {}) });
  }
  const repos = (Array.isArray(c.repos) ? c.repos : []).map(str).filter((r): r is string => !!r && /^[^/\s]+\/[^/\s]+$/.test(r))
    .slice(0, CONTEXT_LIST_MAX);
  const channel = str(c.channel);
  const channelMessageId = str(c.channel_message_id);
  return {
    ...(channel ? { channel } : {}), ...(channelMessageId ? { channel_message_id: channelMessageId } : {}),
    people, actions, repos,
  };
}

/**
 * The person (or the service an operator allowed to speak for them) behind a request, as stored; null when nobody is.
 * The same reading as answering a held merge (`classifyAttendedCaller`): an identity-provider token, never a key or a cookie.
 */
export function attendedViaOfRequest(req: FastifyRequest): AttendedVia | null {
  const caller = classifyAttendedCaller(getAuthMethod(req), { delegation: getUser(req)?.delegation }, readGithubReviewSettings().decisionClientIds);
  if (!caller.ok) return null;
  return caller.via ? { kind: "service", client_id: caller.via.clientId, act_sub: caller.via.actorSub } : { kind: "person" };
}

/** The same, as a held write's decision records who answered (`decide`). */
export function decidedViaOf(via: AttendedVia): DecidedVia | null {
  return via.kind === "service" ? { clientId: via.client_id, actorSub: via.act_sub } : null;
}

/**
 * Write down a message the user sent to their own assistant, inside the transaction that accepts it. Nothing for any
 * other session: the row is what makes a router turn able to act, and only a router turn reads it.
 */
export async function recordAssistantMessage(tx: PoolClient, m: {
  sessionId: string; messageId: string; userId: string; userName?: string; content: string; attendedVia: AttendedVia | null; context: ChannelContext;
}): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context)
     SELECT $1, $2, $3, $7, $4, $5::jsonb, $6::jsonb
      WHERE EXISTS (SELECT 1 FROM claw_assistants WHERE session_id = $1 AND user_id = $3)
     ON CONFLICT (session_id, message_id) DO NOTHING`,
    [m.sessionId, m.messageId, m.userId, m.content, m.attendedVia ? JSON.stringify(m.attendedVia) : null, JSON.stringify(m.context),
      m.userName?.slice(0, CONTEXT_STRING_MAX) || null],
  );
  if (inserted.rowCount) {
    await tx.query(
      `DELETE FROM claw_assistant_messages WHERE session_id = $1 AND received_at < NOW() - $2::interval`,
      [m.sessionId, MESSAGE_RETENTION],
    );
  }
}

export interface TurnMessage {
  messageId: string;
  /** The turn answering it has read what a worker wrote (`markUntrustedRead`). */
  readUntrusted: boolean;
  /** The sender's name as their sign-in gave it, when it did. */
  userName: string | null;
  content: string;
  context: ChannelContext;
  attendedVia: AttendedVia | null;
  receivedAt: Date;
  /** Whether the person's say is still fresh enough to act on (`CLAW_ASSISTANT_ATTENDED_TTL_SEC`), asked of the database's clock. */
  fresh: boolean;
}

/** The user's message a router turn answers, or null for a turn that answers none (a worker's report). */
export async function turnMessage(q: Querier, sessionId: string, messageId: string): Promise<TurnMessage | null> {
  const row = (await q(
    `SELECT message_id, user_name, content, attended_via, channel_context, received_at, untrusted_read_at IS NOT NULL AS read_untrusted,
            received_at > NOW() - make_interval(secs => $3::int) AS fresh
       FROM claw_assistant_messages WHERE session_id = $1 AND message_id = $2`,
    [sessionId, messageId, CLAW_ASSISTANT_ATTENDED_TTL_SEC],
  )).rows[0] as {
    message_id: string; read_untrusted: boolean; user_name: string | null; content: string; attended_via: AttendedVia | null; channel_context: unknown; received_at: Date; fresh: boolean;
  } | undefined;
  if (!row) return null;
  return {
    messageId: row.message_id,
    readUntrusted: row.read_untrusted === true,
    userName: row.user_name,
    content: row.content,
    context: parseChannelContext(row.channel_context),
    attendedVia: row.attended_via && (row.attended_via.kind === "person" || row.attended_via.kind === "service") ? row.attended_via : null,
    receivedAt: new Date(row.received_at),
    fresh: row.fresh === true,
  };
}

/**
 * The turn answering this message has read text a worker or a page wrote (`work_recall`). The person's say covers what
 * they wrote, not what the model read afterwards, so the turn stops acting for them (`attendedTurn` refuses).
 */
export async function markUntrustedRead(q: Querier, sessionId: string, messageId: string): Promise<void> {
  await q(
    "UPDATE claw_assistant_messages SET untrusted_read_at = NOW() WHERE session_id = $1 AND message_id = $2 AND untrusted_read_at IS NULL",
    [sessionId, messageId],
  );
}

/**
 * A user's message takes priority over a worker's report: stop the router turn that is reading a report so the
 * message queued behind it runs now. The report is not lost: it is on the item, which the next turn's list shows, and
 * an item that needs the user and was not announced is the silent sweep's. A turn that answers the user is never
 * stopped for another of their messages.
 */
export async function preemptReportTurn(sessionId: string): Promise<boolean> {
  const turn = (await db.query(
    `SELECT s.agent_gate_message_id AS message_id
       FROM claw_sessions s
       JOIN claw_assistants a ON a.session_id = s.session_id
       JOIN claw_tasks t ON t.session_id = s.session_id AND t.origin = 'chat'
                        AND t.metadata->>'message_id' = s.agent_gate_message_id
                        AND t.status IN ('preparing', 'running')
      WHERE s.session_id = $1 AND s.deleted_at IS NULL AND s.agent_status = 'running'
        AND starts_with(COALESCE(t.prompt, t.input->>'prompt', ''), $2)
        AND NOT EXISTS (SELECT 1 FROM claw_assistant_messages m
                         WHERE m.session_id = s.session_id AND m.message_id = s.agent_gate_message_id)
      LIMIT 1`,
    [sessionId, WORK_EVENT_PREFIX],
  )).rows[0] as { message_id: string } | undefined;
  if (!turn) return false;
  const stopped = await stopTurnRuns(sessionId, turn.message_id);
  logger.info({ sessionId, messageId: turn.message_id, stopped }, "assistant.report_turn_preempted");
  return stopped > 0;
}
