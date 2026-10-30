// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Concurrent sends under the context/task model, in a fleet with no admission
 * ceiling set. That fleet takes no admission lock ("an unmetered fleet
 * serialises no decision"), so what keeps two sends from both starting is the
 * pair of locks the model takes itself: one on the message, for a retry of a
 * send that named no context, and one on the context.
 *
 * Its own file because the admission settings are read once when the modules
 * load; a suite that sets a ceiling (a2a-context-tasks.test.ts) can never see
 * what happens without one.
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
const executes: Array<Record<string, unknown>> = [];
export const js = {
  async publish(_subject: string, data: Uint8Array): Promise<void> { executes.push(JSON.parse(sc.decode(data))); },
};
export const nc = {
  publish(): void { /* nothing listens */ },
  subscribe() {
    return { unsubscribe(): void {}, async *[Symbol.asyncIterator]() { /* no events */ } };
  },
};

const skip = postgresSkipReason();
const ALICE = { userId: "u-alice", userName: "alice", roles: ["default"], platformKey: "pk-a", virtualKey: "vk-a" };

describe("concurrent sends with no admission lock", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let seq = 0;

  before(async () => {
    // No ADMIT_* setting: nothing is metered.
    harness = await startAdmissionCluster({ CLAW_A2A_CONTEXT_TASKS: "1" });
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = ALICE; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);
  const send = async (message: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: ++seq, method: "SendMessage", params: { message, configuration: { returnImmediately: true } } },
    });
    return JSON.parse(res.body);
  };
  const message = (text: string, extra: Record<string, unknown> = {}) =>
    ({ messageId: `m-${++seq}`, role: "ROLE_USER", parts: [{ text }], ...extra });

  test("copies of one message that names no context start one run", async () => {
    const m = message("at once");
    const sends = await Promise.all(Array.from({ length: 6 }, () => send(m)));
    assert.equal(new Set(sends.map((r) => r.result.task.id)).size, 1, JSON.stringify(sends.map((r) => r.error ?? "ok")));
    assert.equal(executes.filter((e) => e.prompt === "at once").length, 1);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE name = 'at once'")).rows[0].n, 1, "in one session");
  });

  test("different messages to one context start one run, and the rest are told it is busy", async () => {
    const sends = await Promise.all(Array.from({ length: 6 }, (_, i) => send(message(`racing ${i}`, { contextId: "ctx-race" }))));
    assert.equal(sends.filter((r) => r.result).length, 1, JSON.stringify(sends.map((r) => r.error?.code ?? "ok")));
    assert.equal(sends.filter((r) => r.error?.code === -32004).length, 5);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE context_id = 'ctx-race'")).rows[0].n, 1, "one session");
    assert.equal(executes.filter((e) => String(e.prompt).startsWith("racing")).length, 1);
  });
});
