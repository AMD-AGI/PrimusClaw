// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Both A2A send paths mint sessions, and both must book the creation.
 *
 * `claw_api_session_created_total` is the rollout's answer to "is anything
 * creating sessions on this pod". A2A writes `claw_sessions` itself rather
 * than calling the standard create, so a counter only that route increments
 * reads as a quiet fleet while these two paths run.
 *
 * The count belongs after the admission transaction commits, not to the
 * statement: a send whose parent check throws rolls the insert back, and a send
 * to a session that already exists writes no row at all. Both are driven, since
 * "counted a session nothing backs" and "counted nothing" are different bugs.
 *
 * The NATS seam is this file's own exports, as in
 * `a2a-publish-failure-classes.test.ts`: `js` and `nc` are module bindings
 * `initNats` assigns, so a resolve hook points `routes/a2a.ts` here instead.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const A2A_MODULE = new URL("../src/routes/a2a.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();

export const js = {
  async publish(): Promise<void> { /* the send succeeds; the count is the subject */ },
};

export const nc = {
  subscribe(_subject: string) {
    return {
      unsubscribe(): void { /* nothing to release */ },
      async *[Symbol.asyncIterator]() { /* no events on this connection */ },
    };
  },
};

const skip = postgresSkipReason();
const CREATED = "claw_api_session_created_total";
const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
const EXISTING = "a2a-existing";

describe("every A2A send that mints a session books the creation", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let registry: typeof import("../src/infra/metrics.js")["registry"];

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "8" });
    registry = (await import("../src/infra/metrics.js")).registry;
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  const clear = async () => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_workspace_refs");
    await query("DELETE FROM claw_sessions WHERE user_id = 'a2a'");
  };

  const sessionCount = async () => Number(
    ((await query("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE user_id = 'a2a'"))
      .rows[0] as { n: number }).n,
  );

  const okCreated = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.startsWith(`${CREATED}{`) && line.includes('outcome="ok"')) {
        return Number(line.slice(line.lastIndexOf(" ") + 1));
      }
    }
    return 0;
  };

  async function moved(act: () => Promise<{ statusCode: number; body: string }>) {
    const before = okCreated(await registry.metrics());
    const res = await act();
    return { ok: okCreated(await registry.metrics()) - before, res };
  }

  const send = (message: unknown) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0", id: 1, method: "SendMessage",
      params: { message, configuration: { returnImmediately: true } },
    },
  });

  test("message/send that mints a new task session books one creation", async () => {
    await clear();
    const { ok, res } = await moved(() => send({
      messageId: "m-new", role: "user", parts: [{ text: "hello" }],
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(await sessionCount(), 1, "the send minted exactly one session");
    assert.equal(ok, 1);
  });

  test("message/send onto a session that already exists books nothing", async () => {
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ($1,'existing','a2a','claw','input_required','ctx-keep',$2)`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    const { ok, res } = await moved(() => send({
      messageId: "m-existing", role: "user", parts: [{ text: "hello" }], taskId: EXISTING,
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(await sessionCount(), 1, "the send reused the session it was given");
    assert.equal(ok, 0);
  });

  test("legacy invoke books the creation for the session it mints", async () => {
    await clear();
    const { ok, res } = await moved(() => app.inject({
      method: "POST", url: "/invoke", payload: { question: "hello" },
    }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await sessionCount(), 1);
    assert.equal(ok, 1);
  });
});
