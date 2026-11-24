// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant does on its own, as the user's channel reaches it.
 *
 *   GET  /v1/assistant/brief?lang=zh|en&timezone=&range=day|week  the caller's brief, put together now (`assistant/brief.ts`);
 *        range=week is their week (the last seven days), for a weekly report
 *   GET  /v1/assistant/confirmations              the cards waiting for the caller's press (`assistant/schedules.ts`)
 *   POST /v1/assistant/confirmations/:id/decision {decision: allow | deny}: the caller's answer to one of them, or to a merge or an
 *        approval a review the assistant started holds for them (`github_merge`, `github_review` cards: `review-items.ts`), made
 *        exactly as `POST /v1/github-review/confirmations/:id/decision` makes it
 *
 * Everything is the caller's own: another user's confirmation answers 404. A decision is the person's say, so it is taken as a
 * held merge's answer is (`classifyAttendedCaller`): from their own sign-in at the identity provider, or from a service the operator
 * named answering for them with a token that acts as them (their chat, pressing the card's button). Never from a key, a BYOK key or a
 * cookie: a model in any sandbox of theirs holds their key, and its own press is not theirs. A created trigger runs later on the
 * key of this request when it carries one, else on the key the person's messages last gave their assistant.
 *
 * Registered only while CLAW_ASSISTANT_ENABLED is on (the confirmations also need the router's schedule tools, personal skills, whose
 * drafts are confirmed the same way, or the assistant's review items); otherwise the paths do not exist.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { classifyAttendedCaller } from "../github-review/attended.js";
import { readGithubReviewSettings } from "../github-review/settings.js";
import { CLAW_ASSISTANT_ENABLED, CLAW_GITHUB_REVIEW_ENABLED, CLAW_USER_SKILLS_ENABLED } from "../config.js";
import { BRIEF_RANGES, briefLanguage, composeBrief, isBriefRange } from "../assistant/brief.js";
import { assistantSchedulesOn, DecisionRefused, decideConfirmation, pendingConfirmations } from "../assistant/schedules.js";
import { reviewItemsEnabled } from "../assistant/review-items.js";
import { reviewToolPorts } from "../assistant/review-tools.js";
import { db } from "../infra/db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `id` is a held GitHub write (`claw_github_confirmations`, there only with the GitHub review on) that asks this user: their card's
 * button answers it here.
 */
async function asksForGithubWrite(userId: string, id: string): Promise<boolean> {
  if (!CLAW_GITHUB_REVIEW_ENABLED || !UUID_RE.test(id)) return false;
  return ((await db.query(
    "SELECT 1 FROM claw_github_confirmations WHERE confirmation_id = $1::uuid AND actor_user_id = $2", [id, userId],
  )).rowCount ?? 0) > 0;
}

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
  userSkills: boolean = CLAW_USER_SKILLS_ENABLED, reviewItems: boolean = reviewItemsEnabled(),
): Promise<void> {
  if (!enabled) return;

  app.get("/v1/assistant/brief", async (req, reply) => {
    const user = requireRealUser(req, reply);
    if (!user) return;
    const query = (req.query ?? {}) as { lang?: string; timezone?: string; range?: string };
    if (query.range !== undefined && !isBriefRange(query.range)) {
      return reply.status(400).send({ ok: false, error: "invalid_request", message: `range must be one of ${BRIEF_RANGES.join(", ")}` });
    }
    const lang = query.lang === "zh" || query.lang === "en" ? query.lang : await briefLanguage(user.userId);
    const timezone = typeof query.timezone === "string" && query.timezone.length <= 64 ? query.timezone : undefined;
    const brief = await composeBrief(user.userId, { apiKey: user.platformKey || null, lang, timezone, range: query.range === "week" ? "week" : "day" });
    return reply.send({ ok: true, data: brief });
  });

  // The cards are the schedule tools', the drafts of a personal skill the assistant suggested (`skill-writes.ts`), and what a review the
  // assistant started holds for its owner (`review-items.ts`).
  if (!schedules && !userSkills && !reviewItems) return;

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
    const id = (req.params as { id: string }).id;
    // A merge or an approval a review holds for them: the review's own decision, with every gate it reads (N54).
    if (await asksForGithubWrite(user.userId, id)) {
      const answer = await reviewToolPorts.decide(user.userId, id, decision, caller.via);
      if (answer.http >= 400) return reply.status(answer.http).send(answer.body);
      return reply.send({ ok: true, data: answer.body });
    }
    try {
      const out = await decideConfirmation({
        userId: user.userId, confirmationId: id, decision, via: caller.via ? `button:${caller.via.clientId}` : "button",
        creds: { platformKey: user.platformKey || "", virtualKey: user.virtualKey || "", userName: user.userName || "" },
      });
      return reply.send({ ok: true, data: out });
    } catch (err) {
      if (!(err instanceof DecisionRefused)) throw err;
      return reply.status(err.status).send({ ok: false, error: err.code, message: err.message });
    }
  });
}
