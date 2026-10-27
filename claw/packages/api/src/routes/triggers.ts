// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/v1/triggers`: scheduled runs owned by the user who creates them.
 *
 * Only the creator can see or change a trigger; there is no route that creates
 * one for somebody else. Creating or resuming one records the caller's current
 * credentials on the row, since the run that fires later has no request to take
 * them from.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertSessionCredentialsForDispatch } from "../auth/session-credentials.js";
import { getUser } from "../auth/middleware.js";
import { TRIGGER_MAX_PER_USER, TRIGGER_MIN_INTERVAL_MINUTES } from "../config.js";
import { encryptUserEnvValue } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { checkSchedule, nextFireAfter } from "../triggers/schedule.js";

const PUBLIC_COLUMNS =
  "trigger_id, name, kind, prompt, schedule, timezone, enabled, paused_reason, next_fire_at, last_fire_at, consecutive_failures, created_at, updated_at";
const MAX_PROMPT = 8000;

function owner(req: FastifyRequest, reply: FastifyReply) {
  const user = getUser(req);
  if (!user?.userId || user.userId === "default") {
    reply.status(403).send({ ok: false, error: "triggers_require_authenticated_user" });
    return null;
  }
  return user;
}

function sealCredentials(user: NonNullable<ReturnType<typeof getUser>>): string {
  return encryptUserEnvValue(JSON.stringify({
    platformKey: user.platformKey || "", virtualKey: user.virtualKey || "", userName: user.userName || "",
  }));
}

export async function registerTriggerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/triggers", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    const schedule = typeof b.schedule === "string" ? b.schedule.trim() : "";
    const timezone = typeof b.timezone === "string" ? b.timezone : "";
    if (!name || name.length > 120) return reply.status(400).send({ ok: false, error: "name required (max 120 characters)" });
    if (!prompt || prompt.length > MAX_PROMPT) return reply.status(400).send({ ok: false, error: "prompt required" });
    const check = checkSchedule(schedule, timezone, TRIGGER_MIN_INTERVAL_MINUTES);
    if (!check.ok) return reply.status(400).send({ ok: false, error: check.error });
    try {
      assertSessionCredentialsForDispatch("trigger", user);
    } catch {
      return reply.status(400).send({ ok: false, error: "no platform key on this request; a trigger needs its owner's key" });
    }
    const triggerId = crypto.randomUUID();
    // One statement: the cap is counted in the same INSERT so two creates cannot both pass it.
    const r = await db.query(
      `INSERT INTO claw_triggers (trigger_id, owner_user_id, name, prompt, schedule, timezone, next_fire_at, credential_enc)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE (SELECT COUNT(*) FROM claw_triggers WHERE owner_user_id = $2) < $9
       RETURNING ${PUBLIC_COLUMNS}`,
      [triggerId, user.userId, name, prompt, schedule, timezone,
        nextFireAfter(schedule, timezone, new Date()), sealCredentials(user), TRIGGER_MAX_PER_USER],
    );
    if (!r.rows.length) return reply.status(409).send({ ok: false, error: "trigger_limit_reached" });
    return { ok: true, data: r.rows[0] };
  });

  app.get("/v1/triggers", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM claw_triggers WHERE owner_user_id = $1 ORDER BY created_at`, [user.userId]);
    return { ok: true, data: r.rows };
  });

  app.get("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2`,
      [(req.params as any).id, user.userId]);
    if (!r.rows.length) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true, data: r.rows[0] };
  });

  app.patch("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const id = (req.params as any).id as string;
    const cur = (await db.query(
      "SELECT name, prompt, schedule, timezone FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2",
      [id, user.userId])).rows[0] as { name: string; prompt: string; schedule: string; timezone: string } | undefined;
    if (!cur) return reply.status(404).send({ ok: false, error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : cur.name;
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : cur.prompt;
    const schedule = typeof b.schedule === "string" ? b.schedule.trim() : cur.schedule;
    const timezone = typeof b.timezone === "string" ? b.timezone : cur.timezone;
    if (!name || name.length > 120 || !prompt || prompt.length > MAX_PROMPT) {
      return reply.status(400).send({ ok: false, error: "invalid name or prompt" });
    }
    const check = checkSchedule(schedule, timezone, TRIGGER_MIN_INTERVAL_MINUTES);
    if (!check.ok) return reply.status(400).send({ ok: false, error: check.error });
    const r = await db.query(
      `UPDATE claw_triggers SET name=$3, prompt=$4, schedule=$5, timezone=$6, next_fire_at=$7,
              credential_enc=$8, updated_at=NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [id, user.userId, name, prompt, schedule, timezone,
        nextFireAfter(schedule, timezone, new Date()), sealCredentials(user)],
    );
    return { ok: true, data: r.rows[0] };
  });

  app.post("/v1/triggers/:id/pause", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      `UPDATE claw_triggers SET paused_reason = 'user', updated_at = NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [(req.params as any).id, user.userId]);
    if (!r.rows.length) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true, data: r.rows[0] };
  });

  app.post("/v1/triggers/:id/resume", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const id = (req.params as any).id as string;
    const cur = (await db.query(
      "SELECT schedule, timezone FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2",
      [id, user.userId])).rows[0] as { schedule: string; timezone: string } | undefined;
    if (!cur) return reply.status(404).send({ ok: false, error: "not_found" });
    try {
      assertSessionCredentialsForDispatch("trigger", user);
    } catch {
      return reply.status(400).send({ ok: false, error: "no platform key on this request" });
    }
    // From the next FUTURE time: a paused trigger does not catch up on resume.
    const r = await db.query(
      `UPDATE claw_triggers SET paused_reason = NULL, consecutive_failures = 0, next_fire_at = $3,
              credential_enc = $4, updated_at = NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [id, user.userId, nextFireAfter(cur.schedule, cur.timezone, new Date()), sealCredentials(user)]);
    return { ok: true, data: r.rows[0] };
  });

  app.delete("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      "DELETE FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING trigger_id",
      [(req.params as any).id, user.userId]);
    if (!r.rows.length) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true };
  });
}
