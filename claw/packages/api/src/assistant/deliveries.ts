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
 */
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DELIVERY_DIR, DELIVERY_ID_RE, DELIVERY_INLINE_MAX_BYTES, DELIVERY_INLINE_TYPES, deliveryContentType } from "@claw/protocol";
import pino from "pino";
import { DELIVERY_TTL_DAYS, S3_BUCKET } from "../config.js";
import { db } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import type { AssistantFile } from "../notifications/assistant-events.js";
import { deterministicEventId } from "../notifications/outbox.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";
import { detectLanguage } from "./language.js";
import { recordSystemNotice, type SayDeps } from "./outbound.js";

const logger = pino({ name: "assistant-deliveries" });

/** At most this many of an item's files are announced after one report (the newest; a worker told to zip more does). */
export const ITEM_DELIVERIES_MAX = 10;
const LIST_MAX_KEYS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One delivered copy in the store, as listed. */
export interface StoredDelivery { id: string; name: string; size: number; at: Date }

/** The store, behind a seam so a test can stand in for it. */
export const deliveryPorts = {
  /** Every object under `prefix` (one page of at most LIST_MAX_KEYS: a session does not deliver more). */
  list: async (prefix: string): Promise<Array<{ key: string; size: number; at: Date }>> => {
    const listed = await getS3Client().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, MaxKeys: LIST_MAX_KEYS }));
    return (listed.Contents ?? []).filter((o) => o.Key).map((o) => ({ key: o.Key!, size: o.Size ?? 0, at: o.LastModified ?? new Date(0) }));
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

/** The message that carries one file, in the language of the item's title. */
export function deliveryText(item: { seq: number; title: string }, file: { name: string; size: number }): string {
  return detectLanguage(item.title) === "Chinese"
    ? `#${item.seq} ${item.title} 交付了文件：${file.name}（${sizeText(file.size)}）`
    : `#${item.seq} ${item.title} delivered a file: ${file.name} (${sizeText(file.size)})`;
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
 * Announce the item's delivered files that have not been announced: one system message each, newest ITEM_DELIVERIES_MAX.
 * Returns how many were announced now. Throws only for a fault of the store or the database, which the caller logs: the
 * next report announces what this one did not.
 */
export async function announceItemDeliveries(itemId: string, deps: SayDeps = {}): Promise<number> {
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
  const deliveries = (await sessionDeliveries(item.user_id, item.worker_session_id)).slice(-ITEM_DELIVERIES_MAX);
  if (!deliveries.length) return 0;
  // The ones already announced are left out before anything else is read for them (the message id is the delivery's).
  const keyOf = (d: StoredDelivery) => `delivery:${d.id}`;
  const announced = new Set(((await db.query(
    "SELECT say_id::text AS say_id FROM claw_assistant_says WHERE say_id = ANY($1::uuid[])",
    [deliveries.map((d) => deterministicEventId("assistant.notice", item.user_id, keyOf(d)))],
  )).rows as Array<{ say_id: string }>).map((r) => r.say_id));
  let told = 0;
  for (const d of deliveries) {
    if (announced.has(deterministicEventId("assistant.notice", item.user_id, keyOf(d)))) continue;
    const file = await assistantFile(itemId, item.user_id, item.worker_session_id, d);
    const stored = await recordSystemNotice({
      userId: item.user_id, sessionId: item.router_session_id, key: keyOf(d),
      text: deliveryText({ seq: Number(item.seq), title: item.title }, d), files: [file],
    }, deps);
    if (stored) told += 1;
  }
  if (told) logger.info({ itemId, told }, "assistant.item_deliveries_announced");
  return told;
}
