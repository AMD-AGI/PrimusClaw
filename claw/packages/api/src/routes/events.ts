// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import { canAccessSessionAsOperator } from "../auth/models.js";
import { db } from "../infra/db.js";
import { createSessionSubscription } from "../events/store.js";
import { redactPublicJson } from "../events/redaction.js";
/**
 * V2-native SSE event stream: Brain events are forwarded verbatim (raw V2
 * `type` as the SSE `event` field, full payload as `data`); the historical V1
 * compat mapping was removed (see sse-v1-compat-removal.md). Query
 * params `subagent_id` / `fold_subagents` / `include_subagents` control
 * sub-agent event filtering — see `shouldForward` below for the exact rules.
 */

/** V2 event types that should NOT be forwarded to the frontend. */
const SKIP_EVENTS = new Set(["exec_complete"]);
/** Sub-agent lifecycle events that ARE forwarded even when sub events are folded. */
const SUBAGENT_LIFECYCLE_PASSTHROUGH = new Set(["subagentStart", "subagentEnd", "subagentProgress"]);

function eventName(evt: Record<string, unknown>): string | null {
  const t = evt.type;
  if (typeof t !== "string" || !t) return null;
  if (SKIP_EVENTS.has(t)) return null;
  return t;
}

interface ForwardOpts {
  /** When set, return ONLY this sub-agent's events. */
  subagentFilter?: string;
  /** When true, drop sub-agent internal events (keep only lifecycle). */
  foldSubagents: boolean;
}

/**
 * Decide whether an event should be forwarded over SSE.
 *
 * - subagentFilter set → only that sub's events (any type).
 * - foldSubagents true → forward main-agent events + sub lifecycle only.
 * - default → forward everything (preserves real-time SubagentCard UX).
 */
function shouldForward(evt: Record<string, unknown>, opts: ForwardOpts): boolean {
  const subId = typeof evt.subagent_id === "string" ? evt.subagent_id : undefined;
  if (opts.subagentFilter) {
    return subId === opts.subagentFilter;
  }
  if (!opts.foldSubagents) return true;
  if (!subId) return true;
  return SUBAGENT_LIFECYCLE_PASSTHROUGH.has((evt.type as string) ?? "");
}

/**
 * The event name for the marker that closes the history segment.
 *
 * Not a Brain event type -- the API is the only thing that knows where history
 * ends, because it is the one that stops reading the table and starts reading
 * the subscription.
 */
export const HISTORY_COMPLETE_EVENT = "historyComplete";

interface HistorySegment {
  frames: string[];
  /** Ids the live loop must dedup against. */
  seenIds: string[];
}

/**
 * The frames a client receives before the live stream begins.
 *
 * The marker at the end is the only thing on the wire that separates a session
 * with no history from one whose history has not arrived yet. Both used to look
 * identical: nothing at all, until a keepalive *comment* 15 seconds later, which
 * fires no EventSource handler. So a client had nothing to stop waiting on, and
 * a session with no events -- a session created but never spoken to -- rendered
 * as a spinner that never resolved while its request sat open in the network
 * tab, which is exactly what it looks like when a server has hung.
 *
 * It carries no `id:` on purpose. That field sets the client's Last-Event-ID,
 * which `?after=` resumes from, so a synthetic id there would make a reconnect
 * either skip real events or ask for ones it already has.
 */
export function historySegment(
  rows: Array<{ event_id: unknown; data: unknown }>,
  opts: ForwardOpts,
): HistorySegment {
  const frames: string[] = [];
  const seenIds: string[] = [];
  for (const row of rows) {
    const data = redactPublicJson(
      (typeof row.data === "object" && row.data) ? row.data : {},
    ) as Record<string, unknown>;
    const name = eventName(data);
    if (!name) continue;
    if (!shouldForward(data, opts)) continue;
    const eid = row.event_id as string;
    seenIds.push(eid);
    frames.push(`id: ${eid}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  frames.push(
    `event: ${HISTORY_COMPLETE_EVENT}\n`
    + `data: ${JSON.stringify({ type: HISTORY_COMPLETE_EVENT, count: frames.length })}\n\n`,
  );
  return { frames, seenIds };
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {

  // SSE event stream (supports ?mode=replay for full history JSON).
  app.get<{
    Params: { id: string };
    Querystring: {
      after?: string;
      mode?: string;
      subagent_id?: string;
      fold_subagents?: string;
      // Legacy alias kept for back-compat: when callers pass it explicitly
      // they wanted "forward everything", which is now the default.
      include_subagents?: string;
    };
  }>(
    "/v1/chat/sessions/:id/messages",
    async (req, reply) => {
      const sessionId = req.params.id;

      const mode = req.query.mode;
      const fwdOpts: ForwardOpts = {
        subagentFilter: req.query.subagent_id || undefined,
        // Default: forward everything. Opt-in folding via ?fold_subagents=1
        // for clients that implement a lazy-load SubagentCard.
        foldSubagents: req.query.fold_subagents === "1" || req.query.fold_subagents === "true",
      };

      const session = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
      if (!session) return reply.status(404).send({ ok: false, error: "session not found" });
      if (!canAccessSessionAsOperator(session.user_id, getUser(req))) {
        return reply.status(403).send({ ok: false, error: "access denied" });
      }

      if (mode === "replay") {
        const events = (await db.query(
          "SELECT event_id, event as event_type, data, created_at FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL ORDER BY id",
          [sessionId],
        )).rows;
        // Apply the same subagent-fold filter to replay mode so the
        // frontend can request a single sub's history via
        // ?subagent_id=sub-xxx&mode=replay (used to populate the expanded
        // sub-agent card without subscribing to a live SSE).
        const filtered = events
          .filter((row: { data: unknown }) => {
            const data = (typeof row.data === "object" && row.data) ? row.data as Record<string, unknown> : {};
            return shouldForward(data, fwdOpts);
          })
          .map((row: { data: unknown; [key: string]: unknown }) => ({
            ...row,
            data: redactPublicJson(row.data),
          }));
        return { ok: true, data: filtered };
      }

      // SSE mode — long-lived connection
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      const sseWrite = (frame: string): boolean => {
        try { res.write(frame); return true; }
        catch { return false; }
      };

      // Subscribe to NATS FIRST (before DB query) so no events are lost
      // in the window between DB read and subscription start.
      const subscription = createSessionSubscription(sessionId);
      const seenIds = new Set<string>();

      // 1. Push history from DB — one SSE frame per row.
      const afterEventId = req.query.after || null;
      const historyRows = afterEventId
        ? (await db.query(
            "SELECT event_id, event, data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND event_id > $2 ORDER BY id",
            [sessionId, afterEventId],
          )).rows
        : (await db.query(
            "SELECT event_id, event, data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL ORDER BY id",
            [sessionId],
          )).rows;

      const history = historySegment(historyRows, fwdOpts);
      for (const eid of history.seenIds) seenIds.add(eid);
      for (const frame of history.frames) sseWrite(frame);

      // 2. Live NATS events + keepalive (dedup against history via seenIds)
      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* client gone */ }
      }, 15_000);

      req.raw.on("close", () => {
        clearInterval(keepAlive);
        subscription.close();
      });

      try {
        // Live path uses eventsWithSeq() so the SSE `id:` field carries the
        // JetStream streamSequence — same format as event_id in DB. Result:
        // history-from-DB and live-from-NATS segments use a single
        // monotonically-increasing id space, so `?after=<id>` and seenIds
        // dedup are correct across the boundary.
        for await (const item of subscription.eventsWithSeq()) {
          if (!item) continue;
          // Already redacted: events/store.ts::sanitizeSessionEvent masks live
          // events at the subscription, so every consumer inherits it.
          const { event: evt, seq } = item;
          const name = eventName(evt);
          if (!name) continue;
          if (!shouldForward(evt, fwdOpts)) continue;
          const liveId = `claw-${seq}`;
          if (seenIds.has(liveId)) continue;
          seenIds.add(liveId);
          if (!sseWrite(`id: ${liveId}\nevent: ${name}\ndata: ${JSON.stringify(evt)}\n\n`)) break;
        }
      } catch { /* subscription ended or client disconnected */ }

      clearInterval(keepAlive);
      res.end();
      return reply;
    },
  );
}
