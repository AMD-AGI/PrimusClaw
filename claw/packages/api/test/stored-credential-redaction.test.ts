// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the API writes of a conversation has credential-shaped content masked; what the model is handed for the turn does not.
 *
 * Each write path is driven as production drives it -- the event consumer for session events and conversation turns, the
 * message route for a turn's `UserMessage`, the assistant's inbound record for the words a router turn grounds on -- and the
 * stored rows are read back. The turn's own prompt is read where Brain gets it (the published task), and must be the words as
 * they were written.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { consumeEventDelivery, tombstoneReader } from "../src/events/consumer.js";
import { db } from "../src/infra/db.js";
import { sc } from "../src/infra/nats.js";
import type { UserInfo } from "../src/auth/models.js";
import { recordAssistantMessage } from "../src/assistant/inbound.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { resetDeletedSessionCache } from "../src/sessions/deleted-cache.js";
import { startHarness, seedRun, seedSession, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

// Assembled from pieces so no scanner reads this file as holding a credential.
const body = (n: number) => "Q7w8E9r0T1y2".repeat(Math.ceil(n / 12)).slice(0, n);
const SAFE_KEY = `ak-${body(38)}-Zq7x`;
const GITHUB = `gh${"p"}_${body(36)}`;
const JWT = `eyJ${body(20)}.eyJ${body(30)}.${body(43)}`;
const PRIVATE_KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", body(60), "-----END OPENSSH PRIVATE KEY-----"].join("\n");
const PASSWORD = "Hunter2xyz";
const URL_PASSWORD = "Pa55w0rdZ";
const BEARER = body(30);
const SECRETS = [SAFE_KEY, GITHUB, JWT, body(60), PASSWORD, URL_PASSWORD, BEARER];
const WITH_SECRETS = [
  `use ${SAFE_KEY} and ${GITHUB}`,
  `jwt ${JWT}`,
  PRIVATE_KEY,
  `password=${PASSWORD}`,
  `postgres://app:${URL_PASSWORD}@db:5432/claw`,
  `Authorization: Bearer ${BEARER}`,
].join("\n");
const ORDINARY = "review AMD-AGI/PrimusClaw#325: const password = getPassword(); max_tokens=4096 -- 请看一下密码策略";

const SESSION = "stored-redaction";
const MESSAGE = "message-1";
const OWNER: UserInfo = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1" };
const originalConnect = db.lockPool.connect;
const originalPoolConnect = db.pool.connect;
const originalTombstone = tombstoneReader.has;
let h: Harness;
let nextSequence = 1;

function noSecretIn(stored: unknown, where: string): void {
  const text = typeof stored === "string" ? stored : JSON.stringify(stored);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${where} stored ${JSON.stringify(secret)}`);
  assert.ok(text.includes("<redacted"), `${where} holds no mask, so it never held the credentials this test sent`);
}

/** An advisory lock that is always free, held per id: the completion path takes one, and PGlite has none to give. */
function stubLockPool(): void {
  const held = new Set<number>();
  db.lockPool.connect = (async () => ({
    async query(sql: string, params: unknown[] = []) {
      const id = params[0] as number;
      if (sql.includes("pg_try_advisory_lock")) {
        if (held.has(id)) return { rows: [{ ok: false }] };
        held.add(id);
        return { rows: [{ ok: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: held.delete(id) }] };
      throw new Error(`Unexpected lock query: ${sql}`);
    },
    release() {},
  })) as unknown as typeof db.lockPool.connect;
}

before(async () => {
  h = await startHarness();
});

beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.reset();
  nextSequence = 1;
  stubLockPool();
  tombstoneReader.has = async () => false;
  resetDeletedSessionCache();
});

after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.sql("SELECT 1");
  await h.close();
  db.lockPool.connect = originalConnect;
  db.pool.connect = originalPoolConnect;
  tombstoneReader.has = originalTombstone;
  resetDeletedSessionCache();
});

async function deliver(event: Record<string, unknown>): Promise<void> {
  let acks = 0;
  const naks: Array<number | undefined> = [];
  await consumeEventDelivery({
    subject: `events.${SESSION}`, data: sc.encode(JSON.stringify(event)), seq: nextSequence++,
    ack: () => { acks++; }, nak: (delay) => { naks.push(delay); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.sql("SELECT 1");
  assert.deepEqual({ acks, naks }, { acks: 1, naks: [] }, `${String(event.type)} was not consumed`);
}

test("session events and conversation turns are stored masked; an ordinary event is stored as it came", async () => {
  await seedSession(h, SESSION);
  await seedRun(h, "run-1", SESSION, { status: "running", messageId: MESSAGE });
  await h.sql("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", ["run-1", `deploy with ${WITH_SECRETS}`]);

  const ordinary = { type: "assistantText", message_id: MESSAGE, text: ORDINARY, seq: 3, tokens: 12 };
  await deliver(ordinary);
  await deliver({ type: "toolUsed", message_id: MESSAGE, actionId: "a-1", tool: "run_command", status: "start", input: { command: `echo ${WITH_SECRETS}` } });
  await deliver({ type: "toolUsed", message_id: MESSAGE, actionId: "a-1", tool: "run_command", status: "success", output: WITH_SECRETS });
  await deliver({
    type: "exec_complete", session_id: SESSION, task_id: "run-1", user_id: "u-1", message_id: MESSAGE,
    prompt: `deploy with ${WITH_SECRETS}`, final_text: `done, I used ${WITH_SECRETS}`, failed: false, error_count: 0, skills_used: {},
  });

  const events = await h.sql("SELECT event, data FROM claw_session_events WHERE session_id = $1 ORDER BY id", [SESSION]);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0].data, ordinary, "an event with no credential in it is stored exactly as it came");
  for (const e of events.slice(1)) noSecretIn(e.data, `claw_session_events ${e.event}`);
  // Routing fields are kept: the completion and the turn's tools are still found by them.
  assert.deepEqual(events.slice(1).map((e) => [e.data.type, e.data.message_id]), [
    ["toolUsed", MESSAGE], ["toolUsed", MESSAGE], ["exec_complete", MESSAGE],
  ]);

  const turns = await h.sql(
    "SELECT role, content, tool_calls, tool_results FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index", [SESSION],
  );
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  noSecretIn(turns[0].content, "the user's turn");
  assert.ok(turns[0].content.startsWith("deploy with use <redacted> and <redacted>"));
  noSecretIn(turns[1].content, "the assistant's turn");
  noSecretIn(turns[1].tool_calls, "the turn's tool calls");
  noSecretIn(turns[1].tool_results, "the turn's tool results");
});

test("a message's turn reaches Brain as written, and its stored UserMessage is masked", async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const ports = { ...sessionDispatchPorts };
  const published: string[] = [];
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => { published.push(payload); return 1; };
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
  const app: FastifyInstance = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerSessionRoutes(app);
  await app.ready();
  try {
    const content = `please deploy: ${WITH_SECRETS}`;
    const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s", message: { content } } });
    assert.ok(res.statusCode < 300, `create answered ${res.statusCode}: ${res.body}`);

    assert.equal(published.length, 1, "the turn was published to Brain");
    assert.equal(JSON.parse(published[0]!).prompt, content, "the turn's prompt is the message as the user wrote it");

    const stored = await h.sql("SELECT data FROM claw_session_events WHERE event = 'UserMessage'");
    assert.equal(stored.length, 1);
    noSecretIn(stored[0].data, "the stored UserMessage");
    assert.equal(stored[0].data.data.content[0].text.startsWith("please deploy: use <redacted> and <redacted>"), true);
  } finally {
    Object.assign(sessionDispatchPorts, ports);
    db.pool.connect = originalPoolConnect;
    await app.close();
  }
});

test("the words an assistant's router turn answers are stored masked, and ordinary words as they are", async () => {
  const written: unknown[][] = [];
  const tx = { query: async (_sql: string, params: unknown[]) => { written.push(params); return { rowCount: 0, rows: [] }; } } as unknown as PoolClient;
  const ordinaryContext = {
    channel: "teams", people: [{ user_id: "u-2", name: "Wei Lei" }],
    actions: [{ name: "deploy", usage: "/deploy <env>", summary: "Deploy a release" }], repos: ["AMD-AGI/PrimusClaw"], handoffs: [],
  };
  const record = (content: string, context: Record<string, unknown> = ordinaryContext) => recordAssistantMessage(tx, {
    sessionId: SESSION, messageId: MESSAGE, userId: "u-1", content, attendedVia: { kind: "person" }, context: context as never,
  });
  await record(`log in with ${WITH_SECRETS}`, {
    ...ordinaryContext, actions: [{ name: "deploy", usage: `/deploy --key ${SAFE_KEY}`, summary: WITH_SECRETS }],
  });
  noSecretIn(written[0]![3], "claw_assistant_messages.content");
  noSecretIn(written[0]![5], "claw_assistant_messages.channel_context");
  await record(ORDINARY);
  assert.equal(written[1]![3], ORDINARY);
  assert.deepEqual(JSON.parse(written[1]![5] as string), ordinaryContext, "an ordinary context is stored as it came");
});
