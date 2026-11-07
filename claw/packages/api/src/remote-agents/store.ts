// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Database access for remote agents.
 *
 * Every function that reads or changes a person's rows takes `owner` and puts it
 * in the WHERE clause, so a caller cannot reach another person's row by knowing
 * its id: the row is simply not found.
 */
import { randomUUID } from "node:crypto";
import { db, inTransaction, type Querier } from "../infra/db.js";
import {
  REMOTE_AGENT_TIMING, REMOTE_COMMANDS, REMOTE_COMMAND_TYPES,
  REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED,
  type ParsedRemoteEvent, type RemoteAgentDescriptor, type RemoteEventRejection, type RemoteHeartbeat,
} from "@claw/protocol";

export type Row = Record<string, any>;

/** Wakes this replica's command stream of a connector (`routes/remote-agents.ts` sets it); others poll within seconds. */
let commandWaker: (connectorId: string) => void = () => {};
export function setCommandWaker(wake: (connectorId: string) => void): void { commandWaker = wake; }
export function wakeConnector(connectorId: string): void { commandWaker(connectorId); }

const direct: Querier = (text, params) => db.query(text, params);
const secs = (ms: number) => ms / 1000;

/** Advisory-lock namespace for this module (two-key form, so it cannot meet a one-key lock). */
const LOCK_NS = 7_001;
const lock = (q: Querier, scope: string) => q("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NS, scope]);

export interface AuditEntry {
  owner: string;
  action: string;
  actor: string;
  client?: string | null;
  connectorId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  detail?: Record<string, unknown>;
}

export function writeAudit(q: Querier, e: AuditEntry): Promise<unknown> {
  return q(
    `INSERT INTO claw_remote_audit (owner_user_id, connector_id, agent_id, session_id, action, actor, client, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [e.owner, e.connectorId ?? null, e.agentId ?? null, e.sessionId ?? null, e.action, e.actor, e.client ?? null, JSON.stringify(e.detail ?? {})],
  );
}

/** `online` as a column of `claw_remote_connectors c`; `$1` is the window in seconds. */
const ONLINE_SQL = `COALESCE(c.revoked_at IS NULL
  AND c.heartbeat_at > NOW() - make_interval(secs => $1::float8)
  AND c.stream_seen_at > NOW() - make_interval(secs => $1::float8), FALSE) AS online`;

/** A connector row (revoked or not) that belongs to `owner`, with its presence. */
export async function findConnector(owner: string, connectorId: string, onlineWindowMs: number, q: Querier = direct): Promise<Row | null> {
  const r = await q(
    `SELECT c.*, ${ONLINE_SQL} FROM claw_remote_connectors c WHERE c.owner_user_id = $2 AND c.connector_id = $3`,
    [secs(onlineWindowMs), owner, connectorId],
  );
  return r.rows[0] ?? null;
}

/** Audit detail naming how the caller was authenticated, when that is known. */
const withCredential = (detail: Record<string, unknown>, credential: string | null): Record<string, unknown> =>
  credential ? { ...detail, credential } : detail;

export async function registerConnector(
  owner: string, name: string, version: string | null, client: string | null, maxPerUser: number,
  credential: string | null = null,
): Promise<Row | null> {
  return inTransaction(async (q) => {
    await lock(q, `connectors:${owner}`);
    const n = Number((await q(
      "SELECT COUNT(*) AS n FROM claw_remote_connectors WHERE owner_user_id = $1 AND revoked_at IS NULL", [owner],
    )).rows[0].n);
    if (n >= maxPerUser) return null;
    const row = (await q(
      `INSERT INTO claw_remote_connectors (connector_id, owner_user_id, name, version) VALUES ($1, $2, $3, $4)
       RETURNING connector_id, name, created_at`,
      [randomUUID(), owner, name, version],
    )).rows[0];
    await writeAudit(q, { owner, actor: owner, client, connectorId: row.connector_id, action: "connector.registered", detail: withCredential({ name }, credential) });
    return row;
  });
}

/** When the connector was last known to be alive, as a column of `claw_remote_connectors c`. */
export const LAST_SEEN_SQL = "GREATEST(c.heartbeat_at, c.stream_seen_at, c.stream_closed_at)";

/**
 * The caller's connectors that are not revoked, with their agents and presence: `online`, `last_seen_at`, and, while
 * offline, `offline_since` (when it was last seen before it went) and `offline_reason` (`presence.ts`).
 */
export async function listConnectors(owner: string, onlineWindowMs: number): Promise<Row[]> {
  const rows = (await direct(
    `SELECT c.connector_id, c.name, c.version, c.heartbeat_at, c.created_at, ${ONLINE_SQL},
            ${LAST_SEEN_SQL} AS last_seen_at, c.presence_state, c.offline_since, c.offline_reason, c.stream_end_reason
       FROM claw_remote_connectors c WHERE c.owner_user_id = $2 AND c.revoked_at IS NULL ORDER BY c.created_at`,
    [secs(onlineWindowMs), owner],
  )).rows;
  const connectors = rows.map(({ presence_state, offline_since, offline_reason, stream_end_reason, ...c }) => ({
    ...c,
    offline_since: c.online ? null : (presence_state === "offline" && offline_since ? offline_since : c.last_seen_at ?? null),
    offline_reason: c.online ? null : (presence_state === "offline" && offline_reason ? offline_reason : offlineReason(stream_end_reason)),
  }));
  const agents = (await direct(
    "SELECT connector_id, agent_id, kind, name, capabilities FROM claw_remote_agents WHERE owner_user_id = $1 ORDER BY agent_id", [owner],
  )).rows;
  return connectors.map((c) => ({
    ...c,
    agents: agents.filter((a) => a.connector_id === c.connector_id).map(({ connector_id: _c, ...a }) => a),
  }));
}

/**
 * Why a connector that is not revoked is offline, from how its last command stream ended: the server ended it because
 * its credential expired or was withdrawn (`auth_expired`), or it went otherwise and no heartbeat followed (`no_heartbeat`).
 */
export function offlineReason(streamEndReason: unknown): "auth_expired" | "no_heartbeat" {
  return streamEndReason === "token_expired" || streamEndReason === "revoked" ? "auth_expired" : "no_heartbeat";
}

/** Revoke one connector and close its sessions. False when it is not the caller's, or already revoked. */
export async function revokeConnector(owner: string, connectorId: string, client: string | null): Promise<boolean> {
  return inTransaction(async (q) => {
    const r = await q(
      `UPDATE claw_remote_connectors SET revoked_at = NOW(), stream_seen_at = NULL
        WHERE connector_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL RETURNING connector_id`,
      [connectorId, owner],
    );
    if (!r.rowCount) return false;
    await q("DELETE FROM claw_remote_commands WHERE connector_id = $1", [connectorId]);
    const closed = await q(
      "UPDATE claw_remote_sessions SET status = 'closed', updated_at = NOW() WHERE connector_id = $1 AND status = 'active' RETURNING session_id",
      [connectorId],
    );
    await writeAudit(q, {
      owner, actor: owner, client, connectorId, action: "connector.revoked",
      detail: { sessions_closed: closed.rowCount ?? 0 },
    });
    return true;
  });
}

/** Record a heartbeat: refresh presence, replace the advertised agents, forget acknowledged commands. */
export async function recordHeartbeat(connectorId: string, owner: string, hb: RemoteHeartbeat): Promise<void> {
  await inTransaction(async (q) => {
    await q(
      "UPDATE claw_remote_connectors SET heartbeat_at = NOW(), version = COALESCE($2, version) WHERE connector_id = $1",
      [connectorId, hb.version],
    );
    const ids = hb.agents.map((a: RemoteAgentDescriptor) => a.agent_id);
    await q("DELETE FROM claw_remote_agents WHERE connector_id = $1 AND NOT (agent_id = ANY($2::text[]))", [connectorId, ids]);
    for (const a of hb.agents) {
      await q(
        `INSERT INTO claw_remote_agents (connector_id, agent_id, owner_user_id, kind, name, capabilities)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (connector_id, agent_id) DO UPDATE
           SET kind = EXCLUDED.kind, name = EXCLUDED.name, capabilities = EXCLUDED.capabilities, updated_at = NOW()`,
        [connectorId, a.agent_id, owner, a.kind, a.name, JSON.stringify(a.capabilities)],
      );
    }
    // Every beat also clears what has expired, acknowledged or not: a connector that reconnects
    // after a long absence may send no cursor, and must not leave its stale prompts behind.
    await pruneCommands(q, connectorId, hb.cmdCursor ?? 0);
  });
}

/** The commands that are accepted only while the connector is online (`needsOnline`). */
const LIVE_COMMAND_TYPES: string[] = REMOTE_COMMAND_TYPES.filter((t) => REMOTE_COMMANDS[t].needsOnline);
const LIVE_COMMAND_TTL_SECS = REMOTE_AGENT_TIMING.liveCommandTtlMs / 1000;

/**
 * Whether a queued command is too old to be carried out, as a SQL condition on `claw_remote_commands`.
 * `typesParam` and `secsParam` are the positions of the two values it reads: {@link LIVE_COMMAND_TYPES}
 * and {@link LIVE_COMMAND_TTL_SECS}.
 *
 * Two bounds. Anything is dead after a day: an instruction nobody has collected for that long is not
 * one anybody still wants carried out. A command that needs a watcher (`prompt`, `set_mode`, `resume`)
 * is dead after minutes: it was accepted because the connector looked online, so one still uncollected
 * was sent into a connection that had died unnoticed (a closed laptop counts as online for up to the
 * online window), and delivering it when the machine wakes hours later would run it with nobody watching,
 * which is the case the `connector_offline` refusal exists to prevent. `cancel`, `close` and `decision`
 * are safe to deliver late and keep only the day.
 */
const expiredSql = (typesParam: number, secsParam: number): string =>
  `(created_at < NOW() - interval '1 day'
    OR (type = ANY($${typesParam}::text[]) AND created_at < NOW() - make_interval(secs => $${secsParam}::float8)))`;

/**
 * Forget commands the connector has handled, plus any that have expired ({@link expiredSql}).
 *
 * A prompt is stored here until it is delivered, and the audit trail keeps only
 * its hash, so this table must not become a second archive of what people typed.
 */
export async function pruneCommands(q: Querier, connectorId: string, upTo: number): Promise<void> {
  await q(
    `DELETE FROM claw_remote_commands WHERE connector_id = $1 AND (cmd_seq <= $2 OR ${expiredSql(3, 4)})`,
    [connectorId, upTo, LIVE_COMMAND_TYPES, LIVE_COMMAND_TTL_SECS],
  );
}

/**
 * Delete sessions that were closed more than `days` ago, and with them their stored events
 * (the foreign key cascades). Live sessions are never touched, and the audit trail has no
 * foreign key on purpose, so it keeps describing what was deleted. Deletes a bounded batch of
 * sessions at a time so one statement never holds a lock over an unbounded number of events;
 * returns how many sessions went.
 */
export async function pruneClosedSessions(days: number, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await direct(
      `DELETE FROM claw_remote_sessions WHERE session_id IN (
         SELECT session_id FROM claw_remote_sessions
          WHERE status = 'closed' AND updated_at < NOW() - make_interval(secs => $1::float8)
          ORDER BY updated_at LIMIT $2)`,
      [days * 86_400, batch],
    );
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

/**
 * A command stream is open, and is the connector's current one. Why the previous stream ended (`stream_end_reason`) is the
 * previous stream's: it is cleared, so a connector that reconnected after its token expired and later loses its heartbeat
 * is offline for the heartbeat, not for a sign-in (`offlineReason`). `stream_closed_at` stays: it is still when it was last seen.
 */
export async function markStreamOpen(connectorId: string, streamConn: string): Promise<void> {
  await direct(
    "UPDATE claw_remote_connectors SET stream_conn = $2, stream_seen_at = NOW(), stream_end_reason = NULL WHERE connector_id = $1",
    [connectorId, streamConn],
  );
}

/** Why a command stream must end, or null while it may go on. */
export async function streamVerdict(connectorId: string, streamConn: string): Promise<"revoked" | "superseded" | null> {
  const row = (await direct(
    "SELECT stream_conn, revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [connectorId],
  )).rows[0];
  if (!row || row.revoked_at) return "revoked";
  return row.stream_conn === streamConn ? null : "superseded";
}

export async function touchStream(connectorId: string, streamConn: string): Promise<void> {
  await direct(
    "UPDATE claw_remote_connectors SET stream_seen_at = NOW() WHERE connector_id = $1 AND stream_conn = $2 AND revoked_at IS NULL",
    [connectorId, streamConn],
  );
}

/**
 * The current stream has ended. `reason` is the last frame the server sent it (`token_expired`, `revoked`), or
 * `closed` when the connection simply went; kept with the time, so presence can say when it was last seen and why.
 */
export async function markStreamClosed(connectorId: string, streamConn: string, reason = "closed"): Promise<void> {
  await direct(
    `UPDATE claw_remote_connectors SET stream_seen_at = NULL, stream_closed_at = NOW(), stream_end_reason = $3
      WHERE connector_id = $1 AND stream_conn = $2`,
    [connectorId, streamConn, reason],
  );
}

export async function commandsAfter(connectorId: string, cursor: number, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT cmd_seq, cmd_id, session_id::text AS session_id, type, payload
       FROM claw_remote_commands WHERE connector_id = $1 AND cmd_seq > $2 AND NOT ${expiredSql(4, 5)}
      ORDER BY cmd_seq LIMIT $3`,
    [connectorId, cursor, limit, LIVE_COMMAND_TYPES, LIVE_COMMAND_TTL_SECS],
  )).rows;
}

export interface NewCommand {
  connectorId: string;
  cmdId: string;
  sessionId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Append a command to a connector's queue. Must run inside a transaction.
 *
 * Takes the connector row's lock first, so two writers get consecutive numbers
 * and the second cannot commit before the first: a stream that has read up to
 * number N can never later see N-1 appear. A repeat of `cmdId` is not queued
 * again; the original row comes back with `inserted: false`.
 */
export async function enqueueCommand(q: Querier, c: NewCommand): Promise<{ inserted: boolean; row: Row }> {
  await q("SELECT 1 FROM claw_remote_connectors WHERE connector_id = $1 FOR UPDATE", [c.connectorId]);
  // A connector that never acknowledges must not keep a user's prompts for ever: whoever is
  // still issuing commands to it clears out what is a day old.
  await pruneCommands(q, c.connectorId, 0);
  const dup = (await q(
    "SELECT cmd_seq, cmd_id, session_id::text AS session_id, type, payload FROM claw_remote_commands WHERE connector_id = $1 AND cmd_id = $2",
    [c.connectorId, c.cmdId],
  )).rows[0];
  if (dup) return { inserted: false, row: dup };
  const seq = (await q(
    "UPDATE claw_remote_connectors SET cmd_counter = cmd_counter + 1 WHERE connector_id = $1 RETURNING cmd_counter",
    [c.connectorId],
  )).rows[0].cmd_counter;
  const row = (await q(
    `INSERT INTO claw_remote_commands (connector_id, cmd_seq, cmd_id, session_id, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING cmd_seq, cmd_id, session_id::text AS session_id, type, payload`,
    [c.connectorId, seq, c.cmdId, c.sessionId, c.type, JSON.stringify(c.payload)],
  )).rows[0];
  return { inserted: true, row };
}

/** How many commands a person has issued in the last minute, from the durable trail. */
export async function recentCommandCount(q: Querier, owner: string): Promise<number> {
  return Number((await q(
    "SELECT COUNT(*) AS n FROM claw_remote_audit WHERE owner_user_id = $1 AND action = 'command.issued' AND ts > NOW() - interval '1 minute'",
    [owner],
  )).rows[0].n);
}

export async function findSession(owner: string, sessionId: string, q: Querier = direct): Promise<Row | null> {
  const r = await q(
    `SELECT session_id::text AS session_id, connector_id::text AS connector_id, agent_id, cwd, mode, status, created_at, updated_at
       FROM claw_remote_sessions WHERE owner_user_id = $1 AND session_id = $2`,
    [owner, sessionId],
  );
  return r.rows[0] ?? null;
}

export async function listSessions(owner: string, connectorId: string | null, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT session_id::text AS session_id, connector_id::text AS connector_id, agent_id, cwd, mode, status, created_at, updated_at
       FROM claw_remote_sessions
      WHERE owner_user_id = $1 AND ($2::uuid IS NULL OR connector_id = $2::uuid)
      ORDER BY created_at DESC LIMIT $3`,
    [owner, connectorId, limit],
  )).rows;
}

/** How many of a session's newest events {@link sessionActivity} reads, and how much of each one's text. */
export const ACTIVITY_EVENTS = 300;
const ACTIVITY_TEXT = 400;

/**
 * The owner's open sessions, newest activity first, each with its newest events cut down to what says what it is doing: the
 * type, when, the text of a message chunk or the title of a tool step (at most {@link ACTIVITY_TEXT} characters), a permission
 * request's id, a turn's stop reason, and whether the event is replayed history. `queued` counts prompts accepted for it that its connector has not
 * yet acknowledged. Nothing of anyone else's: every row is filtered on `owner`.
 */
export async function sessionActivity(owner: string, limit: number, events = ACTIVITY_EVENTS): Promise<Row[]> {
  return (await direct(
    `SELECT s.session_id::text AS session_id, s.connector_id::text AS connector_id, s.agent_id, s.cwd, s.mode,
            s.created_at, s.updated_at,
            (SELECT COUNT(*)::int FROM claw_remote_commands m
              WHERE m.connector_id = s.connector_id AND m.session_id = s.session_id AND m.type = 'prompt') AS queued,
            COALESCE((
              SELECT json_agg(x ORDER BY x.id) FROM (
                SELECT e.id, e.type, e.occurred_at,
                       LEFT(COALESCE(e.data->'update'->'content'->>'text', e.data->'update'->>'title', ''), $4) AS text,
                       e.data->>'actionId' AS action_id, e.data->>'stopReason' AS stop,
                       COALESCE(e.data->>'replay', '') = 'true' AS replay
                  FROM claw_remote_events e WHERE e.session_id = s.session_id ORDER BY e.id DESC LIMIT $3
              ) x
            ), '[]'::json) AS events
       FROM claw_remote_sessions s
      WHERE s.owner_user_id = $1 AND s.status = 'active'
      ORDER BY s.updated_at DESC LIMIT $2`,
    [owner, limit, events, ACTIVITY_TEXT],
  )).rows;
}

export async function eventsAfter(sessionId: string, cursor: number, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT id, seq, type, (EXTRACT(EPOCH FROM occurred_at) * 1000)::float8 AS ts, data
       FROM claw_remote_events WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [sessionId, cursor, limit],
  )).rows;
}

export interface IngestResult {
  acked: Record<string, number>;
  rejected: RemoteEventRejection[];
  /** Sessions that gained at least one new event, for waking their readers. */
  touched: string[];
}

/**
 * Store a connector's batch.
 *
 * One transaction under a per-connector lock, so two overlapping posts (a retry
 * that raced its own original) cannot commit a session's events out of order,
 * and a reader that has seen event N never later finds N-1 missing. A repeat of
 * an event already stored is ignored. Events for a session that is not this
 * connector's are refused individually, and say nothing about whether that
 * session exists.
 */
export async function ingestEvents(
  connector: { connector_id: string; owner_user_id: string }, events: ParsedRemoteEvent[], credential: string | null = null,
): Promise<IngestResult> {
  const owner = connector.owner_user_id;
  return inTransaction(async (q) => {
    await lock(q, `ingest:${connector.connector_id}`);
    const ids = [...new Set(events.map((e) => e.session_id))];
    const owned = new Map<string, string>();
    if (ids.length) {
      const r = await q(
        `SELECT session_id::text AS session_id, agent_id FROM claw_remote_sessions
          WHERE connector_id = $1 AND owner_user_id = $2 AND session_id = ANY($3::uuid[])`,
        [connector.connector_id, owner, ids],
      );
      for (const row of r.rows) owned.set(row.session_id, row.agent_id);
    }
    const rejected: RemoteEventRejection[] = [];
    const accepted: ParsedRemoteEvent[] = [];
    for (const e of events) {
      if (owned.has(e.session_id)) accepted.push(e);
      else rejected.push({ index: e.index, session_id: e.session_id, seq: e.seq, reason: "unknown_session" });
    }
    const touched = new Set<string>();
    const closed = new Set<string>();
    if (accepted.length) {
      const inserted = (await q(
        `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data)
         SELECT s, n, t, to_timestamp(ms / 1000.0), d
           FROM unnest($1::uuid[], $2::bigint[], $3::text[], $4::float8[], $5::jsonb[]) AS u(s, n, t, ms, d)
         ON CONFLICT (session_id, seq) DO NOTHING
         RETURNING session_id::text AS session_id, seq, type, data`,
        [
          accepted.map((e) => e.session_id), accepted.map((e) => e.seq), accepted.map((e) => e.type),
          accepted.map((e) => e.ts), accepted.map((e) => JSON.stringify(e.data)),
        ],
      )).rows;
      for (const row of inserted) {
        touched.add(row.session_id);
        const d = (row.data ?? {}) as Record<string, any>;
        const base = { owner, actor: connector.connector_id, connectorId: connector.connector_id, agentId: owned.get(row.session_id), sessionId: row.session_id };
        if (row.type === REMOTE_EVENT_PERMISSION_REQUEST) {
          await writeAudit(q, { ...base, action: "permission.requested", detail: withCredential({ action_id: str(d.actionId), kind: str(d.kind), tool: str(d.tool, 200) }, credential) });
        } else if (row.type === REMOTE_EVENT_PERMISSION_RESOLVED) {
          await writeAudit(q, { ...base, action: "permission.resolved", detail: withCredential({ action_id: str(d.actionId), option_id: str(d.optionId), by: str(d.by) }, credential) });
        } else if (row.type === REMOTE_EVENT_SESSION_CLOSED) {
          closed.add(row.session_id);
        }
      }
    }
    if (touched.size) {
      await q("UPDATE claw_remote_sessions SET updated_at = NOW() WHERE session_id = ANY($1::uuid[])", [[...touched]]);
    }
    if (closed.size) {
      await q("UPDATE claw_remote_sessions SET status = 'closed' WHERE session_id = ANY($1::uuid[])", [[...closed]]);
    }
    const acked: Record<string, number> = {};
    const answered = [...new Set(accepted.map((e) => e.session_id))];
    if (answered.length) {
      const r = await q(
        "SELECT session_id::text AS session_id, MAX(seq) AS seq FROM claw_remote_events WHERE session_id = ANY($1::uuid[]) GROUP BY session_id",
        [answered],
      );
      for (const row of r.rows) acked[row.session_id] = Number(row.seq);
    }
    return { acked, rejected, touched: [...touched] };
  });
}

const str = (v: unknown, max = 128): string | null => (typeof v === "string" ? v.slice(0, max) : null);

export async function listAudit(owner: string, filter: { sessionId: string | null; connectorId: string | null }, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT id, ts, connector_id::text AS connector_id, agent_id, session_id::text AS session_id, action, actor, client, detail
       FROM claw_remote_audit
      WHERE owner_user_id = $1 AND ($2::uuid IS NULL OR session_id = $2::uuid) AND ($3::uuid IS NULL OR connector_id = $3::uuid)
      ORDER BY id DESC LIMIT $4`,
    [owner, filter.sessionId, filter.connectorId, limit],
  )).rows;
}


/**
 * The command already issued to this connector under `cmdId`, read from the audit trail, shaped like
 * the queue row it replaces for the fields a caller compares (`type`, `session_id`, and a decision's
 * `payload.option_id`). Null when there is none.
 */
async function commandIssued(q: Querier, owner: string, connectorId: string, cmdId: string): Promise<Row | null> {
  const a = (await q(
    `SELECT session_id::text AS session_id, detail FROM claw_remote_audit
      WHERE owner_user_id = $1 AND connector_id = $2 AND action = 'command.issued' AND detail->>'cmd_id' = $3
      ORDER BY id LIMIT 1`,
    [owner, connectorId, cmdId],
  )).rows[0];
  if (!a) return null;
  return { cmd_seq: null, cmd_id: cmdId, session_id: a.session_id, type: a.detail?.type, payload: { option_id: a.detail?.option_id } };
}

export type IssueOutcome =
  | { status: "rate_limited" }
  | { status: "queued" | "duplicate"; row: Row };

export interface IssueRequest {
  owner: string;
  client: string | null;
  connectorId: string;
  agentId: string;
  sessionId: string;
  type: string;
  cmdId: string;
  payload: Record<string, unknown>;
  /** What the audit trail keeps about this command. */
  auditDetail: Record<string, unknown>;
  closesSession: boolean;
  commandsPerMinute: number;
}

/**
 * Queue one command into an existing session, audit it, and apply its effect on
 * the session row, all or nothing. The per-minute limit is counted from the
 * audit trail under a per-user lock, so two requests racing for the last slot
 * cannot both take it.
 */
export async function issueCommand(r: IssueRequest): Promise<IssueOutcome> {
  return inTransaction(async (q) => {
    await lock(q, `commands:${r.owner}`);
    // A repeat of a command already queued is answered with the original and
    // does not count against the limit, so a client may retry freely.
    const dup = (await q(
      "SELECT cmd_seq, cmd_id, session_id::text AS session_id, type, payload FROM claw_remote_commands WHERE connector_id = $1 AND cmd_id = $2",
      [r.connectorId, r.cmdId],
    )).rows[0];
    if (dup) return { status: "duplicate", row: dup } as IssueOutcome;
    // A heartbeat deletes the queue row once the connector has handled the command, and a retry
    // may arrive after that (the response was lost, the connector ran it, the next heartbeat
    // acknowledged it). The queue no longer remembers the command, so the audit trail, which is
    // never pruned, does: for every command, not only a decision, or the retry would run it twice.
    const prior = await commandIssued(q, r.owner, r.connectorId, r.cmdId);
    if (prior) return { status: "duplicate", row: prior } as IssueOutcome;
    if (await recentCommandCount(q, r.owner) >= r.commandsPerMinute) return { status: "rate_limited" } as IssueOutcome;
    const queued = await enqueueCommand(q, { connectorId: r.connectorId, cmdId: r.cmdId, sessionId: r.sessionId, type: r.type, payload: r.payload });
    await writeAudit(q, {
      owner: r.owner, actor: r.owner, client: r.client, connectorId: r.connectorId, agentId: r.agentId, sessionId: r.sessionId,
      action: "command.issued", detail: { type: r.type, cmd_id: r.cmdId, ...r.auditDetail },
    });
    if (r.closesSession) {
      await q("UPDATE claw_remote_sessions SET status = 'closed', updated_at = NOW() WHERE session_id = $1", [r.sessionId]);
    }
    return { status: "queued", row: queued.row } as IssueOutcome;
  });
}

export type CreateSessionOutcome =
  | { status: "limit" } | { status: "rate_limited" }
  | { status: "created"; session: Row; reclaimed: Array<{ session_id: string; connector_id: string }> };

/**
 * When a session nobody is using may be closed to make room for a new one (`createSession` at the limit): no event for this long,
 * no command waiting for its connector, no turn under way and no approval waiting for the user.
 */
export const SESSION_RECLAIM_IDLE_MS = 30 * 60_000;
/** A session with no event for this long may be closed to make room whatever its last events say (a turn whose machine went away). */
export const SESSION_RECLAIM_STALE_MS = 24 * 60 * 60_000;
/** The events that mean a turn is under way when they come after the last `turn_end` (as `readSession` in `devenv-tools.ts` reads them). */
const TURN_EVENT_TYPES = [
  "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "user_message_chunk",
  REMOTE_EVENT_PERMISSION_REQUEST, "permission_auto_allowed",
];

interface Reclaimable { session_id: string; connector_id: string; agent_id: string; updated_at: unknown }

/**
 * The owner's open sessions that may be closed to make room for `need` new ones, the ones on a machine that is offline first, then
 * the longest unused; [] when fewer than `need` may. Sessions are never closed on their own: only here, when the person opens one
 * more than they may have open, so a session left behind (a phone that never closed it, a chat that moved on) does not keep them
 * out for good. One at work, waiting for their approval, or with a command its connector has not collected is never closed, unless
 * nothing has come from it for a day.
 */
async function reclaimable(q: Querier, owner: string, need: number, onlineWindowMs: number): Promise<Reclaimable[]> {
  // Locked as read: an event a connector is storing now commits first, and a session it moved is then read again (and kept).
  const rows = (await q(
    `SELECT s.session_id::text AS session_id, s.connector_id::text AS connector_id, s.agent_id, s.updated_at,
            COALESCE(c.revoked_at IS NULL AND c.heartbeat_at > NOW() - make_interval(secs => $2::float8)
              AND c.stream_seen_at > NOW() - make_interval(secs => $2::float8), FALSE) AS online
       FROM claw_remote_sessions s JOIN claw_remote_connectors c ON c.connector_id = s.connector_id
      WHERE s.owner_user_id = $1 AND s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM claw_remote_commands m WHERE m.connector_id = s.connector_id AND m.session_id = s.session_id)
        AND (s.updated_at < NOW() - make_interval(secs => $4::float8)
          OR (s.updated_at < NOW() - make_interval(secs => $3::float8)
            AND COALESCE((SELECT MAX(e.id) FROM claw_remote_events e
                           WHERE e.session_id = s.session_id AND e.type = ANY($5::text[]) AND COALESCE(e.data->>'replay', '') <> 'true'), 0)
              <= COALESCE((SELECT MAX(e.id) FROM claw_remote_events e WHERE e.session_id = s.session_id AND e.type = 'turn_end'), 0)
            AND NOT EXISTS (
              SELECT 1 FROM claw_remote_events r
               WHERE r.session_id = s.session_id AND r.type = $6 AND COALESCE(r.data->>'replay', '') <> 'true'
                 AND NOT EXISTS (SELECT 1 FROM claw_remote_events d
                                  WHERE d.session_id = s.session_id AND d.type = $7 AND d.data->>'actionId' = r.data->>'actionId'))))
      ORDER BY online, s.updated_at
      LIMIT $8
        FOR UPDATE OF s`,
    [owner, secs(onlineWindowMs), secs(SESSION_RECLAIM_IDLE_MS), secs(SESSION_RECLAIM_STALE_MS), TURN_EVENT_TYPES,
      REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, need],
  )).rows as Reclaimable[];
  return rows.length >= need ? rows : [];
}

/**
 * Create a session and queue the command that makes the connector start it, or refuse at the limits. At the limit of open sessions,
 * the ones nobody is using are closed to make room ({@link reclaimable}): each gets a `close` for its connector (the caller wakes
 * those, `reclaimed`) and a `session.reclaimed` audit naming the session it made room for. Only when no session may be closed is
 * the answer `limit`.
 */
export async function createSession(p: {
  owner: string; client: string | null; connectorId: string; agentId: string; cwd: string; mode: string | null;
  /** Forwarded to the connector as given; never stored on the row (the connector keeps what it needs). */
  resumeRef?: string | null;
  maxActive: number; commandsPerMinute: number;
  /** The connector presence window, which orders the sessions closed to make room (an offline machine's first). */
  onlineWindowMs?: number;
}): Promise<CreateSessionOutcome> {
  return inTransaction(async (q) => {
    await lock(q, `sessions:${p.owner}`);
    await lock(q, `commands:${p.owner}`);
    const n = Number((await q(
      "SELECT COUNT(*) AS n FROM claw_remote_sessions WHERE owner_user_id = $1 AND status = 'active'", [p.owner],
    )).rows[0].n);
    const victims = n >= p.maxActive
      ? await reclaimable(q, p.owner, n - p.maxActive + 1, p.onlineWindowMs ?? REMOTE_AGENT_TIMING.onlineWindowMs)
      : [];
    if (n >= p.maxActive && !victims.length) return { status: "limit" } as CreateSessionOutcome;
    if (await recentCommandCount(q, p.owner) >= p.commandsPerMinute) return { status: "rate_limited" } as CreateSessionOutcome;
    const sessionId = randomUUID();
    const session = (await q(
      `INSERT INTO claw_remote_sessions (session_id, owner_user_id, connector_id, agent_id, cwd, mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING session_id::text AS session_id, connector_id::text AS connector_id, agent_id, cwd, mode, status, created_at, updated_at`,
      [sessionId, p.owner, p.connectorId, p.agentId, p.cwd, p.mode],
    )).rows[0];
    const cmdId = randomUUID();
    await enqueueCommand(q, {
      connectorId: p.connectorId, cmdId, sessionId, type: "session.new",
      payload: { agent_id: p.agentId, cwd: p.cwd, mode: p.mode, ...(p.resumeRef ? { resume_ref: p.resumeRef } : {}) },
    });
    const base = { owner: p.owner, actor: p.owner, client: p.client, connectorId: p.connectorId, agentId: p.agentId, sessionId };
    await writeAudit(q, { ...base, action: "session.created", detail: { cwd: p.cwd, mode: p.mode, ...(p.resumeRef ? { resume_ref: p.resumeRef } : {}) } });
    await writeAudit(q, { ...base, action: "command.issued", detail: { type: "session.new", cmd_id: cmdId } });
    for (const v of victims) {
      // Closed as `/agent close` closes it: its connector is told (a close is delivered late too), and the row is closed now.
      const closeId = randomUUID();
      await enqueueCommand(q, { connectorId: v.connector_id, cmdId: closeId, sessionId: v.session_id, type: "close", payload: {} });
      await q("UPDATE claw_remote_sessions SET status = 'closed', updated_at = NOW() WHERE session_id = $1", [v.session_id]);
      await writeAudit(q, {
        owner: p.owner, actor: p.owner, client: p.client, connectorId: v.connector_id, agentId: v.agent_id, sessionId: v.session_id,
        action: "session.reclaimed",
        detail: { cmd_id: closeId, for_session: sessionId, idle_since: v.updated_at instanceof Date ? v.updated_at.toISOString() : String(v.updated_at) },
      });
    }
    return {
      status: "created", session, reclaimed: victims.map((v) => ({ session_id: v.session_id, connector_id: v.connector_id })),
    } as CreateSessionOutcome;
  });
}

/**
 * What the event log says about one permission request: the options it offered,
 * and whether it has already been answered. The log is the only record of
 * either, so a decision is checked against what the agent actually asked.
 */
export async function permissionState(sessionId: string, actionId: string): Promise<{ options: string[] | null; resolved: boolean }> {
  const asked = (await direct(
    `SELECT data FROM claw_remote_events WHERE session_id = $1 AND type = $2 AND data->>'actionId' = $3 ORDER BY id DESC LIMIT 1`,
    [sessionId, REMOTE_EVENT_PERMISSION_REQUEST, actionId],
  )).rows[0];
  if (!asked) return { options: null, resolved: false };
  const list = Array.isArray(asked.data?.options) ? asked.data.options : [];
  const options = list.map((o: any) => o?.optionId).filter((v: unknown): v is string => typeof v === "string");
  const answered = (await direct(
    `SELECT 1 FROM claw_remote_events WHERE session_id = $1 AND type = $2 AND data->>'actionId' = $3 LIMIT 1`,
    [sessionId, REMOTE_EVENT_PERMISSION_RESOLVED, actionId],
  )).rows.length > 0;
  return { options, resolved: answered };
}
