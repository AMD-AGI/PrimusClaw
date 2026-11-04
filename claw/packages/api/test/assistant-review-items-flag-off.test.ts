// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `CLAW_ASSISTANT_REVIEW_ITEMS` off, with the assistant and GitHub review on: the review routes do not exist (a channel that calls them
 * goes on making acting sessions the way it did), and nothing reads or writes a review item.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
delete process.env.CLAW_ASSISTANT_REVIEW_ITEMS;

test("the review routes do not exist and no review item is looked for", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
  const ri = await import("../src/assistant/review-items.js");
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "alice", userName: "alice", roles: ["default"] };
    (req as any).authMethod = "identity_token";
  });
  await registerAssistantRoutes(app);
  await app.ready();
  try {
    for (const url of ["/v1/assistant/reviews", "/v1/assistant/reviews/kwi_x/restart"]) {
      const r = await app.inject({ method: "POST", url, payload: { prs: [{ owner: "AMD-AGI", repo: "x", number: 1 }] } });
      assert.equal(r.statusCode, 404, url);
    }
    // No database is configured here: any statement would throw.
    assert.equal(await ri.syncReviewItemOfSession("s-1"), false);
    assert.equal(await ri.confirmationOfStoppedReview("c-1"), false);
    assert.equal(await ri.sweepReviewItems(), 0);
  } finally {
    await app.close();
  }
});
