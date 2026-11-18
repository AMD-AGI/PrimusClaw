// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Accepting a message onto a session, and what a retry of it does.
 *
 * `submitSessionMessage` is the one place a message is put on a session: the
 * route calls it, and so will every caller that is not an HTTP request. What
 * stops those callers from duplicating the gate and the queue is that there is
 * nothing left to copy; what stops a retry from queuing a message twice is the
 * dedupe key, enforced by a unique index rather than by a read-then-write.
 *
 * The queue is PGlite, so the statements run: a stub would pass whatever the
 * insert says, and the property here -- one row per key -- is the database's.
 * The race between two submits that both read "no such key" is the one thing
 * PGlite (one connection) cannot show, so that runs against a server.
 *
 * Coverage:
 *   D1  the same key twice queues once, and the second answer says so
 *   D2  a retry that changed its text is still the first message
 *   D3  different keys queue separately
 *   D4  a key is per session
 *   D5  without a key every submit queues, as it always has
 *   D6  a keyed and an unkeyed insert freeze the same request
 *   D7  a session that is running parks the message and is not drained
 *   D8  an idle session is drained once, and the gate is left to the drain
 *   D9  a drain that throws before taking the message says it is still queued
 *   D9b a drain that throws after taking it says it left the queue
 *   D9c a drain that throws with the queue unreadable says it does not know
 *   D10 the duplicate is not drained a second time
 *   D11 a stranger, a missing and a deleted session queue nothing
 *   D12 a key where it cannot be honoured, or an unusable one, is refused
 *   D13 the route queues through it, and answers what it always did, now with the message id its turn will carry
 *   D14 nothing but this module (and one named legacy route) writes the queue
 *   D15 two submits racing on one key, on a server, leave one row
 *   D16 a first attempt that rolls back leaves nothing to dedupe against
 *   D17 the migration is idempotent, in the release manifest, in the schema guard and asserted at start-up
 */
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { EnvironmentTopology } from "@claw/protocol";

import {
  PENDING_DEDUPE_INDEX, assertUniqueIndexValid, db, pendingMessageDedupeSchemaSql,
} from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { REQUIRED_SCHEMA, missingSchemaObjects } from "../src/infra/schema-guard.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import {
  insertPendingMessage, submitMessagePorts, submitSessionMessage,
  type SubmitSessionMessageInput,
} from "../src/sessions/submit-message.js";
import { pendingSecretColumns } from "../src/tasks/run-secrets.js";
import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";
import { seedSession, startHarness, type Harness } from "./scenario-harness.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};
const STRANGER: UserInfo = {
  userId: "u-2", userName: "u-2", roles: ["default"], platformKey: "pk2", virtualKey: "vk-u-2",
};

/** The columns the queue insert names, which the harness table does not carry. */
const QUEUE_COLUMNS = `ALTER TABLE claw_pending_messages
  ADD COLUMN plugin_id INTEGER,
  ADD COLUMN tool_ids JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN workspace_id TEXT,
  ADD COLUMN platform_key TEXT,
  ADD COLUMN llm_api_key TEXT,
  ADD COLUMN credentials_blob TEXT,
  ADD COLUMN image TEXT,
  ADD COLUMN resources JSONB,
  ADD COLUMN timeout INTEGER,
  ADD COLUMN user_env JSONB,
  ADD COLUMN session_env JSONB,
  ADD COLUMN topology JSONB,
  ADD COLUMN tools_allowlist JSONB`;

let h: Harness;
let drains: Array<[string, string]> = [];
let drainFails = false;
const pristineDrain = submitMessagePorts.drainOldestPendingMessage;

before(async () => {
  h = await startHarness();
  await h.sql(QUEUE_COLUMNS);
  // The plugins the queued messages below name: a queued row holds its plugin, and a gone one is refused.
  await h.sql("INSERT INTO plugins (id, name, version, is_public) VALUES (3, 'p3', '1', true), (7, 'p7', '1', true)");
  // The migration's own statements, not a restatement of them.
  for (const sql of pendingMessageDedupeSchemaSql()) await h.sql(sql);
});

beforeEach(async () => {
  await h.reset();
  drains = [];
  drainFails = false;
  submitMessagePorts.drainOldestPendingMessage = async (sessionId: string, userId: string) => {
    drains.push([sessionId, userId]);
    if (drainFails) throw new Error("drain refused");
  };
});

afterEach(() => {
  submitMessagePorts.drainOldestPendingMessage = pristineDrain;
});

after(async () => { await h?.close(); });

function message(
  sessionId: string,
  over: Partial<SubmitSessionMessageInput> = {},
): SubmitSessionMessageInput {
  return {
    sessionId, userId: OWNER.userId, user: OWNER,
    content: "do the thing", messageType: "text", toolIds: [], sessionEnv: {},
    ...over,
  } as SubmitSessionMessageInput;
}

const enqueue = (sessionId: string, dedupeKey?: string, over: Partial<SubmitSessionMessageInput> = {}) =>
  submitSessionMessage(message(sessionId, { ...over, mode: "enqueue", dedupeKey } as Partial<SubmitSessionMessageInput>));

async function queue(): Promise<Array<Record<string, unknown>>> {
  return h.sql(
    "SELECT id, session_id, user_id, content, dedupe_key FROM claw_pending_messages ORDER BY id",
  );
}

describe("the dedupe key", () => {
  test("D1 the same key twice queues once, and the second answer says so", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });

    const first = await enqueue("s1", "start:item-1");
    const second = await enqueue("s1", "start:item-1");

    assert.equal(first.kind, "queued");
    assert.equal(second.kind, "queued");
    if (first.kind !== "queued" || second.kind !== "queued") return;
    assert.equal(first.deduplicated, false);
    assert.equal(typeof first.pendingId, "number", "the first names the row it wrote");
    assert.equal(second.deduplicated, true);
    assert.equal(second.pendingId, null, "the duplicate wrote no row, so names none");
    assert.equal(second.drain, "duplicate");
    const rows = await queue();
    assert.equal(rows.length, 1, "one message, not two");
    assert.equal(rows[0].dedupe_key, "start:item-1");
    assert.equal(rows[0].id, first.pendingId);
  });

  test("D2 a retry that changed its text is still the first message", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });

    await enqueue("s1", "k", { content: "original" });
    await enqueue("s1", "k", { content: "reworded" });

    const rows = await queue();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "original", "the key names the message; the first write stands");
  });

  test("D3 different keys queue separately", async () => {
    await seedSession(h, "s1", { agentStatus: "running" });

    const a = await enqueue("s1", "k-a");
    const b = await enqueue("s1", "k-b");

    assert.ok(a.kind === "queued" && !a.deduplicated);
    assert.ok(b.kind === "queued" && !b.deduplicated);
    assert.deepEqual((await queue()).map((r) => r.dedupe_key), ["k-a", "k-b"]);
  });

  test("D4 a key is per session", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedSession(h, "s2", { agentStatus: "idle" });

    await enqueue("s1", "shared");
    await enqueue("s2", "shared");

    const rows = await queue();
    assert.deepEqual(rows.map((r) => r.session_id), ["s1", "s2"],
      "one session's key must not swallow another session's message");
  });

  test("D5 without a key every submit queues, as it always has", async () => {
    await seedSession(h, "s1", { agentStatus: "running" });

    const first = await submitSessionMessage(message("s1"));
    const second = await submitSessionMessage(message("s1"));

    assert.deepEqual([first.kind, second.kind], ["queued", "queued"]);
    const rows = await queue();
    assert.equal(rows.length, 2, "NULL keys never collide");
    assert.deepEqual(rows.map((r) => r.dedupe_key), [null, null]);
  });

  test("D6 a keyed and an unkeyed insert freeze the same request", async () => {
    // The keyed statement carries one more parameter than the other, which is
    // the place a misnumbered placeholder would shift every column after it.
    await seedSession(h, "s1", { agentStatus: "running" });
    await seedSession(h, "s2", { agentStatus: "running" });
    const topology: EnvironmentTopology = { nodes: 2, backend: "rayjob" };
    const rich: Partial<SubmitSessionMessageInput> = {
      content: "train it", toolIds: [4, 5], pluginId: 7, workspaceId: "ns-a",
      requestImage: "img:1", requestResource: { cpu: 2 }, requestTimeout: 90,
      topology, sessionEnv: { A: "1" },
    };

    await submitSessionMessage(message("s1", rich));
    await enqueue("s2", "k", rich);

    const cols = "content, user_id, plugin_id, tool_ids, workspace_id, platform_key, llm_api_key, image, resources, timeout, session_env, topology";
    const [plain] = await h.sql(`SELECT ${cols} FROM claw_pending_messages WHERE session_id = 's1'`);
    const [keyed] = await h.sql(`SELECT ${cols} FROM claw_pending_messages WHERE session_id = 's2'`);
    assert.deepEqual(keyed, plain);
    assert.equal(plain.plugin_id, 7);
    assert.deepEqual(plain.tool_ids, [4, 5]);
    assert.deepEqual(plain.topology, topology);
    assert.equal(plain.timeout, 90);
  });
});

describe("queue then drain", () => {
  test("D7 a session that is running parks the message and is not drained", async () => {
    await seedSession(h, "s1", { agentStatus: "running", gateOwner: "claw-1" });

    const r = await enqueue("s1", "k");

    assert.ok(r.kind === "queued");
    if (r.kind !== "queued") return;
    assert.equal(r.drain, "awaiting_turn");
    assert.deepEqual(drains, [], "the turn in front drains it when it completes");
    assert.equal((await queue()).length, 1);
    const [gate] = await h.sql("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = 's1'");
    assert.deepEqual(gate, { agent_status: "running", agent_gate_message_id: "claw-1" },
      "parking a message does not touch the turn that holds the gate");
  });

  test("D8 an idle session is drained once, and the gate is left to the drain", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });

    const r = await enqueue("s1", "k");

    assert.ok(r.kind === "queued" && r.drain === "drained");
    assert.deepEqual(drains, [["s1", OWNER.userId]]);
    assert.equal((await queue()).length, 1, "the stubbed drain consumed nothing");
    const [gate] = await h.sql("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = 's1'");
    assert.equal(gate.agent_status, "idle",
      "taking the gate is the dispatch's act, under the marker of the row it dispatches");
  });

  test("D9 a drain that throws leaves the message queued and says so", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });
    drainFails = true;

    const r = await enqueue("s1", "k");

    assert.ok(r.kind === "queued");
    if (r.kind !== "queued") return;
    assert.equal(r.drain, "drain_failed");
    assert.equal(typeof r.pendingId, "number", "the message is recorded, which is what was asked");
    assert.equal((await queue()).length, 1, "and the sweeper's orphan drain can find it");
  });

  test("D9b a drain that took the message off the queue before it failed says the message left it", async () => {
    // The real drain publishes, deletes the queue row and only then takes the
    // gate, so it can fail with the message already on its way. "Still queued"
    // would be false, and a caller that read it as licence to submit again would
    // send the message twice: the key has no row left to find.
    await seedSession(h, "s1", { agentStatus: "idle" });
    submitMessagePorts.drainOldestPendingMessage = async () => {
      await h.sql("DELETE FROM claw_pending_messages WHERE session_id = 's1'");
      throw new Error("gate not taken");
    };

    const r = await enqueue("s1", "k");

    assert.ok(r.kind === "queued");
    if (r.kind !== "queued") return;
    assert.equal(r.drain, "left_queue");
    assert.deepEqual(await queue(), [], "the message is no longer queued");
  });

  test("D9c a drain that failed with the queue unreadable says it does not know", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });
    const query = db.query;
    submitMessagePorts.drainOldestPendingMessage = async () => {
      db.query = (async (text: string, params?: unknown[]) => {
        if (/FROM claw_pending_messages WHERE id = \$1/.test(text)) throw new Error("database unavailable");
        return query(text, params);
      }) as typeof db.query;
      throw new Error("drain refused");
    };

    try {
      const r = await enqueue("s1", "k");
      assert.ok(r.kind === "queued");
      if (r.kind !== "queued") return;
      assert.equal(r.drain, "drain_unknown",
        "neither 'still queued' nor 'gone': a read that failed is not an answer");
    } finally {
      db.query = query;
    }
  });

  test("D10 the duplicate is not drained a second time", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });

    await enqueue("s1", "k");
    await enqueue("s1", "k");
    await enqueue("s1", "k");

    assert.equal(drains.length, 1, "a retry must not start a second turn on the same row");
  });
});

describe("who may queue", () => {
  test("D11 a stranger, a missing and a deleted session queue nothing", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedSession(h, "gone", { agentStatus: "idle" });
    await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 'gone'");

    const stranger = await enqueue("s1", "k", { userId: STRANGER.userId, user: STRANGER });
    const missing = await enqueue("nope", "k");
    const deleted = await enqueue("gone", "k");

    assert.equal(stranger.kind, "not_owner");
    assert.equal(missing.kind, "session_not_found");
    assert.equal(deleted.kind, "session_not_found");
    assert.deepEqual(await queue(), []);
    assert.deepEqual(drains, []);
  });

  test("an operator may write to a session that has no owner, and nobody else may", async () => {
    // The same rule the route had inline: an ownerless session is reachable by
    // a full administrator only.
    await seedSession(h, "orphan", { agentStatus: "idle" });
    await h.sql("UPDATE claw_sessions SET user_id = NULL WHERE session_id = 'orphan'");
    const admin: UserInfo = { ...STRANGER, roles: ["system-admin"] };

    const plain = await enqueue("orphan", "k1", { userId: STRANGER.userId, user: STRANGER });
    const operator = await enqueue("orphan", "k2", { userId: admin.userId, user: admin });

    assert.equal(plain.kind, "not_owner");
    assert.equal(operator.kind, "queued");
  });
});

describe("what a key is allowed to be", () => {
  test("D12 a key where it cannot be honoured, or an unusable one, is refused", async () => {
    await seedSession(h, "s1", { agentStatus: "idle" });

    // dispatch mode writes no row on an idle session: there is nothing for a
    // retry to find, so accepting the key would be a promise nothing keeps.
    await assert.rejects(
      submitSessionMessage({ ...message("s1"), dedupeKey: "k" } as unknown as SubmitSessionMessageInput),
      /needs mode enqueue/,
    );
    await assert.rejects(enqueue("s1", ""), /dedupe key must be/,
      "an empty key would fold every message of the session into one");
    await assert.rejects(enqueue("s1", "x".repeat(257)), /dedupe key must be/);
    assert.deepEqual(await queue(), [], "a refused key reaches no table");
  });
});

describe("the route", () => {
  let app: FastifyInstance;

  before(async () => {
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: UserInfo }).user = OWNER;
    });
    await registerSessionRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); });

  test("D13 the route queues through it, and answers what it always did", async () => {
    await seedSession(h, "s1", { agentStatus: "running", gateOwner: "claw-1" });

    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/messages",
      payload: { content: "while busy", plugin_id: 3, timeout: 60 },
    });

    assert.equal(res.statusCode, 200);
    const [row] = await h.sql(
      "SELECT id, content, user_id, plugin_id, timeout, dedupe_key FROM claw_pending_messages WHERE session_id = 's1'",
    );
    assert.deepEqual(res.json(), { ok: true, session_id: "s1", queued: true, message_id: `claw-pending-${row.id}` },
      "queued, with the message id its turn will carry, and no run id for a run that does not exist yet");
    delete row.id;
    assert.deepEqual(row, {
      content: "while busy", user_id: OWNER.userId, plugin_id: 3, timeout: 60, dedupe_key: null,
    }, "an HTTP request carries no key: its retries are the idempotency layer's business");
    assert.deepEqual(drains, [], "the route never drains: the turn in front does");
  });

  test("D13 and refuses a stranger and a missing session as it did", async () => {
    await seedSession(h, "s1", { agentStatus: "running" });
    const strangerApp = Fastify();
    strangerApp.addHook("preHandler", async (req) => {
      (req as unknown as { user: UserInfo }).user = STRANGER;
    });
    await registerSessionRoutes(strangerApp);
    await strangerApp.ready();
    try {
      const forbidden = await strangerApp.inject({
        method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "hi" },
      });
      assert.equal(forbidden.statusCode, 403);
      assert.deepEqual(forbidden.json(), { ok: false, error: "only the session creator can send messages" });
    } finally {
      await strangerApp.close();
    }

    const missing = await app.inject({
      method: "POST", url: "/v1/sessions/nope/messages", payload: { content: "hi" },
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { ok: false, error: "session not found" });
    assert.deepEqual(await queue(), []);
  });
});

describe("one writer", () => {
  const SRC = new URL("../src/", import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  test("D14 nothing but this module (and one named legacy route) writes the queue", () => {
    // Derived from the tree rather than from a list of callers: a list of the
    // files that do it is the one that is missing the file somebody adds next.
    const writers = sources(SRC)
      .filter((f) => /INSERT\s+INTO\s+claw_pending_messages/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length))
      .sort();
    assert.deepEqual(writers, [
      // Predates this module: its own lock-and-gate for the Anthropic-compatible
      // protocol, with a column list of its own. Not to be copied; to be moved.
      "routes/anthropic-managed-agents.ts",
      "sessions/submit-message.ts",
    ]);
  });

  test("the message route holds no lock, gate or queue of its own", () => {
    const route = readFileSync(join(SRC, "routes/sessions.ts"), "utf8");
    const start = route.indexOf('app.post<{ Params: { id: string } }>("/v1/sessions/:id/messages"');
    const end = route.indexOf('"/v1/sessions/:id/sandbox"', start);
    assert.ok(start > 0 && end > start, "found the message handler");
    // Code only: the comments that explain the mapping name the table.
    const handler = route.slice(start, end).replace(/^\s*\/\/.*$/gm, "");
    assert.match(handler, /await submitSessionMessage\(/);
    assert.doesNotMatch(handler, /FOR UPDATE/, "the row lock is taken in one place");
    assert.doesNotMatch(handler, /takeSessionGate\(/, "and so is the gate");
    assert.doesNotMatch(handler, /dispatchTaskToBrain\(/, "and the hand-off to Brain");
    assert.doesNotMatch(handler, /claw_pending_messages/, "and the queue");
  });
});

describe("the migration", () => {
  test("D17 builds a valid unique index, and builds it twice without harm", async () => {
    for (const sql of pendingMessageDedupeSchemaSql()) await h.sql(sql);
    await assertUniqueIndexValid(db, PENDING_DEDUPE_INDEX, "a retry would queue the message twice");

    await h.sql(`DROP INDEX ${PENDING_DEDUPE_INDEX}`);
    await assert.rejects(
      assertUniqueIndexValid(db, PENDING_DEDUPE_INDEX, "a retry would queue the message twice"),
      /refusing to serve: uq_pending_session_dedupe is absent/,
      "an absent index enforces nothing, and start-up says so",
    );
    for (const sql of pendingMessageDedupeSchemaSql()) await h.sql(sql);
  });

  test("D17 the release gate's schema manifest names the column and the index", async () => {
    // The gate checks the manifest against a migrated database, but only where a
    // container runtime exists; this asks the same of the statements exported
    // here, so a row that drifts from them fails in the ordinary test run.
    const manifest = readFileSync(
      new URL("../../../../scripts/release-tests/db-schema-manifest.tsv", import.meta.url), "utf8",
    ).split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split("\t"));
    assert.ok(manifest.some(([kind, name, member]) =>
      kind === "table" && name === "claw_pending_messages" && member === "dedupe_key"));
    assert.ok(manifest.some(([kind, name]) => kind === "index" && name === PENDING_DEDUPE_INDEX));

    const column = await h.sql(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'claw_pending_messages' AND column_name = 'dedupe_key'",
    );
    const index = await h.sql(
      "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1", [PENDING_DEDUPE_INDEX],
    );
    assert.equal(column.length, 1, "the manifest's column is what the migration builds");
    assert.equal(index.length, 1, "and so is its index");
  });

  test("D17 the schema guard names the column when a half-applied migration lacks it", () => {
    const present = REQUIRED_SCHEMA.flatMap((req) => req.columns
      .filter((c) => !(req.table === "claw_pending_messages" && c === "dedupe_key"))
      .map((column_name) => ({ table_name: req.table, column_name })));
    assert.deepEqual(
      missingSchemaObjects(REQUIRED_SCHEMA, present),
      ["claw_pending_messages is missing column(s): dedupe_key"],
      "without it every keyed submit fails on the insert, far from the boot that caused it",
    );
  });

  test("D17 initDb runs it and assertSchema requires it", () => {
    const src = readFileSync(new URL("../src/infra/db.ts", import.meta.url), "utf8");
    assert.match(src, /for \(const sql of pendingMessageDedupeSchemaSql\(\)\) await client\.query\(sql\)/);
    assert.match(src, /assertUniqueIndexValid\(\s*client,\s*PENDING_DEDUPE_INDEX/);
  });
});

describe("two submits on a server", { skip: postgresSkipReason() }, () => {
  let cluster: PgCluster;
  const row = (dedupeKey: string) => ({
    sessionId: "s1", content: "hi", userId: "u-1", toolIds: [], sessionEnv: {},
    secrets: pendingSecretColumns({ llmKey: "", platformKey: "", userEnv: {}, doorbell: false }),
    dedupeKey,
  });

  before(async () => {
    cluster = await startPgCluster();
    const client = await cluster.connect();
    await client.query(`CREATE TABLE claw_pending_messages (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
      user_id TEXT DEFAULT 'default', created_at TIMESTAMPTZ DEFAULT NOW(),
      plugin_id INTEGER, tool_ids JSONB DEFAULT '[]'::jsonb, workspace_id TEXT,
      platform_key TEXT, llm_api_key TEXT, credentials_blob TEXT, image TEXT,
      resources JSONB, timeout INTEGER, user_env JSONB, session_env JSONB, topology JSONB, tools_allowlist JSONB)`);
    for (const sql of pendingMessageDedupeSchemaSql()) await client.query(sql);
  });
  after(async () => { await cluster?.end(); });
  beforeEach(async () => {
    const client = await cluster.connect();
    await client.query("TRUNCATE claw_pending_messages");
  });

  const count = async (client: pg.Client) =>
    (await client.query("SELECT count(*)::int AS n FROM claw_pending_messages")).rows[0].n as number;

  test("D15 two submits racing on one key leave one row", async () => {
    const a = await cluster.connect();
    const b = await cluster.connect();
    // Whatever the outcome, neither transaction may stay open: a failed
    // assertion that left one holding its row would hang the next case's
    // TRUNCATE instead of reporting.
    try {
      await a.query("BEGIN");
      const first = await insertPendingMessage(a, row("race"));
      // The second reads nothing for this key either -- the first has not
      // committed -- and goes to write. A read-then-write would insert here; the
      // unique index makes it wait for the first's fate and then yield to it.
      await b.query("BEGIN");
      let settled = false;
      const second = insertPendingMessage(b, row("race")).then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const heldBack = !settled;
      await a.query("COMMIT");
      const lost = await second;
      await b.query("COMMIT");

      assert.equal(heldBack, true, "the second is held behind the first's uncommitted row");
      assert.equal(first.deduplicated, false);
      assert.equal(lost.deduplicated, true);
      assert.equal(await count(a), 1);
    } finally {
      await a.query("ROLLBACK").catch(() => {});
      await b.query("ROLLBACK").catch(() => {});
    }
  });

  test("D16 a first attempt that rolls back leaves nothing to dedupe against", async () => {
    const a = await cluster.connect();
    const b = await cluster.connect();
    await a.query("BEGIN");
    await insertPendingMessage(a, row("retry-after-abort"));
    await a.query("ROLLBACK");

    const retried = await insertPendingMessage(b, row("retry-after-abort"));

    assert.equal(retried.deduplicated, false, "the first never happened, so the retry is the message");
    assert.equal(await count(b), 1);
  });
});
