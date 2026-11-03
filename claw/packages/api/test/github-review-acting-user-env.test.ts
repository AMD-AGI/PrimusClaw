// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session that acts as a user is sent of its owner's stored variables (the env vault, where people keep personal tokens for
 * GitHub, Hugging Face, W&B and the like).
 *
 * Its model reads what strangers wrote and can print whatever its sandbox's environment holds, so the sandbox holds none of the owner's keys
 * (github-review-acting-dispatch-keys.test.ts, brain/test/ensure-hands-acting-session-keys*.test.ts). The vault is the other half of what the
 * environment holds of the owner, and it reached the sandbox by a different road: Brain composes it in from `request.user_env`, whatever
 * the key filter says. So a session that withholds its keys is sent no vault at all, on each way a turn reaches Brain, and each test here
 * plants secrets in the owner's vault that no key filter would know by name, and looks at what is on the wire, on the row or in the request:
 *
 *   E1  a message to an idle session (the turn is published with its task)
 *   E2  a message to a running session (the queued message is frozen with no vault), and the drain of it
 *   E2b a message the server queues on a session by itself (the assistant's worker and router turns)
 *   E3  a queued message that was frozen with the vault before the session was marked: drained without it
 *   E4  the first message of a new session
 *   E5  the Anthropic-compatible events route
 *   E6  the start of the session's sandbox
 *   E7  a turn claimed from the queue by Brain (the doorbell path), whose vault is read live at the claim
 *   E8  a task of a DAG, whose vault was embedded in its input when the run was created
 *   E8b the templates of that task, which can read its input into a prompt
 *   E9  the closed set: every place in the source that reads the vault or puts it on a request is on a list with how it decides
 *
 * A session that does not act as a user is run beside each one, and must still be sent the vault: a test that cannot see the vault at all
 * (a renamed field, a table that is empty) fails there instead of passing for want of one. The workbench run (a DAG created into a session)
 * is github-review-acting-workbench.test.ts, W3.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";

process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "t".repeat(40);
process.env.CLAW_GITHUB_REVIEW_MCP_URL = "http://api.internal.example:8200/v1/internal/github-review/mcp";
process.env.CLAW_DEPLOY_MODE = "safe";
process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let seedRun: typeof import("./scenario-harness.js").seedRun;
let db: typeof import("../src/infra/db.js").db;
let published: Record<string, unknown>[] = [];
let originalConnect: unknown;
let pristineDispatchPorts: Record<string, unknown> = {};
let pristinePendingPorts: Record<string, unknown> = {};
let pristineClaimPorts: Record<string, unknown> = {};
type Caller = { userId: string; userName: string };
let appAs: (user: Caller) => Promise<FastifyInstance>;

const ALICE: Caller = { userId: "u-alice", userName: "Alice A" };

/** What an owner keeps in the vault that is not one of the three key variables: personal tokens, under names a key filter would not know. */
const VAULT: Record<string, string> = {
  GITHUB_TOKEN: "ghp_vault_planted_0001",
  HF_TOKEN: "hf_vault_planted_0002",
  WANDB_API_KEY: "wandb_vault_planted_0003",
  MY_PRIVATE_SETTING: "vault-planted-0004",
};
const SECRETS = Object.values(VAULT);

before(async () => {
  const harness = await import("./scenario-harness.js");
  h = await harness.startHarness();
  seedRun = harness.seedRun;
  db = (await import("../src/infra/db.js")).db;
  for (const column of [
    "plugin_id INTEGER", "tool_ids JSONB DEFAULT '[]'::jsonb", "workspace_id TEXT", "platform_key TEXT", "llm_api_key TEXT", "credentials_blob TEXT",
    "image TEXT", "resources JSONB", "timeout INTEGER", "user_env JSONB", "session_env JSONB", "topology JSONB", "tools_allowlist JSONB",
    "bind_attempts INTEGER NOT NULL DEFAULT 0",
  ]) await h.sql(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS ${column}`);
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
  const { runClaimPorts } = await import("../src/tasks/run-claim.js");
  pristineDispatchPorts = { ...sessionDispatchPorts };
  pristinePendingPorts = { ...pendingDispatchPorts };
  pristineClaimPorts = { ...runClaimPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  const { registerAnthropicManagedAgentsRoutes } = await import("../src/routes/anthropic-managed-agents.js");
  appAs = async (user) => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { ...user, roles: ["default"], platformKey: "pk", virtualKey: "vk" };
      (req as unknown as { authMethod: string }).authMethod = "identity_token";
    });
    await registerSessionRoutes(app);
    await registerAnthropicManagedAgentsRoutes(app);
    await app.ready();
    return app;
  };
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
  const { runClaimPorts } = await import("../src/tasks/run-claim.js");
  const { sandboxStartPorts } = await import("../src/routes/sessions.js");
  const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
  Object.assign(sessionDispatchPorts, pristineDispatchPorts);
  Object.assign(pendingDispatchPorts, pristinePendingPorts);
  Object.assign(runClaimPorts, pristineClaimPorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
  pendingDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  pendingDispatchPorts.publishSessionEvent = (async () => undefined) as typeof pendingDispatchPorts.publishSessionEvent;
  pendingDispatchPorts.publish = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
  runClaimPorts.buildHistory = (async () => []) as typeof runClaimPorts.buildHistory;
  sandboxStartPorts.claim = async () => true;
  sandboxStartPorts.readBinding = async () => ({ ready: false, workloadId: null });
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
  const { runClaimPorts } = await import("../src/tasks/run-claim.js");
  Object.assign(sessionDispatchPorts, pristineDispatchPorts);
  Object.assign(pendingDispatchPorts, pristinePendingPorts);
  Object.assign(runClaimPorts, pristineClaimPorts);
  db.pool.connect = originalConnect as typeof db.pool.connect;
  await h?.close();
});

type Res = { status: number; body: any };
const send = async (req: { method: "POST" | "GET"; url: string; payload?: unknown }, user: Caller = ALICE): Promise<Res> => {
  const app = await appAs(user);
  try {
    const res = await app.inject(req as never);
    let body: unknown = null;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  } finally {
    await app.close();
  }
};

/** Alice's vault, with the secrets above in it, as the vault stores them (encrypted, one row a variable). */
const plantVault = async (userId: string = ALICE.userId): Promise<void> => {
  const { encryptUserEnvValue } = await import("../src/crypto/user-env.js");
  for (const [name, value] of Object.entries(VAULT)) {
    await h.sql("INSERT INTO claw_user_env_vars (user_id, key_name, key_value_enc) VALUES ($1, $2, $3)", [userId, name, encryptUserEnvValue(value)]);
  }
};

/** A session of Alice's as the create route makes it: acting as a user, or (`null`) an ordinary one. */
const session = async (actingAs: string | null): Promise<string> => {
  const r = await send({ method: "POST", url: "/v1/sessions", payload: { name: "review", config: actingAs === null ? { notify_on_finish: true } : { acting_as: actingAs } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.session_id as string;
};

/** Both kinds, so that every path is shown to be the mark's doing and not an empty vault's. */
const KINDS: Array<[string, string | null, boolean]> = [["a session that acts as a user", "u-bob", true], ["an ordinary session", null, false]];

/** Whether any secret of the vault is anywhere in this: a wire message, a row, a request. Field names do not matter, values do. */
const holdsVault = (thing: unknown): boolean => SECRETS.some((secret) => JSON.stringify(thing).includes(secret));

/** How many times the vault was read since the harness was last reset: for a session that acts as a user it is not read at all, which is the stronger claim than not sending it. */
const vaultReads = (): number => h.statements.filter((sql) => /FROM claw_user_env_vars/.test(sql)).length;

/** The statement that checks a turn's task or request for the vault, and says which it is when it fails. */
const assertSent = (what: string, task: Record<string, unknown> | undefined, marked: boolean): void => {
  assert.ok(task, `${what}: a turn was sent`);
  if (marked) {
    assert.equal(task.withhold_sandbox_keys, true, `${what}: the turn is marked`);
    assert.equal(holdsVault(task), false, `${what}: nothing of the vault is in what Brain is sent`);
    assert.equal("user_env" in task, false, `${what}: and no user_env`);
  } else {
    assert.deepEqual(task.user_env, VAULT, `${what}: control, an ordinary session is sent its vault as it always was`);
  }
};

test("E1 a message to an idle session: the turn is published without the vault when the session acts as a user, and with it when not", async () => {
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const id = await session(actingAs);
    const r = await send({ method: "POST", url: `/v1/sessions/${id}/messages`, payload: { content: "review it" } });
    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(published.length, 1, `${what}: dispatched`);
    assertSent(what, published[0], marked);
    assert.equal(vaultReads(), marked ? 0 : 1, `${what}: the vault is ${marked ? "not read at all" : "read, as it always was"}`);
  }
});

test("E2 a message to a running session is frozen on the queue without the vault, and the drain sends none either", async () => {
  const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const id = await session(actingAs);
    await h.sql("UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1", [id]);
    const r = await send({ method: "POST", url: `/v1/sessions/${id}/messages`, payload: { content: "review it" } });
    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.queued, true, what);
    const rows = await h.sql("SELECT * FROM claw_pending_messages WHERE session_id = $1", [id]);
    assert.equal(rows.length, 1, `${what}: queued`);
    if (marked) {
      assert.equal(holdsVault(rows[0]), false, `${what}: nothing of the vault is on the queued row`);
      assert.deepEqual(rows[0]!.user_env, {}, `${what}: the column is empty`);
    } else {
      assert.deepEqual(rows[0]!.user_env, VAULT, `${what}: control, the row is frozen with the vault as it always was`);
    }
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    await drainOldestPendingMessage(id, ALICE.userId);
    assert.equal(published.length, 1, `${what}: the drain sent the message on`);
    assertSent(`${what} (drained)`, published[0], marked);
  }
});

test("E2b a message the server queues on a session by itself is frozen without the vault when the session acts as a user", async () => {
  const { queueServerMessage } = await import("../src/assistant/messages.js");
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    await plantVault();
    const id = await session(actingAs);
    await h.sql("UPDATE claw_sessions SET config = config || $2::jsonb WHERE session_id = $1", [id, JSON.stringify({ platform_key: "pk", llm_api_key: "vk", _server_managed_credentials: true })]);
    const queued = await queueServerMessage(db, { sessionId: id, userId: ALICE.userId, content: "a worker's first task" });
    assert.equal(queued.ok, true, `${what}: ${JSON.stringify(queued)}`);
    const rows = await h.sql("SELECT * FROM claw_pending_messages WHERE session_id = $1", [id]);
    assert.equal(rows.length, 1, `${what}: queued`);
    if (marked) {
      assert.equal(holdsVault(rows[0]), false, `${what}: nothing of the vault is on the queued row`);
      assert.equal(vaultReads(), 0, `${what}: the vault is not read at all`);
    } else {
      assert.deepEqual(rows[0]!.user_env, VAULT, `${what}: control, the row is frozen with the vault as it always was`);
    }
  }
});

test("E3 a message that was queued with the vault, before its session was marked, is drained without it", async () => {
  const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const id = await session(actingAs);
    // The row as the code before the mark wrote it: whatever the session, the vault is in the column.
    await h.sql(
      "INSERT INTO claw_pending_messages (session_id, user_id, content, platform_key, llm_api_key, user_env) VALUES ($1, $2, 'review it', 'pk', 'vk', $3::jsonb)",
      [id, ALICE.userId, JSON.stringify(VAULT)],
    );
    await drainOldestPendingMessage(id, ALICE.userId);
    assert.equal(published.length, 1, `${what}: the drain sent the message on`);
    assertSent(what, published[0], marked);
  }
});

test("E4 the first message of a new session: the vault is not read for a session that acts as a user", async () => {
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const r = await send({
      method: "POST", url: "/v1/sessions",
      payload: { name: "review", config: actingAs === null ? { notify_on_finish: true } : { acting_as: actingAs }, message: { content: "review it" } },
    });
    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(published.length, 1, `${what}: dispatched`);
    assertSent(what, published[0], marked);
    assert.equal(vaultReads(), marked ? 0 : 1, `${what}: the vault is ${marked ? "not read at all" : "read, as it always was"}`);
  }
});

test("E5 the Anthropic-compatible events route sends no vault to a session that acts as a user, idle or running", async () => {
  const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
  const event = { events: [{ type: "user.message", content: [{ type: "text", text: "review it" }] }] };
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const id = await session(actingAs);
    const idle = await send({ method: "POST", url: `/anthropic/v1/sessions/${id}/events`, payload: event });
    assert.equal(idle.status, 200, `${what}: ${JSON.stringify(idle.body)}`);
    assert.equal(published.length, 1, `${what}: dispatched`);
    assertSent(`${what} (idle)`, published[0], marked);
    assert.equal(vaultReads(), marked ? 0 : 1, `${what}: the vault is ${marked ? "not read at all" : "read, as it always was"}`);

    published = [];
    await h.sql("UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1", [id]);
    const running = await send({ method: "POST", url: `/anthropic/v1/sessions/${id}/events`, payload: event });
    assert.equal(running.status, 200, `${what}: ${JSON.stringify(running.body)}`);
    const rows = await h.sql("SELECT * FROM claw_pending_messages WHERE session_id = $1", [id]);
    assert.equal(rows.length, 1, `${what}: queued`);
    if (marked) assert.equal(holdsVault(rows[0]), false, `${what}: nothing of the vault is on the queued row`);
    else assert.deepEqual(rows[0]!.user_env, VAULT, `${what}: control`);
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    await drainOldestPendingMessage(id, ALICE.userId);
    assert.equal(published.length, 1, `${what}: drained`);
    assertSent(`${what} (drained)`, published[0], marked);
  }
});

test("E6 the start of the session's sandbox (a script run with no model call, which still builds the sandbox) sends no vault to a session that acts as a user", async () => {
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    published = [];
    await plantVault();
    const id = await session(actingAs);
    const r = await send({ method: "POST", url: `/v1/sessions/${id}/sandbox`, payload: {} });
    assert.equal(r.status, 202, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(published.length, 1, `${what}: dispatched`);
    assert.equal(published[0]!.sandbox_only, true, `${what}: it is the sandbox start`);
    assertSent(what, published[0], marked);
    assert.equal(vaultReads(), marked ? 0 : 1, `${what}: the vault is ${marked ? "not read at all" : "read, as it always was"}`);
  }
});

test("E7 a turn claimed from the queue by Brain is given no vault for a session that acts as a user, read live at the claim for any other", async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  for (const [what, actingAs, marked] of KINDS) {
    await h.reset();
    await plantVault("u-1");
    const sessionId = `s-claim-${marked ? "acting" : "plain"}`;
    await h.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ($1, 'u-1', $2::jsonb)", [sessionId, JSON.stringify(actingAs === null ? {} : { acting_as: actingAs })]);
    await seedRun(h, `ktsk_${marked ? "a" : "p"}`, sessionId, { claimable: true, dispatch: "doorbell" });
    const claimed = await claimRunById(`ktsk_${marked ? "a" : "p"}`, "brain-1");
    assert.ok(typeof claimed === "object" && "request" in claimed, `${what}: claimed (${JSON.stringify(claimed)})`);
    if (typeof claimed !== "object" || !("request" in claimed)) return;
    assertSent(what, claimed.request as unknown as Record<string, unknown>, marked);
    assert.equal(claimed.request.platform_key, "pk-scenario", `${what}: Brain still has the key for what it does itself`);
  }
});

test("E8 a task of a DAG is given no vault for a session that acts as a user, whatever its input holds, and the vault of any other session's", async () => {
  const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
  const NOW = new Date().toISOString();
  const originalQuery = db.query;
  const originalPublish = taskPublisher.publish;
  try {
    for (const [what, actingAs, marked] of KINDS) {
      const config = { platform_key: "pk-user-1", _server_managed_credentials: true, ...(actingAs === null ? {} : { acting_as: actingAs }) };
      db.query = (async (text: string) => {
        const sql = text.replace(/\s+/g, " ").trim();
        if (/SELECT user_id, config FROM claw_sessions/.test(sql)) return { rows: [{ user_id: "u-1", config }], rowCount: 1 };
        if (/^UPDATE claw_tasks/.test(sql) || /FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) {
          return { rows: [{ task_id: "t-1", session_id: "s-1", status: "preparing", mode: "script", prompt: "", input: { user_env: VAULT }, plugin_id: null, sandbox_spec: "none", dag_root_task_id: null, started_at: NOW, created_at: NOW }], rowCount: 1 };
        }
        if (/claw_workspace/.test(sql)) return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }) as typeof db.query;
      const sent: Array<Record<string, unknown>> = [];
      taskPublisher.publish = (async (payload: string) => { sent.push(JSON.parse(payload)); }) as typeof taskPublisher.publish;
      await dispatchTask("t-1");
      assert.equal(sent.length, 1, `${what}: dispatched`);
      assertSent(what, sent[0], marked);
      assert.equal(sent[0]!.platform_key, "pk-user-1", `${what}: Brain still has the key`);
    }
  } finally {
    db.query = originalQuery;
    taskPublisher.publish = originalPublish;
  }
});

test("E8b a template of a DAG task cannot read the vault out of the task's input for a session that acts as a user: the secret is in no prompt that Brain is sent", async () => {
  const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
  const NOW = new Date().toISOString();
  const originalQuery = db.query;
  const originalPublish = taskPublisher.publish;
  try {
    for (const [what, actingAs, marked] of KINDS) {
      const config = { platform_key: "pk-user-1", _server_managed_credentials: true, ...(actingAs === null ? {} : { acting_as: actingAs }) };
      const row = {
        task_id: "t-1", session_id: "s-1", status: "preparing", mode: "llm", prompt: "use ${task.input.user_env.GITHUB_TOKEN} to clone", input: { user_env: VAULT },
        metadata: {}, depends_on: [], batch_id: null, user_id: "u-1", session_config: config, plugin_id: null, sandbox_spec: "none", dag_root_task_id: null, started_at: NOW, created_at: NOW,
      };
      db.query = (async (text: string) => {
        const sql = text.replace(/\s+/g, " ").trim();
        if (/SELECT user_id, config FROM claw_sessions/.test(sql)) return { rows: [{ user_id: "u-1", config }], rowCount: 1 };
        if (/^UPDATE claw_tasks/.test(sql) || /FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row], rowCount: 1 };
        if (/claw_workspace/.test(sql)) return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }) as typeof db.query;
      const sent: Array<Record<string, unknown>> = [];
      taskPublisher.publish = (async (payload: string) => { sent.push(JSON.parse(payload)); }) as typeof taskPublisher.publish;
      await dispatchTask("t-1");
      if (marked) {
        assert.equal(sent.some((request) => holdsVault(request)), false, `${what}: no prompt that Brain is sent carries a secret of the vault`);
        assert.equal(sent.length, 0, `${what}: a template that names the vault does not resolve, and the task is not sent as if it had`);
      } else {
        assert.equal(sent.length, 1, `${what}: dispatched`);
        assert.equal(sent[0]!.prompt, `use ${VAULT.GITHUB_TOKEN} to clone`, `${what}: control, the template reads the task's input as it always did`);
      }
    }
  } finally {
    db.query = originalQuery;
    taskPublisher.publish = originalPublish;
  }
});

// ------------------------------------------------------------------------------------------------ the closed set

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("E9 every place in the source that reads the vault or puts it on a request is on a list with how it decides, and a new one is not added without", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  /** What reads the vault, carries it, or hands it on: the loaders, the field of a request or a task, the column of a queued message. */
  const TOUCHES = [/\bloadUserEnvSnapshot\b/, /\bloadUserEnvForSession\b/, /\buser_env\b(?!\.(?:decrypt|encrypt|snapshot|audit))/];
  const DECIDES: Record<string, string> = {
    "github-review/session-tools.ts": "the one reader of a session's vault: loadUserEnvForSession reads none for a session that withholds its keys, and applySandboxKeyPolicyToTask takes it off a task",
    "assistant/messages.ts": "a message the server queues on a session by itself: reads it through loadUserEnvForSession on the statements of the state change it belongs to (E2b)",
    "sessions/submit-message.ts": "a message: reads it through loadUserEnvForSession on the transaction that holds the session's row (E1, E2)",
    "routes/anthropic-managed-agents.ts": "an event: reads it through loadUserEnvForSession on the transaction that holds the session's row (E5)",
    "routes/sessions.ts": "the first message of a new session decides from the config it is about to be written with (E4); the start of the sandbox reads it through loadUserEnvForSession (E6)",
    "triggers/fire.ts": "a trigger starts a NEW session of its owner, whose config it writes itself and which has no acting_as: its vault is read as an ordinary session's is",
    "workbenches/routes.ts": "a run's input holds it, read through loadUserEnvForSession once the session is known (github-review-acting-workbench.test.ts, W3)",
    "sessions/dispatch.ts": "puts what its callers read on the turn's task; dropped for a marked session where the task is published or sealed (applyAppMcpToTask) and stripped from a stored row (run-spec.ts)",
    "events/consumer.ts": "the queued message's column, frozen by the two writers above; dropped for a marked session where the drain's task is published (E3)",
    "tasks/pending-dispatch.ts": "the drain's fat branch: applyAppMcpToTask takes it off a marked task, and injectLiveUserEnv reads none for one (E3)",
    "tasks/run-claim.ts": "the claim reads the vault live; injectLiveUserEnv reads none for a session that withholds its keys, and takes any off the request (E7)",
    "tasks/dispatcher.ts": "a task of a DAG lifts it out of its input; none for a session that withholds its keys (E8)",
    "tasks/template-renderer.ts": "a template reads the task's input, which holds the vault of a run made before the session was marked; the render context leaves it out for a session that withholds its keys (E8b)",
    "tasks/run-spec.ts": "strips it from a run's stored spec, for every session",
    "crypto/user-env.ts": "the vault's own reader and cipher",
    "routes/user-env-vars.ts": "the owner's routes to edit the vault, not a request to Brain",
    "infra/db.ts": "the column of the queued message and the table of the vault, as schema",
    "infra/schema-guard.ts": "the columns that the schema must have",
  };
  const found = new Set<string>();
  for (const f of walk(src)) {
    const text = stripComments(readFileSync(f, "utf8"));
    if (TOUCHES.some((re) => re.test(text))) found.add(f.slice(src.length));
  }
  const unknown = [...found].filter((f) => !(f in DECIDES));
  assert.deepEqual(unknown, [], "a file that reads the vault or puts it on a request is not on the list: decide how a session that withholds its keys is kept from it, test it above, and say so here");
  assert.deepEqual(Object.keys(DECIDES).filter((f) => !found.has(f)), [], "an entry of the list that no longer matches anything");
});
