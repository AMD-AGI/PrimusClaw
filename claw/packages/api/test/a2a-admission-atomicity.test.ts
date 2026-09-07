// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An A2A send writes a session and the run row that references it, or neither.
 *
 * The cluster here meters nothing, which is the configuration the atomicity has
 * to hold under too: whether a ceiling is set decides what the admission lock
 * serialises, and must not decide whether the writes of one send can be split.
 * A send that mints a session and then fails its parent check leaves the caller
 * a session it never learned the id of, holding a slice of every later count.
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
import {
  failNextCommit, startAdmissionCluster, type AdmissionCluster,
} from "./support/admission-cluster.js";

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
  async publish(): Promise<void> { /* the publish is not what these cases are about */ },
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

describe("an unmetered A2A send is still all-or-nothing", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let registry: typeof import("../src/infra/metrics.js")["registry"];

  before(async () => {
    harness = await startAdmissionCluster({});
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

  const countOf = async (sql: string) => Number(
    ((await query(sql)).rows[0] as { n: number }).n,
  );

  const sessions = () => countOf(
    "SELECT COUNT(*)::int AS n FROM claw_sessions WHERE user_id = 'a2a'",
  );
  const runs = () => countOf("SELECT COUNT(*)::int AS n FROM claw_tasks");

  const okCreated = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.startsWith(`${CREATED}{`) && line.includes('outcome="ok"')) {
        return Number(line.slice(line.lastIndexOf(" ") + 1));
      }
    }
    return 0;
  };

  const send = (message: unknown, metadata?: unknown) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0", id: 1, method: "SendMessage",
      params: { message, metadata, configuration: { returnImmediately: true } },
    },
  });

  const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

  test("no ceiling is configured, so nothing here is serialised by one", () => {
    assert.equal(
      harness.app.admission.anyAdmissionCeilingSet(harness.app.admission.envAdmitLimits()),
      false,
      "the case is only the case while the fleet is unmetered",
    );
  });

  test("a send whose parent check refuses it leaves no session and books no creation", async () => {
    await clear();
    const before = okCreated(await registry.metrics());

    const res = await send(
      { messageId: "m-orphan", role: "user", parts: [{ text: "hello" }] },
      { parent_session_id: "a2a-not-a-session" },
    );

    assert.equal(errorOf(res.body), "Failed to create task");
    assert.equal(await sessions(), 0, "the session write is undone by the refusal that follows it");
    assert.equal(await runs(), 0);
    assert.equal(
      okCreated(await registry.metrics()) - before, 0,
      "and a session nothing backs is not counted as created",
    );
  });

  test("a send onto an existing target keeps that target when the parent check refuses", async () => {
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ('a2a-live','live','a2a','claw','input_required','ctx-keep',$1)`,
      [`user:${CALLER.userId}`],
    );

    const res = await send(
      { messageId: "m-existing", role: "user", parts: [{ text: "hello" }], taskId: "a2a-live" },
      { parent_session_id: "a2a-not-a-session" },
    );

    assert.equal(errorOf(res.body), "Failed to create task");
    assert.equal(await runs(), 0, "no counted row is left naming a send that did not happen");
    const row = (await query(
      "SELECT agent_status, context_id FROM claw_sessions WHERE session_id = 'a2a-live'",
    )).rows[0] as { agent_status: string; context_id: string };
    assert.equal(row.agent_status, "input_required", "the send's own write is rolled back with it");
    assert.equal(row.context_id, "ctx-keep");
  });

  test("a commit that fails leaves no run row referencing the session it rolled back", async () => {
    await clear();
    const restore = failNextCommit(harness.app.db.db.pool);
    try {
      const res = await send({ messageId: "m-commit", role: "user", parts: [{ text: "hello" }] });
      assert.equal(errorOf(res.body), "Failed to create task");
    } finally {
      restore();
    }

    assert.equal(await sessions(), 0);
    assert.equal(
      await runs(), 0,
      "the counted row shares the session's transaction, so it cannot outlive it",
    );
  });
});
