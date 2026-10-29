// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a connector's access token reaches, asked of the whole router.
 *
 * The token is meant to authenticate on four routes. "Nowhere else" is a claim
 * about every route the API has, so this does not sample: it registers every
 * route module the server registers (the list is checked against `index.ts`),
 * discovers each route with an `onRoute` hook, and sends the same valid token to
 * every one. A route added tomorrow is covered the day it is written.
 *
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";

const skip = postgresSkipReason();
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const nowSec = () => Math.floor(Date.now() / 1000);

/** Which module exports each `register*Routes` that `index.ts` calls on the app. */
const REGISTRARS: Record<string, string> = {
  registerSessionRoutes: "routes/sessions.js",
  registerEventRoutes: "routes/events.js",
  registerAnthropicManagedAgentsRoutes: "routes/anthropic-managed-agents.js",
  registerAdminRoutes: "routes/admin.js",
  registerMemoryRoutes: "routes/memory.js",
  registerSkillRoutes: "routes/skills.js",
  registerA2ARoutes: "routes/a2a.js",
  registerPluginRoutes: "routes/plugins.js",
  registerUserEnvVarRoutes: "routes/user-env-vars.js",
  registerNotificationSubscriptionRoutes: "routes/notification-subscriptions.js",
  registerRemoteAgentRoutes: "routes/remote-agents.js",
  registerSystemEnvVarRoutes: "routes/system-env-vars.js",
  registerSandboxAdminRoutes: "routes/sandbox-admin.js",
  registerMcpRoutes: "routes/mcp.js",
  registerInternalTaskRoutes: "routes/internal-tasks.js",
  registerInternalRunRoutes: "routes/internal-runs.js",
  registerInternalAppRoutes: "routes/internal-apps.js",
  registerInternalWorkspaceRoutes: "routes/internal-workspaces.js",
  registerTaskDagRoutes: "routes/task-dags.js",
  registerTaskRoutes: "routes/tasks.js",
  registerRunRoutes: "runs/routes.js",
  registerWorkbenchRoutes: "workbenches/routes.js",
  registerModelsRoutes: "routes/models.js",
  registerMeRoutes: "routes/me.js",
  registerTriggerRoutes: "routes/triggers.js",
};

interface Found { method: string; url: string }

/** Substitute path params so a discovered route can actually be injected. */
const concrete = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, () => randomUUID());

describe("a connector access token over the whole router", { skip }, () => {
  let h: AdmissionCluster;
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let token = "";
  const found: Found[] = [];
  let connectorSide: typeof import("../src/remote-agents/connector-routes.js").CONNECTOR_SIDE_ROUTES;
  let isAnonymousPath: typeof import("../src/auth/middleware.js").isAnonymousPath;
  let isConnectorSideRoute: typeof import("../src/remote-agents/connector-routes.js").isConnectorSideRoute;

  before(async () => {
    fake = await FakeIdentity.start();
    const es = testKey("ES256", "k1");
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    token = signJwt({
      key: es,
      claims: { iss: fake.issuer, aud: "claw-api", sub: "u1", scope: "claw.connector", jti: randomUUID(), exp: nowSec() + 300 },
    });
    h = await startAdmissionCluster({
      // Never called: no route is sent a credential SaFE could judge.
      SAFE_API_URL: "http://127.0.0.1:9", AUTH_INTERNAL_TOKEN: "t", CLAW_REMOTE_AGENTS_ENABLED: "true",
    });
    Object.assign(process.env, {
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    });
    const { startIdentityClient } = await import("../src/auth/identity.js");
    startIdentityClient({ info() {}, warn() {}, error() {} });
    ({ isAnonymousPath } = await import("../src/auth/middleware.js"));
    ({ CONNECTOR_SIDE_ROUTES: connectorSide, isConnectorSideRoute } = await import("../src/remote-agents/connector-routes.js"));
    const { authMiddleware } = await import("../src/auth/middleware.js");

    // Built as index.ts builds it: cookie and multipart, the one global hook, then every module.
    app = Fastify();
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) found.push({ method, url: route.url });
    });
    await app.register((await import("@fastify/cookie")).default);
    await app.register((await import("@fastify/multipart")).default);
    app.addHook("preHandler", authMiddleware);
    for (const [name, path] of Object.entries(REGISTRARS)) {
      const mod = (await import(`../src/${path}`)) as Record<string, (a: FastifyInstance) => Promise<void>>;
      await mod[name]!(app);
    }
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await h?.stop();
    await fake?.close();
  });

  test("the modules registered here are the ones the server registers", () => {
    const indexSource = readFileSync(join(SRC, "index.ts"), "utf8");
    const called = [...indexSource.matchAll(/await (register\w+Routes)\(app/g)].map((m) => m[1]!).sort();
    assert.ok(called.length >= 20, `found only ${called.length} register calls in index.ts`);
    assert.deepEqual(Object.keys(REGISTRARS).sort(), called);
  });

  test("discovery found the API, not a handful of routes", () => {
    const urls = new Set(found.map((r) => r.url));
    assert.ok(found.length >= 150, `only ${found.length} routes discovered`);
    for (const expected of ["/v1/sessions", "/v1/remote-agents/sessions/:id/commands", "/a2a", "/v1/internal/tasks/:taskId/agent_done"]) {
      assert.ok(urls.has(expected), `${expected} was not discovered`);
    }
    for (const r of Object.values(connectorSide)) assert.ok(found.some((f) => f.method === r.method && f.url === r.url), `${r.method} ${r.url}`);
  });

  /** The answer the global hook gives a request with no usable credential, in either error shape. */
  const isUnauthenticated = (method: string, status: number, body: any): boolean =>
    status === 401 && (method === "HEAD" || body?.error === "authentication_required" || body?.error?.type === "authentication_error");

  test("every route the token is not for answers as if no credential was sent", async () => {
    const skipped: string[] = [];
    const failures: string[] = [];
    let checked = 0;
    for (const { method, url } of found) {
      const path = concrete(url);
      if (isAnonymousPath(path)) { skipped.push(`${method} ${url}`); continue; }
      if (Object.values(connectorSide).some((r) => r.method === method && r.url === url)) continue;
      const withBody = !["GET", "HEAD", "DELETE"].includes(method);
      const res = await app.inject({
        method: method as "GET", url: path,
        headers: { authorization: `Bearer ${token}`, ...(withBody ? { "content-type": "application/json" } : {}) },
        ...(withBody ? { payload: "{}" } : {}),
      });
      checked++;
      let body: any = null;
      try { body = res.json(); } catch { /* not JSON */ }
      if (!isUnauthenticated(method, res.statusCode, body)) failures.push(`${method} ${url} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    assert.deepEqual(failures, []);
    assert.ok(checked >= 100, `only ${checked} routes were checked`);
    // The anonymous ones judge no credential at all, so a token cannot add to them; they are the known, tested set.
    assert.ok(skipped.every((s) => /\/health|\/metrics|\.well-known|\/v1\/internal\//.test(s)), skipped.join(", "));
  });

  test("the same request without a token gets the same refusal, so the token was judged and not ignored by luck", async () => {
    const withToken = await app.inject({ method: "GET", url: "/v1/remote-agents/sessions", headers: { authorization: `Bearer ${token}` } });
    const without = await app.inject({ method: "GET", url: "/v1/remote-agents/sessions" });
    assert.deepEqual([withToken.statusCode, withToken.json()], [without.statusCode, without.json()]);
  });

  test("the four connector-side routes accept it, and nothing else is true of them", async () => {
    const cid = randomUUID();
    const expected: Record<string, number> = {
      [`POST ${connectorSide.register.url}`]: 400, // a bad body, which is after authentication
      [`POST ${connectorSide.heartbeat.url}`]: 404, // not this user's connector
      [`POST ${connectorSide.events.url}`]: 404,
      [`GET ${connectorSide.commands.url}`]: 404,
    };
    for (const r of Object.values(connectorSide)) {
      const res = await app.inject({
        method: r.method, url: r.url.replace(":cid", cid), headers: { authorization: `Bearer ${token}` },
        ...(r.method === "POST" ? { payload: {} } : {}),
      });
      assert.equal(res.statusCode, expected[`${r.method} ${r.url}`], `${r.method} ${r.url}: ${res.body}`);
      assert.ok(isConnectorSideRoute(r.method, r.url.replace(":cid", cid)));
    }
  });
});
