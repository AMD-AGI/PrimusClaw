// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { db } from "../infra/db.js";
import { singleflightCreate, type FlightResult } from "../shared/singleflight.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { asJsonObject, dispatchTaskToBrain } from "../sessions/dispatch.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { RUN_DOORBELL_DISPATCH } from "../config.js";
import { pendingSecretColumns } from "../tasks/run-secrets.js";
import { forceIdleAfterInterrupt, interruptUnstartedChatRuns } from "../tasks/chat-run.js";
import { nc, kv } from "../infra/nats.js";
import { getUser } from "../auth/middleware.js";
import {
  canAccessSession,
  canAccessSessionAsOperator,
  canWriteSessionAsOperator,
  isAdmin,
  isSystemAdmin,
} from "../auth/models.js";
import { getContextUsageSnapshot } from "../sessions/context-builder.js";
import { publicSessionRow } from "../events/redaction.js";
import {
  interruptSubject, isUserEnvKeyAllowed,
  validateTopology, type EnvironmentTopology,
} from "@claw/protocol";
import { teardownSession, TeardownRefused } from "../sessions/teardown.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";
import { releaseSessionRefs } from "../workspace/store.js";
import { S3_BUCKET, UPLOAD_TTL_DAYS } from "../config.js";
import { getS3Client } from "../infra/s3-client.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { ZipArchive } from "archiver";
import { Readable, PassThrough } from "node:stream";
import pino from "pino"

const logger = pino({ name: "sessions" });

// --- Zip download constants & state ---
//
// The zip-task flow is intentionally stateless across API replicas: every
// task writes a small marker object plus either the final zip or a failed
// sidecar under users/<uid>/sessions/<sid>/.zip-cache/. Any replica can
// answer poll/download by reading S3; no sticky sessions are required.

/** Folders larger than this are routed to the async zip-task flow. */
const ZIP_STREAM_MAX_BYTES = 500 * 1024 * 1024;
const ZIP_CACHE_PREFIX = ".zip-cache/";
const ZIP_MARKER_SUFFIX = ".json";
const ZIP_FAILED_SUFFIX = ".failed";
const ZIP_PRESIGN_EXPIRES_SEC = 3600;

// Internal prefixes hidden from /files listings + zip downloads:
//   .zip-cache  - presigned-zip artifacts produced by zip-task workers
//   .uploads    - user-uploaded inputs with their own TTL (upload-sweeper)
//   .skills     - runtime-resolved skill assets mirrored from marketplace /
//                 plugins; not user artifacts and would clutter the file list
//
// `.transcripts/` is deliberately absent. It is written by Brain rather than by
// the sandbox, so the sync treats it as internal -- but it is the user's record
// of what their run did, and it was downloadable from this listing for every
// release before it moved into a directory. Hiding it here would take a feature
// away as a side effect of a storage-layout change.
const INTERNAL_PREFIXES_RE = /(?:^|\/)(\.zip-cache|\.uploads|\.skills)\//;

/**
 * Whether an object under the session prefix is hidden from the user's files.
 *
 * Exported so the list can be asserted directly: which directories a user can
 * see is a product decision, and both call sites below are inside route handlers
 * that need S3, a database and an authenticated request before they are reached.
 */
export function isHiddenSessionFile(rel: string): boolean {
  return INTERNAL_PREFIXES_RE.test(rel);
}

function zipKeyFor(sessionPrefix: string, taskId: string): string {
  return `${sessionPrefix}${ZIP_CACHE_PREFIX}${taskId}.zip`;
}

function zipTaskMarkerKeyFor(sessionPrefix: string, taskId: string): string {
  return `${sessionPrefix}${ZIP_CACHE_PREFIX}${taskId}${ZIP_MARKER_SUFFIX}`;
}

interface ZipTaskMarker {
  session_id: string;
  task_id: string;
  zip_name: string;
  total_files: number;
  total_size: number;
  created_at_ms: number;
}

/**
 * Fetch a session row, enforcing that the caller may reach that session.
 *
 * A session carries the creator's prompts, workspace layout and sandbox
 * identifiers, so these routes are closed to other tenants. Admins are allowed
 * through as platform operators; the stricter creator-only rule (no admin
 * bypass) still applies to rename / send-message / delete below. Rows with a
 * null `user_id` are legacy pre-auth sessions and stay readable.
 *
 * Pass `{ write: true }` on routes that mutate the workspace, which additionally
 * refuses `system-admin-readonly`.
 *
 * On denial the reply is already sent and `null` is returned, so callers do:
 *
 *     const row = await requireSessionRow(req, reply, sessionId);
 *     if (!row) return reply;
 */
async function requireSessionRow(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  opts: { write?: boolean } = {},
): Promise<Record<string, any> | null> {
  const row = (await db.query(
    "SELECT * FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0];
  if (!row) {
    reply.status(404).send({ ok: false, error: "session not found" });
    return null;
  }
  const allowed = opts.write
    ? canWriteSessionAsOperator(row.user_id, getUser(req))
    : canAccessSessionAsOperator(row.user_id, getUser(req));
  if (!allowed) {
    reply.status(403).send({
      ok: false,
      error: opts.write
        ? "only the session creator or a system-admin can modify this session"
        : "only the session creator or an admin can access this session",
    });
    return null;
  }
  return row;
}

/**
 * Same access check as {@link requireSessionRow}, resolving the session's S3
 * workspace prefix for the file / zip / upload routes.
 */
async function requireSessionScope(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  opts: { write?: boolean } = {},
): Promise<{ sessionPrefix: string } | null> {
  const row = await requireSessionRow(req, reply, sessionId, opts);
  if (!row) return null;
  // Through the same builder the delete uses, because a prefix these routes
  // write to and the teardown does not address is a session whose files outlive
  // it. The column goes in as it is: the builder resolves a blank owner itself,
  // so resolving it here first would only be asking the same question twice.
  return { sessionPrefix: sessionWorkspacePrefix(row.user_id, sessionId) };
}

type ZipStatus =
  | { status: "ready"; marker: ZipTaskMarker; zipKey: string; zipSize?: number; expiresAt: string }
  | { status: "failed"; marker: ZipTaskMarker; error: string }
  | { status: "processing"; marker: ZipTaskMarker }
  | { status: "missing" };

function isS3NotFound(err: any): boolean {
  return err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey" || err?.name === "NotFound";
}

async function writeZipTaskMarker(
  s3: S3Client,
  sessionPrefix: string,
  marker: ZipTaskMarker,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: zipTaskMarkerKeyFor(sessionPrefix, marker.task_id),
    Body: JSON.stringify(marker),
    ContentType: "application/json",
    Tagging: "origin=zip-cache&ttl=1d",
  }));
}

/** Read the zip-task marker; absence means the task id is unknown or expired. */
async function readZipTaskMarker(
  s3: S3Client,
  sessionPrefix: string,
  taskId: string,
): Promise<ZipTaskMarker | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: zipTaskMarkerKeyFor(sessionPrefix, taskId),
    }));
    return JSON.parse(await streamToString(obj.Body as Readable)) as ZipTaskMarker;
  } catch (err: any) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
}

/**
 * Derive task state from S3 alone. The marker proves the task was scheduled;
 * the zip object signals readiness, and the failed sidecar signals failure.
 */
async function readZipStatus(
  s3: S3Client,
  sessionPrefix: string,
  taskId: string,
): Promise<ZipStatus> {
  const marker = await readZipTaskMarker(s3, sessionPrefix, taskId);
  if (!marker) return { status: "missing" };

  const zipKey = zipKeyFor(sessionPrefix, taskId);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: zipKey }));
    return {
      status: "ready",
      marker,
      zipKey,
      zipSize: head.ContentLength ?? undefined,
      expiresAt: new Date(Date.now() + ZIP_PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  } catch (err: any) {
    if (!isS3NotFound(err)) throw err;
  }

  const failedKey = `${zipKey}${ZIP_FAILED_SUFFIX}`;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: failedKey }));
    const text = await streamToString(obj.Body as Readable);
    let error = "zip task failed";
    try { error = (JSON.parse(text)?.error as string) || error; } catch { /* keep default */ }
    return { status: "failed", marker, error };
  } catch (err: any) {
    if (!isS3NotFound(err)) throw err;
  }

  return { status: "processing", marker };
}

/** Collect a small S3 JSON object body into a UTF-8 string. */
async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf-8");
}

/** Paginated ListObjectsV2 collecting all keys under a prefix. */
async function listS3KeysUnderPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; size: number }>> {
  const entries: Array<{ key: string; size: number }> = [];
  let ct: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: ct }),
    );
    for (const obj of res.Contents || []) {
      if (!obj.Key || obj.Size === undefined || obj.Size <= 0) continue;
      const rel = obj.Key.slice(prefix.length);
      if (isHiddenSessionFile(rel)) continue;
      entries.push({ key: obj.Key, size: obj.Size });
    }
    ct = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ct);
  return entries;
}

/**
 * Background: stream S3 objects into archiver, then upload the zip to S3.
 *
 * Stateless: POST writes the marker before this starts; this worker only
 * writes the resulting zipKey (success) or a failed sidecar (failure).
 */
async function runZipTask(args: {
  sessionId: string;
  taskId: string;
  sessionPrefix: string;
  entries: Array<{ key: string; size: number }>;
}): Promise<void> {
  const { sessionId, taskId, sessionPrefix, entries } = args;
  const s3 = getS3Client();
  const zipKey = zipKeyFor(sessionPrefix, taskId);
  try {
    const archive = new ZipArchive({ zlib: { level: 1 } });
    const passThrough = new PassThrough();
    archive.pipe(passThrough);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: S3_BUCKET,
        Key: zipKey,
        Body: passThrough,
        ContentType: "application/zip",
        Tagging: "origin=zip-cache&ttl=1d",
      },
    });

    const appendAll = (async () => {
      for (const entry of entries) {
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: entry.key }));
          if (obj.Body) {
            const rel = entry.key.slice(sessionPrefix.length);
            archive.append(obj.Body as Readable, { name: rel });
          }
        } catch (e: any) {
          logger.warn({ err: e, key: entry.key, taskId }, "zip_task.skip_file");
        }
      }
      await archive.finalize();
    })();

    await Promise.all([appendAll, upload.done()]);

    logger.info({ taskId, sessionId, zipKey }, "zip_task.ready");
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    logger.error({ err: e, taskId, sessionId }, "zip_task.failed");
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${zipKey}${ZIP_FAILED_SUFFIX}`,
        Body: JSON.stringify({ error: errorMsg, ts: Date.now() }),
        ContentType: "application/json",
        Tagging: "origin=zip-cache&ttl=1d",
      }));
    } catch (sidecarErr: any) {
      logger.error({ err: sidecarErr, taskId, sessionId }, "zip_task.failed_sidecar_write_failed");
    }
  }
}

/** Map internal harness modes to V1-compatible display modes for frontend. */
function displayMode(mode: string): string {
  return mode.replace(/-harness$/, "");
}
function mapSessionForDisplay(row: Record<string, unknown>): Record<string, unknown> {
  const safe = publicSessionRow(row);
  if (safe.mode && typeof safe.mode === "string") {
    return { ...safe, mode: displayMode(safe.mode) };
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Idempotency cache (claw_idempotency_keys)
//
// Used by endpoints whose retry can produce duplicate side effects (today only
// POST /v1/sessions when it also dispatches a first message).  Clients pass
// `Idempotency-Key: <opaque-string>` (typically a UUID generated client-side
// and reused for the lifetime of the user's intent).  We cache the verbatim
// `{status, response}` for 24h scoped by (user_id, route, key).
// ---------------------------------------------------------------------------
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX_LEN = 200;
// Lock-wait budget for the per-key advisory lock. Sits above a normal create
// (incl. dispatch) so the common case still gets the lock, but bounds the wait
// so a wedged holder cannot pin a bulkhead connection forever. Must stay below
// statement_timeout (db.ts, 30s) so lock_timeout fires first.
const IDEM_LOCK_TIMEOUT_MS = Number(process.env.IDEM_LOCK_TIMEOUT_MS) || 15000;
// After lock_timeout, briefly poll the idempotency cache (holding NO connection)
// to catch a holder that finishes just after our wait expired, before failing
// transiently. Tries × interval bounds the extra latency on the slow path only.
const IDEM_BUSY_POLL_MS = Number(process.env.IDEM_BUSY_POLL_MS) || 200;
const IDEM_BUSY_POLL_TRIES = Number(process.env.IDEM_BUSY_POLL_TRIES) || 5;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// A (singleflight): in-process de-dup of concurrent same-key creates, keyed by
// `${userId}:${route}:${idemKey}`. The first request runs the create; all
// concurrent joiners on this pod await the same promise and touch NO DB
// connection, so a same-key retry storm cannot multiply connection usage. The
// entry is always removed in the leader's finally, bounding the map's size.
const inflightCreates = new Map<string, Promise<FlightResult>>();

interface IdempotencyHit {
  statusCode: number;
  response: unknown;
}

interface QueryRunner {
  query: typeof db.query;
}

interface IdempotencyLock {
  client: PoolClient;
  lockScope: string;
  key: string;
}

function extractIdempotencyKey(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers["idempotency-key"] ?? req.headers["Idempotency-Key"];
  if (typeof raw !== "string") return null;
  const k = raw.trim();
  if (!k || k.length > IDEMPOTENCY_KEY_MAX_LEN) return null;
  return k;
}

/**
 * True when the downstream client has already disconnected (DC) before we
 * reached this point. Under pool-queue backpressure a request is frequently
 * dequeued long after the caller gave up and reconnected with a retry, so the
 * expensive work it is about to do (workspace bring-up via dispatch) is wasted
 * and only deepens the cascade. Callers use this to bail out early and roll
 * back any half-applied state.
 */
function isClientGone(req: FastifyRequest): boolean {
  const raw = req.raw as unknown as { aborted?: boolean };
  return raw?.aborted === true || req.socket?.destroyed === true;
}

/**
 * Acquire the per-key advisory lock on the dedicated bulkhead pool (db.lockPool),
 * bounded by lock_timeout. Returns the held lock, or null when the wait timed out
 * (another in-flight request held it past the budget) so the caller can replay
 * the cache or fail transiently WITHOUT pinning a connection. Held until
 * releaseIdempotencyLock returns the pooled client.
 */
async function acquireIdempotencyLock(
  userId: string,
  route: string,
  key: string,
): Promise<IdempotencyLock | null> {
  const client = await db.lockPool.connect();
  const lockScope = `${userId}:${route}`;
  try {
    await client.query(`SET lock_timeout = ${IDEM_LOCK_TIMEOUT_MS}`);
    await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [lockScope, key]);
    return { client, lockScope, key };
  } catch (err) {
    client.release();
    // 55P03 = lock_not_available: lock_timeout fired. Treat as "busy" (null).
    if ((err as { code?: string })?.code === "55P03") return null;
    throw err;
  }
}

/** Release the per-key advisory lock and return the pooled client. */
async function releaseIdempotencyLock(lock: IdempotencyLock): Promise<void> {
  try {
    await lock.client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [lock.lockScope, lock.key]);
    lock.client.release();
  } catch (err) {
    // Unlock failed: the advisory lock may still be held on this physical
    // connection. Destroy it (release with an error => not returned to the
    // pool) so a lingering lock can't force every future same-key acquire to
    // wait out lock_timeout on a poisoned connection.
    lock.client.release(err as Error);
  }
}

async function readIdempotency(
  client: QueryRunner,
  userId: string,
  route: string,
  key: string,
): Promise<IdempotencyHit | null> {
  const row = (await client.query(
    "SELECT status_code, response FROM claw_idempotency_keys WHERE user_id = $1 AND route = $2 AND idem_key = $3 AND expires_at > NOW()",
    [userId, route, key],
  )).rows[0];
  if (!row) return null;
  return { statusCode: row.status_code as number, response: row.response };
}

async function saveIdempotency(
  client: QueryRunner,
  userId: string,
  route: string,
  key: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO claw_idempotency_keys (idem_key, user_id, route, status_code, response, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' milliseconds')::interval)
     ON CONFLICT (user_id, route, idem_key) DO UPDATE SET
       status_code = EXCLUDED.status_code,
       response = EXCLUDED.response,
       created_at = NOW(),
       expires_at = EXCLUDED.expires_at`,
    [key, userId, route, statusCode, JSON.stringify(response), String(IDEMPOTENCY_TTL_MS)],
  );
}

/** Cache idempotency response without changing the primary request outcome. */
async function saveIdempotencyBestEffort(
  client: QueryRunner,
  userId: string,
  route: string,
  key: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  try {
    await saveIdempotency(client, userId, route, key, statusCode, response);
  } catch (err) {
    logger.error({ err, userId, route }, "idempotency.save_failed");
  }
}

// ---------------------------------------------------------------------------
// Session-level env validation (session-env-design.md §3.3).
// Returns a validated Record<string,string> or throws a reply error.
// ---------------------------------------------------------------------------
const SESSION_ENV_MAX_KEYS = 64;
const SESSION_ENV_MAX_VALUE_LEN = 4096;

function parseSessionEnv(
  raw: unknown,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, env: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "env must be a JSON object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > SESSION_ENV_MAX_KEYS) {
    return { ok: false, error: `env exceeds ${SESSION_ENV_MAX_KEYS} keys` };
  }
  const validated: Array<[string, string]> = [];
  for (const [k, v] of entries) {
    if (typeof v !== "string") continue;
    if (!isUserEnvKeyAllowed(k)) {
      return { ok: false, error: `env key '${k}' is not allowed` };
    }
    if (v.length > SESSION_ENV_MAX_VALUE_LEN) {
      return { ok: false, error: `env value for '${k}' exceeds ${SESSION_ENV_MAX_VALUE_LEN} bytes` };
    }
    validated.push([k, v]);
  }
  return { ok: true, env: Object.fromEntries(validated) };
}

// Brain-dispatch helper (dispatchTaskToBrain, DispatchInput, DispatchResult)
// now lives in ../session-dispatch.js — shared with
// routes/anthropic-managed-agents.ts. See that module for the implementation.

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {

  // --- Create Session ---
  //
  // Accepts an OPTIONAL `message` block; when present the endpoint
  // atomically (a) creates the session row, (b) flips agent_status to
  // 'running', and (c) dispatches the first task to Brain. On dispatch
  // failure the freshly-inserted session row is DELETED (strict rollback)
  // so the client never observes a "phantom" row that exists in the DB but
  // has no chat events / brain traffic.
  //
  // Idempotency: clients SHOULD pass `Idempotency-Key: <opaque>` so that
  // network-retry of "create + first message" does not produce duplicate
  // sessions. Cached responses are scoped by (user_id, route, key) for 24h.
  app.post("/v1/sessions", async (req, reply) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const route = "POST /v1/sessions";
    const idemKey = extractIdempotencyKey(req);
    let idemLock: IdempotencyLock | null = null;

    const body = req.body as Record<string, unknown>;
    const { name, system_prompt, config: cfg, mode: reqMode, parent_session_id, team_role } = body;
    const sessionId = crypto.randomUUID();
    const mode = (reqMode as string) || "claw";
    const parentSid = (parent_session_id as string) || null;
    const role = (team_role as string) || "";
    const sessionConfig = cfg == null ? {} : asJsonObject(cfg);
    if (!sessionConfig) {
      return reply.status(400).send({ ok: false, error: "config must be a JSON object" });
    }
    const reservedConfigKeys = [
      "platform_key",
      "llm_api_key",
      "virtual_key",
      "_server_managed_credentials",
    ];
    const suppliedReservedKey = reservedConfigKeys.find((key) =>
      Object.prototype.hasOwnProperty.call(sessionConfig, key)
    );
    if (suppliedReservedKey) {
      return reply.status(400).send({
        ok: false,
        error: `config.${suppliedReservedKey} is server-managed`,
      });
    }

    if (parentSid) {
      if (!user) {
        return reply.status(401).send({ ok: false, error: "authentication required" });
      }
      const parent = (await db.query(
        "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
        [parentSid],
      )).rows[0] as { user_id?: string | null } | undefined;
      if (!parent) {
        return reply.status(404).send({ ok: false, error: "parent_session_not_found" });
      }
      if (!canWriteSessionAsOperator(parent.user_id, user)) {
        return reply.status(403).send({ ok: false, error: "parent_session_access_denied" });
      }
    }

    // --- Parse optional message up-front so validation errors don't
    // leak a half-created session row.
    const firstMsgRaw = body.message;
    let firstMessage: {
      content: string;
      messageType: string;
      toolIds: number[];
      pluginId: number | undefined;
      requestImage: string | undefined;
      requestResource: Record<string, unknown> | undefined;
      requestTimeout: number | undefined;
      workspaceId: string | undefined;
      mcpServers: Record<string, Record<string, unknown>> | undefined;
    } | null = null;
    if (firstMsgRaw !== undefined && firstMsgRaw !== null) {
      if (typeof firstMsgRaw !== "object" || Array.isArray(firstMsgRaw)) {
        return reply.status(400).send({ ok: false, error: "message must be a JSON object" });
      }
      const fm = firstMsgRaw as Record<string, unknown>;
      const fmType = ((fm.messageType as string) || (fm.message_type as string) || "text").toLowerCase();
      if (fmType !== "text" && fmType !== "inject") {
        return reply.status(400).send({ ok: false, error: "message.messageType must be text|inject" });
      }
      const fmContent = (fm.content as string) || "";
      if (!fmContent) {
        return reply.status(400).send({ ok: false, error: "message.content required" });
      }
      const fmResourceRaw = fm.resource;
      if (fmResourceRaw !== undefined && !asJsonObject(fmResourceRaw)) {
        return reply.status(400).send({ ok: false, error: "message.resource must be a JSON object" });
      }
      const fmTimeoutRaw = fm.timeout;
      const fmTimeoutNum =
        fmTimeoutRaw !== undefined && fmTimeoutRaw !== null && String(fmTimeoutRaw).trim() !== ""
          ? Number(fmTimeoutRaw)
          : NaN;
      if (
        fmTimeoutRaw !== undefined && fmTimeoutRaw !== null && String(fmTimeoutRaw).trim() !== "" &&
        (!Number.isFinite(fmTimeoutNum))
      ) {
        return reply.status(400).send({ ok: false, error: "message.timeout must be a finite number" });
      }
      const fmImageRaw = fm.image;
      const fmRequestImage =
        typeof fmImageRaw === "string" && fmImageRaw.trim() !== "" ? fmImageRaw.trim() : undefined;
      const fmWorkspaceRaw = fm.workspaceId ?? fm.workspace_id;
      const fmWorkspaceId =
        typeof fmWorkspaceRaw === "string" && fmWorkspaceRaw.trim() !== "" ? fmWorkspaceRaw.trim() : undefined;
      const fmPluginRaw = fm.pluginId ?? fm.plugin_id;
      let fmPluginId: number | undefined;
      if (fmPluginRaw !== undefined && fmPluginRaw !== null && fmPluginRaw !== "") {
        const n = typeof fmPluginRaw === "number" ? fmPluginRaw : parseInt(String(fmPluginRaw), 10);
        if (Number.isFinite(n)) fmPluginId = n;
      }
      firstMessage = {
        content: fmContent,
        messageType: fmType,
        toolIds: (fm.tools as number[]) || (fm.tool_ids as number[]) || [],
        pluginId: fmPluginId,
        requestImage: fmRequestImage,
        requestResource: asJsonObject(fmResourceRaw),
        requestTimeout: Number.isFinite(fmTimeoutNum) ? Math.trunc(fmTimeoutNum) : undefined,
        workspaceId: fmWorkspaceId,
        mcpServers: (fm.mcp_servers as Record<string, Record<string, unknown>>) || undefined,
      };
    }

    const sessionEnvResult = parseSessionEnv(body.env);
    if (!sessionEnvResult.ok) {
      return reply.status(400).send({ ok: false, error: sessionEnvResult.error });
    }
    const sessionEnv = sessionEnvResult.env;

    // A (singleflight): all DB-touching work + the advisory lock live in
    // execute(); every exit is normalized to {statusCode, response} so a joiner
    // can faithfully replay the leader's result without re-running side effects.
    const execute = async (): Promise<FlightResult> => {
      try {
        // Serialize all side effects for the same idempotency key. Without this
        // lock, two concurrent retries can both miss the cache and both dispatch.
        if (idemKey) {
          idemLock = await acquireIdempotencyLock(userId, route, idemKey);
          if (!idemLock) {
            // lock_timeout fired: the holder is slow/wedged and we did NOT pin a
            // connection. Briefly poll the cache (holding nothing) so a holder
            // that finishes just after our timeout still lets us replay its
            // result instead of forcing a client retry; only fail transiently
            // if it never publishes within the budget.
            for (let i = 0; i < IDEM_BUSY_POLL_TRIES; i++) {
              const busyHit = await readIdempotency(db, userId, route, idemKey);
              if (busyHit) return { statusCode: busyHit.statusCode, response: busyHit.response };
              await sleep(IDEM_BUSY_POLL_MS);
            }
            return {
              statusCode: 503,
              response: {
                ok: false,
                error: "in_progress_timeout",
                message: "creation is taking longer than expected; please retry",
              },
            };
          }
          const hit = await readIdempotency(idemLock.client, userId, route, idemKey);
          if (hit) {
            return { statusCode: hit.statusCode, response: hit.response };
          }
        }

        // Snapshot user env BEFORE inserting the session so a snapshot failure
        // can short-circuit without leaving a row behind.
        let userEnvSnapshot: Record<string, string> = {};
        if (firstMessage) {
          userEnvSnapshot = await loadUserEnvSnapshot(db, userId, logger);
        }

        // Insert session (+ pre-flip to 'running' when message is present,
        // so the row is born consistent with its dispatch state). Single
        // INSERT: no transaction needed because there's no row to lock yet.
        const initialStatus = firstMessage ? "running" : "idle";
        await db.query(
          `INSERT INTO claw_sessions
           (session_id, name, user_id, mode, agent_status, agent_id, system_prompt, status, config, parent_session_id, team_role, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'agent_default', $6, 'active', $7::jsonb, $8, $9, NOW(), NOW())`,
          [
            sessionId,
            (name as string || "").slice(0, 255),
            userId, mode, initialStatus,
            (system_prompt as string || ""),
            JSON.stringify(sessionConfig),
            parentSid, role,
          ],
        );

        const dispMode = mode.replace(/-harness$/, "");

        // Fast path: no message; behaviour identical to the legacy contract.
        if (!firstMessage) {
          const response = {
            ok: true,
            data: {
              session_id: sessionId, name, user_id: userId, mode: dispMode,
              agent_status: "idle", parent_session_id: parentSid, team_role: role,
            },
          };
          if (idemKey && idemLock) await saveIdempotencyBestEffort(idemLock.client, userId, route, idemKey, 200, response);
          return { statusCode: 200, response };
        }

        // A3: if the client already disconnected, skip the expensive dispatch
        // (workspace bring-up) and roll back the just-created row so we don't
        // strand a 'running' session with no task. The Idempotency-Key was not
        // persisted as a final result, so a genuine retry recreates cleanly.
        // Hard DELETE (not soft) for the same reason as the publish-failure
        // rollback below: the row was created in this request and never became
        // visible to any consumer, so there is no history worth soft-deleting.
        if (isClientGone(req)) {
          await db.query("DELETE FROM claw_session_events WHERE session_id = $1", [sessionId]);
          await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [sessionId]);
          logger.warn({ sessionId, userId }, "session.create.client_gone_pre_dispatch");
          return { statusCode: 499, response: { ok: false, error: "client_closed_request" } };
        }

        // Combined path: dispatch the first message via the shared helper.
        // On publish failure we DELETE the just-inserted session row so the
        // client can safely retry (Idempotency-Key replays the 503 if reused).
        const dispatch = await dispatchTaskToBrain(
          {
            sessionId, userId, user,
            content: firstMessage.content,
            messageType: firstMessage.messageType,
            toolIds: firstMessage.toolIds,
            pluginId: firstMessage.pluginId,
            requestImage: firstMessage.requestImage,
            requestResource: firstMessage.requestResource,
            requestTimeout: firstMessage.requestTimeout,
            workspaceId: firstMessage.workspaceId,
            mcpServers: firstMessage.mcpServers,
            capturedUserEnvSnapshot: userEnvSnapshot,
            capturedSessionEnv: sessionEnv,
          },
          async () => {
            // Strict rollback: remove the session row + its UserMessage event
            // so no phantom row survives. Hard DELETE (not soft) is fine here
            // because the row was created in this same request and was never
            // visible to any other consumer (agent_status was 'running' the
            // whole time, so no SSE history fetch matched it).
            //
            // The workspace reference goes first, because it is the one piece of
            // this that outlives the row it belongs to: nothing else releases a
            // reference held by a session that no longer exists -- teardown only
            // runs for sessions someone can still delete -- and a workspace with
            // a live reference is one the collector keeps forever.
            //
            // Logged when it does not land, for the same reason: the row is
            // deleted rather than tombstoned, so a reference left behind here has
            // no session row for the idle sweep to join against and no later pass
            // reaches it. This line is the only notice anyone gets that a
            // workspace is being kept for a session that never existed.
            if (await releaseSessionRefs(sessionId) === "failed") {
              logger.error({ sessionId, userId }, "session.create.rollback_ref_release_failed");
            }

            await db.query("DELETE FROM claw_session_events WHERE session_id = $1", [sessionId]);
            await db.query("DELETE FROM claw_sessions WHERE session_id = $1", [sessionId]);
          },
        );
        if (dispatch.kind === "publish_failed") {
          const errResp = { ok: false, error: "task dispatch failed", detail: dispatch.error?.message };
          if (idemKey && idemLock) await saveIdempotencyBestEffort(idemLock.client, userId, route, idemKey, 503, errResp);
          return { statusCode: 503, response: errResp };
        }
        if (dispatch.kind === "rejected") {
          const errResp = { ok: false, error: "admission_rejected", reason: dispatch.reason };
          if (idemKey && idemLock) await saveIdempotencyBestEffort(idemLock.client, userId, route, idemKey, 429, errResp);
          return { statusCode: 429, response: errResp };
        }

        // Soft-limit overflow and a doorbell a full replica acked look the
        // same to the caller: accepted, session running. The row sits at
        // `queued` either way; advertising a queue position only on the
        // admission path made the two waits look like different products.
        const okResp = {
          ok: true,
          data: {
            session_id: sessionId, name, user_id: userId, mode: dispMode,
            agent_status: "running", parent_session_id: parentSid, team_role: role,
            message: {
              message_id: dispatch.messageId,
              dispatched: true,
            },
          },
        };
        if (idemKey && idemLock) await saveIdempotencyBestEffort(idemLock.client, userId, route, idemKey, 200, okResp);
        return { statusCode: 200, response: okResp };
      } finally {
        if (idemLock) await releaseIdempotencyLock(idemLock);
      }
    };

    // Run through the singleflight map only when an Idempotency-Key is present
    // (the unit of de-duplication). A joiner that would inherit the leader's 499
    // (leader aborted on ITS OWN disconnect) but is itself still connected
    // retries as a fresh attempt instead of wrongly reporting a closed request.
    // A (singleflight): collapse concurrent same-key creates on this pod into a
    // single execution so a retry storm cannot multiply DB/lock-pool usage. The
    // coordination (join, 499/exception retry, leader fallback) lives in the
    // unit-tested singleflightCreate helper.
    let result: FlightResult;
    if (idemKey) {
      const flightKey = `${userId}:${route}:${idemKey}`;
      result = await singleflightCreate(inflightCreates, flightKey, execute, () => isClientGone(req));
    } else {
      result = await execute();
    }
    return reply.status(result.statusCode).send(result.response);
  });

  // --- List Sessions (with A2A children inlined) ---
  // scope=all is restricted to admin (system-admin / system-admin-readonly);
  // any other user passing scope=all silently falls back to their own sessions.
  app.get("/v1/sessions", async (req) => {
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const q = req.query as { scope?: string; limit?: string; offset?: string } | undefined;
    const scope = q?.scope;
    const wantAll = scope === "all" && !!user && isAdmin(user);

    // Pagination (project convention: limit/offset, mirrors /v1/resources).
    // Default 50, clamped to [1, 200]; offset >= 0. The idx_sessions_user
    // index (user_id, created_at DESC) backs the per-user page scan.
    const limit = Math.min(200, Math.max(1, Number(q?.limit) || 50));
    const offset = Math.max(0, Number(q?.offset) || 0);

    const whereSql = wantAll
      ? "deleted_at IS NULL"
      : "user_id = $1 AND deleted_at IS NULL";
    const whereParams: unknown[] = wantAll ? [] : [userId];

    const total = Number(
      (await db.query(
        `SELECT COUNT(*)::int AS n FROM claw_sessions WHERE ${whereSql}`,
        whereParams,
      )).rows[0]?.n ?? 0,
    );

    const rows = (await db.query(
      `SELECT * FROM claw_sessions WHERE ${whereSql} ORDER BY created_at DESC `
        + `LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
      [...whereParams, limit, offset],
    )).rows;

    const sessionIds = rows.map((r: any) => r.session_id);
    const childRows = sessionIds.length
      ? (await db.query(
          "SELECT * FROM claw_sessions WHERE parent_session_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at",
          [sessionIds],
        )).rows
      : [];

    const childrenByParent = new Map<string, Record<string, unknown>[]>();
    for (const c of childRows) {
      const pid = c.parent_session_id as string;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid)!.push(mapSessionForDisplay(c));
    }

    const data = rows.map((r: any) => {
      const session = mapSessionForDisplay(r);
      const children = childrenByParent.get(r.session_id);
      if (children?.length) (session as any).children = children;
      return session;
    });

    return { ok: true, data, pagination: { limit, offset, total } };
  });

  // --- Get Session (creator-only) ---
  app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
    const row = await requireSessionRow(req, reply, req.params.id);
    if (!row) return reply;
    const session = mapSessionForDisplay(row);
    try {
      const kvEntry = await kv.get(`hands.${req.params.id}`);
      if (kvEntry) {
        const info = JSON.parse(new TextDecoder().decode(kvEntry.value));
        if (info.workloadId) (session as any).sandbox_workload_id = info.workloadId;
        if (info.status) (session as any).sandbox_status = info.status;
        if (info.namespace) (session as any).sandbox_namespace = info.namespace;
      }
    } catch { /* KV lookup is best-effort */ }
    return { ok: true, data: session };
  });

  // --- Context Usage (creator-only) ---
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/context-usage", async (req, reply) => {
    const row = await requireSessionRow(req, reply, req.params.id);
    if (!row) return reply;

    const usage = await getContextUsageSnapshot(row.session_id, row.user_id || "default");
    return { ok: true, data: usage };
  });

  // --- List child sessions (agent team members) — creator-only on the parent ---
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/children", async (req, reply) => {
    const parent = await requireSessionRow(req, reply, req.params.id);
    if (!parent) return reply;
    const rows = (await db.query(
      "SELECT * FROM claw_sessions WHERE parent_session_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [req.params.id],
    )).rows;
    return { ok: true, data: rows.map(mapSessionForDisplay) };
  });

  // --- Update Session (rename) ---
  app.patch<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
    const sessionId = req.params.id;
    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const body = req.body as Record<string, unknown>;
    const newName = ((body.name as string) || "").trim();
    if (!newName) return reply.status(400).send({ ok: false, error: "name is required" });

    const row = (await db.query(
      "SELECT session_id, user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0];
    if (!row) return reply.status(404).send({ ok: false, error: "session not found" });
    // Creator-only, like send-message and delete: the same rule those two express
    // through canAccessSession, rather than a second inline copy of it.
    if (!canAccessSession(row.user_id, userId) && !(!row.user_id && user && isSystemAdmin(user))) {
      return reply.status(403).send({ ok: false, error: "only the session owner can rename" });
    }

    await db.query(
      "UPDATE claw_sessions SET name = $1, updated_at = NOW() WHERE session_id = $2 AND deleted_at IS NULL",
      [newName.slice(0, 255), sessionId],
    );
    return { ok: true, data: { session_id: sessionId, name: newName.slice(0, 255) } };
  });

  // --- Send Message (V1/V2 split) ---
  app.post<{ Params: { id: string } }>("/v1/sessions/:id/messages", async (req, reply) => {
    const sessionId = req.params.id;

    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const body = req.body as Record<string, unknown>;
    const messageType = ((body.messageType as string) || (body.message_type as string) || "text").toLowerCase();
    const content = (body.content as string) || "";
    const toolIds = (body.tools as number[]) || (body.tool_ids as number[]) || [];
    const pluginIdRaw = body.pluginId ?? body.plugin_id;
    let pluginId: number | undefined;
    if (pluginIdRaw !== undefined && pluginIdRaw !== null && pluginIdRaw !== "") {
      const n = typeof pluginIdRaw === "number" ? pluginIdRaw : parseInt(String(pluginIdRaw), 10);
      if (Number.isFinite(n)) pluginId = n;
    }
    const imageRaw = body.image;
    const requestImage =
      typeof imageRaw === "string" && imageRaw.trim() !== "" ? imageRaw.trim() : undefined;
    const requestResourceRaw = body.resource;
    if (requestResourceRaw !== undefined && !asJsonObject(requestResourceRaw)) {
      return reply.status(400).send({ ok: false, error: "resource must be a JSON object" });
    }
    const requestResource = asJsonObject(requestResourceRaw);
    const timeoutRaw = body.timeout;
    const timeoutNum =
      timeoutRaw !== undefined && timeoutRaw !== null && String(timeoutRaw).trim() !== ""
        ? Number(timeoutRaw)
        : NaN;
    if (timeoutRaw !== undefined && timeoutRaw !== null && String(timeoutRaw).trim() !== "" && Number.isNaN(timeoutNum)) {
      return reply.status(400).send({ ok: false, error: "timeout must be a number" });
    }
    if (!Number.isNaN(timeoutNum) && !Number.isFinite(timeoutNum)) {
      return reply.status(400).send({ ok: false, error: "timeout must be a finite number" });
    }
    const requestTimeout = Number.isFinite(timeoutNum) ? Math.trunc(timeoutNum) : undefined;
    // workspaceId == target K8s namespace for Brain's Sandbox workload. Same
    // travel path as pluginId: request body -> pending row -> NATS task.
    // Brain falls back to SANDBOX_NAMESPACE env when omitted.
    const workspaceIdRaw = body.workspaceId ?? body.workspace_id;
    const workspaceId =
      typeof workspaceIdRaw === "string" && workspaceIdRaw.trim() !== ""
        ? workspaceIdRaw.trim()
        : undefined;
    const mcpServers = (body.mcp_servers as Record<string, Record<string, unknown>>) || undefined;

    // What the run needs beyond a sandbox, declared rather than written into
    // the prompt as Hyperloom flags. Refused here rather than downgraded:
    // the failure this replaces is a misspelled flag that reads as a request
    // for one node, and answering a 400 is the whole point of the field.
    const topologyRaw = body.topology;
    let topology: EnvironmentTopology | undefined;
    if (topologyRaw !== undefined && topologyRaw !== null) {
      const checked = validateTopology(topologyRaw);
      if (!checked.ok) {
        return reply.status(400).send({ ok: false, error: checked.errors.join("; ") });
      }
      topology = checked.value;
    }

    const sessionEnvResult = parseSessionEnv(body.env);
    if (!sessionEnvResult.ok) {
      return reply.status(400).send({ ok: false, error: sessionEnvResult.error });
    }
    const sessionEnv = sessionEnvResult.env;

    // V1-compatible control-channel messages share the /messages endpoint.
    // Handle them before the "content required" check that only applies to text.
    // Interrupt mutates another execution, so it follows the same owner/full
    // admin boundary as the dedicated control endpoint.
    if (messageType === "interrupt") {
      const row = (await db.query(
        "SELECT user_id, agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
        [sessionId],
      )).rows[0];
      if (!row) return reply.status(404).send({ ok: false, error: "session not found" });
      if (!canWriteSessionAsOperator(row.user_id, user)) {
        return reply.status(403).send({ ok: false, error: "access denied" });
      }
      try { nc.publish(interruptSubject(sessionId)); } catch { /* ignore publish errors */ }
      await interruptUnstartedChatRuns(sessionId);
      // If Brain is running, set a timeout to force idle if exec_complete
      // doesn't arrive within 30s (e.g. Brain stuck in a2a_call HTTP fetch).
      if (row.agent_status === "running") {
        const sid = sessionId;
        setTimeout(async () => {
          try {
            const check = await db.query(
              "SELECT agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
              [sid],
            );
            if (check.rows[0]?.agent_status === "running") {
              const released = await forceIdleAfterInterrupt(sid);
              if (released) logger.warn({ sessionId: sid }, "interrupt.forced_idle_after_timeout");
              else logger.info({ sessionId: sid }, "interrupt.forced_idle_declined_live_lease");
            }
          } catch { /* ignore */ }
        }, 30_000).unref();
      }
      logger.info({ sessionId, userId }, "message.interrupt");
      return { ok: true, session_id: sessionId, accepted: true, interrupted: true };
    }

    if (messageType === "decision") {
      // V2 agent-loop has no interactive tool-permission gate yet.
      return reply.status(501).send({ ok: false, error: "decision messages not supported on v2 sessions" });
    }

    // messageType: "text" | "inject" | default → require content.
    // For "inject" we fall through to the normal path; if the agent is busy it
    // queues into claw_pending_messages (next-turn semantics); if idle it dispatches immediately.
    if (!content) return reply.status(400).send({ ok: false, error: "content required" });

    // Captured inside the transaction (idle path) so the task publish below
    // can inject user_env without re-reading the DB. Queue path freezes it
    // onto claw_pending_messages directly and leaves this map empty.
    let capturedUserEnvSnapshot: Record<string, string> = {};

    // Transaction: lock row → check status → queue or dispatch
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const lockResult = await client.query(
        "SELECT agent_status, user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL FOR UPDATE",
        [sessionId],
      );
      if (!lockResult.rows.length) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ ok: false, error: "session not found" });
      }
      const row = lockResult.rows[0];
      // Owner-only: text/inject messages are conversation writes; only the
      // session creator may extend the conversation. Other ops on this session
      // (read, interrupt, delete-of-own-session) are governed by their own
      // rules above / below.
      if (!canAccessSession(row.user_id, userId) && !(!row.user_id && user && isSystemAdmin(user))) {
        await client.query("ROLLBACK");
        return reply.status(403).send({ ok: false, error: "only the session creator can send messages" });
      }

      const status = lockResult.rows[0].agent_status;
      // Snapshot per-user env at message creation time. Decrypted once here,
      // frozen on the pending_messages row (queue path) or NATS task body
      // (immediate path) so Brain reads plaintext without touching the
      // master key. Same userId source as the SELECT above (req.user).
      // IMPORTANT: reuse the transaction connection `client` here. Using the
      // pool (`db`) would borrow a second connection while this tx still holds
      // the FOR UPDATE row lock; under load that exhausts the pool, leaving
      // connections stuck "idle in transaction" holding claw_sessions locks
      // and blocking ALTER TABLE / reads cluster-wide.
      const userEnvSnapshot = await loadUserEnvSnapshot(client, userId, logger);
      if (status === "running") {
        const secrets = pendingSecretColumns({
          llmKey: resolveUserLlmKey(user) || "",
          platformKey: user?.platformKey || "",
          userEnv: userEnvSnapshot,
          doorbell: RUN_DOORBELL_DISPATCH,
        });
        await client.query(
          "INSERT INTO claw_pending_messages (session_id, content, user_id, plugin_id, tool_ids, workspace_id, platform_key, llm_api_key, credentials_blob, image, resources, timeout, user_env, session_env, topology) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb)",
          [
            sessionId,
            content,
            userId,
            pluginId ?? null,
            JSON.stringify(toolIds.length ? toolIds : []),
            workspaceId ?? null,
            secrets.platform,
            secrets.llm,
            secrets.blob,
            requestImage ?? null,
            requestResource ? JSON.stringify(requestResource) : null,
            requestTimeout ?? null,
            JSON.stringify(secrets.userEnv),
            JSON.stringify(sessionEnv),
            topology ? JSON.stringify(topology) : null,
          ],
        );
        await client.query("COMMIT");
        return { ok: true, session_id: sessionId, queued: true };
      }
      // Stash the snapshot for the immediate-dispatch path below — building
      // `task` happens outside the transaction so we need it accessible.
      // Hoisted via outer-scope variable defined after the try/finally block.
      capturedUserEnvSnapshot = userEnvSnapshot;

      await client.query("UPDATE claw_sessions SET agent_status = 'running', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL", [sessionId]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // A3: client already disconnected — don't dispatch; revert to idle so no
    // phantom 'running' spinner is left behind (mirrors the publish-failure
    // rollback below). The transaction above already committed 'running'.
    if (isClientGone(req)) {
      await db.query(
        "UPDATE claw_sessions SET agent_status = 'idle', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL",
        [sessionId],
      );
      logger.warn({ sessionId, userId }, "message.client_gone_pre_dispatch");
      return reply.status(499).send({ ok: false, error: "client_closed_request" });
    }

    // Outside transaction: hand off to the shared brain-dispatch helper.
    // On JetStream publish failure we MUST flip agent_status back to 'idle'
    // here (the transaction above committed 'running'); otherwise the
    // frontend spinner never stops and the next /messages POST queues into
    // claw_pending_messages waiting for an exec_complete that never arrives.
    const dispatch = await dispatchTaskToBrain(
      {
        sessionId, userId, user,
        content, messageType, toolIds, pluginId,
        requestImage, requestResource, requestTimeout, topology,
        workspaceId, mcpServers,
        capturedUserEnvSnapshot,
        capturedSessionEnv: sessionEnv,
      },
      async () => {
        await db.query(
          "UPDATE claw_sessions SET agent_status = 'idle', updated_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL",
          [sessionId],
        );
      },
    );
    if (dispatch.kind === "publish_failed") {
      return reply.status(503).send({ ok: false, error: "task dispatch failed", detail: dispatch.error?.message });
    }
    if (dispatch.kind === "rejected") {
      return reply.status(429).send({ ok: false, error: "admission_rejected", reason: dispatch.reason });
    }
    return {
      ok: true,
      session_id: sessionId,
      message_id: dispatch.messageId,
      accepted: true,
    };
  });

  // --- List Files (V1/V2 split) ---
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/files", async (req, reply) => {
    const sessionId = req.params.id;

    const scope = await requireSessionScope(req, reply, sessionId);
    if (!scope) return reply;

    const s3 = getS3Client();
    const prefix = scope.sessionPrefix;
    const files: Array<{ path: string; size: number | undefined; last_modified: string | undefined }> = [];
    let ct: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: ct }),
      );
      for (const obj of res.Contents || []) {
        const rel = (obj.Key || "").slice(prefix.length);
        if (!rel || isHiddenSessionFile(rel)) continue;
        files.push({ path: rel, size: obj.Size, last_modified: obj.LastModified?.toISOString() });
      }
      ct = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ct);
    return { ok: true, data: files };
  });

  // --- Download/Stream File (V1/V2 split) ---
  // /v1/sessions/:id/files/:path/download → JSON { api_path } (frontend opens in new tab)
  // /v1/sessions/:id/files/:path/stream   → binary stream (actual file content)
  // /v1/sessions/:id/files/:path          → binary stream (direct access)
  //
  // Folder support: when the path resolves to a prefix (not a single object),
  // all objects under that prefix are streamed as a zip archive. This avoids
  // buffering the entire archive in memory — each S3 object body is piped
  // directly into the archiver transform stream, which pipes into the response.
  app.get<{ Params: { id: string; "*": string } }>("/v1/sessions/:id/files/*", async (req, reply) => {
    const sessionId = req.params.id;

    const rawPath = req.params["*"];
    if (!rawPath) return reply.status(400).send({ ok: false, error: "file path required" });

    const isDownloadMeta = rawPath.endsWith("/download");
    const filePath = rawPath.replace(/\/(download|stream)$/, "");

    if (filePath.includes("..")) return reply.status(400).send({ ok: false, error: "invalid path" });

    const scope = await requireSessionScope(req, reply, sessionId);
    if (!scope) return reply;

    const s3 = getS3Client();
    const s3Key = `${scope.sessionPrefix}${filePath}`;

    if (isDownloadMeta) {
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      const streamUrl = `/v1/sessions/${sessionId}/files/${encodedPath}/stream`;
      return { ok: true, data: { api_path: streamUrl, path: filePath } };
    }

    // Try single-object download first (with Range support for large files).
    try {
      const fileName = filePath.split("/").pop() || "file";
      const rangeHeader = req.headers.range;

      const getParams: Record<string, unknown> = { Bucket: S3_BUCKET, Key: s3Key };
      if (rangeHeader) getParams.Range = rangeHeader;

      const obj = await s3.send(new GetObjectCommand(getParams as any));
      const ct = obj.ContentType || "application/octet-stream";
      const totalLen = obj.ContentLength;
      const statusCode = obj.ContentRange ? 206 : 200;

      reply.raw.writeHead(statusCode, {
        "Content-Type": ct,
        ...(totalLen != null && { "Content-Length": String(totalLen) }),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        "Accept-Ranges": "bytes",
        ...(obj.ContentRange && { "Content-Range": obj.ContentRange }),
        "Cache-Control": "private, max-age=3600",
      });
      const body = obj.Body as Readable;
      body.pipe(reply.raw);
      return reply;
    } catch (err: any) {
      if (err.name !== "NoSuchKey" && err.$metadata?.httpStatusCode !== 404) throw err;
    }

    // Single object not found — treat path as a folder prefix and attempt
    // streaming zip of all objects underneath.
    const prefix = s3Key.endsWith("/") ? s3Key : `${s3Key}/`;
    const entries = await listS3KeysUnderPrefix(s3, S3_BUCKET, prefix);

    if (!entries.length) {
      return reply.status(404).send({ ok: false, error: "file not found" });
    }

    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

    // Large folder → auto-create async zip task, return task info for polling.
    if (totalSize > ZIP_STREAM_MAX_BYTES) {
      const taskId = crypto.randomUUID();
      const sessionPrefix = scope.sessionPrefix;
      const folderName = filePath.split("/").filter(Boolean).pop() || sessionId;
      const zipName = `${folderName}.zip`;
      await writeZipTaskMarker(s3, sessionPrefix, {
        session_id: sessionId,
        task_id: taskId,
        zip_name: zipName,
        total_files: entries.length,
        total_size: totalSize,
        created_at_ms: Date.now(),
      });
      runZipTask({ sessionId, taskId, sessionPrefix, entries }).catch((e) => {
        logger.error({ err: e, taskId, sessionId }, "zip_task.unhandled");
      });
      return reply.status(202).send({
        ok: true,
        data: {
          type: "folder",
          total_files: entries.length,
          total_size: totalSize,
          task_id: taskId,
          poll_url: `/v1/sessions/${sessionId}/zip-tasks/${taskId}`,
          download_url: `/v1/sessions/${sessionId}/zip-tasks/${taskId}/download`,
        },
      });
    }

    // Small folder → stream zip directly to client.
    const folderName = filePath.split("/").filter(Boolean).pop() || sessionId;
    const zipName = `${folderName}.zip`;

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on("error", (e: Error) => {
      logger.error({ err: e, sessionId, prefix }, "session.zip_archive_error");
      if (!reply.raw.writableEnded) reply.raw.destroy(e);
    });

    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(zipName)}"`,
      "Transfer-Encoding": "chunked",
    });
    archive.pipe(reply.raw);

    for (const { key } of entries) {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        if (obj.Body) {
          const rel = key.slice(prefix.length);
          archive.append(obj.Body as Readable, { name: rel });
        }
      } catch (e: any) {
        logger.warn({ err: e, key, sessionId }, "session.zip_skip_file");
      }
    }

    await archive.finalize();
    return reply;
  });

  // --- Async Zip Tasks (large folder → pack to S3 → presigned URL) ---

  app.post<{
    Params: { id: string };
    Body: { path?: string };
  }>("/v1/sessions/:id/zip-tasks", async (req, reply) => {
    const sessionId = req.params.id;
    const body = (req.body || {}) as Record<string, unknown>;
    const folderPath = ((body.path as string) || "").replace(/^\/+/, "");

    if (folderPath.includes("..")) return reply.status(400).send({ ok: false, error: "invalid path" });

    // Writes the zip and its task marker under the tenant's prefix.
    const scope = await requireSessionScope(req, reply, sessionId, { write: true });
    if (!scope) return reply;

    const s3 = getS3Client();
    const sessionPrefix = scope.sessionPrefix;
    const prefix = folderPath ? `${sessionPrefix}${folderPath}${folderPath.endsWith("/") ? "" : "/"}` : sessionPrefix;
    const entries = await listS3KeysUnderPrefix(s3, S3_BUCKET, prefix);

    if (!entries.length) return reply.status(404).send({ ok: false, error: "no files found" });

    const taskId = crypto.randomUUID();
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    const zipFolderName = folderPath.split("/").filter(Boolean).pop() || sessionId;
    const zipName = `${zipFolderName}.zip`;

    await writeZipTaskMarker(s3, sessionPrefix, {
      session_id: sessionId,
      task_id: taskId,
      zip_name: zipName,
      total_files: entries.length,
      total_size: totalSize,
      created_at_ms: Date.now(),
    });

    runZipTask({ sessionId, taskId, sessionPrefix, entries }).catch((e) => {
      logger.error({ err: e, taskId, sessionId }, "zip_task.unhandled");
    });

    logger.info({ taskId, sessionId, totalFiles: entries.length, totalSize, prefix }, "zip_task.created");
    return {
      ok: true,
      data: {
        task_id: taskId,
        status: "processing",
        total_files: entries.length,
        total_size: totalSize,
      },
    };
  });

  app.get<{ Params: { id: string; taskId: string } }>(
    "/v1/sessions/:id/zip-tasks/:taskId",
    async (req, reply) => {
      const sessionId = req.params.id;
      const taskId = req.params.taskId;
      const scope = await requireSessionScope(req, reply, sessionId);
      if (!scope) return reply;

      const s3 = getS3Client();
      const state = await readZipStatus(s3, scope.sessionPrefix, taskId);
      const downloadUrl = `/v1/sessions/${sessionId}/zip-tasks/${taskId}/download`;

      if (state.status === "missing") {
        return reply.status(404).send({ ok: false, error: "task not found" });
      }
      if (state.status === "ready") {
        const totalFiles = state.marker.total_files;
        return {
          ok: true,
          data: {
            task_id: taskId,
            status: "ready" as const,
            total_files: totalFiles,
            total_size: state.marker.total_size,
            processed_files: totalFiles,
            progress: `${totalFiles}/${totalFiles} files`,
            url: downloadUrl,
            zip_size: state.zipSize,
            zip_name: state.marker.zip_name,
            expires_at: state.expiresAt,
          },
        };
      }
      if (state.status === "failed") {
        return {
          ok: true,
          data: {
            task_id: taskId,
            status: "failed" as const,
            total_files: state.marker.total_files,
            total_size: state.marker.total_size,
            processed_files: 0,
            progress: `0/${state.marker.total_files} files`,
            error: state.error,
          },
        };
      }
      return {
        ok: true,
        data: {
          task_id: taskId,
          status: "processing" as const,
          total_files: state.marker.total_files,
          total_size: state.marker.total_size,
          processed_files: 0,
          progress: `0/${state.marker.total_files} files`,
        },
      };
    },
  );

  app.get<{ Params: { id: string; taskId: string } }>(
    "/v1/sessions/:id/zip-tasks/:taskId/download",
    async (req, reply) => {
      const sessionId = req.params.id;
      const taskId = req.params.taskId;
      const scope = await requireSessionScope(req, reply, sessionId);
      if (!scope) return reply;

      const s3 = getS3Client();
      const state = await readZipStatus(s3, scope.sessionPrefix, taskId);

      if (state.status === "missing") {
        return reply.status(404).send({ ok: false, error: "task not found" });
      }
      if (state.status === "failed") {
        return reply.status(409).send({ ok: false, error: state.error || "zip task failed" });
      }
      if (state.status !== "ready") {
        return reply.status(409).send({ ok: false, error: "zip not ready" });
      }

      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: state.zipKey }));
      if (!obj.Body) return reply.status(404).send({ ok: false, error: "zip not found in S3" });
      const filename = state.marker.zip_name || `session-${sessionId}.zip`;
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`)
        .header("Content-Length", obj.ContentLength ?? undefined)
        .send(obj.Body as Readable);
    },
  );

  // --- Upload Folder (multipart → S3, bound to session) ---
  //
  // Accepts multipart/form-data with multiple "file" parts. Each part's
  // `filename` carries the relative path from the selected folder root
  // (frontend sets it to `File.webkitRelativePath`). Files are streamed
  // directly to S3 under `users/<uid>/sessions/<sid>/<relative>`; no buffering
  // in Brain/Hands. Same-name keys are overwritten (per requirement).
  //
  // Plugin-level limits (registered in index.ts): 1 GiB per file, 1000 files
  // per request. Additional guards below: reject dangerous paths, skip
  // common noise (`.git/`, `node_modules/`).
  /**
   * TTL tiers matching the bucket Lifecycle rules defined in
   * claw/deploy/minio-lifecycle.py. Each entry is an independent
   * lifecycle rule; adding a new tier requires coordinated updates in both
   * files (tier here + rule there + re-run the deploy script).
   *
   * Client selects a tier via `?ttl_days=N` (or `x-claw-ttl-days` header).
   */
  const UPLOAD_TTL_DAYS_ALLOWED = [1, 2, 7, 15, 30] as const;

  app.post<{
    Params: { id: string };
    Querystring: { ttl_days?: string };
  }>("/v1/sessions/:id/upload", async (req, reply) => {
    const sessionId = req.params.id;

    // Writes caller-supplied content into the tenant's workspace.
    const scope = await requireSessionScope(req, reply, sessionId, { write: true });
    if (!scope) return reply;

    const user = getUser(req);
    const userId = user?.userId ?? "default";

    if (!req.isMultipart()) {
      return reply.status(400).send({ ok: false, error: "multipart/form-data required" });
    }

    // Resolve the TTL tier: explicit ttl_days query param (or x-claw-ttl-days
    // header) wins; otherwise fall back to the server-wide default.
    const requestedTtl = parseInt(
      (req.query.ttl_days ?? (req.headers["x-claw-ttl-days"] as string) ?? "") as string,
      10,
    );
    let ttlDays: number = UPLOAD_TTL_DAYS;
    if (!Number.isNaN(requestedTtl)) {
      if (!(UPLOAD_TTL_DAYS_ALLOWED as readonly number[]).includes(requestedTtl)) {
        return reply.status(400).send({
          ok: false,
          error: `ttl_days must be one of ${UPLOAD_TTL_DAYS_ALLOWED.join(", ")}`,
        });
      }
      ttlDays = requestedTtl;
    }

    const s3 = getS3Client();
    // Land user uploads under a dedicated `.uploads/` prefix so historical
    // agent artifacts are never touched by the lifecycle rules.
    const sessionPrefix = scope.sessionPrefix;
    const s3Prefix = `${sessionPrefix}.uploads/`;
    const uploadedAt = new Date();
    const expiresAt = ttlDays > 0
      ? new Date(uploadedAt.getTime() + ttlDays * 24 * 3600 * 1000)
      : null;
    const ttlTagValue = `${ttlDays}d`;
    const uploaded: Array<{ path: string; size: number; s3_url: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const failed: Array<{ path: string; error: string }> = [];

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type !== "file") continue;
        // `filename` is set by browser to File.webkitRelativePath when uploading a folder.
        const relRaw = (part.filename || "").replace(/^\/+/, "");
        if (!relRaw) {
          skipped.push({ path: "<empty>", reason: "missing filename" });
          await part.file.resume();
          continue;
        }
        // Defensive path sanitation: reject traversal, normalize separators.
        const rel = relRaw.replace(/\\/g, "/");
        if (rel.includes("..") || rel.startsWith("/")) {
          skipped.push({ path: rel, reason: "unsafe path" });
          await part.file.resume();
          continue;
        }
        // Skip common noise to protect bucket + save bandwidth.
        if (/(^|\/)(\.git|node_modules|\.DS_Store|\.next|dist|build)(\/|$)/.test(rel)) {
          skipped.push({ path: rel, reason: "filtered" });
          await part.file.resume();
          continue;
        }

        const s3Key = `${s3Prefix}${rel}`;
        try {
          // Stream the part to S3 via the high-level `Upload` helper from
          // `@aws-sdk/lib-storage` — no memory buffering even for 1GB files.
          // `Upload` performs an S3 multipart upload under the hood, which
          // works against streams of unknown length. The lower-level
          // `PutObjectCommand` requires a known `ContentLength` for S3
          // streaming sigv4; against MinIO and other S3-compatible endpoints
          // it fails with `Invalid value "undefined" for header
          // "x-amz-decoded-content-length"`. Mirrors the zip-task path that
          // already uses `Upload` for the same reason.
          //
          // Dual labels:
          //   - Metadata (`claw-uploaded-at`, `claw-expires-at`): readable by the
          //     app for UX (show expiry in the files panel) and for any manual
          //     sweeper fallback.
          //   - Tagging (`origin=user-upload`, `session=<sid>`): the authoritative
          //     hook for the bucket-side Lifecycle rule that actually deletes
          //     expired uploads server-side (configured via `mc ilm rule`).
          //     Agent artifacts (syncWorkspaceToS3 / archiveRunToS3) never set
          //     this tag, so they are immune to the expiry rule.
          await new Upload({
            client: s3,
            params: {
              Bucket: S3_BUCKET,
              Key: s3Key,
              Body: part.file,
              ContentType: part.mimetype || "application/octet-stream",
              Metadata: {
                "claw-uploaded-at": uploadedAt.toISOString(),
                ...(expiresAt ? { "claw-expires-at": expiresAt.toISOString() } : {}),
              },
              // `origin` + `ttl` form the compound filter for the bucket
              // Lifecycle rule that actually deletes expired uploads. `session`
              // is informational for audit/debug only.
              Tagging: `origin=user-upload&ttl=${ttlTagValue}&session=${encodeURIComponent(sessionId)}`,
            },
          }).done();
          // Per-file size check: plugin-level fileSize limit surfaces as a
          // stream error; detect and translate here.
          if ((part.file as any).truncated) {
            failed.push({ path: rel, error: "file exceeds 1 GiB limit" });
          } else {
            // Surface the canonical S3 URI so the front-end / agent can refer
            // to the uploaded object without having to know the bucket layout
            // (users/{uid}/sessions/{sid}/.uploads/...). MinIO endpoint is
            // cluster-internal so an http URL would be useless to browsers —
            // s3:// is the lowest-common-denominator that both the in-pod
            // SDK and Magpie / Hyperloom CLIs already understand.
            uploaded.push({
              path: rel,
              size: (part.file as any).bytesRead || 0,
              s3_url: `s3://${S3_BUCKET}/${s3Key}`,
            });
          }
        } catch (e: any) {
          failed.push({ path: rel, error: e?.message || String(e) });
        }
      }
    } catch (e: any) {
      // e.g. too many files or field size limit exceeded → respond with 413.
      if (e?.code === "FST_FILES_LIMIT") {
        return reply.status(413).send({ ok: false, error: "too many files (max 1000 per request)" });
      }
      if (e?.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.status(413).send({ ok: false, error: "file too large (max 1 GiB)" });
      }
      logger.error({ err: e, sessionId }, "upload.multipart_failed");
      return reply.status(500).send({ ok: false, error: "upload failed", detail: e?.message });
    }

    logger.info({
      sessionId, userId, ttlDays, uploaded: uploaded.length, skipped: skipped.length,
      failed: failed.length, s3Prefix, expiresAt: expiresAt?.toISOString(),
    }, "session.folder_uploaded");
    return {
      ok: failed.length === 0,
      session_id: sessionId,
      uploaded,
      skipped,
      failed,
      total: uploaded.length + skipped.length + failed.length,
      expires_at: expiresAt?.toISOString() ?? null,
      ttl_days: ttlDays,
      ttl_allowed: UPLOAD_TTL_DAYS_ALLOWED,
    };
  });

  // --- Delete Session (V1/V2 split + creator-only) ---
  app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
    const sessionId = req.params.id;

    const user = getUser(req);
    const userId = user?.userId ?? "default";
    const session = (await db.query("SELECT * FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
    if (!session) return reply.status(404).send({ ok: false, error: "not found" });
    // Strict creator-only delete (admin role does NOT bypass this per product spec).
    if (!canAccessSession(session.user_id, userId) && !(!session.user_id && user && isSystemAdmin(user))) {
      return reply.status(403).send({ ok: false, error: "only the session creator can delete this session" });
    }

    // Requires the calling user's platformKey — there is no admin fallback.
    const platformKey = user?.platformKey || "";

    // The deletion lives in sessions/teardown.ts because the Anthropic-compatible
    // endpoint needs the same one; it used to run its own shorter version and
    // left six of these steps undone.
    try {
      await teardownSession({
        sessionId,
        // The row's owner, not the caller: that is who the files belong to, and
        // the admin recovery path above means the two can differ. Passed as the
        // column holds it, for the reason requireSessionScope does the same.
        ownerId: session.user_id,
        platformKey,
      });
    } catch (err) {
      // The one failure a caller can do something about: the transaction that
      // hides the session was not confirmed, so this request run again is the
      // repair -- either it does the work or it answers 404 because the commit
      // had landed after all. Anything else is not the caller's to retry, and a
      // 500 is how they are told so.
      if (!(err instanceof TeardownRefused)) throw err;
      logger.error({ sessionId, err: err.message }, "session.delete_refused");
      return reply.status(503).send({ ok: false, error: err.message, retryable: true });
    }
    // Whatever the cleanup could not finish is not the caller's to hear about: it
    // is committed, recorded on the row and the sweeper's from here, and a client
    // told "retry" over it would be retrying a session that answers 404.
    // teardownSession logs the deferral for both endpoints; the report worth
    // paging on is the sweeper's, which is the only one that can tell a cleanup
    // that is slow from one that is stuck.
    return { ok: true, session_id: sessionId };
  });

}
