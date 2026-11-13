// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A signed-out browser that opens a delivery link is sent to sign in and back,
 * when the operator names a sign-in page (CLAW_BROWSER_SIGN_IN_URL); everything
 * else answers as it always did.
 *
 * The real auth hook on a Fastify app with a stand-in SaFE; the delivery route is
 * a stub that reports who reached it, since what is pinned here is the hook.
 *
 *   B1 no credential, a browser navigation, the setting on: 302 to the sign-in page, the
 *      external path (public prefix included) encoded as the return target
 *   B2 no credential and not a browser navigation (no Accept, JSON, text/html;q=0): JSON 401
 *   B3 the setting unset (or unusable): JSON 401, browser or not
 *   B4 a signed-in browser reaches the route; a refused credential keeps its JSON 401
 *   B5 any other route, or another method, is JSON 401 for a browser too
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { AUTH_INTERNAL_TOKEN, startFakePlatform } from "./support/fake-platform.js";
import type { FakeUpstream } from "./support/fake-upstream.js";
import { acceptsHtml, browserSignInBase, browserSignInRedirect } from "../src/auth/browser-sign-in.js";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const LINK = "/v1/sessions/s-1/deliveries/0f8fad5b-d9cb-469f-a165-70867728950e";

let platform: FakeUpstream;
let app: FastifyInstance;

before(async () => {
  platform = await startFakePlatform({ alice: { id: "u-alice", name: "Alice", virtualKey: "vk-alice" } });
  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;

  const { authMiddleware } = await import("../src/auth/middleware.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  app.get("/v1/sessions/:id/deliveries/:deliveryId", async (req) => ({ reached: (req as unknown as { user: { userId: string } }).user.userId }));
  app.get("/v1/sessions/:id", async () => ({ reached: true }));
  await app.ready();
});

beforeEach(() => {
  process.env.CLAW_BROWSER_SIGN_IN_URL = "/login?redirect=";
  process.env.CLAW_PUBLIC_URL = "https://claw.example.com/claw-api";
});

after(async () => {
  await app?.close();
  await platform?.close();
});

const get = (url: string, headers: Record<string, string> = {}, method: "GET" | "POST" = "GET") =>
  app.inject({ method, url, headers });

function assertJson401(res: Awaited<ReturnType<typeof get>>, what: string): void {
  assert.equal(res.statusCode, 401, what);
  assert.equal(res.headers.location, undefined, what);
  assert.equal(JSON.parse(res.body).error, "authentication_required", what);
}

test("B1 a signed-out browser is sent to sign in, with the external path as the return target", async () => {
  const res = await get(LINK, { accept: BROWSER_ACCEPT });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `/login?redirect=${encodeURIComponent(`/claw-api${LINK}`)}`);
  assert.equal(res.headers.location, "/login?redirect=%2Fclaw-api%2Fv1%2Fsessions%2Fs-1%2Fdeliveries%2F0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("B1 the return target keeps the path as the browser sent it, and carries no query", async () => {
  const res = await get("/v1/sessions/s%20x/deliveries/d-1?foo=bar", { accept: "TEXT/HTML" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `/login?redirect=${encodeURIComponent("/claw-api/v1/sessions/s%20x/deliveries/d-1")}`);
});

test("B1 without CLAW_PUBLIC_URL the prefix comes from the proxy's X-Forwarded-Prefix, else none", async () => {
  delete process.env.CLAW_PUBLIC_URL;
  let res = await get(LINK, { accept: BROWSER_ACCEPT, "x-forwarded-prefix": "/claw-api" });
  assert.equal(res.headers.location, `/login?redirect=${encodeURIComponent(`/claw-api${LINK}`)}`);
  res = await get(LINK, { accept: BROWSER_ACCEPT });
  assert.equal(res.headers.location, `/login?redirect=${encodeURIComponent(LINK)}`);
  // A forwarded prefix that is not a plain path is ignored, never repaired.
  res = await get(LINK, { accept: BROWSER_ACCEPT, "x-forwarded-prefix": "//evil.example" });
  assert.equal(res.headers.location, `/login?redirect=${encodeURIComponent(LINK)}`);
});

test("B2 no credential and not a browser navigation: JSON 401", async () => {
  assertJson401(await get(LINK), "no Accept");
  assertJson401(await get(LINK, { accept: "application/json" }), "JSON");
  assertJson401(await get(LINK, { accept: "*/*" }), "anything");
  assertJson401(await get(LINK, { accept: "text/html;q=0, application/json" }), "html refused");
});

test("B3 with the setting unset or unusable, a browser gets JSON 401", async () => {
  for (const value of [undefined, "", "   ", "//evil.example/login?r=", "javascript:alert(1)//", "login?r="]) {
    if (value === undefined) delete process.env.CLAW_BROWSER_SIGN_IN_URL;
    else process.env.CLAW_BROWSER_SIGN_IN_URL = value;
    assertJson401(await get(LINK, { accept: BROWSER_ACCEPT }), String(value));
  }
});

test("B4 a signed-in browser reaches the route; a refused or non-cookie credential keeps its JSON answer", async () => {
  const ok = await get(LINK, { accept: BROWSER_ACCEPT, cookie: "Token=tok-alice; userType=default" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { reached: "u-alice" });

  const stale = await get(LINK, { accept: BROWSER_ACCEPT, cookie: "Token=tok-nobody" });
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.headers.location, undefined);
  assert.equal(JSON.parse(stale.body).error, "invalid_cookie");

  const badKey = await get(LINK, { accept: BROWSER_ACCEPT, authorization: "Bearer ak-nobody" });
  assert.equal(badKey.statusCode, 401);
  assert.equal(badKey.headers.location, undefined);

  // A credential this API does not recognise is still a credential: no redirect.
  assertJson401(await get(LINK, { accept: BROWSER_ACCEPT, authorization: "Basic dXNlcjpwdw==" }), "other scheme");
  // Nor is a `?token=` key, which this route does not accept: it keeps its JSON 401.
  assertJson401(await get(`${LINK}?token=ak-alice`, { accept: BROWSER_ACCEPT }), "query token");
  assertJson401(await get(`${LINK}?token=`, { accept: BROWSER_ACCEPT }), "empty query token");
});

test("B5 other routes and other methods are JSON 401 for a browser too", async () => {
  assertJson401(await get("/v1/sessions/s-1", { accept: BROWSER_ACCEPT }), "session");
  assertJson401(await get(`${LINK}/x`, { accept: BROWSER_ACCEPT }), "deeper path");
  assertJson401(await get("/v1/sessions/s-1/files/a.txt", { accept: BROWSER_ACCEPT }), "files");
  const post = await get(LINK, { accept: BROWSER_ACCEPT }, "POST");
  assert.notEqual(post.statusCode, 302);
  assert.equal(post.headers.location, undefined);
});

test("browserSignInBase accepts a same-origin path or an http(s) URL only", () => {
  assert.equal(browserSignInBase({ CLAW_BROWSER_SIGN_IN_URL: " /login?redirect= " }), "/login?redirect=");
  assert.equal(browserSignInBase({ CLAW_BROWSER_SIGN_IN_URL: "https://sso.example.com/in?next=" }), "https://sso.example.com/in?next=");
  for (const bad of ["", "//x", "/\\x", "ftp://x/", "https:///x", "login"]) {
    assert.equal(browserSignInBase({ CLAW_BROWSER_SIGN_IN_URL: bad }), "", bad);
  }
});

test("acceptsHtml reads media types, not substrings", () => {
  assert.equal(acceptsHtml(BROWSER_ACCEPT), true);
  assert.equal(acceptsHtml(["application/json", "text/html"]), true);
  assert.equal(acceptsHtml("text/html;q=0.0"), false);
  assert.equal(acceptsHtml("application/text/html+json"), false);
  assert.equal(acceptsHtml(undefined), false);
});

test("browserSignInRedirect is null for HEAD, which a browser does not navigate with", () => {
  const req = { method: "HEAD", headers: { accept: BROWSER_ACCEPT }, cookies: {}, query: {} };
  assert.equal(browserSignInRedirect(req as never, LINK, { CLAW_BROWSER_SIGN_IN_URL: "/login?redirect=" }), null);
  assert.equal(
    browserSignInRedirect({ ...req, method: "GET" } as never, LINK, { CLAW_BROWSER_SIGN_IN_URL: "/login?redirect=" }),
    `/login?redirect=${encodeURIComponent(LINK)}`,
  );
});
