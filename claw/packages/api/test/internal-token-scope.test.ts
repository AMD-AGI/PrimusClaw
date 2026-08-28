// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a run's own token may do with it, as opposed to what it was issued for.
 *
 * A chat run is handed a token so it can renew its lease, and the chat path
 * withholds `callback_url` because the endpoints that URL names move rows
 * between states, wake the scheduler, and resolve a session's `user_id` /
 * `workspace_id` to open the backend tool surface. Withholding the address was
 * never withholding the authorization: all four routes under
 * `/v1/internal/tasks/:taskId/` verify against the same
 * `claw_tasks.internal_token_hash`, and the other three URLs differ from the
 * lease one by a path segment.
 *
 * What the routes now ask for, and what these pin:
 *
 *   1. The lease route accepts a row's token whatever kind of row it is; a run
 *      that cannot say it is alive is a run that gets reaped.
 *   2. The acting routes accept it only from a row dispatched with a
 *      `callback_url` -- the fact that already distinguishes a run meant to use
 *      them from a chat run's shadow record.
 *   3. The `AUTH_INTERNAL_TOKEN` fallback is untouched by the scope: it belongs
 *      to an operator rather than to a run.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";

/** The secret a row's `internal_token_hash` is the sha256 of. */
const ROW_TOKEN = "b".repeat(64);
const CLUSTER_TOKEN = "cluster-internal-token";

const originalQuery = db.query;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

after(async () => {
  db.query = originalQuery;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

/**
 * A database holding one row with `ROW_TOKEN`'s hash on it. Everything past the
 * auth lookup answers empty, which each handler treats as a task it cannot find
 * -- enough to tell a 401 from a request that got through.
 */
function stubRow(callbackUrl: string | null): void {
  db.query = (async (text: string) => {
    if (text.replace(/\s+/g, " ").includes("SELECT internal_token_hash")) {
      return {
        rows: [{
          internal_token_hash: createHash("sha256").update(ROW_TOKEN).digest("hex"),
          callback_url: callbackUrl,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

const ACTING_ROUTES = ["agent_done", "event", "backend-mcp"] as const;

async function post(route: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/v1/internal/tasks/ktsk_1/${route}`,
    headers: { authorization: `Bearer ${token}` },
    payload: route === "backend-mcp" ? { jsonrpc: "2.0", id: 1, method: "tools/list" } : {},
  });
}

test("a chat run's token renews the lease it was issued for", async () => {
  delete process.env.AUTH_INTERNAL_TOKEN;
  stubRow(null);

  const res = await post("lease", ROW_TOKEN);
  assert.notEqual(res.statusCode, 401,
    "a run that cannot renew its lease is reaped, chat row or not");
});

test("a chat run's token is refused by the endpoints that act on rows", async () => {
  // The capability this closes is new to the branch that gave chat rows a token
  // at all: before it there was no hash on these rows for the preHandler to
  // match, so the whole surface was out of reach by accident rather than by rule.
  delete process.env.AUTH_INTERNAL_TOKEN;
  stubRow(null);

  for (const route of ACTING_ROUTES) {
    const res = await post(route, ROW_TOKEN);
    assert.equal(res.statusCode, 401,
      `${route} accepted a token issued for lease renewal alone`);
  }
});

test("a dispatched row's token still reaches all four", async () => {
  // The one thing this must not do. Brain reports its running status, its final
  // outcome and its backend tool calls with the token the dispatcher issued, and
  // every dispatched row carries the `callback_url` that names those endpoints --
  // written at insert by the DAG expander and rewritten onto retry copies.
  delete process.env.AUTH_INTERNAL_TOKEN;
  stubRow("http://api.internal/v1/internal/tasks/ktsk_1");

  for (const route of [...ACTING_ROUTES, "lease"]) {
    const res = await post(route, ROW_TOKEN);
    assert.notEqual(res.statusCode, 401, `${route} refused the token it was dispatched with`);
  }
});

test("the scope does not narrow the operator's token", async () => {
  // It authenticates an admin or a seed script rather than a run, so it has no
  // task scope to exceed; making it depend on a column of the row in the path
  // would break the callers that have no task context at all.
  process.env.AUTH_INTERNAL_TOKEN = CLUSTER_TOKEN;
  stubRow(null);

  for (const route of [...ACTING_ROUTES, "lease"]) {
    const res = await post(route, CLUSTER_TOKEN);
    assert.notEqual(res.statusCode, 401, `${route} refused the cluster-wide token`);
  }
});

test("a token that is neither is still refused everywhere", async () => {
  process.env.AUTH_INTERNAL_TOKEN = CLUSTER_TOKEN;
  stubRow("http://api.internal/v1/internal/tasks/ktsk_1");

  for (const route of [...ACTING_ROUTES, "lease"]) {
    const res = await post(route, "not-either-token");
    assert.equal(res.statusCode, 401, `${route} accepted a token nothing issued`);
  }
});
