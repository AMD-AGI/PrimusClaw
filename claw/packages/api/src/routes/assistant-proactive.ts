// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant does on its own, as the user's channel reaches it.
 *
 *   GET  /v1/assistant/brief?lang=zh|en&timezone=  the caller's brief, put together now (`assistant/brief.ts`)
 *   GET  /v1/assistant/confirmations              the cards waiting for the caller's press (`assistant/schedules.ts`)
 *   POST /v1/assistant/confirmations/:id/decision {decision: allow | deny}: the caller's answer to one of them
 *
 * Everything is the caller's own: another user's confirmation answers 404. A decision is the person's say, so it is taken as a
 * held merge's answer is (`classifyAttendedCaller`): from their own sign-in at the identity provider, or from a service the operator
 * named answering for them with a token that acts as them (their chat, pressing the card's button). Never from a key, a BYOK key or a
 * cookie: a model in any sandbox of theirs holds their key, and its own press is not theirs. A created trigger runs later on the
 * key of this request when it carries one, else on the key the person's messages last gave their assistant.
 *
 * Registered only while CLAW_ASSISTANT_ENABLED is on (the confirmations also need the router's schedule tools); otherwise the
 * paths do not exist.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { classifyAttendedCaller } from "../github-review/attended.js";
import { readGithubReviewSettings } from "../github-review/settings.js";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { briefLanguage, composeBrief } from "../assistant/brief.js";
import { assistantSchedulesOn, DecisionRefused, decideConfirmation, pendingConfirmations } from "../assistant/schedules.js";

function requireRealUser(req: FastifyRequest, reply: FastifyReply): NonNullable<ReturnType<typeof getUser>> | null {
  const user = getUser(req);
  if (!user?.userId || user.userId === "default") {
    reply.status(403).send({ ok: false, error: "assistant_requires_authenticated_user" });
    return null;
  }
  return user;
}

export async function registerAssistantProactiveRoutes(
  app: FastifyInstance, enabled: boolean = CLAW_ASSISTANT_ENABLED, schedules: boolean = assistantSchedulesOn(),
): Promise<void> {
  if (!enabled) return;

  app.get("/v1/assistant/brief", async (req, reply) => {
    const user = requireRealUser(req, reply);
    if (!user) return;
    const query = (req.query ?? {}) as { lang?: string; timezone?: string };
    const lang = query.lang === "zh" || query.lang === "en" ? query.lang : await briefLanguage(user.userId);
    const timezone = typeof query.timezone === "string" && query.timezone.length <= 64 ? query.timezone : undefined;
    const brief = await composeBrief(user.userId, { apiKey: user.platformKey || null, lang, timezone });
    return reply.send({ ok: true, data: brief });
  });

  if (!schedules) return;

  app.get("/v1/assistant/confirmations", async (req, reply) => {
    const user = requireRealUser(req, reply);
    if (!user) return;
    return reply.send({ ok: true, data: await pendingConfirmations(user.userId) });
  });

  app.post("/v1/assistant/confirmations/:id/decision", async (req, reply) => {
    const user = requireRealUser(req, reply);
    if (!user) return;
    const decision = ((req.body ?? {}) as { decision?: unknown }).decision;
    if (decision !== "allow" && decision !== "deny") {
      return reply.status(400).send({ ok: false, error: "invalid_request", message: "decision must be allow or deny" });
    }
    const caller = classifyAttendedCaller(getAuthMethod(req), { delegation: user.delegation }, readGithubReviewSettings().decisionClientIds);
    if (!caller.ok) {
      return reply.status(403).send({
        ok: false, error: caller.error, message: "a card is answered by you, signed in (or by your chat for you), never with a key",
      });
    }
    try {
      const out = await decideConfirmation({
        userId: user.userId, confirmationId: (req.params as { id: string }).id, decision, via: caller.via ? `button:${caller.via.clientId}` : "button",
        creds: { platformKey: user.platformKey || "", virtualKey: user.virtualKey || "", userName: user.userName || "" },
      });
      return reply.send({ ok: true, data: out });
    } catch (err) {
      if (!(err instanceof DecisionRefused)) throw err;
      return reply.status(err.status).send({ ok: false, error: err.code, message: err.message });
    }
  });
}
