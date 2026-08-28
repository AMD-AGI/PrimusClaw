// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Per-user environment variables CRUD (user-env-vars-design.md v1.5 §5).
 *
 * Endpoints (canonical + legacy alias during migration, both map to the same
 * handlers; see system-env-design.md §2.1):
 *   GET    /v1/env/user                  (legacy: /v1/users/me/env-vars)
 *   PUT    /v1/env/user/:key_name        (legacy: /v1/users/me/env-vars/:key_name)
 *   DELETE /v1/env/user/:key_name        (legacy: /v1/users/me/env-vars/:key_name)
 *
 * Auth: authMiddleware runs first; `requireRealUser` then defensively rejects
 * the "default" sentinel user_id (a fallback used elsewhere, e.g.
 * `user?.userId ?? "default"` — never a value authMiddleware itself sets) so
 * the encrypted store can't be reached anonymously. key_name is validated via
 * isUserEnvKeyAllowed (@claw/protocol); value <= 4096 bytes; <= 32 keys per
 * user. Every write/delete is audit-logged (user_id_hash_prefix, action,
 * key_name, caller_ip) without ever logging plaintext values.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { db } from "../infra/db.js";
import { isUserEnvKeyAllowed } from "@claw/protocol";
import {
  encryptUserEnvValue,
  decryptUserEnvValue,
  maskUserEnvValue,
} from "../crypto/user-env.js";

const logger = pino({ name: "user-env" });

const MAX_VALUE_BYTES = 4096;
const MAX_KEYS_PER_USER = 32;

// Canonical path + legacy alias kept live during the migration window.
const CANONICAL_BASE = "/v1/env/user";
const LEGACY_BASE = "/v1/users/me/env-vars";

/** SHA-256 first 8 hex of user_id for audit log (avoid linking back to raw id in stdout). */
function userIdHashPrefix(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

/** Pull a usable user_id off the request or reject with 403. */
function requireRealUser(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const user = getUser(req);
  const userId = user?.userId;
  if (!userId || userId === "default") {
    reply.status(403).send({
      ok: false,
      error: "user_env_requires_authenticated_user",
      message: "user_env API requires an authenticated user_id (not 'default')",
    });
    return null;
  }
  return userId;
}

/** Caller IP for audit log; best-effort, falls back to '-' when unknown. */
function callerIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip || "-";
}

async function listHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = requireRealUser(req, reply);
  if (!userId) return;
  const r = await db.query(
    `SELECT key_name, key_value_enc, updated_at
       FROM claw_user_env_vars
       WHERE user_id = $1
       ORDER BY key_name ASC`,
    [userId],
  );
  // Decryption only happens to compute the mask; we never return plaintext.
  const data: Array<{ key_name: string; value_mask: string; updated_at: string }> = [];
  for (const row of r.rows as Array<{ key_name: string; key_value_enc: string; updated_at: Date }>) {
    let mask = "***";
    try {
      mask = maskUserEnvValue(decryptUserEnvValue(row.key_value_enc));
    } catch (e) {
      logger.warn({ err: e, user_id_hash: userIdHashPrefix(userId), key_name: row.key_name }, "user_env.decrypt_failed");
    }
    data.push({
      key_name: row.key_name,
      value_mask: mask,
      updated_at: row.updated_at.toISOString(),
    });
  }
  return reply.send({ ok: true, data });
}

async function putHandler(
  req: FastifyRequest<{ Params: { key_name: string }; Body: { value?: unknown } }>,
  reply: FastifyReply,
): Promise<void> {
  const userId = requireRealUser(req, reply);
  if (!userId) return;

  const keyName = req.params.key_name;
  if (!isUserEnvKeyAllowed(keyName)) {
    return reply.status(400).send({
      ok: false,
      error: "invalid_key_name",
      message: `key_name '${keyName}' is reserved or violates naming rules`,
    });
  }

  const rawValue = (req.body ?? {}).value;
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return reply.status(400).send({
      ok: false,
      error: "invalid_value",
      message: "value must be a non-empty string",
    });
  }
  if (Buffer.byteLength(rawValue, "utf8") > MAX_VALUE_BYTES) {
    return reply.status(400).send({
      ok: false,
      error: "value_too_long",
      message: `value exceeds ${MAX_VALUE_BYTES} bytes`,
    });
  }

  // Count check is against *other* keys; an UPSERT on the same key must
  // not be rejected once the user already has 32 keys.
  const cnt = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM claw_user_env_vars
       WHERE user_id = $1 AND key_name <> $2`,
    [userId, keyName],
  );
  const existingOthers = Number((cnt.rows[0] as { n?: number })?.n ?? 0);
  if (existingOthers >= MAX_KEYS_PER_USER) {
    return reply.status(400).send({
      ok: false,
      error: "too_many_keys",
      message: `each user may store at most ${MAX_KEYS_PER_USER} env vars`,
    });
  }

  let encBlob: string;
  try {
    encBlob = encryptUserEnvValue(rawValue);
  } catch (e) {
    logger.error({ err: e, user_id_hash: userIdHashPrefix(userId) }, "user_env.encrypt_failed");
    return reply.status(500).send({
      ok: false,
      error: "internal_encryption_error",
    });
  }

  await db.query(
    `INSERT INTO claw_user_env_vars (user_id, key_name, key_value_enc, enc_version)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, key_name) DO UPDATE
       SET key_value_enc = EXCLUDED.key_value_enc,
           enc_version   = EXCLUDED.enc_version,
           updated_at    = NOW()`,
    [userId, keyName, encBlob],
  );

  logger.info(
    {
      user_id_hash: userIdHashPrefix(userId),
      action: "put",
      key_name: keyName,
      caller_ip: callerIp(req),
    },
    "user_env.audit",
  );
  return reply.send({ ok: true });
}

// DELETE — idempotent, always returns 200 (no existence leak via 404)
async function deleteHandler(
  req: FastifyRequest<{ Params: { key_name: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const userId = requireRealUser(req, reply);
  if (!userId) return;

  const keyName = req.params.key_name;
  // Validate format even on delete; bogus names cannot exist, but we
  // refuse them anyway so attackers cannot probe shape rules.
  if (!isUserEnvKeyAllowed(keyName)) {
    return reply.status(400).send({
      ok: false,
      error: "invalid_key_name",
    });
  }

  const r = await db.query(
    `DELETE FROM claw_user_env_vars
       WHERE user_id = $1 AND key_name = $2`,
    [userId, keyName],
  );
  const deleted = (r.rowCount ?? 0) > 0;
  logger.info(
    {
      user_id_hash: userIdHashPrefix(userId),
      action: "delete",
      key_name: keyName,
      deleted,
      caller_ip: callerIp(req),
    },
    "user_env.audit",
  );
  return reply.send({ ok: true, deleted });
}

export async function registerUserEnvVarRoutes(app: FastifyInstance): Promise<void> {

  // Canonical path + legacy alias both wired to the same handlers. Drop the
  // legacy registrations once the frontend has fully migrated (see
  // system-env-design.md §2.1 stage 3).
  app.get(CANONICAL_BASE, listHandler);
  app.get(LEGACY_BASE, listHandler);

  app.put<{ Params: { key_name: string }; Body: { value?: unknown } }>(
    `${CANONICAL_BASE}/:key_name`, putHandler);
  app.put<{ Params: { key_name: string }; Body: { value?: unknown } }>(
    `${LEGACY_BASE}/:key_name`, putHandler);

  app.delete<{ Params: { key_name: string } }>(
    `${CANONICAL_BASE}/:key_name`, deleteHandler);
  app.delete<{ Params: { key_name: string } }>(
    `${LEGACY_BASE}/:key_name`, deleteHandler);
}
