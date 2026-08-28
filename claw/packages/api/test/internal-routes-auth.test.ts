// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every `/v1/internal/*` route must authenticate itself.
 *
 * `isAnonymousPath` exempts the whole `/v1/internal/` prefix from the global
 * SaFE middleware, because these are Brain callbacks carrying a per-task token
 * that SaFE would reject. The exemption is only safe because each route under
 * the prefix attaches its own preHandler -- an arrangement held together by
 * convention, with two modules already relying on it through two different
 * auth functions (`internalTaskAuth` in routes/internal-tasks.ts against
 * `claw_tasks.internal_token_hash`, `internalAuth` in routes/admin.ts against
 * `AUTH_INTERNAL_TOKEN`). A third route added without a preHandler would be
 * served to anyone, and no other test would notice: auth-anonymous-paths.test.ts
 * asserts the exemption *exists*, which is the permissive direction.
 *
 * This is the strict direction. It discovers routes rather than listing them,
 * so a new one is covered the day it is written. Discovery uses an `onRoute`
 * hook rather than `app.printRoutes()` because printRoutes renders only methods
 * and paths -- the preHandler chain, which is the thing at issue, is not in it.
 *
 * The lint guards in scripts/ cannot cover this: they match handler text, and
 * `lint-tenant-routes-must-authorize.sh` deliberately skips this prefix since
 * these routes have no session owner to compare a caller against.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { isAnonymousPath } from "../src/auth/middleware.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { registerInternalWorkspaceRoutes } from "../src/routes/internal-workspaces.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";

const REGISTRARS: Array<(app: FastifyInstance) => Promise<void>> = [
  registerInternalTaskRoutes,
  registerAdminRoutes,
  registerInternalWorkspaceRoutes,
  registerInternalRunRoutes,
];

interface DiscoveredRoute {
  method: string;
  url: string;
  preHandlers: number;
}

/** Substitute path params so a discovered route can actually be injected. */
function concreteUrl(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "probe-$1");
}

/**
 * Register every module that owns `/v1/internal/*` on one instance and record
 * what came out. `onRoute` fires synchronously at registration, so the hook has
 * to be installed before the modules run.
 */
async function discoverInternalRoutes(): Promise<{ app: FastifyInstance; routes: DiscoveredRoute[] }> {
  const app = Fastify();
  const routes: DiscoveredRoute[] = [];
  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url.startsWith("/v1/internal/")) return;
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const preHandler = routeOptions.preHandler;
    const preHandlers = preHandler === undefined
      ? 0
      : Array.isArray(preHandler) ? preHandler.length : 1;
    for (const method of methods) routes.push({ method, url: routeOptions.url, preHandlers });
  });
  for (const register of REGISTRARS) await register(app);
  await app.ready();
  return { app, routes };
}

// internalTaskAuth reaches for claw_tasks.internal_token_hash once a token is
// presented. "No such task" is the right answer here: it forces the fallback
// path, which is what the wrong-token case is meant to exercise.
const originalQuery = db.query;
const originalInternalToken = process.env.AUTH_INTERNAL_TOKEN;
after(() => {
  db.query = originalQuery;
  if (originalInternalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalInternalToken;
});

function stubDb(): void {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
}

test("the /v1/internal/ modules register at least the routes we think they do", async () => {
  // A discovery test that discovers nothing passes vacuously, so pin the floor.
  const { app, routes } = await discoverInternalRoutes();
  try {
    const urls = new Set(routes.map((r) => r.url));
    for (const expected of [
      "/v1/internal/tasks/:taskId/agent_done",
      "/v1/internal/tasks/:taskId/event",
      "/v1/internal/tasks/:taskId/backend-mcp",
      "/v1/internal/brain/min-version",
      "/v1/internal/sandbox/status",
      // The lease a run renews to say it is still alive, and the question the
      // collector asks before deleting anyone's files. Both are reachable
      // from outside the cluster if an ingress is ever misconfigured, which
      // is why they are in the floor rather than only in their own tests.
      "/v1/internal/tasks/:taskId/lease",
      "/v1/internal/workspaces/by-session/:sessionId",
      "/v1/internal/tasks/:taskId/claim",
      "/v1/internal/runs/claim-next",
    ]) {
      assert.ok(urls.has(expected), `expected ${expected} to be registered`);
    }
  } finally {
    await app.close();
  }
});

test("every /v1/internal/ route carries its own preHandler", async () => {
  const { app, routes } = await discoverInternalRoutes();
  try {
    const unguarded = routes.filter((r) => r.preHandlers === 0);
    assert.deepEqual(
      unguarded, [],
      "a route under /v1/internal/ has no preHandler, so nothing authenticates it: "
      + "the global SaFE middleware skips the whole prefix via isAnonymousPath",
    );
  } finally {
    await app.close();
  }
});

test("every /v1/internal/ route rejects a request with no credentials", async () => {
  // The structural check above cannot tell an auth preHandler from any other
  // one. This is the behavioural half: what an unauthenticated client receives.
  stubDb();
  process.env.AUTH_INTERNAL_TOKEN = "test-internal-token-value";
  const { app, routes } = await discoverInternalRoutes();
  try {
    for (const route of routes) {
      const url = concreteUrl(route.url);
      assert.equal(
        isAnonymousPath(url), true,
        `${url} is expected to skip global auth; if it no longer does, this test is checking the wrong thing`,
      );

      const noHeader = await app.inject({ method: route.method as "GET", url, payload: {} });
      assert.equal(noHeader.statusCode, 401, `${route.method} ${url} without an Authorization header`);

      const wrongToken = await app.inject({
        method: route.method as "GET",
        url,
        headers: { authorization: "Bearer not-the-internal-token" },
        payload: {},
      });
      assert.equal(wrongToken.statusCode, 401, `${route.method} ${url} with a wrong token`);
    }
  } finally {
    await app.close();
  }
});

test("the shared internal token is not accepted when it is unset", async () => {
  // Both auth functions fall back to AUTH_INTERNAL_TOKEN. An empty expected
  // value must not match an empty presented one, or an unconfigured deployment
  // would serve the whole prefix to anyone sending `Authorization: Bearer`.
  stubDb();
  delete process.env.AUTH_INTERNAL_TOKEN;
  const { app, routes } = await discoverInternalRoutes();
  try {
    for (const route of routes) {
      const res = await app.inject({
        method: route.method as "GET",
        url: concreteUrl(route.url),
        headers: { authorization: "Bearer " },
        payload: {},
      });
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} with an empty token`);
    }
  } finally {
    await app.close();
  }
});
