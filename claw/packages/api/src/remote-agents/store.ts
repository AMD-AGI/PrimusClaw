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
  REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED,
  type ParsedRemoteEvent, type RemoteAgentDescriptor, type RemoteEventRejection, type RemoteHeartbeat,
} from "@claw/protocol";

export type Row = Record<string, any>;

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

export async function listConnectors(owner: string, onlineWindowMs: number): Promise<Row[]> {
  const connectors = (await direct(
    `SELECT c.connector_id, c.name, c.version, c.heartbeat_at, c.created_at, ${ONLINE_SQL}
       FROM claw_remote_connectors c WHERE c.owner_user_id = $2 AND c.revoked_at IS NULL ORDER BY c.created_at`,
    [secs(onlineWindowMs), owner],
  )).rows;
  const agents = (await direct(
    "SELECT connector_id, agent_id, kind, name, capabilities FROM claw_remote_agents WHERE owner_user_id = $1 ORDER BY agent_id", [owner],
  )).rows;
  return connectors.map((c) => ({
    ...c,
    agents: agents.filter((a) => a.connector_id === c.connector_id).map(({ connector_id: _c, ...a }) => a),
  }));
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
    if (hb.cmdCursor !== null) await pruneCommands(q, connectorId, hb.cmdCursor);
  });
}

/**
 * Forget commands the connector has handled, plus any a day old.
 *
 * A prompt is stored here until it is delivered, and the audit trail keeps only
 * its hash, so this table must not become a second archive of what people typed.
 * The day is also a deliberate bound on delivery: an instruction that nobody has
 * collected for that long is not one anybody still wants carried out, and a
 * permission answer is worthless long before it (the connector gives up on the
 * request after minutes).
 */
export async function pruneCommands(q: Querier, connectorId: string, upTo: number): Promise<void> {
  await q(
    "DELETE FROM claw_remote_commands WHERE connector_id = $1 AND (cmd_seq <= $2 OR created_at < NOW() - interval '1 day')",
    [connectorId, upTo],
  );
}

export async function markStreamOpen(connectorId: string, streamConn: string): Promise<void> {
  await direct(
    "UPDATE claw_remote_connectors SET stream_conn = $2, stream_seen_at = NOW() WHERE connector_id = $1",
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

export async function markStreamClosed(connectorId: string, streamConn: string): Promise<void> {
  await direct(
    "UPDATE claw_remote_connectors SET stream_seen_at = NULL WHERE connector_id = $1 AND stream_conn = $2",
    [connectorId, streamConn],
  );
}

export async function commandsAfter(connectorId: string, cursor: number, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT cmd_seq, cmd_id, session_id::text AS session_id, type, payload
       FROM claw_remote_commands WHERE connector_id = $1 AND cmd_seq > $2 ORDER BY cmd_seq LIMIT $3`,
    [connectorId, cursor, limit],
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

export type CreateSessionOutcome = { status: "limit" } | { status: "rate_limited" } | { status: "created"; session: Row };

/** Create a session and queue the command that makes the connector start it, or refuse at the limits. */
export async function createSession(p: {
  owner: string; client: string | null; connectorId: string; agentId: string; cwd: string; mode: string | null;
  maxActive: number; commandsPerMinute: number;
}): Promise<CreateSessionOutcome> {
  return inTransaction(async (q) => {
    await lock(q, `sessions:${p.owner}`);
    await lock(q, `commands:${p.owner}`);
    const n = Number((await q(
      "SELECT COUNT(*) AS n FROM claw_remote_sessions WHERE owner_user_id = $1 AND status = 'active'", [p.owner],
    )).rows[0].n);
    if (n >= p.maxActive) return { status: "limit" } as CreateSessionOutcome;
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
      payload: { agent_id: p.agentId, cwd: p.cwd, mode: p.mode },
    });
    const base = { owner: p.owner, actor: p.owner, client: p.client, connectorId: p.connectorId, agentId: p.agentId, sessionId };
    await writeAudit(q, { ...base, action: "session.created", detail: { cwd: p.cwd, mode: p.mode } });
    await writeAudit(q, { ...base, action: "command.issued", detail: { type: "session.new", cmd_id: cmdId } });
    return { status: "created", session } as CreateSessionOutcome;
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
