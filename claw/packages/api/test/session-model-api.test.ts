// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session chooses its own model: create, read, update, and what a turn is given.
 *
 * Runs against a real PostgreSQL engine (PGlite) behind the real routes, because
 * the properties here are a column that is written, read back and cleared, and a
 * stubbed database would only show that some statement was sent.
 *
 * Coverage:
 *   V1 every spelling of `model` the create route accepts or refuses (table-driven)
 *   V2 the same table against PATCH, with the row left as it was on a refusal
 *   C1 create stores the choice; GET and the list report it; null means "default"
 *   C2 a create that carries a first message dispatches it on that model
 *   P1 PATCH sets, replaces and clears the model, with or without a rename
 *   P2 PATCH keeps its old contract: a rename alone, and a blank name still refused
 *   P3 only the owner may change it, and a missing session is a 404
 *   P4 a change is the next turn's model, not the running one's
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { SESSION_MODEL_MAX_LENGTH } from "../src/sessions/session-model.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};
const OTHER: UserInfo = {
  userId: "u-2", userName: "u-2", roles: ["default"], platformKey: "pk2", virtualKey: "vk-u-2",
};

let h: Harness;
let pristinePorts: Record<string, unknown> | null = null;
let originalConnect: typeof db.pool.connect;
let published: Record<string, unknown>[] = [];

before(async () => {
  h = await startHarness();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  // The message routes flip the gate in a transaction on their own connection,
  // which a `db.query` substitution never sees.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  if (pristinePorts) Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect;
  await h?.close();
});

async function appAs(user: UserInfo): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = user;
  });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

async function storedModel(sessionId: string): Promise<unknown> {
  const rows = await h.sql("SELECT model FROM claw_sessions WHERE session_id = $1", [sessionId]);
  assert.equal(rows.length, 1, `no session ${sessionId}`);
  return rows[0].model;
}

async function sessionCount(): Promise<number> {
  return Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0].n);
}

/** What the gateway names, and what a client might send instead. */
const ACCEPTED: Array<[string, unknown]> = [
  ["a gateway name with dots", "claude-sonnet-5.5"],
  ["a fallback alias", "glm-5-3-with-fallback"],
  ["every allowed separator", "vendor/model:tag.v1-x"],
  ["one character", "m"],
  ["exactly the longest length", "m".repeat(SESSION_MODEL_MAX_LENGTH)],
];
const REFUSED: Array<[string, unknown]> = [
  ["empty", ""],
  ["one over the longest length", "m".repeat(SESSION_MODEL_MAX_LENGTH + 1)],
  ["a space inside", "claude sonnet"],
  ["a space around it", " claude-sonnet-5.5"],
  ["a trailing newline", "claude-sonnet-5.5\n"],
  ["a quote", 'claude"x'],
  ["a shell metacharacter", "a;b"],
  ["a wildcard", "claude-*"],
  ["non-ASCII", "模型"],
  ["a number", 123],
  ["a boolean", true],
  ["an array", ["claude-sonnet-5.5"]],
  ["an object", { name: "claude-sonnet-5.5" }],
];

for (const [label, model] of ACCEPTED) {
  test(`V1 create accepts ${label}`, async () => {
    const app = await appAs(OWNER);
    try {
      const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s", model } });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { data: { session_id: string; model: string | null } };
      assert.equal(body.data.model, model);
      assert.equal(await storedModel(body.data.session_id), model, "and the column holds it");
    } finally {
      await app.close();
    }
  });
}

for (const [label, model] of REFUSED) {
  test(`V1 create refuses ${label}, and leaves no session behind`, async () => {
    const app = await appAs(OWNER);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/sessions",
        payload: { name: "s", model, message: { content: "hello" } },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.match((res.json() as { error: string }).error, /^model /);
      assert.equal(await sessionCount(), 0, "the refusal came before any row was written");
      assert.equal(published.length, 0, "and before any turn was dispatched");
    } finally {
      await app.close();
    }
  });
}

for (const [label, model] of ACCEPTED) {
  test(`V2 PATCH accepts ${label}`, async () => {
    await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
    const app = await appAs(OWNER);
    try {
      const res = await app.inject({ method: "PATCH", url: "/v1/sessions/s1", payload: { model } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((res.json() as { data: { model: string } }).data.model, model);
      assert.equal(await storedModel("s1"), model);
    } finally {
      await app.close();
    }
  });
}

for (const [label, model] of REFUSED) {
  test(`V2 PATCH refuses ${label}, and the session keeps the model it had`, async () => {
    await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
    await h.sql("UPDATE claw_sessions SET model = 'before', name = 'old' WHERE session_id = 's1'");
    const app = await appAs(OWNER);
    try {
      const res = await app.inject({
        method: "PATCH", url: "/v1/sessions/s1", payload: { name: "renamed", model },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(await storedModel("s1"), "before");
      const rows = await h.sql("SELECT name FROM claw_sessions WHERE session_id = 's1'");
      assert.equal(rows[0].name, "old", "a refused model refuses the rename that came with it");
    } finally {
      await app.close();
    }
  });
}

test("C1 create stores the choice; GET and the list report it; none means the default", async () => {
  const app = await appAs(OWNER);
  try {
    const chosen = (await app.inject({
      method: "POST", url: "/v1/sessions", payload: { name: "chosen", model: "claude-sonnet-5.5" },
    })).json() as { data: { session_id: string } };
    const defaulted = (await app.inject({
      method: "POST", url: "/v1/sessions", payload: { name: "plain" },
    })).json() as { data: { session_id: string; model: unknown } };
    const explicitNull = (await app.inject({
      method: "POST", url: "/v1/sessions", payload: { name: "null", model: null },
    })).json() as { data: { session_id: string; model: unknown } };

    assert.equal(defaulted.data.model, null, "the create answer says null, not a missing field");
    assert.equal(explicitNull.data.model, null);
    assert.equal(await storedModel(defaulted.data.session_id), null);
    assert.equal(await storedModel(explicitNull.data.session_id), null);

    const get = async (id: string) =>
      (await app.inject({ method: "GET", url: `/v1/sessions/${id}` })).json() as { data: { model: unknown } };
    assert.equal((await get(chosen.data.session_id)).data.model, "claude-sonnet-5.5");
    assert.equal((await get(defaulted.data.session_id)).data.model, null, "null, not absent: it is a field a client reads");

    const list = (await app.inject({ method: "GET", url: "/v1/sessions" })).json() as {
      data: Array<{ session_id: string; model: unknown }>;
    };
    const byId = new Map(list.data.map((s) => [s.session_id, s.model]));
    assert.equal(byId.get(chosen.data.session_id), "claude-sonnet-5.5");
    assert.equal(byId.get(defaulted.data.session_id), null);
  } finally {
    await app.close();
  }
});

test("C2 a create carrying a first message dispatches it on the chosen model", async () => {
  const cases: Array<{ name: string; model: string | undefined }> = [
    { name: "a chosen model", model: "claude-sonnet-5.5" },
    { name: "no choice", model: undefined },
  ];
  const app = await appAs(OWNER);
  try {
    for (const c of cases) {
      published = [];
      const res = await app.inject({
        method: "POST", url: "/v1/sessions",
        payload: { name: c.name, ...(c.model ? { model: c.model } : {}), message: { content: "hello" } },
      });
      assert.equal(res.statusCode, 200, `${c.name}: ${res.body}`);
      assert.equal(published.length, 1, `${c.name}: the first turn was not published`);
      if (c.model) assert.equal(published[0].model, c.model, c.name);
      else assert.equal("model" in published[0], false, `${c.name}: a session with no choice sends none`);
    }
  } finally {
    await app.close();
  }
});

test("P1 PATCH sets, replaces and clears the model, with or without a rename", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
  await h.sql("UPDATE claw_sessions SET name = 'keep' WHERE session_id = 's1'");
  const app = await appAs(OWNER);
  try {
    const patch = async (payload: Record<string, unknown>) => {
      const res = await app.inject({ method: "PATCH", url: "/v1/sessions/s1", payload });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as { data: { session_id: string; name: string; model: string | null } }).data;
    };
    const nameNow = async () => (await h.sql("SELECT name FROM claw_sessions WHERE session_id = 's1'"))[0].name;

    assert.deepEqual(await patch({ model: "claude-sonnet-5.5" }), {
      session_id: "s1", name: "keep", model: "claude-sonnet-5.5",
    });
    assert.equal(await nameNow(), "keep", "a model alone does not touch the name");

    assert.equal((await patch({ model: "glm-5-3-with-fallback" })).model, "glm-5-3-with-fallback");
    assert.equal(await storedModel("s1"), "glm-5-3-with-fallback");

    const both = await patch({ name: "renamed", model: "claude-haiku-5.5" });
    assert.deepEqual(both, { session_id: "s1", name: "renamed", model: "claude-haiku-5.5" });

    assert.equal((await patch({ model: null })).model, null, "null clears it back to the default");
    assert.equal(await storedModel("s1"), null);
    assert.equal(await nameNow(), "renamed");
  } finally {
    await app.close();
  }
});

test("P2 PATCH keeps its old contract: a rename alone, and a blank or missing name still refused", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
  await h.sql("UPDATE claw_sessions SET model = 'chosen' WHERE session_id = 's1'");
  const app = await appAs(OWNER);
  try {
    const rename = await app.inject({ method: "PATCH", url: "/v1/sessions/s1", payload: { name: "  new name  " } });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal((rename.json() as { data: { name: string } }).data.name, "new name");
    assert.equal(await storedModel("s1"), "chosen", "a rename alone leaves the model as it was");

    const refused: Array<[string, Record<string, unknown>]> = [
      ["an empty body", {}],
      ["a blank name", { name: "   " }],
      ["a blank name beside a valid model", { name: "", model: "claude-sonnet-5.5" }],
      ["a null name beside a valid model", { name: null, model: "claude-sonnet-5.5" }],
      ["unrelated fields only", { status: "archived" }],
    ];
    for (const [label, payload] of refused) {
      const res = await app.inject({ method: "PATCH", url: "/v1/sessions/s1", payload });
      assert.equal(res.statusCode, 400, `${label}: ${res.body}`);
      assert.equal((res.json() as { error: string }).error, "name is required", label);
    }
    assert.equal(await storedModel("s1"), "chosen", "none of the refusals changed it");
  } finally {
    await app.close();
  }
});

test("P3 only the owner may change the model, and a missing or deleted session is a 404", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
  await seedSession(h, "gone", { agentStatus: "idle", userId: OWNER.userId });
  await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 'gone'");
  const stranger = await appAs(OTHER);
  const owner = await appAs(OWNER);
  try {
    const denied = await stranger.inject({
      method: "PATCH", url: "/v1/sessions/s1", payload: { model: "claude-sonnet-5.5" },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(await storedModel("s1"), null, "another user's choice did not land");

    for (const id of ["nope", "gone"]) {
      const res = await owner.inject({ method: "PATCH", url: `/v1/sessions/${id}`, payload: { model: "x" } });
      assert.equal(res.statusCode, 404, `${id}: ${res.body}`);
    }
  } finally {
    await stranger.close();
    await owner.close();
  }
});

test("P4 a change takes effect from the next turn: the one running keeps what it was sent", async () => {
  const app = await appAs(OWNER);
  try {
    const created = (await app.inject({
      method: "POST", url: "/v1/sessions",
      payload: { name: "s", model: "first-model", message: { content: "one" } },
    })).json() as { data: { session_id: string } };
    const sid = created.data.session_id;
    assert.equal(published.length, 1);
    assert.equal(published[0].model, "first-model");

    const patched = await app.inject({ method: "PATCH", url: `/v1/sessions/${sid}`, payload: { model: "second-model" } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(published[0].model, "first-model", "the turn already sent is not rewritten");

    // The gate is held by the first turn; hand it back, as its completion would.
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sid]);
    const second = await app.inject({ method: "POST", url: `/v1/sessions/${sid}/messages`, payload: { content: "two" } });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(published.length, 2);
    assert.equal(published[1].model, "second-model");

    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sid]);
    await app.inject({ method: "PATCH", url: `/v1/sessions/${sid}`, payload: { model: null } });
    const third = await app.inject({ method: "POST", url: `/v1/sessions/${sid}/messages`, payload: { content: "three" } });
    assert.equal(third.statusCode, 200, third.body);
    assert.equal("model" in published[2], false, "cleared: the next turn carries none and Brain uses its default");
  } finally {
    await app.close();
  }
});
