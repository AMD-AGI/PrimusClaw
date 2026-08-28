// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the two delete endpoints answer, now that a 200 means something else.
 *
 * The deletion used to be finished by the time it replied, so a step that failed
 * was a step the response could report. It is now a commit and a cleanup: past
 * the commit the session is gone to every reader and the rest is recorded on the
 * row for the sweeper, so "accepted and guaranteed" is what a 200 says. Both
 * halves of that are worth pinning at the HTTP boundary rather than at
 * `teardownSession`'s return value, because it is the boundary that a client and
 * a compliance answer are written against:
 *
 *   - a cleanup that could not finish is still a 200, since a caller told to
 *     retry would be retrying a session that answers 404 -- and the sweeper owns
 *     it either way;
 *   - a commit that did not land is a 503 and not a 500, since that one *is*
 *     theirs to retry.
 *
 * Both endpoints, because the reason this module exists at all is that they used
 * to disagree about deletion, and a response is the one part of the disagreement
 * a client could see.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerAnthropicManagedAgentsRoutes } from "../src/routes/anthropic-managed-agents.js";
import { teardownPorts } from "../src/sessions/teardown.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const SID = "sess-owned";
const OWNER: UserInfo = {
  userId: "u-owner",
  userName: "u-owner",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk-u-owner",
};

const originalPorts = { ...teardownPorts };
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(teardownPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
});

/** Every step of the cleanup succeeding, so a test can fail exactly one. */
function healthyPorts(): void {
  teardownPorts.writeTombstones = async () => "written";
  teardownPorts.notifyCleanup = () => true;
  teardownPorts.parkHands = async () => "parked";
  teardownPorts.purgeSessionEvents = async () => {};
  teardownPorts.deleteGateLocks = async () => true;
  teardownPorts.deleteWorkspaceObjects = async () => ({ deleted: 1, failed: 0, complete: true });
  teardownPorts.releaseWorkspaceRefs = async () => "released";
}

/** The session exists and belongs to OWNER; everything else answers nothing. */
function sessionOwnedByCaller(extra?: Answer): void {
  dbStub = stubDb((sql, params) => {
    if (/FROM claw_sessions WHERE session_id = \$1/.test(sql)) {
      return [{ session_id: SID, user_id: OWNER.userId }];
    }
    return extra?.(sql, params) ?? [];
  });
}

/**
 * A server that acts as OWNER, as src/index.ts does with one global preHandler:
 * the routes never authenticate themselves, so a stub hook is the whole harness.
 */
async function appWith(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await register(app);
  await app.ready();
  return app;
}

const ENDPOINTS = [
  { name: "the standard endpoint", url: `/v1/sessions/${SID}`, register: registerSessionRoutes },
  {
    name: "the Anthropic-compatible endpoint",
    url: `/anthropic/v1/sessions/${SID}`,
    register: registerAnthropicManagedAgentsRoutes,
  },
];

for (const endpoint of ENDPOINTS) {
  test(`${endpoint.name} reports a delete whose cleanup was deferred as done`, async () => {
    healthyPorts();
    teardownPorts.deleteWorkspaceObjects = async () => { throw new Error("connect ECONNREFUSED"); };
    sessionOwnedByCaller();
    const app = await appWith(endpoint.register);

    try {
      const res = await app.inject({ method: "DELETE", url: endpoint.url });

      assert.equal(res.statusCode, 200,
        "the session is gone to every reader, whatever is left of the cleanup");
      assert.ok(dbStub!.ran(/cleanup_next_at = NOW\(\) \+ \(\s*LEAST/),
        "and what is left is written down, or nothing comes back for it");
      assert.equal(res.body.includes("workspace_objects"), false,
        "the labels are the sweeper's business, not a client's");
    } finally {
      await app.close();
    }
  });

  test(`${endpoint.name} answers a commit that did not land with a retryable 503`, async () => {
    healthyPorts();
    sessionOwnedByCaller((sql) => {
      if (/UPDATE claw_sessions SET deleted_at/.test(sql)) {
        throw new Error("terminating connection due to administrator command");
      }
    });
    const app = await appWith(endpoint.register);

    try {
      const res = await app.inject({ method: "DELETE", url: endpoint.url });

      assert.equal(res.statusCode, 503,
        "a 500 tells the caller to stop, and this is the one failure that is theirs to retry");
      assert.match(res.body, /Retry the delete/);
    } finally {
      await app.close();
    }
  });
}
