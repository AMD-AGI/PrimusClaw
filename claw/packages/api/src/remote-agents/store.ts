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
import { redactPublicJson } from "../events/redaction.js";
import {
  REMOTE_AGENT_TIMING, REMOTE_COMMANDS, REMOTE_COMMAND_TYPES,
  REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED, REMOTE_EVENT_SESSION_CLOSED, REMOTE_EVENT_USER_PROMPT,
  type ParsedRemoteEvent, type RemoteAgentDescriptor, type RemoteEventRejection, type RemoteHeartbeat,
} from "@claw/protocol";

export type Row = Record<string, any>;

/** Wakes this replica's command stream of a connector (`routes/remote-agents.ts` sets it); others poll within seconds. */
let commandWaker: (connectorId: string) => void = () => {};
export function setCommandWaker(wake: (connectorId: string) => void): void { commandWaker = wake; }
export function wakeConnector(connectorId: string): void { commandWaker(connectorId); }

/** Wakes this replica's readers of a session's events (`routes/remote-agents.ts` sets it); others poll within seconds. */
let sessionWaker: (sessionId: string) => void = () => {};
export function setSessionWaker(wake: (sessionId: string) => void): void { sessionWaker = wake; }

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

/**
 * How long a connector whose command stream has just ended still counts as online, when its heartbeat is fresh: the time it takes to
 * open the next one. A replica that shuts down gracefully keeps its streams' connectors online itself (`markStreamClosed`'s
 * `restart`); one that crashed or was killed, an ingress or gateway restart, or a token refresh ends a stream with no such word, and
 * the connector is back within seconds (2-7 s measured over four releases on 2026-11-07). A session asked for in that gap is queued
 * and delivered on the new stream instead of refused with `connector_offline` and "restart the connector". Never longer than the
 * online window itself.
 */
export const STREAM_GRACE_SECS = 45;

/**
 * Whether a connector is online, as a boolean SQL expression on `claw_remote_connectors c`: not revoked, its last heartbeat at most
 * the window old (`$<windowParam>`, in seconds), and its command stream open, or closed less than {@link STREAM_GRACE_SECS} ago.
 * Every place that decides presence uses it (`presence.ts`, `assistant/remote-items.ts`), so they cannot disagree.
 */
export const onlineSql = (windowParam: number): string => `COALESCE(c.revoked_at IS NULL
  AND c.heartbeat_at > NOW() - make_interval(secs => $${windowParam}::float8)
  AND (c.stream_seen_at > NOW() - make_interval(secs => $${windowParam}::float8)
       OR (c.stream_seen_at IS NULL
           AND c.stream_closed_at > NOW() - make_interval(secs => LEAST($${windowParam}::float8, ${STREAM_GRACE_SECS})))), FALSE)`;

/** `online` as a column of `claw_remote_connectors c`; `$1` is the window in seconds. */
const ONLINE_COND = onlineSql(1);
const ONLINE_SQL = `${ONLINE_COND} AS online`;

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

/** A connector grant may not register this way (`registerConnector` with a grant id): its row was revoked, or another name. */
export class GrantRegistrationRefused extends Error {
  constructor(readonly reason: "revoked" | "name_mismatch") { super(`connector grant registration refused: ${reason}`); }
}

export async function registerConnector(
  owner: string, name: string, version: string | null, client: string | null, maxPerUser: number,
  credential: string | null = null, onlineWindowMs: number | null = null,
  /** What else ends with a row replaced here, in this transaction (as `revokeConnector`'s `alsoInTransaction`). */
  alsoOnReplace?: (q: Querier, connectorId: string) => Promise<void>,
  /** A connector grant (`pairing.ts`) the caller registers with: bound to the new row in this same transaction. */
  grantId: string | null = null,
): Promise<(Row & { replaced: string[]; closedSessions: string[] }) | null> {
  try {
    return await registerIn(owner, name, version, client, maxPerUser, credential, onlineWindowMs, alsoOnReplace, grantId);
  } catch (err) {
    if (err instanceof ConnectorLimitReached) return null;
    throw err;
  }
}

/**
 * Thrown inside `registerIn`'s transaction when the owner has no place left even after the rows it replaced: the transaction rolls
 * back, so a refused registration replaces nothing. Committed, those rows would be revoked and their sessions closed with nobody
 * told (the caller says the closes only of a registration that succeeded), and a paired machine's grant would point at its revoked
 * row and be refused for good.
 */
class ConnectorLimitReached extends Error {}

async function registerIn(
  owner: string, name: string, version: string | null, client: string | null, maxPerUser: number,
  credential: string | null, onlineWindowMs: number | null,
  alsoOnReplace: ((q: Querier, connectorId: string) => Promise<void>) | undefined, grantId: string | null,
): Promise<Row & { replaced: string[]; closedSessions: string[] }> {
  return inTransaction(async (q) => {
    await lock(q, `connectors:${owner}`);
    // A connector that lost its local state registers afresh under the same name, and the row it had stays behind offline for
    // good: a stale twin the owner cannot tell from the real one. Rows of this owner with this name that are offline (as
    // `ONLINE_SQL`, with `onlineWindowMs` as its window) are revoked here, as `revokeConnector` does, before the count. One online
    // is another process holding that name and is left alone, and so is one made within the window (registered, not yet
    // connected). Should a machine whose row was revoked this way come back after all, it is told `revoked` and stops. A registration
    // the limit refuses rolls all of it back (`ConnectorLimitReached`): nothing is replaced unless the new row is made.
    const replaced: string[] = [];
    // The sessions the replaced rows had, closed with them (`revokeIn`): the caller tells their readers and items.
    const closedSessions: string[] = [];
    if (grantId) {
      // A paired machine's grant (`pairing.ts`) replaces no row but its own: never another machine of the owner's, whatever name it
      // gives. Bound already, it registers again only under its own row's name, and that row is the one replaced; a grant whose row
      // was revoked (`/agent off`) is over, here too, in this transaction.
      const g = (await q("SELECT connector_id::text AS connector_id, revoked_at FROM claw_remote_grants WHERE grant_id = $1 FOR UPDATE",
        [grantId])).rows[0] as { connector_id: string | null; revoked_at: Date | null } | undefined;
      if (!g || g.revoked_at) throw new GrantRegistrationRefused("revoked");
      if (g.connector_id) {
        const own = (await q("SELECT name, revoked_at FROM claw_remote_connectors WHERE connector_id = $1 AND owner_user_id = $2 FOR UPDATE",
          [g.connector_id, owner])).rows[0] as { name: string; revoked_at: Date | null } | undefined;
        if (!own || own.revoked_at) throw new GrantRegistrationRefused("revoked");
        if (own.name !== name) throw new GrantRegistrationRefused("name_mismatch");
        const closed = await revokeIn(q, owner, g.connector_id, client, { reason: "replaced_by_same_name" });
        if (closed) {
          closedSessions.push(...closed);
          await alsoOnReplace?.(q, g.connector_id);
          replaced.push(g.connector_id);
        }
      }
    } else if (onlineWindowMs !== null) {
      const stale = (await q(
        `SELECT c.connector_id FROM claw_remote_connectors c
          WHERE c.owner_user_id = $2 AND c.name = $3 AND c.revoked_at IS NULL
            AND c.created_at < NOW() - make_interval(secs => $1::float8) AND NOT ${ONLINE_COND}
          ORDER BY c.created_at FOR UPDATE`,
        [secs(onlineWindowMs), owner, name],
      )).rows.map((r) => String(r.connector_id));
      for (const id of stale) {
        const closed = await revokeIn(q, owner, id, client, { reason: "replaced_by_same_name" });
        if (!closed) continue;
        closedSessions.push(...closed);
        await alsoOnReplace?.(q, id);
        replaced.push(id);
      }
    }
    const n = Number((await q(
      "SELECT COUNT(*) AS n FROM claw_remote_connectors WHERE owner_user_id = $1 AND revoked_at IS NULL", [owner],
    )).rows[0].n);
    if (n >= maxPerUser) throw new ConnectorLimitReached();
    const row = (await q(
      `INSERT INTO claw_remote_connectors (connector_id, owner_user_id, name, version) VALUES ($1, $2, $3, $4)
       RETURNING connector_id, name, created_at`,
      [randomUUID(), owner, name, version],
    )).rows[0];
    // In the transaction that may have revoked the grant's previous row (same name, above): never a moment, nor a failure in
    // between, in which the grant points at a revoked row and is refused for good.
    if (grantId) {
      await q("UPDATE claw_remote_grants SET connector_id = $2 WHERE grant_id = $1 AND revoked_at IS NULL", [grantId, row.connector_id]);
    }
    await writeAudit(q, {
      owner, actor: owner, client, connectorId: row.connector_id, action: "connector.registered",
      detail: withCredential(replaced.length ? { name, replaced } : { name }, credential),
    });
    return { ...row, replaced, closedSessions };
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
            ${LAST_SEEN_SQL} AS last_seen_at, c.presence_state, c.offline_since, c.offline_reason, c.stream_end_reason,
            -- Connected with a pairing code (a connector grant), not a login: connecting it again is a new pairing command.
            EXISTS (SELECT 1 FROM claw_remote_grants g WHERE g.connector_id = c.connector_id) AS paired
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

/**
 * Revoke one connector and close its sessions. Null when it is not the caller's, or already revoked; else the sessions it closed,
 * each of which gained Claw's own `session_closed` (`revokeIn`), for the caller to tell their readers and items.
 */
export async function revokeConnector(
  owner: string, connectorId: string, client: string | null, alsoInTransaction?: (q: Querier) => Promise<void>,
): Promise<string[] | null> {
  return inTransaction(async (q) => {
    const closed = await revokeIn(q, owner, connectorId, client);
    if (!closed) return null;
    // What else ends with the machine (the cards that would send to it: `closeCardsOfConnector`), in the same transaction, so a
    // revoked machine never leaves a card that still waits for the person.
    await alsoInTransaction?.(q);
    return closed;
  });
}

/**
 * The `seq` of the `session_closed` Claw writes in a session it closed because its connector was revoked (`revokeIn`): negative,
 * so it never meets a connector's own numbering, below every `-cmd_seq` of `expireUndelivered`, and one per session (a session
 * closes once).
 */
export const REVOKED_CLOSE_SEQ = -Number.MAX_SAFE_INTEGER;

/**
 * The `seq` of the `user_prompt` Claw writes for the prompt it queued as command `cmdSeq` ({@link issueCommand}): negative, so it
 * never meets a connector's own numbering; offset by 2^52, so it never meets the `-cmd_seq` of the `turn_end` that
 * `expireUndelivered` may write for the same prompt; above {@link REVOKED_CLOSE_SEQ}; one per prompt.
 */
export const USER_PROMPT_SEQ_OFFSET = 2 ** 52;
export const userPromptSeq = (cmdSeq: number): number => -(USER_PROMPT_SEQ_OFFSET + cmdSeq);

/** Why Claw closed a session whose connector was revoked: `replaced` when the same machine registered again in its place. */
export const SESSION_CLOSED_CONNECTOR_REVOKED = "connector_revoked";
export const SESSION_CLOSED_MACHINE_REPLACED = "machine_reconnected";

/**
 * `revokeConnector` inside a transaction the caller holds; `detail` is added to its audit row. Null when nothing was revoked, else
 * the sessions closed. Its queued commands go, so nothing the machine never collected can end a turn later: each closed session
 * gains a `session_closed` of Claw's own, which ends whatever waits on it (an item's open prompt, a chat attached to it) as the
 * machine's own close would; without it they waited for an end that cannot come.
 */
async function revokeIn(
  q: Querier, owner: string, connectorId: string, client: string | null, detail: Record<string, unknown> = {},
): Promise<string[] | null> {
  const r = await q(
    `UPDATE claw_remote_connectors SET revoked_at = NOW(), stream_seen_at = NULL
      WHERE connector_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL RETURNING connector_id`,
    [connectorId, owner],
  );
  if (!r.rowCount) return null;
  await q("DELETE FROM claw_remote_commands WHERE connector_id = $1", [connectorId]);
  const closed = (await q(
    "UPDATE claw_remote_sessions SET status = 'closed', updated_at = NOW() WHERE connector_id = $1 AND status = 'active' RETURNING session_id",
    [connectorId],
  )).rows.map((x) => String(x.session_id));
  const reason = detail.reason === "replaced_by_same_name" ? SESSION_CLOSED_MACHINE_REPLACED : SESSION_CLOSED_CONNECTOR_REVOKED;
  if (closed.length) {
    await q(
      `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data)
       SELECT sid, $2, $3, NOW(), $4::jsonb FROM unnest($1::uuid[]) AS sid
       ON CONFLICT (session_id, seq) DO NOTHING`,
      [closed, REVOKED_CLOSE_SEQ, REMOTE_EVENT_SESSION_CLOSED, JSON.stringify({ reason, by: "claw" })],
    );
  }
  await writeAudit(q, {
    owner, actor: owner, client, connectorId, action: "connector.revoked",
    detail: { ...detail, sessions_closed: closed.length },
  });
  return closed;
}

/**
 * Record a heartbeat: refresh presence, replace the advertised agents, forget acknowledged commands, and end what was never
 * delivered (`expireUndelivered`). Returns the sessions that gained an event by it, for the caller to tell their readers and items.
 */
export async function recordHeartbeat(connectorId: string, owner: string, hb: RemoteHeartbeat): Promise<Undelivered[]> {
  return inTransaction(async (q) => {
    // Every beat also clears what has expired, acknowledged or not: a connector that reconnects
    // after a long absence may send no cursor, and must not leave its stale prompts behind.
    await pruneCommands(q, connectorId, hb.cmdCursor ?? 0);
    // What is left is not acknowledged. One too old to deliver, queued before its machine went away, is ended now, judged by the
    // beat before this one (whether the machine had already missed one when it was queued), which this beat is about to replace.
    const undelivered = await expireUndelivered(q, { connectorId });
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
    return undelivered;
  });
}

/**
 * The commands that are accepted only while the connector is online (`needsOnline`), and `session.new`, which is refused the same
 * way (`connector_offline`): a session nobody could see being opened must not start hours later, when the machine wakes.
 */
const LIVE_COMMAND_TYPES: string[] = [...REMOTE_COMMAND_TYPES.filter((t) => REMOTE_COMMANDS[t].needsOnline), "session.new"];
const LIVE_COMMAND_TTL_SECS = REMOTE_AGENT_TIMING.liveCommandTtlMs / 1000;
/**
 * How much longer than {@link LIVE_COMMAND_TTL_SECS} a command waits before a sweep calls it undelivered: a command sent just before
 * it expired is acknowledged by the connector's next heartbeat, at most two beats later, and must not be called lost meanwhile.
 */
export const UNDELIVERED_SLACK_SECS = (2 * REMOTE_AGENT_TIMING.heartbeatMs) / 1000;

/** A session that gained an event because a command of it was never delivered (`expireUndelivered`). */
export interface Undelivered { owner: string; session_id: string }

/**
 * What Claw writes in a session (`turn_end.error`) for a prompt its machine never acknowledged and can no longer be sent: the machine
 * went away after it was queued. Claw cannot tell whether it took the prompt just before it went (a connector acknowledges one only on
 * its next heartbeat, after it reaches the agent), so it says neither: the prompt may not have run, and an end of the machine's own
 * that comes later still counts (`assistant/remote-items.ts`).
 */
export const DELIVERY_UNCONFIRMED = "delivery_unconfirmed";

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
 * which is the case the `connector_offline` refusal exists to prevent. A `session.new` is one of those
 * too ({@link LIVE_COMMAND_TYPES}), and for a takeover (`takeover`) this matters most: delivered late, it
 * would end a terminal the person may be using by then. `cancel`, `close` and `decision` are safe to
 * deliver late and keep only the day.
 */
const expiredSql = (typesParam: number, secsParam: number, alias = ""): string =>
  `(${alias}created_at < NOW() - interval '1 day'
    OR (${alias}type = ANY($${typesParam}::text[]) AND ${alias}created_at < NOW() - make_interval(secs => $${secsParam}::float8)))`;

/**
 * Forget commands the connector has handled, plus any a day old. A live command too old to deliver ({@link expiredSql}) is not
 * deleted here: {@link expireUndelivered} deletes it and says so in the session, so nobody waits for an answer that cannot come.
 *
 * A prompt is stored here until it is delivered, and the audit trail keeps only
 * its hash, so this table must not become a second archive of what people typed.
 */
export async function pruneCommands(q: Querier, connectorId: string, upTo: number): Promise<void> {
  await q(
    "DELETE FROM claw_remote_commands WHERE connector_id = $1 AND (cmd_seq <= $2 OR created_at < NOW() - interval '1 day')",
    [connectorId, upTo],
  );
}

/**
 * Delete the live commands ({@link LIVE_COMMAND_TYPES}) that were never delivered and now never will be (older than
 * `liveCommandTtlMs` plus `slackSecs`: {@link commandsAfter} no longer sends them; their machine went away after they were queued;
 * their session has heard nothing from it since), of one connector or of all, and write in each
 * session what that means, as an event of Claw's own every reader already understands:
 *  - a `prompt`: `turn_end {stopReason: "error", error: "delivery_unconfirmed", cmd_seq}`, which ends that prompt's turn by name (the
 *    item, `assistant/remote-items.ts`; a chat attached to the session, which otherwise waits hours for a turn's end). Claw cannot
 *    tell whether the machine took it just before it went, so it never says the prompt did not run, and the machine's own end of it,
 *    if that comes, still counts.
 *  - a `session.new`: no event, and the session is left open: the machine may be starting it. Its prompts say what is known.
 *  - a `set_mode` or `resume`: nothing waits on its answer; it is dropped, as before.
 * Typically a laptop closed within the online window: the command was accepted because the machine still looked online.
 *
 * Claw's events take a negative `seq` (minus the command's `cmd_seq`, unique within a connector and so within its session): a
 * connector numbers a session's events from 1 up, so they never meet one of its own, and a repeat is ignored.
 */
export async function expireUndelivered(
  q: Querier, opts: { connectorId?: string | null; slackSecs?: number; onlineWindowMs?: number } = {},
): Promise<Undelivered[]> {
  // A command still held is one the connector has not acknowledged, which is not the same as one it never got: a prompt sent
  // behind a running turn is acknowledged only when that turn ends and it reaches the agent (connector.ts), which may be long
  // after. So a command is called undelivered only when its machine went away after it was queued (offline now, or recorded
  // offline since by the presence sweep), its session has heard nothing from the machine since (a turn that went on running
  // after it was queued shows the machine had it), and no turn was running when it was queued (one sent before it, since the
  // last turn's end, had been acknowledged): a prompt waiting behind a silent turn is the machine's, wherever the machine goes.
  const gone = (await q(
    `DELETE FROM claw_remote_commands m USING claw_remote_connectors c
      WHERE c.connector_id = m.connector_id AND ($1::uuid IS NULL OR m.connector_id = $1::uuid)
        AND m.type = ANY($2::text[]) AND m.created_at < NOW() - make_interval(secs => $3::float8)
        AND (NOT ${onlineSql(4)}
             OR EXISTS (SELECT 1 FROM claw_remote_connector_transitions t
                         WHERE t.connector_id = m.connector_id AND t.to_state <> 'online' AND t.at > m.created_at))
        AND NOT EXISTS (SELECT 1 FROM claw_remote_events e
                         WHERE e.session_id = m.session_id AND e.seq > 0 AND e.created_at > m.created_at)
        AND NOT EXISTS (
          -- A turn was running when it was queued, however silent: a prompt of the session sent since its last turn's end had
          -- reached the agent (acknowledged: no longer queued). This one waits behind that turn on the machine.
          SELECT 1 FROM claw_remote_audit a
           WHERE a.owner_user_id = c.owner_user_id AND a.session_id = m.session_id AND a.action = 'command.issued'
             AND a.detail->>'type' = 'prompt' AND a.detail->>'cmd_id' <> m.cmd_id AND a.ts < m.created_at
             AND a.ts > COALESCE((SELECT MAX(t.created_at) FROM claw_remote_events t
                                   WHERE t.session_id = m.session_id AND t.type = 'turn_end' AND t.seq > 0 AND t.created_at < m.created_at),
                                 '-infinity'::timestamptz)
             AND NOT EXISTS (SELECT 1 FROM claw_remote_commands o WHERE o.connector_id = m.connector_id AND o.cmd_id = a.detail->>'cmd_id')
             -- (refused by the machine: it never ran, so nothing runs ahead of this one)
             AND NOT EXISTS (SELECT 1 FROM claw_remote_events r
                              WHERE r.session_id = m.session_id AND r.type = 'command_rejected' AND r.data->>'cmd_id' = a.detail->>'cmd_id')
             -- (gone because Claw ended it here, not because the machine took it)
             AND NOT EXISTS (SELECT 1 FROM claw_remote_audit x
                              WHERE x.owner_user_id = c.owner_user_id AND x.connector_id = m.connector_id AND x.action = 'command.expired'
                                AND x.detail->>'cmd_id' = a.detail->>'cmd_id'))
      RETURNING m.connector_id::text AS connector_id, c.owner_user_id AS owner, m.session_id::text AS session_id, m.type, m.cmd_seq,
                m.cmd_id`,
    [opts.connectorId ?? null, LIVE_COMMAND_TYPES, LIVE_COMMAND_TTL_SECS + (opts.slackSecs ?? UNDELIVERED_SLACK_SECS),
      (opts.onlineWindowMs ?? REMOTE_AGENT_TIMING.onlineWindowMs) / 1000],
  )).rows.sort((a, b) => Number(a.cmd_seq) - Number(b.cmd_seq)) as Array<{
    connector_id: string; owner: string; session_id: string | null; type: string; cmd_seq: string; cmd_id: string;
  }>;
  const touched = new Map<string, Undelivered>();
  const note = async (r: (typeof gone)[number], type: string, data: Record<string, unknown>) => {
    const added = await q(
      `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data)
       SELECT session_id, $2, $3, NOW(), $4::jsonb FROM claw_remote_sessions WHERE session_id = $1 AND connector_id = $5
       ON CONFLICT (session_id, seq) DO NOTHING`,
      [r.session_id, -Number(r.cmd_seq), type, JSON.stringify({ ...data, by: "claw" }), r.connector_id],
    );
    if (added.rowCount) touched.set(r.session_id!, { owner: r.owner, session_id: r.session_id! });
  };
  for (const r of gone) {
    // A prompt's turn is ended, said as unconfirmed. A session.new gets no end: the machine may be starting that session, and its
    // prompts say what is known. A set_mode or resume is dropped, as before.
    if (r.session_id && r.type === "prompt") {
      await note(r, "turn_end", { stopReason: "error", error: DELIVERY_UNCONFIRMED, cmd_seq: Number(r.cmd_seq) });
    }
    await writeAudit(q, {
      owner: r.owner, actor: "claw", connectorId: r.connector_id, sessionId: r.session_id, action: "command.expired",
      detail: { type: r.type, cmd_id: r.cmd_id, cmd_seq: Number(r.cmd_seq), reason: DELIVERY_UNCONFIRMED },
    });
  }
  if (touched.size) {
    await q("UPDATE claw_remote_sessions SET updated_at = NOW() WHERE session_id = ANY($1::uuid[])", [[...touched.keys()]]);
  }
  return [...touched.values()];
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
 * `restart` is the server's own shutdown (a Claw release), which told the connector to reconnect at once: the stream
 * keeps counting as seen, so the connector stays online through the handover and only goes offline if it does not
 * come back within the online window.
 */
export async function markStreamClosed(connectorId: string, streamConn: string, reason = "closed"): Promise<void> {
  await direct(
    `UPDATE claw_remote_connectors SET stream_seen_at = CASE WHEN $3 = 'restart' THEN stream_seen_at ELSE NULL END,
            stream_closed_at = NOW(), stream_end_reason = $3
      WHERE connector_id = $1 AND stream_conn = $2`,
    [connectorId, streamConn, reason],
  );
}

export async function commandsAfter(connectorId: string, cursor: number, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT cmd_seq, cmd_id, session_id::text AS session_id, type, payload, created_at
       FROM claw_remote_commands WHERE connector_id = $1 AND cmd_seq > $2 AND NOT ${expiredSql(4, 5)}
      ORDER BY cmd_seq LIMIT $3`,
    [connectorId, cursor, limit, LIVE_COMMAND_TYPES, LIVE_COMMAND_TTL_SECS],
  )).rows;
}

/**
 * What a connector is told when it asks, before carrying out a command it received late ({@link commandLiveness}). Only `live` may
 * run; a connector drops anything else and says so in the session.
 *  - `live`: still queued, its session open, not expired, nothing after it cancels it.
 *  - `session_closed`: its session was closed (by the person, by a reclaim, by its machine, or because the connector was revoked).
 *  - `cancelled`: a prompt, and a `cancel` or `close` of its session was queued after it. (A `set_mode`, `resume` or `decision`
 *    queued before a cancel is still live: the connector's cancel drops only queued prompts.)
 *  - `expired`: it reached the connector already older than a command of its kind may be carried out ({@link expiredSql}). One the
 *    connector received in time (`receivedLate` false) and that then waited on the machine, queued behind a long turn or for a
 *    terminal, is never expired: the TTL is for commands that were never collected, not for ones collected in time.
 *  - `gone`: Claw holds no such command for this connector any more (ended by Claw, or never this connector's), and the connector
 *    named no session of its own that closed (for one it did, `session_closed`: closing deletes the session's acting commands).
 * `connector_revoked`: the connector was revoked (the route answers it 401 `revoked`, as every connector-side route does).
 *
 * Answered under the connector row's lock, the one a revocation (`revokeIn`) and every queued command (`enqueueCommand`: a `close`,
 * a reclaim) take first: a `live` answer is never given once a close or a revocation has committed, and one that has committed
 * before them is recorded (`command.confirmed`), so the command counts as started before the close, as one delivered in time does.
 */
export type CommandLiveness = "live" | "session_closed" | "cancelled" | "expired" | "gone" | "connector_revoked";

/**
 * The commands {@link commandLiveness} always calls live (they only end or take back things), and the ones that, queued after a
 * prompt, make it `cancelled`: a `cancel`, a `close`, and a `withdraw` (which takes back the prompts that have not started).
 */
const ENDING_COMMAND_TYPES = ["cancel", "close", "withdraw"];

/**
 * Whether command `cmdId`, which connector `connectorId` received and has not carried out, may still be carried out. `receivedLate`:
 * the connector says the command was already past the live TTL when it came (only then can it be `expired`); `why` is the
 * connector's reason for asking, for the audit trail; `sessionId` the session the connector says the command is of, which answers
 * about one Claw no longer holds: `session_closed` when that session is this connector's and closed (its acting commands were
 * deleted with it, {@link dropActingCommandsOf}), else `gone` (a connector naming another of its sessions only refuses its own
 * command). An answer about a command Claw holds is audited (`command.confirmed`, or `command.refused_late` with what was refused
 * and why, never the text of a prompt); one about an id it does not hold is not, so the route cannot be used to fill the trail.
 */
export async function commandLiveness(
  owner: string, connectorId: string, cmdId: string, client: string | null,
  ask: { receivedLate: boolean; why: string | null; sessionId?: string | null } = { receivedLate: true, why: null },
): Promise<{ status: CommandLiveness; cmd_seq: number | null; session_id: string | null }> {
  return inTransaction(async (q) => {
    const conn = (await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1 FOR UPDATE", [connectorId])).rows[0];
    if (!conn || conn.revoked_at) return { status: "connector_revoked" as const, cmd_seq: null, session_id: null };
    const row = (await q(
      `SELECT m.cmd_seq, m.type, m.session_id::text AS session_id, s.status AS session_status, s.agent_id,
              ${expiredSql(3, 4, "m.")} AS expired,
              EXISTS (SELECT 1 FROM claw_remote_commands o
                       WHERE o.connector_id = m.connector_id AND o.session_id = m.session_id AND o.cmd_seq > m.cmd_seq
                         AND o.type = ANY($5::text[])) AS cancelled_after
         FROM claw_remote_commands m LEFT JOIN claw_remote_sessions s ON s.session_id = m.session_id
        WHERE m.connector_id = $1 AND m.cmd_id = $2`,
      [connectorId, cmdId, LIVE_COMMAND_TYPES, LIVE_COMMAND_TTL_SECS, ENDING_COMMAND_TYPES],
    )).rows[0];
    let status: CommandLiveness;
    if (!row) {
      // (The route passes only a uuid.)
      const closed = ask.sessionId ? (await q(
        "SELECT 1 FROM claw_remote_sessions WHERE session_id = $1::uuid AND connector_id = $2 AND status <> 'active'",
        [ask.sessionId, connectorId],
      )).rows.length > 0 : false;
      status = closed ? "session_closed" : "gone";
    }
    else if (ENDING_COMMAND_TYPES.includes(String(row.type))) status = "live";
    else if (row.session_id && row.session_status !== "active") status = "session_closed";
    else if (row.expired && ask.receivedLate) status = "expired";
    else if (row.cancelled_after && row.type === "prompt") status = "cancelled";
    else status = "live";
    const sessionId = row?.session_id ? String(row.session_id) : null;
    if (row) {
      await writeAudit(q, {
        owner, actor: connectorId, client, connectorId, agentId: row.agent_id ?? null, sessionId,
        action: status === "live" ? "command.confirmed" : "command.refused_late",
        detail: { cmd_id: cmdId, type: row.type, cmd_seq: Number(row.cmd_seq), status, received_late: ask.receivedLate, ...(ask.why ? { why: ask.why } : {}) },
      });
    }
    return { status, cmd_seq: row ? Number(row.cmd_seq) : null, session_id: sessionId };
  });
}

/**
 * The commands of a session that would make its agent act ({@link LIVE_COMMAND_TYPES} and `decision`), deleted when the session
 * closes on Claw's side: the person was told it ended, so nothing they sent it before may run after. Its `close` and any `cancel`
 * stay, to be delivered. A connector that already received one (a frame held in a socket while its machine was asleep, or one
 * queued behind a turn) asks before it carries it out ({@link commandLiveness}) and, naming the session, is told `session_closed`.
 */
async function dropActingCommandsOf(q: Querier, sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  await q(
    "DELETE FROM claw_remote_commands WHERE session_id = ANY($1::uuid[]) AND type = ANY($2::text[])",
    [sessionIds, [...LIVE_COMMAND_TYPES, "decision"]],
  );
}

export interface NewCommand {
  connectorId: string;
  cmdId: string;
  sessionId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** Thrown by `enqueueCommand` when the connector is revoked (or gone); `issueCommand` and `createSession` answer it as `gone`. */
export class ConnectorGone extends Error {
  constructor() { super("connector revoked"); this.name = "ConnectorGone"; }
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
  // Read under the lock a revoke takes: a caller that found the connector active before a revoke that has committed since queues
  // nothing for it (a command stream already open could still fetch it). The caller's transaction rolls back (`ConnectorGone`).
  const live = (await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1 FOR UPDATE", [c.connectorId])).rows[0];
  if (!live || live.revoked_at) throw new ConnectorGone();
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

/**
 * Whether session `s` is read-only: its connector opened it to watch a conversation that a terminal on that machine has open
 * (`read_only` on the session's newest `session_started` or `session_resumed`, connector/src/session.ts `spectate`). Such a
 * session shows what the terminal does and takes no prompt; the routes refuse one before it is queued.
 */
const READ_ONLY_SQL = `COALESCE((SELECT e.data->>'read_only' = 'true' FROM claw_remote_events e
   WHERE e.session_id = s.session_id AND e.type IN ('session_started', 'session_resumed') ORDER BY e.id DESC LIMIT 1), false)`;

export async function findSession(owner: string, sessionId: string, q: Querier = direct): Promise<Row | null> {
  const r = await q(
    `SELECT session_id::text AS session_id, connector_id::text AS connector_id, agent_id, cwd, mode, status, created_at, updated_at,
            ${READ_ONLY_SQL} AS read_only
       FROM claw_remote_sessions s WHERE owner_user_id = $1 AND session_id = $2`,
    [owner, sessionId],
  );
  return r.rows[0] ?? null;
}

export async function listSessions(owner: string, connectorId: string | null, limit: number): Promise<Row[]> {
  return (await direct(
    `SELECT session_id::text AS session_id, connector_id::text AS connector_id, agent_id, cwd, mode, status, created_at, updated_at,
            ${READ_ONLY_SQL} AS read_only
       FROM claw_remote_sessions s
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
            s.created_at, s.updated_at, ${READ_ONLY_SQL} AS read_only,
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
    // A batch that closes sessions takes the connector row's lock first, as every other close does (`issueCommand`, a reclaim,
    // `revokeIn`), before any session row: a late confirmation (`commandLiveness`, under the same lock) then never answers `live`
    // for a command of a session this batch has closed.
    if (events.some((e) => e.type === REMOTE_EVENT_SESSION_CLOSED)) {
      await q("SELECT 1 FROM claw_remote_connectors WHERE connector_id = $1 FOR UPDATE", [connector.connector_id]);
    }
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
      // Its machine closed it: what is still queued that would make its agent act is never sent (it would only be refused there).
      await dropActingCommandsOf(q, [...closed]);
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
  | { status: "gone" }
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
  const out = await goneAsStatus(() => inTransaction(async (q): Promise<IssueOutcome> => {
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
      await dropActingCommandsOf(q, [r.sessionId]);
    }
    if (r.type === "prompt") await notePrompt(q, r, Number(queued.row.cmd_seq));
    return { status: "queued", row: queued.row } as IssueOutcome;
  }));
  if (out.status === "queued" && r.type === "prompt") sessionWaker(r.sessionId);
  return out;
}

/**
 * What the person sent, as an event of the session (`user_prompt`), in the same transaction that queues it, so it is stored once
 * per queued prompt and before anything the agent says about it. An agent reports only its own side; this is how every reader of
 * the session (a web page beside a Teams chat, another device) sees what was asked. Stored where the agent's output is, masked the
 * way the agent's output is at ingest, and deleted with the session like the rest of its events; the audit trail still keeps only
 * a hash. Nothing that follows a turn reads this type, so it neither opens nor ends one.
 */
async function notePrompt(q: Querier, r: IssueRequest, cmdSeq: number): Promise<void> {
  const text = typeof r.payload.text === "string" ? r.payload.text : "";
  if (!text) return;
  const data = redactPublicJson({ text, cmd_id: r.cmdId, cmd_seq: cmdSeq, client: r.client, by: "claw" });
  await q(
    `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data)
     VALUES ($1, $2, $3, NOW(), $4::jsonb) ON CONFLICT (session_id, seq) DO NOTHING`,
    [r.sessionId, userPromptSeq(cmdSeq), REMOTE_EVENT_USER_PROMPT, JSON.stringify(data)],
  );
}

/** `run`, with a `ConnectorGone` it threw (its transaction rolled back) answered as `{ status: "gone" }`. */
async function goneAsStatus<T>(run: () => Promise<T>): Promise<T | { status: "gone" }> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConnectorGone) return { status: "gone" };
    throw err;
  }
}

export type CreateSessionOutcome =
  | { status: "limit" } | { status: "rate_limited" } | { status: "gone" }
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
 * nothing has come from it for a day. A read-only session (one that watches a conversation a terminal has open, {@link READ_ONLY_SQL})
 * is never at work for Claw, whatever the terminal writes: it may be closed whenever no command waits for it, before any session that
 * is not read-only (closing it ends only the watch; the conversation goes on in the terminal and can be watched again).
 */
async function reclaimable(q: Querier, owner: string, need: number, onlineWindowMs: number): Promise<Reclaimable[]> {
  // Locked as read (FOR UPDATE), which waits for a batch of its events being stored now: storing an event takes a key-share lock
  // on its session row (the events' foreign key) before the batch moves the row's updated_at, so the batch commits first and the
  // row is then read again as it is (Postgres re-checks a row that changed while it waited), and a session it moved is kept.
  const rows = (await q(
    `SELECT s.session_id::text AS session_id, s.connector_id::text AS connector_id, s.agent_id, s.updated_at,
            ${onlineSql(2)} AS online,
            ${READ_ONLY_SQL} AS read_only
       FROM claw_remote_sessions s JOIN claw_remote_connectors c ON c.connector_id = s.connector_id
      WHERE s.owner_user_id = $1 AND s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM claw_remote_commands m WHERE m.connector_id = s.connector_id AND m.session_id = s.session_id)
        AND (s.updated_at < NOW() - make_interval(secs => $4::float8)
          -- A watch: what its terminal writes is the terminal's turn, never one of Claw's, so it never keeps the session open.
          OR ${READ_ONLY_SQL}
          OR (s.updated_at < NOW() - make_interval(secs => $3::float8)
            AND COALESCE((SELECT MAX(e.id) FROM claw_remote_events e
                           WHERE e.session_id = s.session_id AND e.type = ANY($5::text[]) AND COALESCE(e.data->>'replay', '') <> 'true'), 0)
              <= COALESCE((SELECT MAX(e.id) FROM claw_remote_events e WHERE e.session_id = s.session_id AND e.type = 'turn_end'), 0)
            AND NOT EXISTS (
              SELECT 1 FROM claw_remote_events r
               WHERE r.session_id = s.session_id AND r.type = $6 AND COALESCE(r.data->>'replay', '') <> 'true'
                 AND NOT EXISTS (SELECT 1 FROM claw_remote_events d
                                  WHERE d.session_id = s.session_id AND d.type = $7 AND d.data->>'actionId' = r.data->>'actionId'))))
      ORDER BY online, read_only DESC, s.updated_at
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
  /** With `resumeRef`: end whatever holds that session open on the machine first (the person confirmed it). */
  takeover?: boolean;
  maxActive: number; commandsPerMinute: number;
  /** The connector presence window, which orders the sessions closed to make room (an offline machine's first). */
  onlineWindowMs?: number;
}): Promise<CreateSessionOutcome> {
  return goneAsStatus(() => inTransaction(async (q): Promise<CreateSessionOutcome> => {
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
      // A takeover is carried out only while the confirmation is fresh: the server drops it after the live TTL
      // (`expiredSql`), and `takeover_until` lets the connector refuse one that reaches it later anyway.
      payload: { agent_id: p.agentId, cwd: p.cwd, mode: p.mode, ...(p.resumeRef ? { resume_ref: p.resumeRef, ...(p.takeover
        ? { takeover: true, takeover_until: Date.now() + REMOTE_AGENT_TIMING.liveCommandTtlMs } : {}) } : {}) },
    });
    const base = { owner: p.owner, actor: p.owner, client: p.client, connectorId: p.connectorId, agentId: p.agentId, sessionId };
    await writeAudit(q, { ...base, action: "session.created", detail: { cwd: p.cwd, mode: p.mode, ...(p.resumeRef ? { resume_ref: p.resumeRef, ...(p.takeover ? { takeover: true } : {}) } : {}) } });
    await writeAudit(q, { ...base, action: "command.issued", detail: { type: "session.new", cmd_id: cmdId } });
    for (const v of victims) {
      // Closed as `/agent close` closes it: its connector is told (a close is delivered late too), and the row is closed now.
      const closeId = randomUUID();
      await enqueueCommand(q, { connectorId: v.connector_id, cmdId: closeId, sessionId: v.session_id, type: "close", payload: {} });
      await q("UPDATE claw_remote_sessions SET status = 'closed', updated_at = NOW() WHERE session_id = $1", [v.session_id]);
      await dropActingCommandsOf(q, [v.session_id]);
      await writeAudit(q, {
        owner: p.owner, actor: p.owner, client: p.client, connectorId: v.connector_id, agentId: v.agent_id, sessionId: v.session_id,
        action: "session.reclaimed",
        detail: { cmd_id: closeId, for_session: sessionId, idle_since: v.updated_at instanceof Date ? v.updated_at.toISOString() : String(v.updated_at) },
      });
    }
    return {
      status: "created", session, reclaimed: victims.map((v) => ({ session_id: v.session_id, connector_id: v.connector_id })),
    } as CreateSessionOutcome;
  }));
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

/** At most this many waiting requests are listed per session (an agent asks one at a time; more is a connector out of step). */
const WAITING_PER_SESSION = 5;

/**
 * The permission requests each of the owner's active sessions `sessionIds` waits on now, oldest first: asked since the session's last
 * turn ended (an ask from before is moot: that turn is over), not replayed history, and not answered (`permission_resolved`). A request
 * a connector sent again after a reconnect is the same request, listed once. What a sessions list puts first: a session that needs
 * its user (`GET /v1/remote-agents/sessions` `waiting`). `tool` is what the agent wrote (untrusted). Nothing of anyone else's.
 */
export async function sessionsWaiting(
  owner: string, sessionIds: readonly string[],
): Promise<Map<string, Array<{ action_id: string; tool: string; asked_at: string }>>> {
  const out = new Map<string, Array<{ action_id: string; tool: string; asked_at: string }>>();
  if (!sessionIds.length) return out;
  const rows = (await direct(
    `SELECT s.session_id::text AS session_id, w.action_id, w.tool, w.asked_at
       FROM claw_remote_sessions s
       CROSS JOIN LATERAL (
         SELECT DISTINCT ON (r.data->>'actionId') r.data->>'actionId' AS action_id, LEFT(COALESCE(r.data->>'tool', ''), 200) AS tool,
                r.occurred_at AS asked_at, r.id
           FROM claw_remote_events r
          WHERE r.session_id = s.session_id AND r.type = $3 AND COALESCE(r.data->>'actionId', '') <> ''
            AND COALESCE(r.data->>'replay', '') <> 'true'
            AND r.id > COALESCE((SELECT MAX(t.id) FROM claw_remote_events t WHERE t.session_id = s.session_id AND t.type = 'turn_end'), 0)
            AND NOT EXISTS (SELECT 1 FROM claw_remote_events d
                             WHERE d.session_id = s.session_id AND d.type = $4 AND d.data->>'actionId' = r.data->>'actionId')
          ORDER BY r.data->>'actionId', r.id
       ) w
      WHERE s.owner_user_id = $1 AND s.session_id = ANY($2::uuid[]) AND s.status = 'active'
      ORDER BY s.session_id, w.id`,
    [owner, [...sessionIds], REMOTE_EVENT_PERMISSION_REQUEST, REMOTE_EVENT_PERMISSION_RESOLVED],
  )).rows as Array<{ session_id: string; action_id: string; tool: string; asked_at: Date }>;
  for (const r of rows) {
    const list = out.get(r.session_id) ?? [];
    if (list.length < WAITING_PER_SESSION) list.push({ action_id: r.action_id, tool: r.tool, asked_at: new Date(r.asked_at).toISOString() });
    out.set(r.session_id, list);
  }
  return out;
}
