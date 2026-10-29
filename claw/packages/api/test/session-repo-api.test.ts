// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session bound to a repository: `POST /v1/sessions` with `config.repo`.
 *
 * Against the real routes and a real PostgreSQL engine (PGlite), because the
 * properties are a value that is refused before any row exists, stored as sent,
 * and handed to Brain on the turn.
 *
 *   V1 the urls and branches the create route accepts, and what it stores
 *   V2 the ones it refuses (table-driven): 400, `config.repo...`, no row, no turn
 *   D1 a create with a first message hands Brain exactly `{url, branch}`, normalised
 *   D2 a session with no repository sends no `repo` field at all
 *   D3 the rest of `config` is untouched by the repo check
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
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

async function storedConfig(sessionId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql("SELECT config FROM claw_sessions WHERE session_id = $1", [sessionId]);
  assert.equal(rows.length, 1, `no session ${sessionId}`);
  return rows[0].config as Record<string, unknown>;
}

async function sessionCount(): Promise<number> {
  return Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0].n);
}

const U = "https://github.com/example-org/example-repo";

const ACCEPTED: Array<[string, unknown]> = [
  ["a url alone", { url: U }],
  ["a url with .git", { url: `${U}.git` }],
  ["a url and a branch", { url: U, branch: "main" }],
  ["a branch with slashes", { url: U, branch: "feat/session-repo-binding" }],
  ["an empty branch (the default)", { url: U, branch: "" }],
  ["a null branch", { url: U, branch: null }],
  ["another host", { url: "https://git.example.invalid/team/tool" }],
  ["no repository at all", undefined],
  ["a null repository", null],
];

const REFUSED: Array<[string, unknown]> = [
  ["a string instead of an object", U],
  ["an array", [{ url: U }]],
  ["no url", { branch: "main" }],
  ["an empty object", {}],
  ["http", { url: "http://github.com/example-org/example-repo" }],
  ["an ssh url", { url: "git@github.com:example-org/example-repo.git" }],
  ["a credential in the url", { url: "https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/example-org/example-repo" }],
  ["a user and password in the url", { url: "https://u:p@github.com/example-org/example-repo" }],
  ["a query", { url: `${U}?x=1` }],
  ["a fragment", { url: `${U}#main` }],
  ["a space in the url", { url: `${U} x` }],
  ["a newline in the url", { url: `${U}\n` }],
  ["only an owner", { url: "https://github.com/example-org" }],
  ["a trailing slash", { url: `${U}/` }],
  ["a dot-dot name", { url: "https://github.com/example-org/.." }],
  ["a url that is not a string", { url: 5 }],
  ["a leading-dash branch", { url: U, branch: "-f" }],
  ["a dot-dot branch", { url: U, branch: "a..b" }],
  ["a branch with a space", { url: U, branch: "my branch" }],
  ["a branch with a newline", { url: U, branch: "main\nx" }],
  ["a branch that is not a string", { url: U, branch: 7 }],
  ["an unknown key", { url: U, setup: "npm ci" }],
];

for (const [label, repo] of ACCEPTED) {
  test(`V1 create accepts ${label}, and stores it as sent`, async () => {
    const app = await appAs(OWNER);
    try {
      const config = repo === undefined ? { notify_on_finish: true } : { notify_on_finish: true, repo };
      const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s", config } });
      assert.equal(res.statusCode, 200, res.body);
      const id = (res.json() as { data: { session_id: string } }).data.session_id;
      assert.deepEqual(await storedConfig(id), config);
    } finally {
      await app.close();
    }
  });
}

for (const [label, repo] of REFUSED) {
  test(`V2 create refuses ${label}, and leaves no session and no turn behind`, async () => {
    const app = await appAs(OWNER);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/sessions",
        payload: { name: "s", config: { repo }, message: { content: "hello" } },
      });
      assert.equal(res.statusCode, 400, res.body);
      const body = res.json() as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /^config\.repo/);
      assert.equal(body.error.includes("ghp_"), false, "the answer does not echo a credential back");
      assert.equal(await sessionCount(), 0, "the refusal came before any row was written");
      assert.equal(published.length, 0, "and before any turn was dispatched");
    } finally {
      await app.close();
    }
  });
}

test("D1 a create with a first message hands Brain exactly the repository, normalised", async () => {
  const cases: Array<{ name: string; repo: Record<string, unknown>; expected: Record<string, unknown> }> = [
    { name: "url and branch", repo: { url: U, branch: "release/1.2" }, expected: { url: U, branch: "release/1.2" } },
    { name: "url alone", repo: { url: `${U}.git` }, expected: { url: `${U}.git` } },
    { name: "an empty branch is dropped", repo: { url: U, branch: "" }, expected: { url: U } },
    { name: "a null branch is dropped", repo: { url: U, branch: null }, expected: { url: U } },
  ];
  const app = await appAs(OWNER);
  try {
    for (const c of cases) {
      published = [];
      const res = await app.inject({
        method: "POST", url: "/v1/sessions",
        payload: { name: c.name, config: { repo: c.repo }, message: { content: "git status && git branch" } },
      });
      assert.equal(res.statusCode, 200, `${c.name}: ${res.body}`);
      assert.equal(published.length, 1, `${c.name}: the first turn was not published`);
      assert.deepEqual(published[0].repo, c.expected, c.name);
    }
  } finally {
    await app.close();
  }
});

test("D2 a session with no repository sends no repo field at all", async () => {
  const app = await appAs(OWNER);
  try {
    for (const config of [undefined, {}, { notify_on_finish: true }, { repo: null }]) {
      published = [];
      const res = await app.inject({
        method: "POST", url: "/v1/sessions",
        payload: { name: "plain", ...(config === undefined ? {} : { config }), message: { content: "hello" } },
      });
      assert.equal(res.statusCode, 200, `${JSON.stringify(config)}: ${res.body}`);
      assert.equal(published.length, 1);
      assert.equal("repo" in published[0], false, `repo leaked for ${JSON.stringify(config)}`);
    }
  } finally {
    await app.close();
  }
});

test("D3 the rest of config is left as it was", async () => {
  const app = await appAs(OWNER);
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions",
      payload: { name: "s", config: { repo: { url: U, branch: "main" }, notify_on_finish: true, custom: { a: 1 } } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const id = (res.json() as { data: { session_id: string } }).data.session_id;
    assert.deepEqual(await storedConfig(id), { repo: { url: U, branch: "main" }, notify_on_finish: true, custom: { a: 1 } });
    // The reserved keys are still refused first, repo or no repo.
    const reserved = await app.inject({
      method: "POST", url: "/v1/sessions",
      payload: { name: "s", config: { repo: { url: U }, platform_key: "x" } },
    });
    assert.equal(reserved.statusCode, 400);
    assert.equal((reserved.json() as { error: string }).error, "config.platform_key is server-managed");
  } finally {
    await app.close();
  }
});
