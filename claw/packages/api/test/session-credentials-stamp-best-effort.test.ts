// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a failed credential stamp costs the user's turn.
 *
 * The stamp records the caller's SaFE key on the session row so a *later*
 * reader -- `platform-backfill`, which authenticates the terminal facts read --
 * can find it once the request that made the run is long gone. The run itself
 * does not depend on it: `dispatchTaskToBrain` puts `platform_key` straight on
 * the task, Brain creates the workload with that, and the workload is owned by
 * its submitter whether or not the UPDATE landed. So a stamp that fails is a
 * degraded diagnostic on that one run, not a turn that must not execute.
 *
 * It was a refusal all the same: the stamp threw, the throw reached the
 * dispatcher's catch, and the catch rolls the turn back -- 503 on a message,
 * and a deleted session on a create. These assert at the HTTP boundary because
 * that is where the cost was paid, and on the row the turn leaves behind
 * because "accepted" is a claim about the conversation, not about a return
 * value.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";

process.env.CLAW_DEPLOY_MODE = "safe";

const { db } = await import("../src/infra/db.js");
const { registerSessionRoutes } = await import("../src/routes/sessions.js");
const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
const { startHarness, seedSession } = await import("./scenario-harness.js");
const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
const { readTrustedSessionCredentials } = await import("../src/auth/session-credentials.js");
import type { UserInfo } from "../src/auth/models.js";
import type { Harness } from "./scenario-harness.js";

/** Distinctive enough that its appearance anywhere in a log line is unambiguous. */
const PLATFORM_KEY = "pk-stamp-best-effort-7f3a";
const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"],
  platformKey: PLATFORM_KEY, virtualKey: "vk-u-1",
};

let h: Harness;
let originalQuery: typeof db.query;
let originalConnect: typeof db.pool.connect;
let pristinePorts: Record<string, unknown>;

before(async () => {
  h = await startHarness();
  originalQuery = db.query;
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  // The message route flips the gate in a transaction on its own connection,
  // which a `db.query` substitution never sees.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});

beforeEach(async () => {
  db.query = originalQuery;
  Object.assign(sessionDispatchPorts, pristinePorts);
  await h.reset();
  await h.sql("ALTER TABLE claw_sessions DROP CONSTRAINT IF EXISTS reject_credentials");
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => 1;
});

after(async () => {
  db.query = originalQuery;
  Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect;
  await h?.close();
});

async function appWithRoutes(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

/** A connection that dropped under the one UPDATE the stamp issues. */
function breakStampTransiently(): { attempts: () => number } {
  const inner = db.query;
  let attempts = 0;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/UPDATE claw_sessions\s+SET config/.test(text)) {
      attempts++;
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    }
    return await inner(text, params);
  }) as typeof db.query;
  return { attempts: () => attempts };
}

/**
 * The same bytes the process was about to write to fd 1.
 *
 * pino here is a module-private instance writing to a fd, so there is no object
 * to swap; borrowing the sink underneath keeps the real serializers on the path
 * and reads the real line. Swallowed rather than forwarded so the captured
 * lines do not also land in the test output.
 */
async function captureLogLines(run: () => Promise<unknown>, waitFor: string): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = fs.write as unknown as (...args: unknown[]) => unknown;
  const realWriteSync = fs.writeSync as unknown as (...args: unknown[]) => unknown;
  const take = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) if (line) lines.push(line);
  };
  fs.write = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWrite(fd, chunk, ...rest);
    take(chunk);
    // A short count reads as a partial write and the sink reissues the rest.
    const done = rest[rest.length - 1];
    if (typeof done === "function") done(null, Buffer.byteLength(String(chunk)), chunk);
    return undefined;
  }) as unknown as typeof fs.write;
  fs.writeSync = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWriteSync(fd, chunk, ...rest);
    take(chunk);
    return Buffer.byteLength(String(chunk));
  }) as unknown as typeof fs.writeSync;
  try {
    await run();
    const wanted = `"msg":${JSON.stringify(waitFor)}`;
    for (let i = 0; i < 500 && !lines.some((line) => line.includes(wanted)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    fs.write = realWrite as unknown as typeof fs.write;
    fs.writeSync = realWriteSync as unknown as typeof fs.writeSync;
  }
  return lines;
}

test("a dropped connection under the credential stamp does not refuse the chat turn", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const broken = breakStampTransiently();
  const app = await appWithRoutes();
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "hello" },
    });

    assert.equal(broken.attempts(), 1, "the stamp really was the statement that failed");
    assert.equal(res.statusCode, 200, "the turn is accepted, not answered 503");
    assert.equal(res.json().accepted, true);
    assert.equal(
      Number((await h.sql(
        "SELECT count(*)::int AS n FROM claw_session_events WHERE session_id = 's1' AND event = 'UserMessage'",
      ))[0].n),
      1,
      "and the user's message is in the transcript the run will answer",
    );
    const session = (await h.sql(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = 's1'",
    ))[0];
    assert.equal(session.agent_status, "running", "the gate was not handed back under a live turn");
    assert.equal(session.agent_gate_message_id, res.json().message_id);
    const run = (await h.sql("SELECT status FROM claw_tasks"))[0];
    assert.equal(run.status, "preparing", "and a run row exists for the turn that was published");
  } finally {
    await app.close();
  }
});

test("a create whose credential stamp fails still returns a session the user can talk in", async () => {
  breakStampTransiently();
  const app = await appWithRoutes();
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions", payload: { name: "s", message: { content: "hello" } },
    });

    assert.equal(res.statusCode, 200, "the session the create minted was not deleted under a 503");
    const rows = await h.sql("SELECT session_id, agent_status FROM claw_sessions");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, res.json().data.session_id);
    assert.equal(rows[0].agent_status, "running");
    assert.equal(res.json().data.message.dispatched, true);
  } finally {
    await app.close();
  }
});

test("the failed stamp is reported, and reports no credential", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  // A real Postgres refusal, so the error object carries the `detail` a driver
  // builds from the failing row -- which is the config row, credentials and
  // all. Any per-statement failure would do for the branch; only this one can
  // show what logging the raw error would have leaked.
  await h.sql(`ALTER TABLE claw_sessions ADD CONSTRAINT reject_credentials
    CHECK (config->>'platform_key' IS DISTINCT FROM '${PLATFORM_KEY}')`);
  const app = await appWithRoutes();
  let status = 0;
  try {
    const lines = await captureLogLines(async () => {
      const res = await app.inject({
        method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "hello" },
      });
      status = res.statusCode;
    }, "session.credentials_stamp_failed");

    assert.equal(status, 200, "still accepted");
    // Filtered by session, not merely counted: pino's sink batches, so a line
    // an earlier case in this file logged can be handed over during this one.
    const stamped = lines.filter((l) =>
      l.includes('"msg":"session.credentials_stamp_failed"') && l.includes('"sessionId":"s1"'));
    assert.equal(stamped.length, 1, "the turn that ran unstamped says so exactly once");
    assert.match(stamped[0], /"userId":"u-1"/, "naming who the row is now stale for");
    assert.match(stamped[0], /"code":"23514"/, "and the driver's class of failure, which is not the row");
    for (const line of lines) {
      assert.equal(line.includes(PLATFORM_KEY), false, `credential leaked into: ${line.slice(0, 300)}`);
    }
    // Nothing was stamped, and nothing pretends otherwise: a later reader sees
    // no server-managed key rather than a stale or half-written one.
    const [row] = await h.sql("SELECT config FROM claw_sessions WHERE session_id = 's1'");
    assert.equal(readTrustedSessionCredentials(row.config).platformKey, "");
  } finally {
    await app.close();
  }
});
