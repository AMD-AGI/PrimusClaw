// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may start a turn in a session that acts as a user, against the real routes and a real PostgreSQL engine (PGlite).
 *
 * Creating such a session needs the person's own sign-in with the identity provider (github-review-session.test.ts, V5). That is
 * worth nothing if the turns that run in it can be sent with the key a sandbox holds: a model in any ordinary session of the user finds the
 * acting session with `GET /v1/sessions` and writes to it with that key, and the review tools it is then offered approve and merge with the
 * user's GitHub account on their own. So the same credentials are asked of every route that puts work in front of the session's model.
 * (The keys of the session's own sandbox are a different door and are shut differently: such a session's sandbox holds none, A2 and A7.)
 *
 *   A1  a message, queued or immediate: the key, the cookie it signs in to, a connector token, a method nobody listed and no method at all
 *       are 403, and leave nothing behind (no row, no queued message, no turn)
 *   A2  the person's own identity-provider token, and an allowed service's, still send one; a service that is not allowed is refused
 *   A3  a session that does not act as a user is exactly what it was: any credential sends to it
 *   A4  an approval or an answer to a question of the model (four routes), and Stop, which is not asked for
 *   A5  the Anthropic-compatible events route
 *   A6  a task, a batch and a retry (and a hosted application run, which is a task with a mode)
 *   A7  a session whose `acting_as` is not a well-formed id is not offered the tools, is not gated and keeps its sandbox's keys: one reading decides all three
 *   A8  every place in the source that can start a turn is either gated or on a list with the reason it needs no gate; the server's own
 *       queued message (`queueServerMessage`) is one, gated by the proof only the create's credential check makes
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";

// Before anything reads the configuration, which is read when its module loads.
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "t".repeat(40);
process.env.CLAW_GITHUB_REVIEW_MCP_URL = "http://api.internal.example:8200/v1/internal/github-review/mcp";
process.env.RUN_FAT_PREPARING_RECONCILE = "true";

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let seedRun: typeof import("./scenario-harness.js").seedRun;
let db: typeof import("../src/infra/db.js").db;
let published: Record<string, unknown>[] = [];
let originalConnect: unknown;
let pristinePorts: Record<string, unknown> = {};
type Caller = { userId: string; userName: string; delegation?: { actorSub?: string; clientId?: string } };
let appAs: (user: Caller, method?: string | null) => Promise<FastifyInstance>;

const ALICE: Caller = { userId: "u-alice", userName: "Alice A" };
/** Every way a request can have been authenticated that is not an identity-provider token: what a sandbox's key, and what it can sign in to, are. */
const NOT_A_PERSON = ["api_key", "x_api_key", "query_token", "connector_token", "cookie", "something_new", null] as const;

before(async () => {
  const harness = await import("./scenario-harness.js");
  h = await harness.startHarness();
  seedRun = harness.seedRun;
  db = (await import("../src/infra/db.js")).db;
  // The columns of a queued message that the harness's table leaves out (db.ts adds them with ALTERs): the queue path writes them all.
  for (const column of [
    "plugin_id INTEGER", "tool_ids JSONB DEFAULT '[]'::jsonb", "workspace_id TEXT", "platform_key TEXT", "llm_api_key TEXT", "credentials_blob TEXT",
    "image TEXT", "resources JSONB", "timeout INTEGER", "user_env JSONB", "session_env JSONB", "topology JSONB", "tools_allowlist JSONB",
  ]) await h.sql(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS ${column}`);
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
  const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  const { registerAdminRoutes } = await import("../src/routes/admin.js");
  const { registerAnthropicManagedAgentsRoutes } = await import("../src/routes/anthropic-managed-agents.js");
  const { registerTaskRoutes } = await import("../src/routes/tasks.js");
  appAs = async (user, method = "identity_token") => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { ...user, roles: ["default"], platformKey: "pk", virtualKey: "vk" };
      if (method !== null) (req as unknown as { authMethod: string }).authMethod = method;
    });
    await registerSessionRoutes(app);
    await registerAdminRoutes(app);
    await registerAnthropicManagedAgentsRoutes(app);
    await registerTaskRoutes(app);
    await app.ready();
    return app;
  };
  (globalThis as unknown as { __closed: unknown }).__closed = closedDoorbellBarrier;
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = (globalThis as unknown as { __closed: typeof sessionDispatchPorts.doorbellDispatch }).__closed;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect as typeof db.pool.connect;
  await h?.close();
});

type Res = { status: number; body: any };
const send = async (user: Caller, method: string | null, req: { method: "POST" | "GET"; url: string; payload?: unknown }): Promise<Res> => {
  const app = await appAs(user, method);
  try {
    const res = await app.inject(req as never);
    let body: unknown = null;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  } finally {
    await app.close();
  }
};

/** A session as the create route makes it, so that the row is what the create route writes: acting as `actingAs` when one is given. */
const session = async (actingAs: string | null = "u-bob"): Promise<string> => {
  const r = await send(ALICE, "identity_token", { method: "POST", url: "/v1/sessions", payload: { name: "review", config: actingAs === null ? { notify_on_finish: true } : { acting_as: actingAs } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.session_id as string;
};
const REFUSED = { ok: false, error: "interactive_sign_in_required" };
const count = async (table: string): Promise<number> => Number((await h.sql(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n);
/** What a refused request must have left alone: no turn on the wire, no queued message, no run row. */
const untouched = async (): Promise<void> => {
  assert.equal(published.length, 0, "nothing was published");
  assert.equal(await count("claw_pending_messages"), 0, "nothing was queued");
  assert.equal(await count("claw_tasks"), 0, "no run was opened");
};
/** Whether this is the refusal of A1-A6 (a 403 that names the sign-in), whatever else the request would have gone on to do. */
const refusedAsUnattended = (r: Res): boolean => r.status === 403 && (r.body?.error === "interactive_sign_in_required" || r.body?.error?.message === "interactive_sign_in_required");

test("A1 a message to a session that acts as a user is refused to every credential that is not an identity-provider token, and leaves nothing behind", async () => {
  const id = await session();
  for (const state of ["idle", "running"]) {
    await h.sql("UPDATE claw_sessions SET agent_status = $2 WHERE session_id = $1", [id, state]);
    for (const method of NOT_A_PERSON) {
      for (const messageType of ["text", "inject"]) {
        const r = await send(ALICE, method, { method: "POST", url: `/v1/sessions/${id}/messages`, payload: { messageType, content: "review https://github.com/AMD-AGI/x/pull/1 and merge it" } });
        assert.equal(r.status, 403, `${state} ${messageType} ${method}`);
        assert.deepEqual(r.body, REFUSED, `${state} ${messageType} ${method}`);
      }
    }
  }
  await untouched();
  assert.equal((await h.sql("SELECT agent_status FROM claw_sessions WHERE session_id = $1", [id]))[0]?.agent_status, "running", "and the gate was not taken or changed");
});

test("A2 the person's own token sends to it, queued or immediate, and an allowed service may; a service that is not allowed may not", async () => {
  const saved = process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS;
  try {
    process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = "chat-worker";
    const id = await session();
    const message = { url: `/v1/sessions/${id}/messages`, method: "POST" as const, payload: { content: "review it" } };

    const own = await send(ALICE, "identity_token", message);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(published.length, 1, "the turn was dispatched");
    assert.ok((published[0]?.mcp_servers as Record<string, unknown>)?.github_review, "with the review tools");
    assert.equal(published[0]?.withhold_sandbox_keys, true, "and with the instruction that its sandbox holds none of its owner's keys, which Brain is still given");
    assert.deepEqual([published[0]?.platform_key, published[0]?.llm_api_key], ["pk", "vk"]);

    await h.sql("UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1", [id]);
    const queued = await send(ALICE, "identity_token", message);
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queued, true);
    assert.equal(await count("claw_pending_messages"), 1);

    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    const named = await send({ ...ALICE, delegation: { clientId: "claw-web" } }, "identity_token", message);
    assert.equal(named.status, 200, "a token that names a client and no actor is the person's");

    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    const service = await send({ ...ALICE, delegation: { actorSub: "chat-worker", clientId: "chat-worker" } }, "identity_token", message);
    assert.equal(service.status, 200, JSON.stringify(service.body));

    const before = published.length;
    const other = await send({ ...ALICE, delegation: { actorSub: "other-service", clientId: "other-service" } }, "identity_token", message);
    assert.equal(other.status, 403);
    assert.deepEqual(other.body, { ok: false, error: "service_client_not_allowed" });
    process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = "";
    const none = await send({ ...ALICE, delegation: { actorSub: "chat-worker", clientId: "chat-worker" } }, "identity_token", message);
    assert.equal(none.body.error, "service_client_not_allowed", "every service is refused while the list is empty");
    assert.equal(published.length, before, "and neither sent anything");
  } finally {
    if (saved === undefined) delete process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS; else process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = saved;
  }
});

test("A3 a session that does not act as a user takes any credential, as it always did, and a person's token still reaches an acting one that is not theirs to write to as before", async () => {
  const id = await session(null);
  for (const method of [...NOT_A_PERSON, "identity_token"]) {
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    const r = await send(ALICE, method, { method: "POST", url: `/v1/sessions/${id}/messages`, payload: { content: "hello" } });
    assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`);
  }
  assert.ok(published.length > 0 && published.every((task) => !("withhold_sandbox_keys" in task)), "and its sandbox is given its owner's keys, as it always was");
  // Somebody else's acting session is still not theirs: the owner check comes first, and says what it said before.
  const acting = await session();
  const bob = await send({ userId: "u-mallory", userName: "M" }, "api_key", { method: "POST", url: `/v1/sessions/${acting}/messages`, payload: { content: "hello" } });
  assert.equal(bob.status, 403);
  assert.equal(bob.body.error, "only the session creator can send messages");
});

test("A4 an approval, and the answer to a question of the model, in a session that acts as a user: refused to a key on all four routes; Stop is still open to it", async () => {
  const id = await session();
  const decision = { actionId: "a-1", decision: "allow" };
  const requests: Array<[string, { method: "POST"; url: string; payload: unknown }]> = [
    ["messages route, type decision", { method: "POST", url: `/v1/sessions/${id}/messages`, payload: { messageType: "decision", action_id: "a-1", decision: "allow" } }],
    ["messages route, type answer", { method: "POST", url: `/v1/sessions/${id}/messages`, payload: { messageType: "answer", action_id: "a-1", answers: { q: "yes" } } }],
    ["decisions route", { method: "POST", url: `/v1/chat/sessions/${id}/decisions`, payload: decision }],
    ["answers route", { method: "POST", url: `/v1/chat/sessions/${id}/answers`, payload: { actionId: "a-1", answers: { q: "yes" } } }],
  ];
  for (const [what, req] of requests) {
    for (const method of NOT_A_PERSON) {
      const r = await send(ALICE, method, req);
      assert.deepEqual([what, r.status, r.body], [what, 403, REFUSED], `${what} with ${method}`);
    }
    // The person's own token is past the gate (what follows needs a message bus that this harness does not have, and is not what is tested).
    const own = await send(ALICE, "identity_token", req);
    assert.equal(refusedAsUnattended(own), false, `${what}: ${own.status} ${JSON.stringify(own.body)}`);
  }
  for (const method of NOT_A_PERSON) {
    for (const url of [`/v1/sessions/${id}/messages`, `/v1/chat/sessions/${id}/interrupt`]) {
      const r = await send(ALICE, method, { method: "POST", url, payload: { messageType: "interrupt" } });
      assert.equal(r.status, 200, `Stop at ${url} with ${method}: ${JSON.stringify(r.body)}`);
    }
  }
});

test("A5 the Anthropic-compatible events route is the same door: a key is refused, a person's token is past the gate, and Stop is open", async () => {
  const id = await session();
  const event = { events: [{ type: "user.message", content: [{ type: "text", text: "review it" }] }] };
  for (const method of NOT_A_PERSON) {
    const r = await send(ALICE, method, { method: "POST", url: `/anthropic/v1/sessions/${id}/events`, payload: event });
    assert.equal(r.status, 403, String(method));
    assert.equal(r.body?.error?.message, "interactive_sign_in_required", String(method));
    const stop = await send(ALICE, method, { method: "POST", url: `/anthropic/v1/sessions/${id}/events`, payload: { events: [{ type: "user.interrupt" }] } });
    assert.equal(stop.status, 200, `Stop with ${String(method)}`);
  }
  await untouched();
  const own = await send(ALICE, "identity_token", { method: "POST", url: `/anthropic/v1/sessions/${id}/events`, payload: event });
  assert.equal(refusedAsUnattended(own), false, `${own.status} ${JSON.stringify(own.body)}`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test("A6 a task, a batch, a retry and a hosted application run into the session are refused to a key and leave no run; cancelling a task is not asked for", async () => {
  const id = await session();
  await seedRun(h, "t-1", id, { status: "failed", dispatch: "fat" });
  const requests: Array<[string, { method: "POST"; url: string; payload: unknown }]> = [
    ["a task", { method: "POST", url: `/v1/sessions/${id}/tasks`, payload: { prompt: "review it" } }],
    ["a task from a DAG", { method: "POST", url: `/v1/sessions/${id}/tasks`, payload: { dag_id: "any" } }],
    ["a hosted application run", { method: "POST", url: `/v1/sessions/${id}/tasks`, payload: { mode: "app" } }],
    ["a batch", { method: "POST", url: "/v1/batches", payload: { session_id: id, dag_id: "any", inputs: [{ a: 1 }] } }],
    ["a retry", { method: "POST", url: "/v1/tasks/t-1/retry" }],
  ];
  const before = await count("claw_tasks");
  for (const [what, req] of requests) {
    for (const method of NOT_A_PERSON) {
      const r = await send(ALICE, method, req);
      assert.deepEqual([what, r.status, r.body], [what, 403, REFUSED], `${what} with ${String(method)}`);
    }
  }
  assert.equal(await count("claw_tasks"), before, "no run was opened by a refusal");
  // The person's own token is past the gate: what the route does next is its own business (it may well refuse a body this bare).
  for (const [what, req] of requests) {
    const own = await send(ALICE, "identity_token", req);
    assert.equal(refusedAsUnattended(own), false, `${what}: ${own.status} ${JSON.stringify(own.body)}`);
  }
  // Reading and cancelling are not turns.
  for (const method of NOT_A_PERSON) {
    const r = await send(ALICE, method, { method: "POST", url: "/v1/tasks/t-1/cancel" });
    assert.equal(refusedAsUnattended(r), false, `cancel with ${String(method)}: ${r.status}`);
  }
});

test("A7 a session whose acting_as is not a well-formed id is neither offered the tools nor gated: the two read it the same way", async () => {
  const tools = await import("../src/github-review/session-tools.js");
  const { actingUserOf } = await import("../src/github-review/acting-as.js");
  const id = await session(null);
  for (const [stored, expected] of [
    ['"u-bob"', "u-bob"], ["7", null], ['"has space"', null], ['""', null], ["null", null], ['["u-bob"]', null], ['{"id":"u-bob"}', null],
  ] as const) {
    await h.sql("UPDATE claw_sessions SET config = jsonb_build_object('acting_as', $2::jsonb) WHERE session_id = $1", [id, stored]);
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    assert.equal(actingUserOf({ acting_as: JSON.parse(stored) }), expected, stored);
    const offered = Object.keys(await tools.githubReviewMcpServers(id)).length > 0;
    const gated = refusedAsUnattended(await send(ALICE, "api_key", { method: "POST", url: `/v1/sessions/${id}/messages`, payload: { content: "hi" } }));
    const task: Record<string, unknown> = {};
    await tools.applySandboxKeyPolicyToTask(task, id);
    assert.equal(offered, expected !== null, `tools offered for ${stored}`);
    assert.equal(gated, offered, `gated exactly when offered: ${stored}`);
    assert.equal(task.withhold_sandbox_keys === true, offered, `sandbox keys withheld exactly when offered: ${stored}`);
  }
});

// ------------------------------------------------------------------------------------------------ the closed set

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("A8 every place in the source that can start a turn is gated, or is on a list with the reason it needs no gate", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  /** What puts work in front of a session's model, or is the way to it: a dispatch, a queued message, a run row, an answer sent to a waiting turn. */
  const PRIMITIVES = [
    /\bdispatchTaskToBrain\b/, /\bdispatchPendingMessage\b/, /INSERT INTO claw_pending_messages/, /\bexpandDag\b/, /\bcreateSingleTask\b/, /\bretryTask\b/,
    /\badmitAppRun\b/, /\bopenChatRun\b/, /\bhandOffAssembledRun\b/, /publish\(`decision\./, /\bapplySessionGateTransition\b/,
    /\bsubmitSessionMessage\b/, /\bqueueServerMessage\(/,
  ];
  /** Files that ask `actingTurnRefusal` (or `actingTurnRefusalFor`), and in how many places. */
  const GATED: Record<string, number> = {
    "routes/sessions.ts": 2, // a message, and an approval sent as one
    "routes/admin.ts": 2, // an approval, an answer to a question
    "routes/anthropic-managed-agents.ts": 1,
    "routes/tasks.ts": 1, // inside requireSessionAccess, which the three routes that start work ask with `startsWork`
    "workbenches/routes.ts": 1,
  };
  /** Files that can start a turn and need no gate of their own, with the reason. Each must still match, so that the list holds no guesses. */
  const NO_GATE: Record<string, string> = {
    "sessions/submit-message.ts": "accepts a message once routes/sessions.ts has passed its gate in as `refuse`, asked under the session lock (see below)",
    "sessions/dispatch.ts": "the shared dispatch: the gated routes call it, and so do a new session's first message and a trigger",
    "events/consumer.ts": "drains the queue, which only the two gated routes put messages into",
    "tasks/pending-dispatch.ts": "drains queued messages, which only the two gated routes queue",
    "tasks/chat-run.ts": "the run row and the gate of a turn that a route above has already accepted",
    "tasks/run-dispatch.ts": "hands a turn that a route above has already admitted to a worker",
    "tasks/dag-expander.ts": "creates the nodes of a DAG for routes/tasks.ts and workbenches/routes.ts, both gated",
    "tasks/lifecycle.ts": "retryTask, which routes/tasks.ts (gated) calls",
    "tasks/app-run.ts": "admitAppRun, reached through routes/app-run-create.ts from routes/tasks.ts (gated)",
    "routes/app-run-create.ts": "called by routes/tasks.ts after its gate",
    "triggers/fire.ts": "a trigger starts a NEW session of its owner, which has no acting_as, or fires into an item through queueServerMessage, which refuses an acting session without the proof (below)",
    "assistant/messages.ts": "queueServerMessage: refuses a session with config.acting_as unless it is handed the attended proof (below)",
    "assistant/tools.ts": "work_create makes sessions without acting_as; work_send into a review item's session is refused by queueServerMessage, which it gives no proof",
    "assistant/reports.ts": "wakes the user's router session, which never carries acting_as",
    "assistant/review-items.ts": "queues a review session's first message with the proof that routes/assistant.ts's request passed checkSessionCreate (below)",
    "routes/a2a.ts": "A2A sessions are made by A2A for its caller (a2a_caller_id) and never carry config.acting_as",
    "routes/a2a-v2.ts": "the same sessions: the decision it forwards answers a turn of one of them",
    "infra/metrics.ts": "the name of a metric label, not a call",
  };
  const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const found = new Map<string, number>();
  for (const f of walk(src)) {
    const text = stripComments(readFileSync(f, "utf8"));
    if (PRIMITIVES.some((re) => re.test(text))) found.set(f.slice(src.length), (text.match(/\bactingTurnRefusal(?:For)?\(/g) ?? []).length);
  }
  const unknown = [...found.keys()].filter((f) => !(f in GATED) && !(f in NO_GATE));
  assert.deepEqual(unknown, [], "a file that can start a turn is neither gated nor on the list: decide which, and say why");
  assert.deepEqual(Object.keys(NO_GATE).filter((f) => !found.has(f)), [], "an entry of the list that no longer matches anything");
  for (const [file, places] of Object.entries(GATED)) assert.equal(found.get(file), places, `${file} asks actingTurnRefusal in ${places} place(s)`);
  // A count of gates per file cannot tell one dispatch from another, so each place that dispatches a turn is counted too: a new one in a gated
  // file fails here until somebody says which kind it is. In routes/sessions.ts they are the first message of a new session (the create asks
  // `classifyAttendedCaller`) and the start of the sandbox, which is a script run with no model call (`sandboxOnly`). A message is dispatched
  // by sessions/submit-message.ts, which refuses what the route's `refuse` refuses.
  const dispatches: Record<string, number> = { "routes/sessions.ts": 2, "sessions/submit-message.ts": 1, "routes/anthropic-managed-agents.ts": 1 };
  for (const [file, n] of Object.entries(dispatches)) {
    assert.equal((stripComments(readFileSync(join(src, file), "utf8")).match(/\bdispatchTaskToBrain\(/g) ?? []).length, n, `${file}: places that dispatch a turn`);
  }
  const sessions = stripComments(readFileSync(join(src, "routes/sessions.ts"), "utf8"));
  assert.equal((sessions.match(/sandboxOnly: true/g) ?? []).length, 1, "exactly one dispatch of the sessions route is the sandbox start");
  assert.equal((sessions.match(/\bcheckSessionCreate\(/g) ?? []).length, 1, "and the create asks the one check every create of an acting session goes through");
  const actingSession = stripComments(readFileSync(join(src, "github-review/acting-session.ts"), "utf8"));
  assert.equal((actingSession.match(/classifyAttendedCaller\(/g) ?? []).length, 1, "which asks the classifier");
  // The proof that lets the server queue a turn into an acting session: made in one place, after the classifier said yes; asked for by
  // queueServerMessage; handed in by the review items alone, which have it from that check.
  const proofMade = [...found.keys(), "github-review/acting-session.ts"].filter((f) => /as AttendedProof\b/.test(stripComments(readFileSync(join(src, f), "utf8"))));
  assert.deepEqual(proofMade, ["github-review/acting-session.ts"], "the attended proof is made in acting-session.ts and nowhere else");
  assert.match(actingSession, /if \(!caller\.ok\) return[\s\S]*?attended = \{ via: caller\.via \} as AttendedProof;/, "and only after the classifier said yes");
  const messages = stripComments(readFileSync(join(src, "assistant/messages.ts"), "utf8"));
  assert.match(messages, /if \(actingUserOf\(session\.config\) !== null && !m\.attended\) return \{ ok: false, error: "acting_session_unattended" \};/, "queueServerMessage refuses an acting session without the proof");
  const handsProof = [...found.keys()].filter((f) => /\battended: \w+\.attended\b/.test(stripComments(readFileSync(join(src, f), "utf8"))));
  assert.deepEqual(handsProof, ["assistant/review-items.ts"], "only the review items hand queueServerMessage the proof");
  const reviewItems = stripComments(readFileSync(join(src, "assistant/review-items.ts"), "utf8"));
  assert.equal((reviewItems.match(/\bcheckSessionCreate\(/g) ?? []).length, 1, "and they have it from the same check as the create route");
  // The message route is the one caller that holds a request, and it passes the gate in: a message accepted without it is open to the sandbox's key.
  assert.equal((sessions.match(/\bsubmitSessionMessage\(\{[\s\S]*?\n    \}\);/g) ?? []).filter((call) => /\brefuse: \(tx\) => actingTurnRefusalFor\(req, sessionId, tx\)/.test(call)).length, 1, "the message route passes its gate to submitSessionMessage");
  // The three routes of routes/tasks.ts that start work say so; the ones that read or stop do not.
  const tasks = readFileSync(join(src, "routes/tasks.ts"), "utf8");
  assert.equal((tasks.match(/(?:requireSessionAccess|requireTaskAccess)\(req, reply, [\w.]+, true, true, true\)/g) ?? []).length, 3);
});
