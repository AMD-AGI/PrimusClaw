// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Telling an owner when a conversation open in a terminal on one of their machines has been waiting for them a while.
 *
 * A connector reports the conversations a terminal holds open (`capabilities.resumable`, `state: "live"`) with what Claude Code
 * itself says each is doing there (`activity`: `working`, `waiting` for the person at that terminal, `idle`; `waiting_for`: "input
 * needed"). Someone at that terminal answers a question or a permission in seconds; one who walked away does not. So a conversation
 * that has been waiting for `noticeAfterMs` (a minute, as Claude Code's own "waiting for your input" notification) on a machine that is
 * online is said to its owner once (`recordSystemNotice`, keyed by the episode); one answered at the terminal before then is never
 * said, and neither is anything else a terminal does (working, finishing): the person at the terminal sees that, and only the need of
 * one who is not there is worth a push. The episode ends when the conversation stops waiting (answered, ended, or its machine went
 * offline, on a report that says so: one heartbeat that could not see its terminals ends nothing), and a later wait is a new one.
 *
 * A sweep, every few seconds on whichever replica takes the lock, keeps one row per waiting conversation
 * (`claw_remote_terminal_waits`: since when the sweep first saw it wait, and whether it was told), so the minute is counted from the
 * sweep's own sight, never from a time a connector wrote; and it is told only on a report made after the minute (and the connector's
 * own lag, `TERMINAL_REPORT_LAG_MS`) that still says it waits.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { onlineSql } from "./store.js";

const logger = pino({ name: "remote-agents-terminal-waits" });

/** How long a conversation open in a terminal waits for its person before they are told. */
export const TERMINAL_WAIT_NOTICE_MS = 60 * 1000;
/** How often a replica tries to sweep. One sweep at a time across replicas (an advisory lock). */
export const TERMINAL_WAIT_SWEEP_MS = 15 * 1000;

/**
 * How stale a connector's report of a terminal may be: it looks at its terminals every 10 s and says what changed with its next
 * heartbeat. A wait is told only once a report made this long after the minute was up still says it waits, so someone who answered
 * just before the minute is never told on an older report.
 */
export const TERMINAL_REPORT_LAG_MS = 15 * 1000;

/** Same namespace as the presence sweep's lock, a scope of its own. */
const LOCK_NS = 7_001;
const NAME_MAX = 64;
const TITLE_MAX = 80;
const WAITING_FOR_MAX = 60;
/** A conversation ref as a connector names it (`connector/src/attach.ts`), and nothing else. */
const REF_RE = "^[A-Za-z0-9._:-]{1,128}$";

export interface TerminalWaitNotice {
  owner: string;
  connectorId: string;
  agentId: string;
  ref: string;
  machine: string;
  agent: string;
  title: string;
  cwd: string;
  waitingFor: string;
  since: Date;
}

export interface TerminalWaitSweep {
  /** False when another replica held the sweep. */
  swept: boolean;
  /** Conversations waiting now, on machines online now. */
  waiting: number;
  notices: TerminalWaitNotice[];
}

const oneLine = (text: unknown, max: number): string => {
  const t = String(text ?? "").replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/** The words of a notice, in `lang`. Pure, for the tests. What the connector reported is quoted text, one line each. */
export function terminalWaitText(n: TerminalWaitNotice, lang: "zh" | "en"): string {
  const machine = oneLine(n.machine, NAME_MAX) || n.connectorId.slice(0, 8);
  // A claude agent's derived agent for the conversations already on the machine (id "<its id>-sessions") is named "<its name>
  // (existing sessions)" (connector/src/config.ts existingSessionAgents): to the owner it is the tool they started in that terminal.
  const name = oneLine(n.agent, NAME_MAX);
  const agent = (n.agentId.endsWith("-sessions") ? name.replace(/ \(existing sessions\)$/, "") : name) || n.agentId;
  const what = oneLine(n.title, TITLE_MAX) || oneLine(n.cwd, TITLE_MAX);
  const why = oneLine(n.waitingFor, WAITING_FOR_MAX);
  return lang === "zh"
    ? `${machine} 上终端里的 ${agent} 在等你${why ? `（${why}）` : ""}${what ? `：${what}` : ""}。已经等了一分多钟，回到那个终端处理。`
    : `${agent} in a terminal on ${machine} is waiting for you${why ? ` (${why})` : ""}${what ? `: ${what}` : ""}. It has waited over a minute; answer it in that terminal.`;
}

/** The deterministic key of a notice: one per waiting episode of a conversation, whoever sends it and however often. */
export const terminalWaitKey = (n: Pick<TerminalWaitNotice, "connectorId" | "agentId" | "ref" | "since">): string =>
  `remote-terminal-wait:${n.connectorId}:${n.agentId}:${n.ref}:${n.since.getTime()}`;

/**
 * One sweep: start an episode for every conversation that waits now on a machine online now, end the ones that no longer wait, and
 * mark as told (returning them) the ones that have waited `noticeAfterMs`. Under a transaction-scoped advisory lock, so two replicas
 * never sweep at once; one that finds it held does nothing (`swept: false`).
 */
export async function sweepTerminalWaits(onlineWindowMs: number, noticeAfterMs: number = TERMINAL_WAIT_NOTICE_MS): Promise<TerminalWaitSweep> {
  return inTransaction(async (q) => {
    const got = (await q("SELECT pg_try_advisory_xact_lock($1, hashtext('terminal-waits')) AS got", [LOCK_NS])).rows[0]?.got;
    if (!got) return { swept: false, waiting: 0, notices: [] };
    const now = (await q(
      `SELECT c.connector_id::text AS connector_id, c.owner_user_id, c.name AS machine, a.agent_id, a.name AS agent,
              r.value->>'ref' AS ref, COALESCE(r.value->>'title', '') AS title, COALESCE(r.value->>'cwd', '') AS cwd,
              COALESCE(r.value->>'waiting_for', '') AS waiting_for, a.updated_at AS reported_at
         FROM claw_remote_connectors c
         JOIN claw_remote_agents a ON a.connector_id = c.connector_id
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(a.capabilities->'resumable') = 'array' THEN a.capabilities->'resumable' ELSE '[]'::jsonb END) r(value)
        WHERE ${onlineSql(1)}
          AND jsonb_typeof(r.value) = 'object' AND r.value->>'state' = 'live' AND r.value->>'activity' = 'waiting'
          AND jsonb_typeof(r.value->'ref') = 'string' AND r.value->>'ref' ~ $2`,
      [onlineWindowMs / 1000, REF_RE],
    )).rows as Array<Record<string, string>>;
    const keyOf = (c: string, a: string, r: string) => `${c}\u0000${a}\u0000${r}`;
    const byKey = new Map(now.map((r) => [keyOf(r.connector_id, r.agent_id, r.ref), r]));
    const keys = { c: now.map((r) => r.connector_id), a: now.map((r) => r.agent_id), r: now.map((r) => r.ref) };
    // The episodes that are over, on a report that says so: the machine went offline (or was revoked), the agent is gone from its
    // report, or the agent's report says the conversation no longer waits (another activity, idle, attached, or absent from a list
    // that knows its conversations). A report that does not know (`state: "unknown"`: the connector's look at its terminals timed out,
    // or every entry is unknown) ends nothing: a wait told once is never told again just because one heartbeat could not see it.
    const open = (await q(
      `SELECT w.connector_id::text AS connector_id, w.agent_id, w.ref,
              ${onlineSql(1)} AS online,
              a.capabilities->'resumable' AS resumable, a.agent_id IS NOT NULL AS has_agent
         FROM claw_remote_terminal_waits w
         LEFT JOIN claw_remote_connectors c ON c.connector_id = w.connector_id
         LEFT JOIN claw_remote_agents a ON a.connector_id = w.connector_id AND a.agent_id = w.agent_id`,
      [onlineWindowMs / 1000],
    )).rows as Array<{ connector_id: string; agent_id: string; ref: string; online: boolean; resumable: unknown; has_agent: boolean }>;
    const over = open.filter((w) => {
      if (byKey.has(keyOf(w.connector_id, w.agent_id, w.ref))) return false;
      if (!w.online || !w.has_agent) return true;
      const list = (Array.isArray(w.resumable) ? w.resumable : []).filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
      const entry = list.find((e) => e.ref === w.ref);
      if (entry) return entry.state !== "unknown";
      return list.some((e) => e.state !== "unknown");
    });
    if (over.length) {
      await q(
        `DELETE FROM claw_remote_terminal_waits w USING unnest($1::uuid[], $2::text[], $3::text[]) k(c, a, r)
          WHERE w.connector_id = k.c AND w.agent_id = k.a AND w.ref = k.r`,
        [over.map((w) => w.connector_id), over.map((w) => w.agent_id), over.map((w) => w.ref)],
      );
    }
    await q(
      `INSERT INTO claw_remote_terminal_waits (connector_id, agent_id, ref, owner_user_id, since)
       SELECT k.c, k.a, k.r, k.o, NOW() FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) k(c, a, r, o)
       ON CONFLICT (connector_id, agent_id, ref) DO NOTHING`,
      [keys.c, keys.a, keys.r, now.map((r) => r.owner_user_id)],
    );
    // Waited the minute, and the report that says so was made after it (and the connector's lag): someone who answered in time is not
    // told on a report that predates their answer.
    const candidates = (await q(
      `SELECT connector_id::text AS connector_id, agent_id, ref, since FROM claw_remote_terminal_waits
        WHERE told_at IS NULL AND since <= NOW() - make_interval(secs => $1::float8)`,
      [noticeAfterMs / 1000],
    )).rows as Array<{ connector_id: string; agent_id: string; ref: string; since: Date }>;
    const confirmed = candidates.filter((d) => {
      const r = byKey.get(keyOf(d.connector_id, d.agent_id, d.ref));
      return !!r && new Date(r.reported_at).getTime() >= new Date(d.since).getTime() + noticeAfterMs + TERMINAL_REPORT_LAG_MS;
    });
    const due = confirmed.length ? (await q(
      `UPDATE claw_remote_terminal_waits w SET told_at = NOW()
         FROM unnest($1::uuid[], $2::text[], $3::text[]) k(c, a, r)
        WHERE w.connector_id = k.c AND w.agent_id = k.a AND w.ref = k.r AND w.told_at IS NULL
        RETURNING w.connector_id::text AS connector_id, w.agent_id, w.ref, w.since`,
      [confirmed.map((d) => d.connector_id), confirmed.map((d) => d.agent_id), confirmed.map((d) => d.ref)],
    )).rows as Array<{ connector_id: string; agent_id: string; ref: string; since: Date }> : [];
    // A conversation whose approval its terminal's hook already put to the owner as a card (a terminal-hook session of that machine
    // and conversation with a request not yet answered, `store.openTerminalSession`): the card was the news, and this is not said.
    const carded = due.length ? new Set((await q(
      `SELECT DISTINCT s.connector_id::text AS connector_id, s.ref FROM claw_remote_sessions s
        WHERE s.origin = 'terminal_hook' AND s.status = 'active'
          AND s.connector_id = ANY($1::uuid[]) AND s.ref = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM claw_remote_events r WHERE r.session_id = s.session_id AND r.type = 'permissionRequest'
                       AND NOT EXISTS (SELECT 1 FROM claw_remote_events d WHERE d.session_id = s.session_id
                                         AND d.type = 'permission_resolved' AND d.data->>'actionId' = r.data->>'actionId'))`,
      [due.map((d) => d.connector_id), due.map((d) => d.ref)],
    )).rows.map((r) => `${r.connector_id}\u0000${r.ref}`)) : new Set<string>();
    const notices: TerminalWaitNotice[] = [];
    for (const d of due) {
      const r = byKey.get(keyOf(d.connector_id, d.agent_id, d.ref));
      if (!r) continue;
      if (carded.has(`${d.connector_id}\u0000${d.ref}`)) continue;
      notices.push({
        owner: r.owner_user_id, connectorId: r.connector_id, agentId: r.agent_id, ref: r.ref, machine: r.machine, agent: r.agent,
        title: r.title, cwd: r.cwd, waitingFor: r.waiting_for, since: new Date(d.since),
      });
    }
    return { swept: true, waiting: now.length, notices };
  });
}

/** The ports a test stands in for: what reaches the owner. */
export const terminalWaitPorts: {
  tell: (n: TerminalWaitNotice) => Promise<boolean>;
} = {
  /** Say the notice through the owner's assistant, in the language they write in. False when there is nobody to say it through. */
  tell: async (n) => {
    if (!CLAW_ASSISTANT_ENABLED) return false;
    const q: Querier = (t, p) => db.query(t, p);
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [n.owner])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return false;
    const { personWritesChinese, recordSystemNotice } = await import("../assistant/outbound.js");
    const lang = (await personWritesChinese(q, n.owner)) ? "zh" : "en";
    await recordSystemNotice({ userId: n.owner, sessionId, text: terminalWaitText(n, lang), key: terminalWaitKey(n) });
    return true;
  },
};

/**
 * One sweep and its notices. A notice that fails to be stored, or that had nobody to say it through (the owner has no assistant
 * yet: it is made on their first message), is put back (not told) for the next sweep, as long as that conversation still waits; its key
 * (the episode's) makes a second attempt say nothing twice.
 */
export async function runTerminalWaitSweep(onlineWindowMs: number, noticeAfterMs: number = TERMINAL_WAIT_NOTICE_MS): Promise<TerminalWaitSweep> {
  const out = await sweepTerminalWaits(onlineWindowMs, noticeAfterMs);
  // (the row, if it is still there, is this episode or a newer one not yet told: either way it is not told)
  const putBack = (n: TerminalWaitNotice) => db.query(
    "UPDATE claw_remote_terminal_waits SET told_at = NULL WHERE connector_id = $1 AND agent_id = $2 AND ref = $3",
    [n.connectorId, n.agentId, n.ref],
  ).catch((e) => logger.warn({ err: (e as Error)?.message, connectorId: n.connectorId }, "remote_agents.terminal_wait_requeue_failed"));
  for (const n of out.notices) {
    try {
      const told = await terminalWaitPorts.tell(n);
      logger.info({ owner: n.owner, connectorId: n.connectorId, agentId: n.agentId, told }, "remote_agents.terminal_wait_notice");
      if (!told) await putBack(n);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, connectorId: n.connectorId }, "remote_agents.terminal_wait_notice_failed");
      await putBack(n);
    }
  }
  return out;
}

/**
 * The sweep, every `sweepMs` on this replica, until the returned stop is called. A timer that keeps nothing alive; a failed sweep is
 * logged and the next one tries again.
 */
export function startTerminalWaitSweep(opts: { onlineWindowMs: number; noticeAfterMs?: number; sweepMs?: number }): () => void {
  const sweepMs = opts.sweepMs ?? TERMINAL_WAIT_SWEEP_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const out = await runTerminalWaitSweep(opts.onlineWindowMs, opts.noticeAfterMs);
      if (out.notices.length) logger.info({ waiting: out.waiting, notices: out.notices.length }, "remote_agents.terminal_waits_swept");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "remote_agents.terminal_wait_sweep_failed");
    }
    if (stopped) return;
    timer = setTimeout(tick, sweepMs);
    timer.unref();
  };
  timer = setTimeout(tick, sweepMs);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
