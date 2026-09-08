// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { nc, kv, kvDoorbellFloor, sc } from "../infra/nats.js";
import { db } from "../infra/db.js";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";
import { stopSessionRuns } from "../tasks/chat-run.js";
import { countIncompatibleDoorbellRuns } from "../tasks/run-claim.js";
import {
  DOORBELL_SEMANTICS_KEY, doorbellGateOpen, doorbellInFlight, doorbellLatch,
} from "../tasks/doorbell-gate.js";
import { SAFE_API_URL } from "../config.js";
import { getUser, internalTokenAuth as internalAuth } from "../auth/middleware.js";
import { canWriteSessionAsOperator } from "../auth/models.js";

async function readKvString(key: string): Promise<string | null> {
  try {
    const entry = await kv.get(key);
    return entry ? sc.decode(entry.value) : null;
  } catch {
    return null;
  }
}

/** The floor lives in its own non-expiring bucket; see DOORBELL_FLOOR_BUCKET. */
async function readFloorString(): Promise<string | null> {
  const e = await kvDoorbellFloor.get(DOORBELL_SEMANTICS_KEY).catch(() => null);
  return e ? sc.decode(e.value) : null;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Update global minimum Brain version used by cooperative drain.
   * This is an internal endpoint for external upgrade orchestrators.
   */
  app.post("/v1/internal/brain/min-version", { preHandler: internalAuth }, async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const minVersion = typeof body.minVersion === "string" ? body.minVersion.trim() : "";
    if (!minVersion) {
      return reply.status(400).send({ ok: false, error: "minVersion is required" });
    }

    const key = "brain.min_version";
    const previous = await readKvString(key);

    await kv.put(key, sc.encode(minVersion));
    req.log.info({ key, previous, current: minVersion }, "brain.min_version.updated");
    return { ok: true, key, value: minVersion, previous };
  });

  // Not the min-version key: that names a deployment tag, this a contract version.
  app.post("/v1/internal/brain/doorbell-semantics", { preHandler: internalAuth }, async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const semantics = body.semantics;
    if (typeof semantics !== "number" || !Number.isInteger(semantics) || semantics < 1) {
      return reply.status(400).send({
        ok: false,
        error: "semantics must be an integer of at least 1",
      });
    }
    // A stored floor above this binary's own version has no reader that can act on it.
    if (semantics > DOORBELL_SEMANTICS_VERSION) {
      return reply.status(400).send({
        ok: false,
        error: `semantics must not exceed this API's own ${DOORBELL_SEMANTICS_VERSION}`,
      });
    }
    const previous = await readFloorString();
    await kvDoorbellFloor.put(DOORBELL_SEMANTICS_KEY, sc.encode(String(semantics)));
    req.log.info(
      { key: DOORBELL_SEMANTICS_KEY, previous, current: semantics },
      "brain.doorbell_semantics.updated",
    );
    return { ok: true, key: DOORBELL_SEMANTICS_KEY, value: semantics, previous };
  });

  // The gate closing does not prove nothing more is coming; poll in-flight too.
  app.delete("/v1/internal/brain/doorbell-semantics", { preHandler: internalAuth }, async (req) => {
    const previous = await readFloorString();
    await kvDoorbellFloor.delete(DOORBELL_SEMANTICS_KEY);
    req.log.warn({ key: DOORBELL_SEMANTICS_KEY, previous }, "brain.doorbell_semantics.revoked");
    return { ok: true, key: DOORBELL_SEMANTICS_KEY, previous };
  });

  // Every non-terminal state: a claimed row becomes queued again on the drain.
  app.get<{ Querystring: { version?: string } }>(
    "/v1/internal/brain/doorbell-gate",
    { preHandler: internalAuth },
    async (req, reply) => {
      const raw = req.query.version;
      const version = raw === undefined ? DOORBELL_SEMANTICS_VERSION : Number(raw);
      if (!Number.isInteger(version) || version < 1) {
        return reply.status(400).send({ ok: false, error: "version must be an integer of at least 1" });
      }
      return {
        ok: true,
        gate: doorbellGateOpen() ? 1 : 0,
        in_flight: doorbellInFlight(),
        latch: doorbellLatch().state,
        supported: DOORBELL_SEMANTICS_VERSION,
        incompatible_runs: await countIncompatibleDoorbellRuns(version),
      };
    },
  );

  // Sandbox status (ops debug). Admin only — scans NATS KV for all Hands
  // entries and health-checks each endpoint. Mirrors V1 get_executor_sandbox_status.
  app.get("/v1/internal/sandbox/status", { preHandler: internalAuth }, async () => {
    const sessions: Array<Record<string, unknown>> = [];
    try {
      const iter = await kv.keys("hands.*");
      for await (const key of iter) {
        const sessionId = key.slice("hands.".length);
        const entry = await kv.get(key);
        if (!entry) continue;
        let info: Record<string, unknown>;
        try {
          info = JSON.parse(new TextDecoder().decode(entry.value));
        } catch {
          continue;
        }

        const handsUrl = (info.handsUrl as string) || "";
        const healthUrl = handsUrl.replace(/\/mcp\/?$/, "") + "/health";
        let healthy = false;
        if (handsUrl) {
          try {
            const r = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
            healthy = r.ok;
          } catch { /* unhealthy */ }
        }

        sessions.push({
          session_id: sessionId,
          workload_id: info.workloadId || "",
          hands_url: handsUrl,
          sandbox_image: info.sandboxImage || null,
          created_at: info.createdAt || null,
          has_platform_key: Boolean(info.platformKey),
          healthy,
        });
      }
    } catch (e: any) {
      return { ok: false, error: `kv scan failed: ${e?.message || e}` };
    }
    return {
      ok: true,
      count: sessions.length,
      sessions,
      config: {
        SAFE_API_URL: SAFE_API_URL || "(not set)",
      },
    };
  });

  // Interrupt
  app.post<{ Params: { id: string } }>("/v1/chat/sessions/:id/interrupt", async (req, reply) => {
    const sessionId = req.params.id;
    const user = getUser(req);
    if (!user) return reply.status(401).send({ ok: false, error: "authentication required" });
    const session = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
    if (!session) return reply.status(404).send({ ok: false, error: "not found" });
    if (!canWriteSessionAsOperator(session.user_id, user)) {
      return reply.status(403).send({ ok: false, error: "access denied" });
    }
    // A caller told `ok` for a Stop that reached neither half never retries it.
    try {
      await stopSessionRuns(sessionId);
    } catch {
      return reply.status(503).send({ ok: false, error: "interrupt_not_recorded" });
    }
    return { ok: true };
  });

  // HITL decision approval/rejection (P2: owner/admin check + edit support)
  app.post<{ Params: { id: string } }>("/v1/chat/sessions/:id/decisions", async (req, reply) => {
    const sessionId = req.params.id;
    const user = getUser(req);
    if (!user) return reply.status(401).send({ ok: false, error: "authentication required" });
    const userId = user.userId;
    const session = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
    if (!session) return reply.status(404).send({ ok: false, error: "not found" });

    if (!canWriteSessionAsOperator(session.user_id, user)) {
      return reply.status(403).send({ ok: false, error: "forbidden" });
    }

    const body = req.body as Record<string, unknown>;
    const decision = (body.decision as string) || "";
    const actionId = (body.actionId as string) || (body.action_id as string) || "";
    if (!decision || !actionId) {
      return reply.status(400).send({ ok: false, error: "decision and actionId are required" });
    }
    if (!["allow", "deny", "edit", "skip"].includes(decision)) {
      return reply.status(400).send({ ok: false, error: "decision must be allow, deny, edit, or skip" });
    }
    if (decision === "edit" && !body.edited_input) {
      return reply.status(400).send({ ok: false, error: "edited_input required when decision is edit" });
    }

    nc.publish(`decision.${sessionId}`, sc.encode(JSON.stringify({
      type: "decision",
      session_id: sessionId,
      user_id: userId,
      action_id: actionId,
      decision,
      feedback: body.feedback || "",
      ...(decision === "edit" ? { edited_input: body.edited_input } : {}),
      ...(body.remember != null ? { remember: !!body.remember } : {}),
    })));
    return { ok: true, session_id: sessionId, action_id: actionId, decision };
  });

  // P5: ask_user_question answer endpoint
  app.post<{ Params: { id: string } }>("/v1/chat/sessions/:id/answers", async (req, reply) => {
    const sessionId = req.params.id;
    const user = getUser(req);
    if (!user) return reply.status(401).send({ ok: false, error: "authentication required" });
    const userId = user.userId;
    const session = (await db.query("SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId])).rows[0];
    if (!session) return reply.status(404).send({ ok: false, error: "not found" });

    if (!canWriteSessionAsOperator(session.user_id, user)) {
      return reply.status(403).send({ ok: false, error: "forbidden" });
    }

    const body = req.body as Record<string, unknown>;
    const actionId = (body.actionId as string) || (body.action_id as string) || "";
    if (!actionId) {
      return reply.status(400).send({ ok: false, error: "actionId is required" });
    }

    nc.publish(`decision.${sessionId}`, sc.encode(JSON.stringify({
      type: "answer",
      session_id: sessionId,
      user_id: userId,
      action_id: actionId,
      answers: body.answers ?? {},
      skipped: body.skipped ?? [],
    })));
    return { ok: true, session_id: sessionId, action_id: actionId };
  });
}
