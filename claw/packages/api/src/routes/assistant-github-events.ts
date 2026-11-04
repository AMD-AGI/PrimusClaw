// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The pull requests a work item watches (`assistant/github-events.ts`).
 *
 *   POST   /v1/work-items/:id/subscriptions          {pr, reply?}: watch it; reply true lets the worker answer on it as you
 *   GET    /v1/work-items/:id/subscriptions
 *   DELETE /v1/work-items/:id/subscriptions/:sub_id  stop watching
 *
 * Everything is the caller's own, as on the board: another user's item answers 404. `reply: true` is the one thing that lets a
 * model write to GitHub as the owner without asking each time, so it is taken only from the person themselves, signed in at the
 * identity provider (`classifyAttendedCaller`, the check a held merge's answer goes through): a key, which any sandbox of theirs
 * holds, cannot give it. Taking it away (`reply: false`, or ending the subscription) needs nothing more than ownership.
 *
 * Registered only while CLAW_ASSISTANT_ENABLED and CLAW_ASSISTANT_GITHUB_EVENTS are both on; otherwise the paths do not exist.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import {
  endSubscription, githubEventsEnabled, listSubscriptions, subscribeItem, SubscriptionRefused,
} from "../assistant/github-events.js";
import { classifyAttendedCaller } from "../github-review/attended.js";
import { readGithubReviewSettings } from "../github-review/settings.js";

function requireRealUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = getUser(req)?.userId;
  if (!userId || userId === "default") {
    reply.status(403).send({ ok: false, error: "assistant_requires_authenticated_user" });
    return null;
  }
  return userId;
}

export async function registerAssistantGithubEventRoutes(app: FastifyInstance, enabled: boolean = githubEventsEnabled()): Promise<void> {
  if (!enabled) return;

  app.post("/v1/work-items/:id/subscriptions", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as { pr?: unknown; reply?: unknown };
    if (body.reply !== undefined && typeof body.reply !== "boolean") {
      return reply.status(400).send({ ok: false, error: "invalid_request", message: "reply must be true or false" });
    }
    if (body.reply === true) {
      const caller = classifyAttendedCaller(getAuthMethod(req), { delegation: getUser(req)?.delegation }, readGithubReviewSettings().decisionClientIds);
      if (!caller.ok) {
        return reply.status(403).send({
          ok: false, error: caller.error, message: "allowing answers on GitHub without asking needs you, signed in yourself",
        });
      }
    }
    try {
      const sub = await subscribeItem({ userId, item: (req.params as { id: string }).id, pr: body.pr, reply: body.reply as boolean | undefined });
      return reply.status(sub.created ? 201 : 200).send({ ok: true, data: sub });
    } catch (err) {
      if (!(err instanceof SubscriptionRefused)) throw err;
      return reply.status(err.status).send({ ok: false, error: err.code, message: err.message });
    }
  });

  app.get("/v1/work-items/:id/subscriptions", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const subs = await listSubscriptions(userId, (req.params as { id: string }).id);
    if (!subs) return reply.status(404).send({ ok: false, error: "not_found" });
    return reply.send({ ok: true, data: subs });
  });

  app.delete("/v1/work-items/:id/subscriptions/:sub_id", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const params = req.params as { id: string; sub_id: string };
    const subId = Number(params.sub_id);
    if (!Number.isSafeInteger(subId) || subId <= 0) return reply.status(404).send({ ok: false, error: "not_found" });
    const ended = await endSubscription(userId, params.id, subId);
    if (!ended) return reply.status(404).send({ ok: false, error: "not_found" });
    return reply.send({ ok: true, data: ended });
  });
}
