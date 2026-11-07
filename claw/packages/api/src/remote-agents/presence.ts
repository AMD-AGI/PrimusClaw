// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Presence of connectors over time, and telling their owner when one has gone.
 *
 * Whether a connector is online is a fact of the moment (`ONLINE_SQL` in `store.ts`: its stream is open and its last
 * heartbeat is fresh). This module turns that into a history: a sweep, every few seconds on whichever replica takes the
 * lock, compares each connector with the state it last recorded (`presence_state`) and writes every change it sees as a
 * row of `claw_remote_connector_transitions`.
 *
 * An owner is told through their assistant (`recordSystemNotice`, keyed by the episode, so said once) when a connector
 * has stayed offline for `noticeAfterMs` (5 minutes): when it was last seen, why it went, and the command that brings it
 * back. When it comes back after that, they are told once that it has. The time is counted from when the sweep first
 * found it offline, not from its last heartbeat, so a short break (a Claw release cuts every stream and the connector is
 * back within seconds) and a Claw outage (the sweep is down with it) are never reported.
 *
 * Not told:
 *  - a connector the owner revoked: they did it themselves, and it cannot come back;
 *  - one replaced by another of the same name that is online (the connector was set up again and registered anew);
 *  - one already offline when presence was first recorded for it (the first sweep after this shipped): a baseline, not a
 *    change anybody is waiting to hear about.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { LAST_SEEN_SQL, offlineReason, onlineSql } from "./store.js";

const logger = pino({ name: "remote-agents-presence" });

/** How long a connector must stay offline before its owner is told. */
export const OFFLINE_NOTICE_MS = 5 * 60 * 1000;
/** How often a replica tries to sweep. One sweep at a time across replicas (an advisory lock). */
export const PRESENCE_SWEEP_MS = 15 * 1000;

/** Same namespace as `store.ts`'s locks, a scope of its own. */
const LOCK_NS = 7_001;
const NAME_MAX = 64;

export type PresenceState = "online" | "offline" | "revoked";

/** What one sweep decided to say, said after its transaction commits. */
export interface PresenceNotice {
  kind: "offline" | "online";
  connectorId: string;
  owner: string;
  name: string;
  episode: number;
  lastSeenAt: Date | null;
  reason: string | null;
}

export interface SweepResult {
  /** False when another replica held the sweep. */
  swept: boolean;
  transitions: number;
  notices: PresenceNotice[];
}

const oneLine = (text: unknown, max: number): string => {
  const t = String(text ?? "").replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/** `HH:MM` in UTC, with the date in front when it is not today's. */
export function clock(at: Date | null, now: Date = new Date()): string {
  if (!at) return "?";
  const iso = at.toISOString();
  const hm = iso.slice(11, 16);
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? hm : `${iso.slice(5, 10)} ${hm}`;
}

const RUN = "claw-connector run";
const LOGIN = "claw-connector login";

export const PRESENCE_WORDS = {
  zh: {
    offline: (name: string, seen: string, reason: string | null) => reason === "auth_expired"
      ? `你的开发环境 ${name} 离线了（最后在线 ${seen}Z，登录已过期或被撤销）。在那台机器上先运行 \`${LOGIN}\`，再运行 \`${RUN}\` 恢复。`
      : `你的开发环境 ${name} 离线了（最后在线 ${seen}Z，心跳停止，多半是机器或 pod 重启、连接器进程退出）。在那台机器上运行 \`${RUN}\` 恢复。`,
    online: (name: string) => `你的开发环境 ${name} 已恢复在线。`,
  },
  en: {
    offline: (name: string, seen: string, reason: string | null) => reason === "auth_expired"
      ? `Your dev environment ${name} is offline (last online ${seen}Z; its sign-in expired or was withdrawn). On that machine run \`${LOGIN}\`, then \`${RUN}\`.`
      : `Your dev environment ${name} is offline (last online ${seen}Z; heartbeats stopped, most likely the machine or pod restarted or the connector exited). On that machine run \`${RUN}\` to bring it back.`,
    online: (name: string) => `Your dev environment ${name} is back online.`,
  },
};

/** The words for a notice, in `lang`. Pure, for the tests. */
export function noticeText(n: PresenceNotice, lang: "zh" | "en", now: Date = new Date()): string {
  const w = PRESENCE_WORDS[lang];
  const name = oneLine(n.name, NAME_MAX) || n.connectorId.slice(0, 8);
  return n.kind === "online" ? w.online(name) : w.offline(name, clock(n.lastSeenAt, now), n.reason);
}

/** The deterministic key of a notice: one per episode of a connector, whoever sends it and however often. */
export const noticeKey = (n: Pick<PresenceNotice, "kind" | "connectorId" | "episode">): string =>
  `remote-connector-${n.kind}:${n.connectorId}:${n.episode}`;

/**
 * One sweep: record every change of presence since the last, and decide what to tell. Runs under a transaction-scoped
 * advisory lock, so two replicas never sweep at once; one that finds it held does nothing (`swept: false`).
 */
export async function sweepPresence(onlineWindowMs: number, noticeAfterMs: number = OFFLINE_NOTICE_MS): Promise<SweepResult> {
  return inTransaction(async (q) => {
    const got = (await q("SELECT pg_try_advisory_xact_lock($1, hashtext('presence')) AS got", [LOCK_NS])).rows[0]?.got;
    if (!got) return { swept: false, transitions: 0, notices: [] };
    const rows = (await q(
      `SELECT c.connector_id::text AS connector_id, c.owner_user_id, c.name, c.revoked_at, c.presence_state, c.offline_notice,
              c.offline_since, c.offline_reason, c.presence_episode, c.stream_end_reason, ${LAST_SEEN_SQL} AS last_seen_at,
              ${onlineSql(1)} AS online,
              COALESCE(c.presence_since <= NOW() - make_interval(secs => $2::float8), FALSE) AS notice_due
         FROM claw_remote_connectors c
        WHERE c.revoked_at IS NULL OR c.presence_state IS DISTINCT FROM 'revoked'
        ORDER BY c.connector_id`,
      [onlineWindowMs / 1000, noticeAfterMs / 1000],
    )).rows as Array<Record<string, any>>;
    const notices: PresenceNotice[] = [];
    let transitions = 0;
    const record = async (r: Record<string, any>, to: PresenceState, reason: string | null): Promise<number> => {
      transitions += 1;
      return Number((await q(
        `INSERT INTO claw_remote_connector_transitions (connector_id, owner_user_id, from_state, to_state, reason, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [r.connector_id, r.owner_user_id, r.presence_state ?? null, to, reason, r.last_seen_at ?? null],
      )).rows[0].id);
    };
    for (const r of rows) {
      const base = { connectorId: r.connector_id as string, owner: r.owner_user_id as string, name: r.name as string };
      if (r.revoked_at) {
        await record(r, "revoked", "revoked");
        await q(
          `UPDATE claw_remote_connectors SET presence_state = 'revoked', presence_since = revoked_at, offline_since = $2,
                  offline_reason = 'revoked', offline_notice = NULL WHERE connector_id = $1`,
          [r.connector_id, r.last_seen_at ?? null],
        );
        continue;
      }
      if (r.presence_state !== "online" && r.presence_state !== "offline") {
        // First sight: a baseline. One already offline is marked as told, so only a change from here on is said.
        const to: PresenceState = r.online ? "online" : "offline";
        const reason = r.online ? null : offlineReason(r.stream_end_reason);
        const id = await record(r, to, reason);
        await q(
          `UPDATE claw_remote_connectors SET presence_state = $2, presence_since = NOW(), offline_since = $3, offline_reason = $4,
                  offline_notice = $5, presence_episode = $6 WHERE connector_id = $1`,
          [r.connector_id, to, r.online ? null : r.last_seen_at ?? null, reason, r.online ? null : "baseline", id],
        );
        continue;
      }
      if (r.presence_state === "online" && !r.online) {
        const reason = offlineReason(r.stream_end_reason);
        const id = await record(r, "offline", reason);
        await q(
          `UPDATE claw_remote_connectors SET presence_state = 'offline', presence_since = NOW(), offline_since = $2, offline_reason = $3,
                  offline_notice = 'pending', presence_episode = $4 WHERE connector_id = $1`,
          [r.connector_id, r.last_seen_at ?? null, reason, id],
        );
        continue;
      }
      if (r.presence_state === "offline" && r.online) {
        const id = await record(r, "online", null);
        // "Back" only to someone who was told it had gone (`back_sent`; put back to `back_pending` if it could not be stored).
        const back = r.offline_notice === "sent";
        await q(
          `UPDATE claw_remote_connectors SET presence_state = 'online', presence_since = NOW(), offline_since = NULL, offline_reason = NULL,
                  offline_notice = $3, presence_episode = $2 WHERE connector_id = $1`,
          [r.connector_id, id, back ? "back_sent" : null],
        );
        if (back) notices.push({ ...base, kind: "online", episode: id, lastSeenAt: null, reason: null });
        continue;
      }
      if (r.presence_state === "online" && r.online && r.offline_notice === "back_pending") {
        await q("UPDATE claw_remote_connectors SET offline_notice = 'back_sent' WHERE connector_id = $1", [r.connector_id]);
        notices.push({ ...base, kind: "online", episode: Number(r.presence_episode), lastSeenAt: null, reason: null });
        continue;
      }
      if (r.presence_state === "offline" && r.offline_notice === "pending" && r.notice_due) {
        // Set up again under a new registration, and that one is online: nothing has gone.
        const replaced = (await q(
          `SELECT 1 FROM claw_remote_connectors c
            WHERE c.owner_user_id = $1 AND c.name = $2 AND c.connector_id <> $3 AND ${onlineSql(4)}
            LIMIT 1`,
          [r.owner_user_id, r.name, r.connector_id, onlineWindowMs / 1000],
        )).rows.length > 0;
        await q("UPDATE claw_remote_connectors SET offline_notice = $2 WHERE connector_id = $1", [r.connector_id, replaced ? "superseded" : "sent"]);
        if (!replaced) {
          notices.push({
            ...base, kind: "offline", episode: Number(r.presence_episode),
            lastSeenAt: r.offline_since ? new Date(r.offline_since) : null, reason: r.offline_reason ?? null,
          });
        }
      }
    }
    return { swept: true, transitions, notices };
  });
}

/** The language the owner last wrote to their assistant in, Chinese or (failing that) English. */
async function ownerLanguage(q: Querier, owner: string): Promise<"zh" | "en"> {
  const rows = (await q(
    "SELECT content FROM claw_assistant_messages WHERE user_id = $1 ORDER BY received_at DESC LIMIT 5", [owner],
  )).rows as Array<{ content: string }>;
  for (const r of rows) {
    const t = String(r.content ?? "");
    if (/\p{Script=Han}/u.test(t)) return "zh";
    if (/\p{L}{2,}/u.test(t)) return "en";
  }
  return "en";
}

/** The ports a test stands in for: what reaches the owner. */
export const presencePorts: {
  tell: (n: PresenceNotice) => Promise<boolean>;
} = {
  /** Say the notice through the owner's assistant. False when there is nobody to say it through (no assistant). */
  tell: async (n) => {
    if (!CLAW_ASSISTANT_ENABLED) return false;
    const q: Querier = (t, p) => db.query(t, p);
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [n.owner])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return false;
    const { recordSystemNotice } = await import("../assistant/outbound.js");
    await recordSystemNotice({ userId: n.owner, sessionId, text: noticeText(n, await ownerLanguage(q, n.owner)), key: noticeKey(n) });
    return true;
  },
};

/**
 * One sweep and its notices. A notice that fails to be stored is put back to be tried by the next sweep (its key makes a
 * second attempt say nothing twice), as long as the connector is still in the episode it was about.
 */
export async function runPresenceSweep(onlineWindowMs: number, noticeAfterMs: number = OFFLINE_NOTICE_MS): Promise<SweepResult> {
  const out = await sweepPresence(onlineWindowMs, noticeAfterMs);
  for (const n of out.notices) {
    try {
      const told = await presencePorts.tell(n);
      logger.info({ owner: n.owner, connectorId: n.connectorId, kind: n.kind, episode: n.episode, told }, "remote_agents.presence_notice");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, connectorId: n.connectorId, kind: n.kind }, "remote_agents.presence_notice_failed");
      const [from, to] = n.kind === "offline" ? ["sent", "pending"] : ["back_sent", "back_pending"];
      await db.query(
        "UPDATE claw_remote_connectors SET offline_notice = $3 WHERE connector_id = $1 AND presence_episode = $2 AND offline_notice = $4",
        [n.connectorId, n.episode, to, from],
      ).catch((e) => logger.warn({ err: (e as Error)?.message, connectorId: n.connectorId }, "remote_agents.presence_notice_requeue_failed"));
    }
  }
  return out;
}

/** Delete the presence history older than `days`; how many rows went. */
export async function prunePresenceHistory(days: number): Promise<number> {
  const r = await db.query(
    "DELETE FROM claw_remote_connector_transitions WHERE at < NOW() - make_interval(secs => $1::float8)", [days * 86_400],
  );
  return r.rowCount ?? 0;
}

/**
 * The sweep, every `sweepMs` on this replica, until the returned stop is called. A timer that keeps nothing alive; a
 * failed sweep is logged and the next one tries again.
 */
export function startPresenceSweep(opts: { onlineWindowMs: number; noticeAfterMs?: number; sweepMs?: number }): () => void {
  const sweepMs = opts.sweepMs ?? PRESENCE_SWEEP_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const out = await runPresenceSweep(opts.onlineWindowMs, opts.noticeAfterMs);
      if (out.transitions) logger.info({ transitions: out.transitions, notices: out.notices.length }, "remote_agents.presence_swept");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "remote_agents.presence_sweep_failed");
    }
    if (stopped) return;
    timer = setTimeout(tick, sweepMs);
    timer.unref();
  };
  timer = setTimeout(tick, sweepMs);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
