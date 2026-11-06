// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files a work item's worker delivered (`deliver_file`), handed to the user.
 *
 * A worker never speaks to the user, and the router only reads what a report says, so a delivered file used to reach
 * nobody on the assistant path: the download card a chat shows for `deliver_file` follows a session's own stream, and the
 * user does not follow the worker's. Here the system says so itself, in its own words and once per file: after a report
 * that tells the assistant anything (`ingestReport`), every delivery in the worker's session that is still downloadable
 * and was not announced before becomes one message, carrying the file (`AssistantFile`) for a channel to offer as a download.
 *
 * The object store is the record (Brain's copy is written before `deliver_file` answers, so before any report after it),
 * and the message id is derived from the delivery's id, so a second report, a retry or a redelivery announces nothing twice.
 * A message about a file is a fallback (not counted against the say limit, not taken for the router having spoken).
 *
 * Nothing announced is lost to a store that did not answer: the report's announcement records how far it got
 * (`claw_work_item_delivery_checks`, through the report's event id) only once every file is announced, and the sweep
 * (`announceMissedDeliveries`) announces again for any item with a newer report. A worker's run end announces too, which
 * covers a file delivered after the item's last report.
 */
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DELIVERY_DIR, DELIVERY_ID_RE, DELIVERY_INLINE_MAX_BYTES, DELIVERY_INLINE_TYPES, deliveryContentType } from "@claw/protocol";
import pino from "pino";
import { CLAW_NOTIFICATIONS_ENABLED, DELIVERY_TTL_DAYS, S3_BUCKET } from "../config.js";
import { redactPublicJson } from "../events/redaction.js";
import { publishEvent } from "../events/store.js";
import { db } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import type { AssistantFile } from "../notifications/assistant-events.js";
import { deterministicEventId } from "../notifications/outbox.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";
import { detectLanguage } from "./language.js";
import { recordSystemNotice, type SayDeps } from "./outbound.js";

const logger = pino({ name: "assistant-deliveries" });

/**
 * At most this many files are announced in one call, oldest first; the rest wait for the next call (a report, a run's end, the
 * sweep), which is why a call that leaves some does not record its report as done.
 */
export const ANNOUNCE_BATCH_MAX = 50;
/** A listing of more than this many pages (1000 keys each) is not a session's deliveries: the rest is left and logged. */
const LIST_MAX_PAGES = 20;
/** Reports this recent whose files were not announced are announced by the sweep; at most this many items a tick. */
const SWEEP_WINDOW = "1 day";
const SWEEP_SETTLE = "1 minute";
const SWEEP_BATCH = 20;
/** A delivery's message stored this long ago whose event is nowhere is taken as never published, and published again. */
const REPUBLISH_SETTLE = "1 minute";
const DAY_MS = 24 * 60 * 60 * 1000;

/** One delivered copy in the store, as listed. */
export interface StoredDelivery { id: string; name: string; size: number; at: Date }

/** The store, behind a seam so a test can stand in for it. */
export const deliveryPorts = {
  /** Every object under `prefix`, page after page (at most LIST_MAX_PAGES). */
  list: async (prefix: string): Promise<Array<{ key: string; size: number; at: Date }>> => {
    const out: Array<{ key: string; size: number; at: Date }> = [];
    let token: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const listed = await getS3Client().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token }));
      for (const o of listed.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, at: o.LastModified ?? new Date(0) });
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      if (!token) return out;
    }
    logger.warn({ prefix: prefix.length, pages: LIST_MAX_PAGES }, "assistant.deliveries_listing_cut");
    return out;
  },
  /** One small object's bytes. */
  read: async (key: string): Promise<Buffer> => {
    const got = await getS3Client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of got.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  },
};

/** The deliveries in a session that can still be downloaded (`DELIVERY_TTL_DAYS`), oldest first. */
export async function sessionDeliveries(ownerId: string, sessionId: string, now = Date.now()): Promise<StoredDelivery[]> {
  const prefix = `${sessionWorkspacePrefix(ownerId, sessionId)}${DELIVERY_DIR}/`;
  const out: StoredDelivery[] = [];
  for (const o of await deliveryPorts.list(prefix)) {
    // `<prefix><id>/<name>`, exactly: anything else is not a delivery the download route would serve.
    const rest = o.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    const id = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    if (slash <= 0 || !DELIVERY_ID_RE.test(id) || !name || name.includes("/")) continue;
    if (now - o.at.getTime() > DELIVERY_TTL_DAYS * DAY_MS) continue;
    out.push({ id, name, size: o.size, at: o.at });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}

function sizeText(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file's name as a channel shows it in markdown: inside a code span, so a name a worker chose (from what it read) draws no link or
 * formatting in the user's chat; one line, its backticks turned to quotes.
 */
function codeName(name: string): string {
  return `\`${name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "'")}\``;
}

/** The message that carries one file, in the language of the item's title. */
export function deliveryText(item: { seq: number; title: string }, file: { name: string; size: number }): string {
  return detectLanguage(item.title) === "Chinese"
    ? `#${item.seq} ${item.title} 交付了文件：${codeName(file.name)}（${sizeText(file.size)}）`
    : `#${item.seq} ${item.title} delivered a file: ${codeName(file.name)} (${sizeText(file.size)})`;
}

/** The file as a channel gets it: what the download route needs, and a small image itself. */
async function assistantFile(itemId: string, ownerId: string, sessionId: string, d: StoredDelivery): Promise<AssistantFile> {
  const contentType = deliveryContentType(d.name);
  const file: AssistantFile = { item_id: itemId, session_id: sessionId, id: d.id, name: d.name, size: d.size, content_type: contentType };
  if (DELIVERY_INLINE_TYPES.includes(contentType) && d.size > 0 && d.size <= DELIVERY_INLINE_MAX_BYTES) {
    try {
      const bytes = await deliveryPorts.read(`${sessionWorkspacePrefix(ownerId, sessionId)}${DELIVERY_DIR}/${d.id}/${d.name}`);
      if (bytes.length === d.size) file.data_base64 = bytes.toString("base64");
    } catch (err) {
      // The download is the file; the picture in the message is a convenience.
      logger.warn({ err: (err as Error)?.name, sessionId }, "assistant.delivery_inline_read_failed");
    }
  }
  return file;
}

/**
 * What became of each delivery's message, by its say id: `carried` once something durable holds it for the user (an outbox row a
 * channel delivers from, or the `AssistantSay` event persisted in the session); `settled` once it is old enough that a publish of
 * its event would have been persisted by now. A message stored but carried by nothing (its event was never published: the publish
 * failed, or the process died after the commit, and the user has no channel subscription) is published again.
 */
async function messagesOf(sayIds: string[], routerSessionId: string): Promise<Map<string, { carried: boolean; settled: boolean }>> {
  if (!sayIds.length) return new Map();
  const outbox = CLAW_NOTIFICATIONS_ENABLED
    ? "EXISTS (SELECT 1 FROM claw_notification_outbox o WHERE o.event_id = s.say_id::text) OR "
    : "";
  const rows = (await db.query(
    `SELECT s.say_id::text AS say_id, s.created_at < NOW() - $3::interval AS settled,
            ${outbox}EXISTS (SELECT 1 FROM claw_session_events e
                       WHERE e.session_id = $2 AND e.event = 'AssistantSay' AND e.created_at >= s.created_at
                         AND e.data->>'say_id' = s.say_id::text) AS carried
       FROM claw_assistant_says s WHERE s.say_id = ANY($1::uuid[])`,
    [sayIds, routerSessionId, REPUBLISH_SETTLE],
  )).rows as Array<{ say_id: string; settled: boolean; carried: boolean }>;
  return new Map(rows.map((r) => [r.say_id, { carried: r.carried === true, settled: r.settled === true }]));
}

/** The web client's copy of a delivery's message, as `announce` publishes it (`outbound.ts`). */
function sayEvent(sessionId: string, sayId: string, text: string, file: AssistantFile): Record<string, unknown> {
  return {
    type: "AssistantSay", session_id: sessionId, say_id: sayId, text: String(redactPublicJson(text) ?? ""), files: [file],
    fallback: false, ts: Date.now(),
  };
}

/**
 * Announce the item's delivered files that have not been announced, oldest first, one system message each (at most
 * ANNOUNCE_BATCH_MAX in one call). With `throughEventId` (the report that asked), the item is recorded as announced through
 * that report once every file's message is held by something durable, so the sweep does not ask again. Returns how many were
 * announced now. Throws for a fault of the store or the database: the caller logs it, and the next report, run end or sweep
 * announces what this one did not.
 */
export async function announceItemDeliveries(itemId: string, deps: SayDeps = {}, throughEventId?: number): Promise<number> {
  const item = (await db.query(
    `SELECT w.user_id, w.seq, w.title, w.worker_session_id, a.session_id AS router_session_id
       FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
      WHERE w.item_id = $1 AND w.kind = 'task'`,
    [itemId],
  )).rows[0] as { user_id: string; seq: number; title: string; worker_session_id: string; router_session_id: string } | undefined;
  if (!item?.worker_session_id) return 0;
  const owner = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1", [item.worker_session_id])).rows[0] as
    { user_id: string | null } | undefined;
  // The worker's session is the user's: one that is not names no file of theirs.
  if (!owner || owner.user_id !== item.user_id) return 0;
  const deliveries = await sessionDeliveries(item.user_id, item.worker_session_id);
  // What became of each one's message is read before anything else is read for it (the message id is the delivery's).
  const keyOf = (d: StoredDelivery) => `delivery:${d.id}`;
  const idOf = (d: StoredDelivery) => deterministicEventId("assistant.notice", item.user_id, keyOf(d));
  const known = await messagesOf(deliveries.map(idOf), item.router_session_id);
  const textOf = (d: StoredDelivery) => deliveryText({ seq: Number(item.seq), title: item.title }, d);
  let told = 0;
  let open = 0;   // files whose message nothing durable holds yet
  let done = 0;
  for (const d of deliveries) {
    const message = known.get(idOf(d));
    if (message?.carried) continue;
    if (done >= ANNOUNCE_BATCH_MAX) { open += 1; continue; }
    done += 1;
    if (message && !message.settled) { open += 1; continue; }   // (stored a moment ago: its event may still be on its way)
    const file = await assistantFile(itemId, item.user_id, item.worker_session_id, d);
    if (message) {
      // Stored, and carried by nothing: its event was never published. Published again; held once the stream has it.
      try {
        await (deps.publishSessionEvent ?? publishEvent)(item.router_session_id, sayEvent(item.router_session_id, idOf(d), textOf(d), file));
        told += 1;
      } catch (err) {
        logger.warn({ err: (err as Error)?.name, itemId }, "assistant.delivery_republish_failed");
        open += 1;
      }
      continue;
    }
    let published = true;
    const stored = await recordSystemNotice({
      userId: item.user_id, sessionId: item.router_session_id, key: keyOf(d), text: textOf(d), files: [file],
    }, {
      ...deps,
      publishSessionEvent: async (sessionId, event) => {
        try {
          await (deps.publishSessionEvent ?? publishEvent)(sessionId, event);
        } catch (err) {
          published = false;
          throw err;
        }
      },
    });
    if (stored) told += 1;
    // Held by a channel's outbox row, or by its event in the stream; with neither, the sweep publishes it again.
    if (!stored || (stored.subscribers === 0 && !published)) open += 1;
  }
  if (throughEventId !== undefined && open === 0) {
    await db.query(
      `INSERT INTO claw_work_item_delivery_checks (item_id, event_id) VALUES ($1, $2)
       ON CONFLICT (item_id) DO UPDATE SET event_id = GREATEST(claw_work_item_delivery_checks.event_id, EXCLUDED.event_id),
                                           checked_at = NOW()`,
      [itemId, throughEventId],
    );
  }
  if (told) logger.info({ itemId, told, open }, "assistant.item_deliveries_announced");
  return told;
}

/**
 * The sweep's part: every task item touched in the last SWEEP_WINDOW whose newest report (of any kind but progress), settled for
 * SWEEP_SETTLE, is newer than what its files were announced through, is announced again. Returns how many files were announced.
 */
export async function announceMissedDeliveries(deps: SayDeps = {}): Promise<number> {
  // Led by the items touched in the window (a report updates its item), each with its newest report through the item's own index:
  // never a scan of every item's log.
  const due = (await db.query(
    `SELECT w.item_id, ev.id AS event_id
       FROM claw_work_items w
       CROSS JOIN LATERAL (
         SELECT e.id, e.created_at FROM claw_work_item_events e
          WHERE e.item_id = w.item_id
            AND e.kind IN ('waiting', 'ready', 'answer', 'blocked', 'failed', 'dropped')
            AND e.source IN ('worker', 'turn_end', 'sweep', 'watchdog')
          ORDER BY e.id DESC LIMIT 1
       ) ev
       LEFT JOIN claw_work_item_delivery_checks c ON c.item_id = w.item_id
      WHERE w.kind = 'task' AND w.updated_at > NOW() - $1::interval
        AND ev.created_at > NOW() - $1::interval AND ev.created_at < NOW() - $2::interval
        AND ev.id > COALESCE(c.event_id, 0)
      ORDER BY ev.id
      LIMIT $3`,
    [SWEEP_WINDOW, SWEEP_SETTLE, SWEEP_BATCH],
  )).rows as Array<{ item_id: string; event_id: string | number }>;
  let told = 0;
  for (const row of due) {
    try {
      told += await announceItemDeliveries(row.item_id, deps, Number(row.event_id));
    } catch (err) {
      logger.warn({ err: (err as Error)?.name, itemId: row.item_id }, "assistant.item_deliveries_sweep_failed");
    }
  }
  return told;
}
