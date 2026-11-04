// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_AGENT_GUIDELINE_ENABLED` on, an A2A run carries the working guideline like a chat turn does.
 *
 * A2A publishes `tasks.execute` itself rather than through `applySessionRoleToTask`, so without its own call the
 * sub-agent and team-member turns it starts ran without the guideline, and an A/B with the flag on measured a mix.
 *
 *   G1 a SendMessage run carries the guideline as its system text
 *   G2 a legacy `/invoke` run carries it too
 *
 * The NATS seam is the one `a2a-plugin-tools.test.ts` uses; it must be registered before `routes/a2a.ts` loads.
 */

process.env.CLAW_AGENT_GUIDELINE_ENABLED = "true";

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

const published: Array<{ subject: string; payload: string }> = [];

export const js = {
  async publish(subject: string, payload: Uint8Array): Promise<void> {
    published.push({ subject, payload: new TextDecoder().decode(payload) });
  },
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

const CALLER = { userId: "u-caller", userName: "u-caller", roles: ["user"], platformKey: "pk", virtualKey: "vk" };

function onlyExecuteRequest(body: string): Record<string, unknown> {
  const tasks = published.filter((m) => m.subject === "tasks.execute");
  assert.equal(tasks.length, 1, `expected one execute request, got ${tasks.length}: ${body.slice(0, 200)}`);
  return JSON.parse(tasks[0]!.payload) as Record<string, unknown>;
}

describe("an A2A run carries the working guideline when it is on", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let guideline: string;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "50" });
    const a2a = await import("../src/routes/a2a.js");
    guideline = (await import("../src/sessions/agent-guideline.js")).AGENT_GUIDELINE;
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  test("G1 a SendMessage run carries the guideline as its system text", async () => {
    published.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/a2a",
      headers: { "a2a-version": "1.0" },
      payload: {
        jsonrpc: "2.0", id: 1, method: "SendMessage",
        params: {
          message: { messageId: "m-guideline-1", role: "user", parts: [{ text: "ls /tmp" }] },
          configuration: { returnImmediately: true },
        },
      },
    });
    assert.ok(res.statusCode < 500, `the send failed: ${res.statusCode} ${res.body.slice(0, 200)}`);
    assert.equal(onlyExecuteRequest(res.body).system_append, guideline);
  });

  test("G2 a legacy /invoke run carries it too", async () => {
    published.length = 0;
    const res = await app.inject({ method: "POST", url: "/invoke", payload: { question: "hello" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(onlyExecuteRequest(res.body).system_append, guideline);
  });
});
