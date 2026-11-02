// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * kubernetes/BYOK mode has no SaFE and no image registry to search, and its
 * callers hold an LLM-gateway key, not a SaFE credential. `GET /v1/images` says
 * so (503) instead of asking a SaFE that is not there and answering 401.
 *
 * SAFE_API_URL is set here on purpose: it is the deployment mode that has to
 * decide, not an address that happens to be present, and a server is listening
 * so that a route which asked anyway would be seen doing it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";

test("kubernetes mode is 503 images_unavailable and SaFE is not asked", async () => {
  let asked = 0;
  const fake = createServer((_req, res) => { asked++; res.end("[]"); });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  process.env.SAFE_API_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.CLAW_DEPLOY_MODE = "kubernetes";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  const app = Fastify();
  try {
    await app.register(cookie);
    app.addHook("preHandler", async (req) => {
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "", virtualKey: "ak-u1" };
    });
    const { registerImageRoutes } = await import("../src/routes/images.js");
    await registerImageRoutes(app);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/images", headers: { authorization: "Bearer ak-user-key" } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "images_unavailable");
    assert.equal(asked, 0);
  } finally {
    await app.close();
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
