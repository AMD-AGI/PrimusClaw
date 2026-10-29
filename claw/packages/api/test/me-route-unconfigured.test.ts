// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me` with no SAFE_API_URL: a 503 that names the missing setting, not a
 * fetch of `undefined/api/v1/...` that surfaces as a confusing "unreachable".
 *
 * Its own file because SAFE_API_URL is read when the config module is imported.
 * The auth middleware refuses first in a real process (it cannot authenticate
 * without SaFE), so this drives the route with the identity already attached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

delete process.env.SAFE_API_URL;
process.env.APP_ENV = "production";
delete process.env.CLAW_INSECURE_DEV_AUTH;
process.env.CLAW_DEPLOY_MODE = "safe";

test("no SAFE_API_URL is a 503 safe_not_configured", async () => {
  const { registerMeRoutes } = await import("../src/routes/me.js");
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "u-gina", userName: "Gina", roles: ["default"], platformKey: "", virtualKey: "" };
  });
  await registerMeRoutes(app);
  try {
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: "Token=whatever" } });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    assert.equal(body.error, "safe_not_configured");
    assert.match(body.reason, /SAFE_API_URL/);
  } finally {
    await app.close();
  }
});
