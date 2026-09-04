// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which run a caller is told it just started.
 *
 * `/v1/runs` answers to a run id, and until now nothing that starts a run handed
 * one back. A dispatcher above Claw got a session id and a message id, neither of
 * which names a row: a session owns many runs -- a turn per message, a root plus
 * a node per DAG, a clone per retry -- so "look it up by session" returns the
 * whole history and leaves the caller guessing which entry is its own. The guess
 * is the part that matters, because the field it is guessing at is `kill_reason`,
 * and reading a nested node's `oom` as the dispatch's own is worse than having
 * no answer.
 *
 * These are the two native entry points that open a row, asserted at the HTTP
 * boundary rather than at the dispatch helper, because the wire shape is the
 * contract and a handler can drop a field the helper returned.
 *
 * The queued case is here for the opposite reason: it must keep answering
 * without a run id. A message that arrives while the session is busy is written
 * to `claw_pending_messages`, and the row is opened later by the drain -- an id
 * minted at accept time would 404 until then, and would name nothing at all if
 * the replay is later refused a workspace or its admission.
 *
 * Coverage:
 *   N1 creating a session without a message names no run
 *   N2 creating a session with a first message names the run it opened
 *   N3 a message dispatched immediately names the run it opened
 *   N4 a message queued behind a running turn names no run
 *   N5 an idempotent replay names the same run, not a second one
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const SID = "sess-1";
const CALLER: UserInfo = {
  userId: "u-caller",
  userName: "u-caller",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk-caller",
};

/** The run row the stubbed dispatch opens, and what the response must name. */
const OPENED_RUN = "ktsk_opened";

const originalPorts = { ...sessionDispatchPorts };
const originalLockConnect = db.lockPool.connect;
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(sessionDispatchPorts, originalPorts);
  db.lockPool.connect = originalLockConnect;
  dbStub?.restore();
  dbStub = null;
});

/** The workspace lookup a turn is bound on, already answered. */
const BIND_LOOKUP = /FROM claw_workspace_refs r/;

function boundWorkspace() {
  return [{
    workspace_id: "kws_1",
    owner_user_id: CALLER.userId,
    storage_prefix: `users/${CALLER.userId}/sessions/${SID}/`,
    version: "0",
    writer_run_id: null,
    retention_expires_at: null,
    deleted_at: null,
  }];
}

/**
 * A database that lets a dispatch run to completion.
 *
 * Everything answers empty except the workspace binding, which has to succeed
 * or the turn is refused before a row is opened, and the session lock, which
 * decides the immediate-vs-queued branch these tests are about.
 */
function stubFor(agentStatus: "idle" | "running", extra?: Answer): DbStub {
  dbStub = stubDb((sql, params) => {
    if (BIND_LOOKUP.test(sql)) return boundWorkspace();
    if (/FROM claw_sessions WHERE session_id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) {
      return [{ agent_status: agentStatus, user_id: CALLER.userId }];
    }
    return extra?.(sql, params) ?? [];
  });
  return dbStub;
}

/** A dispatch that opens `OPENED_RUN` and publishes cleanly. */
function dispatchOpensRun(): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = false;
  sessionDispatchPorts.openChatRun =
    (async () => ({ taskId: OPENED_RUN })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => {};
}

/**
 * A server that acts as CALLER, as src/index.ts does with one global
 * preHandler: the routes never authenticate themselves.
 */
async function app(): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = CALLER;
  });
  await registerSessionRoutes(instance);
  await instance.ready();
  return instance;
}

test("N1 creating a session without a message names no run", async () => {
  // Nothing was asked to execute, so there is nothing to name. A run id here
  // would be a handle to a row that does not exist.
  stubFor("idle");
  const server = await app();
  try {
    const res = await server.inject({
      method: "POST", url: "/v1/sessions", payload: { name: "s" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Record<string, unknown> };
    assert.ok(!("run_id" in body.data), "an empty session started no run");
    assert.ok(!("message" in body.data), "and carries no message block");
  } finally {
    await server.close();
  }
});

test("N2 creating a session with a first message names the run it opened", async () => {
  dispatchOpensRun();
  stubFor("idle");
  const server = await app();
  try {
    const res = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { name: "s", message: { content: "summarise the logs" } },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      data: { message: { message_id: string; dispatched: boolean; run_id: string } };
    };
    assert.equal(body.data.message.run_id, OPENED_RUN);
    assert.equal(body.data.message.dispatched, true);
    assert.ok(body.data.message.message_id, "the message id is still reported alongside");
  } finally {
    await server.close();
  }
});

test("N3 a message dispatched immediately names the run it opened", async () => {
  dispatchOpensRun();
  stubFor("idle");
  const server = await app();
  try {
    const res = await server.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/messages`,
      payload: { content: "and again" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { accepted: boolean; run_id: string; session_id: string };
    assert.equal(body.accepted, true);
    assert.equal(body.run_id, OPENED_RUN);
    assert.equal(body.session_id, SID, "the session is still reported, as the container");
  } finally {
    await server.close();
  }
});

test("N4 a message queued behind a running turn names no run", async () => {
  // The row is opened by the drain, after the turn in front of it finishes. An
  // id minted here would answer 404 on /v1/runs until then, and would name
  // nothing at all if the replay is later refused a workspace or its admission.
  dispatchOpensRun();
  const stub = stubFor("running");
  const server = await app();
  try {
    const res = await server.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/messages`,
      payload: { content: "while busy" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.queued, true);
    assert.ok(!("run_id" in body), "no run row exists yet, so none is named");
    assert.ok(
      stub.ran(/INSERT INTO claw_pending_messages/),
      "the message was accepted onto the queue rather than dispatched",
    );
  } finally {
    await server.close();
  }
});

test("N5 an idempotent replay names the same run, not a second one", async () => {
  // The whole response is what gets cached, so this is really asking whether
  // the run id travels with it. A replay that answered a different id -- or
  // dropped it -- would have a retrying client polling a run nobody started.
  dispatchOpensRun();
  const cached = new Map<string, { statusCode: number; response: unknown }>();
  stubFor("idle");

  // The idempotency lock lives on its own pool, so it needs its own stub. The
  // store behind it is a map: read misses first, then hits what save wrote.
  db.lockPool.connect = (async () => ({
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, " ").trim();
      if (/FROM claw_idempotency_keys/.test(sql)) {
        const hit = cached.get(String(params[2]));
        return {
          rows: hit ? [{ status_code: hit.statusCode, response: hit.response }] : [],
          rowCount: hit ? 1 : 0,
        };
      }
      if (/INSERT INTO claw_idempotency_keys/.test(sql)) {
        cached.set(String(params[0]), {
          statusCode: params[3] as number,
          response: JSON.parse(params[4] as string),
        });
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  const server = await app();
  try {
    const send = () => server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "idempotency-key": "retry-me" },
      payload: { name: "s", message: { content: "summarise the logs" } },
    });

    const first = (await send()).json() as { data: { message: { run_id: string } } };
    const replay = (await send()).json() as { data: { message: { run_id: string } } };

    assert.equal(first.data.message.run_id, OPENED_RUN);
    assert.equal(
      replay.data.message.run_id, first.data.message.run_id,
      "a retry must resolve to the run the first call started",
    );
  } finally {
    await server.close();
  }
});
