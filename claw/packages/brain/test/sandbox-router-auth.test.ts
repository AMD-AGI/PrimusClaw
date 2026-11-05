// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hands through a Router that runs with --enable-auth, over real sockets.
 *
 * Such a Router refuses a /v1 request without a SaFE key, and one whose key's
 * user does not own the sandbox. The stand-in below does the same: it accepts
 * only the owner's key in `Authorization`, and strips that header before Hands
 * would see it, as the real port proxy does. Hands' own credential must still
 * arrive in X-Hands-Token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

const OWNER_KEY = "ak-owner-of-wl-7";
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
const router = createServer((req, res) => {
  seen.push({ url: req.url ?? "", headers: { ...req.headers } });
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== `Bearer ${OWNER_KEY}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ code: "caller_credentials_missing" }));
  }
  if ((req.url ?? "").endsWith("/health")) return res.end(JSON.stringify({ status: "ok" }));
  res.end(JSON.stringify({ running: 1 }));
});
await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
const live = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;

process.env.SANDBOX_ROUTER_URL = live;
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";
process.env.SANDBOX_ROUTER_AUTH_ENABLED = "true";

const {
  safeHandsBaseUrl, rememberRouterCredential, routerCredentialFor, routerAuthSettings,
  resetRouterCredentialsForTest, withRouterFailover,
} = await import("../src/sandbox/sandbox-router.js");
const { checkHandsHealth } = await import("../src/sandbox/hands-health.js");
const { countActiveShells } = await import("../src/clients/hands.js");

test.after(() => { router.close(); });
test.afterEach(() => { routerAuthSettings.enabled = true; resetRouterCredentialsForTest(); });

const mcpUrl = () => `${safeHandsBaseUrl("ns", "wl-7", "9100")}/mcp`;

test("without the owner's key a routed Hands request is refused, as the Router does", async () => {
  seen.length = 0;
  const health = await checkHandsHealth(mcpUrl(), 3_000);
  assert.equal(health.ok, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, undefined);
});

test("with the owner's key remembered, health and a credentialed route get through", async () => {
  seen.length = 0;
  rememberRouterCredential(safeHandsBaseUrl("ns", "wl-7", "9100"), OWNER_KEY);

  const health = await checkHandsHealth(mcpUrl(), 3_000);
  assert.deepEqual(health, { ok: true, detail: "ok" });
  assert.equal(seen[0].headers["x-session-id"], "wl-7");

  assert.equal(await countActiveShells(mcpUrl(), "tok", "owner-1"), 1);
  const last = seen[seen.length - 1];
  assert.equal(last.headers.authorization, `Bearer ${OWNER_KEY}`, "the Router gets the owner's key");
  const token = last.headers["x-hands-token"];
  assert.ok(typeof token === "string" && token.length > 0 && token !== OWNER_KEY,
    "Hands' own credential still travels in X-Hands-Token");
});

test("the key is per sandbox: another sandbox's URL gets none", async () => {
  rememberRouterCredential(safeHandsBaseUrl("ns", "wl-7", "9100"), OWNER_KEY);
  assert.equal(routerCredentialFor(`${safeHandsBaseUrl("ns", "wl-8", "9100")}/health`), null);
  assert.equal(routerCredentialFor(`${safeHandsBaseUrl("other-ns", "wl-7", "9100")}/mcp`), OWNER_KEY,
    "keyed by the Router session, which is what the Router authorises");
});

test("with Router auth off nothing is added, so no key leaves Brain it does not need to", async () => {
  routerAuthSettings.enabled = false;
  rememberRouterCredential(safeHandsBaseUrl("ns", "wl-7", "9100"), OWNER_KEY);
  seen.length = 0;
  await checkHandsHealth(mcpUrl(), 3_000);
  assert.equal(seen[0].headers.authorization, undefined);
});

test("a direct URL or an empty key is never remembered", () => {
  rememberRouterCredential("http://wl-7.ns.svc.cluster.local:9100/mcp", OWNER_KEY);
  assert.equal(routerCredentialFor("http://wl-7.ns.svc.cluster.local:9100/mcp"), null);
  rememberRouterCredential(mcpUrl(), "  ");
  rememberRouterCredential(mcpUrl(), undefined);
  assert.equal(routerCredentialFor(mcpUrl()), null);
});

test("headers given as a Headers object keep every other header", async () => {
  rememberRouterCredential(mcpUrl(), OWNER_KEY);
  let got: RequestInit | undefined;
  const f = withRouterFailover(async (_u: string, init?: RequestInit) => { got = init; return new Response("{}"); });
  await f(mcpUrl(), { headers: new Headers({ authorization: "Bearer hands-token", "x-hands-token": "hands-token", "x-session-id": "wl-7" }) });
  const h = new Headers(got?.headers);
  assert.equal(h.get("authorization"), `Bearer ${OWNER_KEY}`);
  assert.equal(h.get("x-hands-token"), "hands-token");
  assert.equal(h.get("x-session-id"), "wl-7");
});
