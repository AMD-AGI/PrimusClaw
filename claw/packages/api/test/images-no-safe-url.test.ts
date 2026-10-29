// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deployment without SAFE_API_URL has nowhere to ask for images. The route
 * says so (503) rather than answering 500 or an empty list: an empty list would
 * read as "no images exist".
 */
import assert from "node:assert/strict";
import test from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";

test("an unset SAFE_API_URL is 503 images_unavailable, not an empty list", async () => {
  delete process.env.SAFE_API_URL;
  process.env.CLAW_DEPLOY_MODE = "safe";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  const app = Fastify();
  try {
    await app.register(cookie);
    app.addHook("preHandler", async (req) => {
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "", virtualKey: "vk" };
    });
    const { registerImageRoutes } = await import("../src/routes/images.js");
    await registerImageRoutes(app);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/images", headers: { cookie: "Token=abc" } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(Object.keys(res.json()).sort(), ["error", "ok", "reason"]);
    assert.equal(res.json().error, "images_unavailable");
  } finally {
    await app.close();
  }
});
