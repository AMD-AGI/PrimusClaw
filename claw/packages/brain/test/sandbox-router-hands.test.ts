// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hands reached through the Router's port proxy, over real sockets.
 *
 * The proxy routes on x-session-id and strips Authorization, so every Hands
 * request must carry the session and the credential in X-Hands-Token as well.
 * The first Router base here is a closed port, so the same requests also prove
 * that a Hands URL built on a dead base still gets through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";

const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
const router = createServer((req, res) => {
  seen.push({ url: req.url ?? "", headers: req.headers });
  res.setHeader("content-type", "application/json");
  if ((req.url ?? "").endsWith("/health")) return res.end(JSON.stringify({ status: "ok" }));
  res.end(JSON.stringify({ running: 2 }));
});
await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
const live = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
// A port that was just free: nothing listens there once this closes.
const probe = createNetServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
await new Promise<void>((r) => probe.close(() => r()));

process.env.SANDBOX_ROUTER_URL = `${dead},${live}`;
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";

const { handsViaRouter, safeHandsBaseUrl, resetRouterPreferenceForTest } =
  await import("../src/sandbox/sandbox-router.js");
const { checkHandsHealth } = await import("../src/sandbox/hands-health.js");
const { countActiveShells } = await import("../src/clients/hands.js");

test.after(() => { router.close(); });

test("with the flag on, the Hands base is the Router's port proxy for the sandbox", () => {
  assert.equal(handsViaRouter(), true);
  assert.equal(
    safeHandsBaseUrl("crusoe-spur-vk", "claw-1-sandbox-x", "9100"),
    `${dead}/v1/namespaces/crusoe-spur-vk/code-interpreters/claw-1-sandbox-x/invocations/proxy/9100`,
  );
});

test("health and a credentialed route carry the session and X-Hands-Token, past a dead base", async () => {
  resetRouterPreferenceForTest();
  seen.length = 0;
  const mcpUrl = `${safeHandsBaseUrl("ns", "wl-7", "9100")}/mcp`;
  assert.ok(mcpUrl.startsWith(dead), "built on the first base, which is down");

  const health = await checkHandsHealth(mcpUrl, 3_000);
  assert.deepEqual(health, { ok: true, detail: "ok" });
  assert.equal(seen[0].url, "/v1/namespaces/ns/code-interpreters/wl-7/invocations/proxy/9100/health");
  assert.equal(seen[0].headers["x-session-id"], "wl-7");

  const running = await countActiveShells(mcpUrl, "tok", "owner-1");
  assert.equal(running, 2);
  const last = seen[seen.length - 1];
  assert.equal(last.url, "/v1/namespaces/ns/code-interpreters/wl-7/invocations/proxy/9100/internal/shells/active");
  assert.equal(last.headers["x-session-id"], "wl-7");
  const token = last.headers["x-hands-token"];
  assert.ok(typeof token === "string" && token.length > 0, "credential travels in X-Hands-Token");
  assert.equal(last.headers.authorization, `Bearer ${token}`, "and in Authorization, the same value");
});
