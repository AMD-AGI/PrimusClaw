// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * System-level environment variables CRUD (system-env-design.md).
 *
 * Endpoints:
 *   GET    /v1/env/system                list { key_name, value_mask, updated_at }   (any authenticated user)
 *   PUT    /v1/env/system/:key_name      upsert encrypted value                      (system-admin)
 *   DELETE /v1/env/system/:key_name      hard delete (idempotent)                    (system-admin)
 *
 * Unlike user env these are GLOBAL (no user_id): every sandbox sees them as a
 * fallback layer that user_env overrides. After any write the decrypted map is
 * republished to the SYSTEM_ENV NATS KV bucket, which Brain watches (Brain
 * never holds the master key).
 *
 * Auth: authMiddleware first. Reads (GET) require only an authenticated user —
 * any logged-in user may view the masked list (key_name + masked value +
 * updated_at); the anonymous "default" subject is rejected. Writes (PUT/DELETE)
 * require the `system-admin` role.
 *
 * Validation: key_name passes isSystemEnvKeyAllowed (user rules + extra deny of
 * ANTHROPIC_API_KEY / OPENAI_API_KEY). value length <= 4096 bytes; total keys
 * <= 64.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getUserRole } from "../auth/models.js";
import { db } from "../infra/db.js";
import { isSystemEnvKeyAllowed } from "@claw/protocol";
import {
  encryptUserEnvValue,
  decryptUserEnvValue,
  maskUserEnvValue,
  loadSystemEnvSnapshot,
} from "../crypto/user-env.js";
import { kvSystemEnv, sc } from "../infra/nats.js";

const logger = pino({ name: "system-env" });

const MAX_VALUE_BYTES = 4096;
const MAX_KEYS = 64;
const KV_KEY = "current";
// Retry the KV publish a few times so a transient NATS blip doesn't leave the
// SYSTEM_ENV bucket stale. Admin writes are infrequent, so the small added
// latency on failure is acceptable; backoff is short and bounded.
const KV_PUBLISH_ATTEMPTS = 3;

/** SHA-256 first 8 hex of user_id for audit log. */
function userIdHashPrefix(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

/** Caller IP for audit log; best-effort. */
function callerIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip || "-";
}

/**
 * Recompute the decrypted system-env map from DB and publish it to the
 * SYSTEM_ENV KV bucket. Brain watches this key. Exported so api boot can do an
 * initial publish (KV ↔ DB reconciliation) after initNats.
 */
export async function publishSystemEnvToKv(): Promise<void> {
  const map = await loadSystemEnvSnapshot(db, logger);
  const payload = sc.encode(JSON.stringify(map));
  let lastErr: unknown;
  for (let i = 0; i < KV_PUBLISH_ATTEMPTS; i++) {
    try {
      await kvSystemEnv.put(KV_KEY, payload);
      return;
    } catch (e) {
      lastErr = e;
      if (i < KV_PUBLISH_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/** Require any authenticated user (reject the anonymous "default"), else 403. */
function requireLoggedIn(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(req);
  if (!user || !user.userId || user.userId === "default") {
    reply.status(403).send({
      ok: false,
      error: "requires_authenticated_user",
      message: "viewing system_env requires an authenticated user",
    });
    return false;
  }
  return true;
}

/** Require a write-capable admin (system-admin, not readonly), else 403. */
function requireAdminWrite(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(req);
  if (!user || getUserRole(user) !== "system-admin") {
    reply.status(403).send({
      ok: false,
      error: "system_env_requires_admin_write",
      message: "writing system_env requires the system-admin role (not readonly)",
    });
    return false;
  }
  return true;
}

export async function registerSystemEnvVarRoutes(app: FastifyInstance): Promise<void> {

  app.get("/v1/env/system", async (req, reply) => {
    if (!requireLoggedIn(req, reply)) return;
    const r = await db.query(
      `SELECT key_name, key_value_enc, updated_at
         FROM claw_system_env_vars
         ORDER BY key_name ASC`,
    );
    const data: Array<{ key_name: string; value_mask: string; updated_at: string }> = [];
    for (const row of r.rows as Array<{ key_name: string; key_value_enc: string; updated_at: Date }>) {
      let mask = "***";
      try {
        mask = maskUserEnvValue(decryptUserEnvValue(row.key_value_enc));
      } catch (e) {
        logger.warn({ err: e, key_name: row.key_name }, "system_env.decrypt_failed");
      }
      data.push({
        key_name: row.key_name,
        value_mask: mask,
        updated_at: row.updated_at.toISOString(),
      });
    }
    return reply.send({ ok: true, data });
  });

  app.put<{ Params: { key_name: string }; Body: { value?: unknown } }>(
    "/v1/env/system/:key_name",
    async (req, reply) => {
      if (!requireAdminWrite(req, reply)) return;

      const keyName = req.params.key_name;
      if (!isSystemEnvKeyAllowed(keyName)) {
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

      const cnt = await db.query(
        `SELECT COUNT(*)::int AS n FROM claw_system_env_vars WHERE key_name <> $1`,
        [keyName],
      );
      const existingOthers = Number((cnt.rows[0] as { n?: number })?.n ?? 0);
      if (existingOthers >= MAX_KEYS) {
        return reply.status(400).send({
          ok: false,
          error: "too_many_keys",
          message: `system env may store at most ${MAX_KEYS} keys`,
        });
      }

      let encBlob: string;
      try {
        encBlob = encryptUserEnvValue(rawValue);
      } catch (e) {
        logger.error({ err: e }, "system_env.encrypt_failed");
        return reply.status(500).send({ ok: false, error: "internal_encryption_error" });
      }

      await db.query(
        `INSERT INTO claw_system_env_vars (key_name, key_value_enc, enc_version)
         VALUES ($1, $2, 1)
         ON CONFLICT (key_name) DO UPDATE
           SET key_value_enc = EXCLUDED.key_value_enc,
               enc_version   = EXCLUDED.enc_version,
               updated_at    = NOW()`,
        [keyName, encBlob],
      );

      try {
        await publishSystemEnvToKv();
      } catch (e) {
        // DB write already committed; a KV publish failure must not 500 the
        // request. Brain will pick up the change on the next successful publish
        // (any later write) or on api restart reconciliation.
        logger.error({ err: e }, "system_env.kv_publish_failed");
      }

      const user = getUser(req);
      logger.info(
        {
          user_id_hash: user ? userIdHashPrefix(user.userId) : "-",
          scope: "system",
          action: "put",
          key_name: keyName,
          caller_ip: callerIp(req),
        },
        "system_env.audit",
      );
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { key_name: string } }>(
    "/v1/env/system/:key_name",
    async (req, reply) => {
      if (!requireAdminWrite(req, reply)) return;

      const keyName = req.params.key_name;
      if (!isSystemEnvKeyAllowed(keyName)) {
        return reply.status(400).send({ ok: false, error: "invalid_key_name" });
      }

      const r = await db.query(
        `DELETE FROM claw_system_env_vars WHERE key_name = $1`,
        [keyName],
      );
      const deleted = (r.rowCount ?? 0) > 0;

      if (deleted) {
        try {
          await publishSystemEnvToKv();
        } catch (e) {
          logger.error({ err: e }, "system_env.kv_publish_failed");
        }
      }

      const user = getUser(req);
      logger.info(
        {
          user_id_hash: user ? userIdHashPrefix(user.userId) : "-",
          scope: "system",
          action: "delete",
          key_name: keyName,
          deleted,
          caller_ip: callerIp(req),
        },
        "system_env.audit",
      );
      return reply.send({ ok: true, deleted });
    },
  );
}
