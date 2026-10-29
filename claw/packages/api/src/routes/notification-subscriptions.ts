// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Outbound notification subscriptions.
 *
 *   POST   /v1/notification-subscriptions
 *   GET    /v1/notification-subscriptions
 *   PATCH  /v1/notification-subscriptions/:id
 *   DELETE /v1/notification-subscriptions/:id
 *
 * A caller subscribes only for their own events: the owner is the authenticated
 * user and every read, update and delete filters on it, so another user's
 * subscription answers 404 rather than 403. The signing secret is generated
 * here, returned once, and stored only encrypted.
 *
 * Registered only when `CLAW_NOTIFICATIONS_ENABLED` is on; otherwise the paths
 * do not exist.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { CLAW_NOTIFICATIONS_ENABLED, NOTIFY_WEBHOOK_ALLOWED_HOSTS } from "../config.js";
import { getUser } from "../auth/middleware.js";
import { encryptUserEnvValue } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { newSubscriptionId } from "../notifications/outbox.js";
import { guardWebhookUrl, parseAllowedHosts } from "../notifications/url-guard.js";

const MAX_SUBSCRIPTIONS_PER_USER = 5;
const EVENT_TYPES = ["run.completed", "run.failed"];
const SOURCES = ["trigger", "long_run"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireRealUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = getUser(req)?.userId;
  if (!userId || userId === "default") {
    reply.status(403).send({ ok: false, error: "notifications_require_authenticated_user" });
    return null;
  }
  return userId;
}

function pickList(value: unknown, allowed: string[]): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((v) => typeof v === "string" && allowed.includes(v))) return null;
  return [...new Set(value as string[])];
}

const view = (r: Record<string, unknown>) => ({
  subscription_id: r.subscription_id,
  url: r.url,
  event_types: r.event_types,
  sources: r.sources,
  enabled: r.enabled,
  consecutive_failures: r.consecutive_failures,
  created_at: r.created_at,
});

export async function registerNotificationSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  if (!CLAW_NOTIFICATIONS_ENABLED) return;
  const allowedHosts = parseAllowedHosts(NOTIFY_WEBHOOK_ALLOWED_HOSTS);

  app.post("/v1/notification-subscriptions", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.url !== "string") {
      return reply.status(400).send({ ok: false, error: "url is required" });
    }
    const types = pickList(body.event_types, EVENT_TYPES);
    const sources = pickList(body.sources, SOURCES);
    if (types === null) return reply.status(400).send({ ok: false, error: `event_types must be a non-empty subset of ${EVENT_TYPES.join(", ")}` });
    if (sources === null) return reply.status(400).send({ ok: false, error: `sources must be a non-empty subset of ${SOURCES.join(", ")}` });
    const guard = await guardWebhookUrl(body.url, allowedHosts);
    if (!guard.ok) return reply.status(400).send({ ok: false, error: "url_refused", reason: guard.reason });
    const count = Number((await db.query(
      "SELECT COUNT(*) AS n FROM claw_notification_subscriptions WHERE owner_user_id = $1", [userId],
    )).rows[0].n);
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      return reply.status(409).send({ ok: false, error: "subscription_limit_reached" });
    }
    const secret = randomBytes(32).toString("hex");
    const id = newSubscriptionId();
    const row = (await db.query(
      `INSERT INTO claw_notification_subscriptions
         (subscription_id, owner_user_id, url, secret_enc, event_types, sources)
       VALUES ($1, $2, $3, $4,
               COALESCE($5::text[], ARRAY['run.completed','run.failed']),
               COALESCE($6::text[], ARRAY['trigger','long_run']))
       RETURNING *`,
      [id, userId, guard.url.toString(), encryptUserEnvValue(secret), types ?? null, sources ?? null],
    )).rows[0];
    // The only time the secret leaves the server.
    return reply.status(201).send({ ok: true, data: { ...view(row), secret } });
  });

  app.get("/v1/notification-subscriptions", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const rows = (await db.query(
      "SELECT * FROM claw_notification_subscriptions WHERE owner_user_id = $1 ORDER BY created_at", [userId],
    )).rows;
    return reply.send({ ok: true, data: rows.map(view) });
  });

  app.patch("/v1/notification-subscriptions/:id", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) return reply.status(404).send({ ok: false, error: "not_found" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const types = pickList(body.event_types, EVENT_TYPES);
    const sources = pickList(body.sources, SOURCES);
    if (types === null || sources === null) return reply.status(400).send({ ok: false, error: "invalid_filter" });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return reply.status(400).send({ ok: false, error: "enabled must be a boolean" });
    }
    const row = (await db.query(
      `UPDATE claw_notification_subscriptions
          SET event_types = COALESCE($3::text[], event_types),
              sources = COALESCE($4::text[], sources),
              enabled = COALESCE($5::boolean, enabled),
              auto_disabled = CASE WHEN $5::boolean IS NULL THEN auto_disabled ELSE FALSE END,
              consecutive_failures = CASE WHEN $5::boolean IS TRUE THEN 0 ELSE consecutive_failures END,
              failing_since = CASE WHEN $5::boolean IS TRUE THEN NULL ELSE failing_since END,
              updated_at = NOW()
        WHERE subscription_id = $1 AND owner_user_id = $2
        RETURNING *`,
      [id, userId, types ?? null, sources ?? null, body.enabled ?? null],
    )).rows[0];
    if (!row) return reply.status(404).send({ ok: false, error: "not_found" });
    return reply.send({ ok: true, data: view(row) });
  });

  app.delete("/v1/notification-subscriptions/:id", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) return reply.status(404).send({ ok: false, error: "not_found" });
    const r = await db.query(
      "DELETE FROM claw_notification_subscriptions WHERE subscription_id = $1 AND owner_user_id = $2", [id, userId],
    );
    if (!r.rowCount) return reply.status(404).send({ ok: false, error: "not_found" });
    return reply.send({ ok: true });
  });
}
