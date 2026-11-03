// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The answer to a question the model asked (`ask_user_question`) through the
 * user API: `POST /v1/sessions/:id/messages` with `messageType: "answer"`.
 * Brain waits for `{type: "answer", action_id}` on `decision.<sessionId>`
 * (delivery/decision-dispatcher.ts); this drives the real route against a real
 * PostgreSQL engine (PGlite) and reads what reaches that subject.
 *
 * `nc` is a module binding `initNats` assigns, so a resolve hook points
 * `routes/sessions.ts` at this module's exports, before that module loads.
 *
 *   Q1 the session's owner answers: one `answer` message, with the answers, on the session's subject
 *   Q2 somebody else's session: refused, nothing published
 *   Q3 a malformed answer is a 400, never a message Brain would read as an answer
 *   Q4 an approval on the same route is still a `decision`
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, beforeEach } from "node:test";

import type { FastifyInstance } from "fastify";
import { StringCodec } from "nats";

const SESSIONS_MODULE = new URL("../src/routes/sessions.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === SESSIONS_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();
export const kv = {};
const published: Array<{ subject: string; payload: Record<string, unknown> }> = [];
export const nc = {
  publish(subject: string, data: Uint8Array): void {
    published.push({ subject, payload: JSON.parse(sc.decode(data)) as Record<string, unknown> });
  },
};

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let appAs: (userId: string) => Promise<FastifyInstance>;

before(async () => {
  h = await (await import("./scenario-harness.js")).startHarness();
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  appAs = async (userId) => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { userId, userName: userId, roles: ["default"], platformKey: "pk", virtualKey: "vk" };
      (req as unknown as { authMethod: string }).authMethod = "identity_token";
    });
    await registerSessionRoutes(app);
    await app.ready();
    return app;
  };
});

beforeEach(async () => {
  await h.reset();
  published.length = 0;
  await h.sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ('s-answer', 'u-alice')");
});

after(async () => { await h?.close(); });

const post = async (userId: string, payload: Record<string, unknown>) => {
  const app = await appAs(userId);
  try {
    const res = await app.inject({ method: "POST", url: "/v1/sessions/s-answer/messages", payload });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  } finally {
    await app.close();
  }
};

test("Q1 the owner's answer reaches Brain's dispatcher as an answer to that question", async () => {
  const r = await post("u-alice", {
    messageType: "answer",
    extData: { tool_use_id: "toolu_q1", answers: { db: "PostgreSQL", why: "already deployed" }, skipped: ["size"] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, session_id: "s-answer", action_id: "toolu_q1" });
  assert.deepEqual(published, [{
    subject: "decision.s-answer",
    payload: {
      type: "answer", session_id: "s-answer", user_id: "u-alice", action_id: "toolu_q1",
      answers: { db: "PostgreSQL", why: "already deployed" }, skipped: ["size"],
    },
  }]);
});

test("Q2 an answer in somebody else's session is refused and nothing is published", async () => {
  const r = await post("u-mallory", { messageType: "answer", extData: { tool_use_id: "toolu_q1", answers: { db: "x" } } });
  assert.equal(r.status, 403);
  assert.equal(published.length, 0);
});

test("Q3 a malformed answer is refused and nothing is published", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no id", { answers: { db: "x" } }],
    ["answers is a list", { tool_use_id: "t", answers: ["x"] }],
    ["answers is text", { tool_use_id: "t", answers: "x" }],
    ["skipped holds a number", { tool_use_id: "t", answers: {}, skipped: [1] }],
  ];
  for (const [what, extData] of cases) {
    const r = await post("u-alice", { messageType: "answer", extData });
    assert.equal(r.status, 400, what);
  }
  assert.equal(published.length, 0);
});

test("Q4 an approval on the same route is still a decision", async () => {
  const r = await post("u-alice", { messageType: "decision", extData: { tool_use_id: "toolu_h1", action: "allow" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(published.length, 1);
  assert.equal(published[0]!.payload.type, "decision");
  assert.equal(published[0]!.payload.decision, "allow");
});
