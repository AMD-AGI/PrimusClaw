// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant watching a group chat or a repository, and writing down what it would do there without doing it.
 *
 * A place the assistant watches is a scope: `group:<channel>:<id>` or `repo:<owner>/<repo>`. Each person who turns
 * watching on for a scope has one row here and one observer session of their own: an ordinary session, apart from
 * their assistant's, so what is said in a group never enters their assistant's history and their own work items never
 * enter the group's context. A channel hands each message of the place to that session; each turn there decides what
 * it would do, and every tool it calls is recorded instead of done (`observeEveryTool`). The record, read back with
 * the message it was about, is what a person checks before letting the assistant act there.
 *
 * Nothing done in an observer turn reaches anyone. That is a mechanism, not a prompt: the observer's bearer has its own
 * role, and the MCP service built for it swaps the callback of every tool it registers, the router's included, for the
 * recorder. A tool added to the router later is recorded the same way without being listed here.
 *
 * A scope's mode is `observe` until a person says otherwise, and only a person can: `auto` is taken only from a
 * credential a sandbox cannot hold (`classifyAttendedCaller`, the same test a held merge is answered under). Acting in
 * `auto` is not built yet: until the record has been checked, an `auto` scope is still only recorded.
 */
import { CLAW_ASSISTANT_ROUTER_MODEL } from "../config.js";
import { db, inTransaction, type Querier, type StatementRunner } from "../infra/db.js";
import { insertSessionRow } from "../routes/sessions.js";
import { drainSessionIfIdle, queueServerMessage } from "./messages.js";
import { assertLiveRun, ToolRefused } from "./tools.js";
import type { AssistantTokenClaims } from "./token.js";
import { ASSISTANT_SESSION_NAME } from "./assistant.js";

export const SCOPE_MODES = ["observe", "auto"] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

/** The longest a scope may be: it is a key, not a description. */
export const SCOPE_MAX_CHARS = 200;
const GROUP_SCOPE = /^group:[a-z0-9_-]{1,32}:[^\s]{1,160}$/i;
const REPO_SCOPE = /^repo:[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/i;

/** Messages waiting for one observer session past which a channel is told to slow down: each is a model call on the owner's key. */
export const OBSERVE_BACKLOG_MAX = 20;
/** The longest message handed to an observer, and the longest record of a call it makes. */
export const OBSERVED_CONTENT_MAX_CHARS = 8000;
const RECORDED_ARGS_MAX_CHARS = 8000;
export const OBSERVATIONS_LIST_MAX = 200;

/** The scope, normalised, or null when it is not one. Repositories are not case sensitive on GitHub, and neither is this. */
export function parseScope(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const scope = raw.trim();
  if (!scope || scope.length > SCOPE_MAX_CHARS) return null;
  if (REPO_SCOPE.test(scope)) return scope.toLowerCase();
  if (GROUP_SCOPE.test(scope)) return scope;
  return null;
}

export interface ScopeRow {
  scope: string;
  mode: ScopeMode;
  session_id: string;
  mode_set_at: Date | null;
  created_at: Date;
}

async function newObserverSession(q: StatementRunner, userId: string, scope: string, sessionId: string): Promise<void> {
  await insertSessionRow(q, {
    sessionId,
    name: `${ASSISTANT_SESSION_NAME} · ${scope}`,
    userId,
    mode: "claw",
    agentStatus: "idle",
    systemPrompt: "",
    config: {},
    parentSid: null,
    role: "",
    model: CLAW_ASSISTANT_ROUTER_MODEL || null,
  }, { parentSid: null });
}

/**
 * The caller's watcher of a scope, made on first use in `observe`. Safe to call twice at once, as `getOrCreateAssistant`
 * is: the row and its session are written in one transaction, and a session deleted from the web UI is replaced in the
 * same row, keeping its mode.
 */
export async function getOrCreateScope(userId: string, scope: string): Promise<{ row: ScopeRow; created: boolean }> {
  return inTransaction(async (query) => {
    const q: StatementRunner = { query };
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await query(
        "SELECT scope, mode, session_id, mode_set_at, created_at FROM claw_assistant_scopes WHERE user_id = $1 AND scope = $2 FOR UPDATE",
        [userId, scope],
      )).rows[0] as ScopeRow | undefined;
      const live = current && (await query(
        "SELECT 1 FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [current.session_id],
      )).rowCount;
      if (current && live) return { row: current, created: false };
      const sessionId = crypto.randomUUID();
      if (current) {
        await query(
          "UPDATE claw_assistant_scopes SET session_id = $3, updated_at = NOW() WHERE user_id = $1 AND scope = $2",
          [userId, scope, sessionId],
        );
        await newObserverSession(q, userId, scope, sessionId);
        return { row: { ...current, session_id: sessionId }, created: true };
      }
      const inserted = (await query(
        `INSERT INTO claw_assistant_scopes (user_id, scope, session_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, scope) DO NOTHING
         RETURNING scope, mode, session_id, mode_set_at, created_at`,
        [userId, scope, sessionId],
      )).rows[0] as ScopeRow | undefined;
      if (inserted) {
        await newObserverSession(q, userId, scope, sessionId);
        return { row: inserted, created: true };
      }
    }
    throw new Error("assistant.scope_lost_the_race");
  });
}

export async function listScopes(userId: string): Promise<ScopeRow[]> {
  return (await db.query(
    "SELECT scope, mode, session_id, mode_set_at, created_at FROM claw_assistant_scopes WHERE user_id = $1 ORDER BY created_at",
    [userId],
  )).rows as ScopeRow[];
}

/**
 * Set a scope's mode. The caller has already decided whether the request may: `auto` only from a person (the route asks
 * `classifyAttendedCaller`), `observe` from any request of the owner's, since it only takes power away.
 */
export async function setScopeMode(
  userId: string, scope: string, mode: ScopeMode, via: Record<string, unknown>,
): Promise<ScopeRow> {
  await getOrCreateScope(userId, scope);
  return (await db.query(
    `UPDATE claw_assistant_scopes SET mode = $3, mode_set_at = NOW(), mode_set_via = $4::jsonb, updated_at = NOW()
      WHERE user_id = $1 AND scope = $2
      RETURNING scope, mode, session_id, mode_set_at, created_at`,
    [userId, scope, mode, JSON.stringify(via)],
  )).rows[0] as ScopeRow;
}

/** The scope a session watches, or null when it is no observer session. */
export async function observerOf(sessionId: string): Promise<{ userId: string; scope: string; mode: ScopeMode } | null> {
  const row = (await db.query(
    "SELECT user_id, scope, mode FROM claw_assistant_scopes WHERE session_id = $1",
    [sessionId],
  )).rows[0] as { user_id: string; scope: string; mode: ScopeMode } | undefined;
  return row ? { userId: row.user_id, scope: row.scope, mode: row.mode } : null;
}

export type QueuedObservation =
  | { ok: true; scope: string; mode: ScopeMode; session_id: string; queued: boolean }
  | { ok: false; error: "observe_backlog" | "session_not_found" | "no_credentials" | "acting_session_unattended" };

/**
 * Hand one message of the place to its watcher. The message is queued (so a replay of the same channel message,
 * named by `messageId`, queues nothing) and the session drained when idle, as every message the server puts on a
 * session. The caller has stamped its credentials on the session: the turn runs, and costs, as its owner.
 */
export async function queueObservation(input: {
  userId: string; sessionId: string; scope: string; mode: ScopeMode; content: string; messageId?: string | null;
}): Promise<QueuedObservation> {
  const queued = await inTransaction(async (query) => {
    // Serialises two posts to one watcher, so the backlog count each reads is the other's too.
    await query("SELECT 1 FROM claw_sessions WHERE session_id = $1 FOR UPDATE", [input.sessionId]);
    const waiting = Number((await query(
      "SELECT COUNT(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", [input.sessionId],
    )).rows[0].n);
    if (waiting >= OBSERVE_BACKLOG_MAX) return { ok: false as const, error: "observe_backlog" as const };
    return queueServerMessage({ query }, {
      sessionId: input.sessionId, userId: input.userId, content: input.content,
      ...(input.messageId ? { dedupeKey: `obs:${input.messageId}` } : {}),
    });
  });
  if (!queued.ok) return queued;
  if (!queued.deduplicated) await drainSessionIfIdle(input.sessionId, input.userId);
  return { ok: true, scope: input.scope, mode: input.mode, session_id: input.sessionId, queued: !queued.deduplicated };
}

function recordedArgs(args: unknown): unknown {
  const value = args && typeof args === "object" ? args : {};
  const text = JSON.stringify(value);
  return text.length > RECORDED_ARGS_MAX_CHARS ? { truncated: true, json: text.slice(0, RECORDED_ARGS_MAX_CHARS) } : value;
}

/**
 * What an observer turn's tool call does: write it down. Asked of a live turn, in the transaction that writes, as every
 * tool of the assistant is, so a late call from an interrupted turn records nothing.
 */
export async function recordObservation(
  claims: AssistantTokenClaims, tool: string, args: unknown,
): Promise<{ ok: true; observed: true; mode: ScopeMode; note: string }> {
  if (claims.role !== "observer") throw new ToolRefused("not_allowed", "only an observer turn records what it would do");
  return inTransaction(async (query: Querier) => {
    const { userId } = await assertLiveRun(query, claims);
    const scope = (await query(
      "SELECT scope, mode FROM claw_assistant_scopes WHERE session_id = $1 AND user_id = $2",
      [claims.sid, userId],
    )).rows[0] as { scope: string; mode: ScopeMode } | undefined;
    if (!scope) throw new ToolRefused("turn_not_live", "this session is not watching anything");
    await query(
      `INSERT INTO claw_assistant_observations (user_id, scope, session_id, run_id, tool, args)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT DO NOTHING`,
      [userId, scope.scope, claims.sid, claims.task_id, tool, JSON.stringify(recordedArgs(args))],
    );
    return {
      ok: true as const, observed: true as const, mode: scope.mode,
      note: "Recorded as what you would do. Nothing was sent or started: this place is only being observed.",
    };
  });
}

/**
 * Swap the callback of every tool registered on this server, from here on, for `record`. Both ways of registering a
 * tool are covered, and the arguments are told apart the way the SDK passes them: `(args, extra)` for a tool with an
 * input schema, `(extra)` for one without.
 */
export function observeEveryTool(
  mcp: object, record: (tool: string, args: unknown) => Promise<unknown>,
): void {
  const server = mcp as Record<string, (...a: unknown[]) => unknown>;
  for (const method of ["tool", "registerTool"]) {
    const original = server[method];
    if (typeof original !== "function") throw new Error(`assistant.observe_cannot_intercept_${method}`);
    server[method] = (name: unknown, ...rest: unknown[]) => {
      const callback = rest.pop();
      if (typeof callback !== "function") throw new Error("assistant.observe_tool_without_callback");
      return original.call(mcp, name, ...rest, (...call: unknown[]) => record(String(name), call.length >= 2 ? call[0] : {}));
    };
  }
}

export interface ObservedMessage {
  run_id: string;
  at: Date;
  status: string;
  /** What the place said: the message the turn was given. */
  message: string;
  /** What the assistant would have done, in order; empty when it decided nothing. */
  would: Array<{ tool: string; args: unknown; at: Date }>;
}

/** The record of one scope, newest message first: each message the watcher was given, and what it would have done. */
export async function listObservations(userId: string, scope: string, limit: number): Promise<ObservedMessage[] | null> {
  const row = (await db.query(
    "SELECT session_id FROM claw_assistant_scopes WHERE user_id = $1 AND scope = $2", [userId, scope],
  )).rows[0] as { session_id: string } | undefined;
  if (!row) return null;
  // Every session the scope has had: one deleted from the web UI was replaced, and its record is still the scope's.
  return (await db.query(
    `SELECT t.task_id AS run_id, t.created_at AS at, t.status, COALESCE(t.prompt, t.input->>'prompt', '') AS message,
            COALESCE((
              SELECT json_agg(json_build_object('tool', o.tool, 'args', o.args, 'at', o.created_at) ORDER BY o.id)
                FROM claw_assistant_observations o WHERE o.run_id = t.task_id AND o.user_id = $1
            ), '[]'::json) AS would
       FROM claw_tasks t
      WHERE t.origin = 'chat'
        AND (t.session_id = $3 OR t.session_id IN (
          SELECT DISTINCT o.session_id FROM claw_assistant_observations o WHERE o.user_id = $1 AND o.scope = $2))
      ORDER BY t.created_at DESC, t.task_id DESC
      LIMIT $4`,
    [userId, scope, row.session_id, Math.max(1, Math.min(limit, OBSERVATIONS_LIST_MAX))],
  )).rows as ObservedMessage[];
}
