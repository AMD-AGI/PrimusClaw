// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { nc, kv, sc } from "../infra/nats.js";
import { db } from "../infra/db.js";
import { interruptSubject } from "@claw/protocol";
import { interruptUnstartedChatRuns } from "../tasks/chat-run.js";
import { SAFE_API_URL } from "../config.js";
import { getUser, internalTokenAuth as internalAuth } from "../auth/middleware.js";
import { canWriteSessionAsOperator } from "../auth/models.js";
import { collectSandboxInventory } from "./sandbox-inventory.js";
import { sessionIdFromHandsKey } from "@claw/protocol";
import { listDagHandles } from "../infra/dag-handles.js";

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
    let previous: string | null = null;
    try {
      const prev = await kv.get(key);
      previous = prev ? sc.decode(prev.value) : null;
    } catch {
      previous = null;
    }

    await kv.put(key, sc.encode(minVersion));
    req.log.info({ key, previous, current: minVersion }, "brain.min_version.updated");
    return { ok: true, key, value: minVersion, previous };
  });

  // Sandbox status (ops debug). Admin only — the authoritative fleet census
  // every rollout gate and every rollback step iterates, which is why an
  // unreadable half fails the whole answer rather than shrinking it.
  app.get("/v1/internal/sandbox/status", { preHandler: internalAuth }, async () => {
    try {
      const inventory = await collectSandboxInventory({
        handsKeys: async (filter) => {
          const out: string[] = [];
          for await (const key of await kv.keys(filter)) out.push(key);
          return out;
        },
        handsGet: async (key) => {
          const entry = await kv.get(key);
          return entry ? new TextDecoder().decode(entry.value) : null;
        },
        dagHandles: listDagHandles,
        probeHealth: async (handsUrl) => {
          try {
            const r = await fetch(`${handsUrl.replace(/\/mcp\/?$/, "")}/health`, {
              signal: AbortSignal.timeout(3000),
            });
            return r.ok;
          } catch {
            return false;
          }
        },
        // Decoded, not sliced: a re-keyed session would otherwise be reported
        // under the encoded form, which names nothing an operator can act on.
        sessionIdFromKey: sessionIdFromHandsKey,
      });
      return { ...inventory, config: { SAFE_API_URL: SAFE_API_URL || "(not set)" } };
    } catch (e: any) {
      return { ok: false, error: `sandbox inventory unreadable: ${e?.message || e}` };
    }
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
    nc.publish(interruptSubject(sessionId));
    await interruptUnstartedChatRuns(sessionId);
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
