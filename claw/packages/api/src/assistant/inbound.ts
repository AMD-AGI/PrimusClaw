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
import { redactStoredText, redactStoredValue } from "@claw/utils";
import { db, type Querier } from "../infra/db.js";
import { stopTurnRuns } from "../tasks/chat-run.js";
import { messageSurface, recordSurfaceUsed } from "../notifications/surfaces.js";
import { isChosenLanguage, type ChosenLanguage } from "./language.js";
import { WORK_EVENT_PREFIX } from "./prompts.js";

const logger = pino({ name: "assistant-inbound" });

/** At most this many entries of each list, and characters of each string: longer is cut, never refused. */
export const CONTEXT_LIST_MAX = 50;
export const CONTEXT_STRING_MAX = 200;
/** How long a message is kept for the turn that answers it. Far longer than any turn may wait in the queue. */
const MESSAGE_RETENTION = "7 days";

/** At most this many other handles of one person (`ChannelPerson.aliases`). */
export const PERSON_ALIASES_MAX = 10;
/**
 * A person the channel lists beside the message. `aliases`: other handles the channel knows them by (a GitHub login, a chat user name,
 * the address they sign in with), each a way the message may name them (`reviewerNamed`).
 */
export interface ChannelPerson { name: string; user_id?: string; email?: string; aliases?: string[] }
export interface ChannelAction { name: string; usage?: string; summary?: string }
/**
 * What a channel can be handed to carry out itself, as typed data (`channel_context.handoffs`). `review_for_other`: a review the person
 * asks of someone else, which runs on that person's own credentials; only a channel that holds them (their exchanged
 * token and their linked key) can start it, so the router hands it over (`review_start`, `AssistantActionPayload.review`) instead of
 * being refused. A name Claw does not know is dropped: a channel cannot widen what is handed to it.
 */
export const CHANNEL_HANDOFFS = ["review_for_other"] as const;
export type ChannelHandoff = (typeof CHANNEL_HANDOFFS)[number];
/**
 * A file the person sent with the message, which the channel has already put in the assistant's session
 * (`POST /v1/sessions/:id/upload`). `path` is where that upload stored it, relative to the session's `.uploads/` (as the upload
 * answered it), and it is the only thing Claw reads the file by: always below this session's own `.uploads/`, so a channel cannot
 * name anything else. The name, type and size are what the channel says, for the model to read.
 */
export interface ChannelFile { path: string; name: string; media_type?: string; size?: number }
/** At most this many files of one message are taken (a channel that sends more has its first ones read). */
export const CONTEXT_FILES_MAX = 10;
const FILE_PATH_MAX = 300;

/**
 * The agent session on one of the person's machines that the chat this message came from is attached to (`channel_context.attached`,
 * as a chat channel sends it): what the person types in that chat goes to that session, and only a message addressed to the
 * assistant (or one sent on their behalf) comes here. `phase`: `watching` when the session only watches a conversation open in a
 * terminal (read-only), else `attached`. The words are the channel's (its connector's and agent's names): grounding, never instructions.
 */
export interface ChannelAttached {
  session_id: string;
  connector?: string;
  agent?: string;
  agent_id?: string;
  cwd?: string;
  phase: "watching" | "attached";
  busy: boolean;
  conversation?: string;
  /**
   * Where the chat box goes while attached (Clawy's `/agent mode card|chat`): `card`, the chat box stays with the assistant and the
   * session card's own text box (or a reply quoting that card) goes to the session; `chat`, what is typed goes to the session. Absent:
   * not said (a Clawy from before it), read as `chat`.
   */
  chat_box?: "card" | "chat";
}

function parseAttached(raw: unknown): ChannelAttached | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const sessionId = str(a.session_id);
  if (!sessionId) return undefined;
  const opt = (k: string, v: string | undefined) => (v ? { [k]: v } : {});
  return {
    session_id: sessionId,
    ...opt("connector", str(a.connector)), ...opt("agent", str(a.agent)), ...opt("agent_id", str(a.agent_id)), ...opt("cwd", str(a.cwd)),
    phase: a.phase === "watching" ? "watching" : "attached",
    busy: a.busy === true,
    ...opt("conversation", str(a.conversation)),
    ...(a.chat_box === "card" || a.chat_box === "chat" ? { chat_box: a.chat_box } : {}),
  };
}

/**
 * How the message reached the chat it came from, when not typed there by the person (`channel_context.via`). `on_behalf`: the channel
 * posted it into the person's own chat for them (Clawy's `POST /primus-claw-agent/on-behalf`, their coordinator's review request) and
 * then handed it on as typed. Stored with the message so that what counts the person's own messages (Clawy's daily failure mining) can
 * count these apart. A label the channel gives, kept to this closed set: it is read for counting only and widens nothing a turn may do.
 */
export const CHANNEL_VIAS = ["on_behalf"] as const;
export type ChannelVia = (typeof CHANNEL_VIAS)[number];

export interface ChannelContext {
  /**
   * The chat surface the message came from (`teams`, `slack`, ...): a reply of the turn answering it goes back there, and the
   * person's proactive messages go to the surface they wrote from last (`notifications/surfaces.ts`). Absent: Teams.
   */
  channel?: string;
  /** How the message reached the chat (`ChannelVia`); absent: typed there, or not said. */
  via?: ChannelVia;
  channel_message_id?: string;
  people: ChannelPerson[];
  actions: ChannelAction[];
  repos: string[];
  handoffs: ChannelHandoff[];
  /** The files sent with the message (`ChannelFile`); empty when none were. */
  files: ChannelFile[];
  /** The session the chat is attached to (`ChannelAttached`); null: the channel says it is attached to none; absent: not said. */
  attached?: ChannelAttached | null;
  /**
   * The language the person chose to be answered in, in the channel (Clawy's `/lang zh|en`); absent: they chose none (`/lang auto`, or a
   * channel from before it), and the language is read from what they write (`language.ts`). The sender's own choice, in a group as well.
   */
  reply_language?: ChosenLanguage;
}

/**
 * A file's upload path as Claw reads it: relative to `.uploads/`, no `..` or empty segment, no backslash or control character, no
 * leading slash. Null for anything else, which names no file.
 */
export function uploadPathOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > FILE_PATH_MAX) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  return raw.split("/").some((s) => s === "" || s === "." || s === "..") ? null : raw;
}

function parseFiles(raw: unknown): ChannelFile[] {
  const files: ChannelFile[] = [];
  const seen = new Set<string>();
  for (const f of objects(raw)) {
    const path = uploadPathOf(f.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = str(f.name) ?? path.slice(path.lastIndexOf("/") + 1).slice(0, CONTEXT_STRING_MAX);
    const mediaType = str(f.media_type);
    const size = typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : undefined;
    files.push({
      path, name,
      ...(mediaType && /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? { media_type: mediaType.toLowerCase() } : {}),
      ...(size !== undefined ? { size } : {}),
    });
    if (files.length >= CONTEXT_FILES_MAX) break;
  }
  return files;
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
    const aliases = [...new Set((Array.isArray(p.aliases) ? p.aliases : []).map(str).filter((a): a is string => !!a))].slice(0, PERSON_ALIASES_MAX);
    people.push({ name, ...(userId ? { user_id: userId } : {}), ...(email ? { email } : {}), ...(aliases.length ? { aliases } : {}) });
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
  const handoffs = CHANNEL_HANDOFFS.filter((h) => Array.isArray(c.handoffs) && c.handoffs.includes(h));
  const channel = str(c.channel);
  const channelMessageId = str(c.channel_message_id);
  const attached = parseAttached(c.attached);
  const via = CHANNEL_VIAS.find((v) => v === c.via);
  return {
    ...(channel ? { channel } : {}), ...(via ? { via } : {}), ...(channelMessageId ? { channel_message_id: channelMessageId } : {}),
    people, actions, repos, handoffs, files: parseFiles(c.files),
    ...(attached !== undefined ? { attached } : {}),
    ...(isChosenLanguage(c.reply_language) ? { reply_language: c.reply_language } : {}),
  };
}

/**
 * The language the person chose to be answered in, as of the turn answering `messageId`: what that message's channel said
 * (`ChannelContext.reply_language`; nothing said is no choice, `/lang auto` included). A turn that answers no message of theirs (a
 * worker's report woke the assistant) follows their latest message to it. Null: no choice, and the language is read from their words.
 */
export async function chosenReplyLanguage(q: Querier, sessionId: string, messageId: string | null): Promise<ChosenLanguage | null> {
  const select = "SELECT channel_context->>'reply_language' AS chosen FROM claw_assistant_messages WHERE session_id = $1";
  type Row = { chosen: unknown };
  let row: Row | undefined = messageId
    ? (await q(`${select} AND message_id = $2`, [sessionId, messageId])).rows[0] as Row | undefined
    : undefined;
  row ??= (await q(`${select} ORDER BY received_at DESC LIMIT 1`, [sessionId])).rows[0] as Row | undefined;
  const chosen = row?.chosen;
  return isChosenLanguage(chosen) ? chosen : null;
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
 * other session: the row is what makes a router turn able to act, and only a router turn reads it. The words and the channel's
 * context are stored with credential-shaped content masked (`redactStoredText`, `redactStoredValue`); the turn's prompt is the
 * queued message, which is not.
 */
export async function recordAssistantMessage(tx: PoolClient, m: {
  sessionId: string; messageId: string; userId: string; userName?: string; content: string; attendedVia: AttendedVia | null; context: ChannelContext;
}): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context)
     SELECT $1, $2, $3, $7, $4, $5::jsonb, $6::jsonb
      WHERE EXISTS (SELECT 1 FROM claw_assistants WHERE session_id = $1 AND user_id = $3)
     ON CONFLICT (session_id, message_id) DO NOTHING`,
    [m.sessionId, m.messageId, m.userId, redactStoredText(m.content).text, m.attendedVia ? JSON.stringify(m.attendedVia) : null, JSON.stringify(redactStoredValue(m.context)),
      m.userName?.slice(0, CONTEXT_STRING_MAX) || null],
  );
  if (inserted.rowCount) {
    await tx.query(
      `DELETE FROM claw_assistant_messages WHERE session_id = $1 AND received_at < NOW() - $2::interval`,
      [m.sessionId, MESSAGE_RETENTION],
    );
    // The surface it came from (a channel that names none is Teams): where the person is reached when no message of theirs started
    // what is said (`preferredSurfaces`).
    await recordSurfaceUsed((text, params) => tx.query(text, params), m.userId, messageSurface(m.context.channel));
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
 * The turn answering this message was refused something only the person may do because the message came with a key, not with a
 * confirmed identity (`not_attended`). Only such a message is marked (attended_via NULL), so a say of the turn can tell the channel to
 * offer the person to confirm their identity once (`needs_identity`).
 */
export async function markIdentityRefused(q: Querier, sessionId: string, messageId: string): Promise<void> {
  await q(
    `UPDATE claw_assistant_messages SET identity_refused_at = NOW()
      WHERE session_id = $1 AND message_id = $2 AND attended_via IS NULL AND identity_refused_at IS NULL`,
    [sessionId, messageId],
  );
}

/** Whether the turn answering this message was refused for want of a confirmed identity ({@link markIdentityRefused}). */
export async function identityRefused(q: Querier, sessionId: string, messageId: string): Promise<boolean> {
  const row = (await q(
    "SELECT 1 AS x FROM claw_assistant_messages WHERE session_id = $1 AND message_id = $2 AND identity_refused_at IS NOT NULL",
    [sessionId, messageId],
  )).rows[0];
  return row !== undefined;
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
 * message queued behind it runs now. The report is not lost: it is on the item, which the next turn's list shows; an
 * answer the stopped turn did not say is said by the system when the turn ends (`tellUnsaidAnswers`), and an item that
 * needs the user and was not announced is the silent sweep's. A turn that answers the user is never stopped for another
 * of their messages.
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
