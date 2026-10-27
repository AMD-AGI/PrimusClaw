// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Long-term memory is opt-in per user. Off (the default, and what a missing row
 * means) must mean: nothing injected into the prompt, nothing stored by any
 * writer. On must mean both work. Memories are only ever the owner's.
 *
 * Uses an in-memory fake of the three tables the code touches, so the tests
 * exercise the real SQL-shaped call sites rather than asserting on mocks of the
 * functions under test.
 */
process.env.CLAW_MEMORY_ENABLED = "true";

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

const { db } = await import("../src/infra/db.js");
const { insertMemoryEntry, getMemoryPreference, setMemoryPreference } = await import("../src/memory/service.js");
const { buildSystemContextParts, MEMORY_OFF_NOTICE } = await import("../src/sessions/context-builder.js");
const { registerMemoryRoutes } = await import("../src/routes/memory.js");

const originalQuery = db.query;
let prefs: Map<string, boolean>;
let memories: Array<{ id: number; user_id: string; category: string; content: string; deleted_at: string | null }>;
let inserts: number;

beforeEach(() => {
  prefs = new Map();
  memories = [];
  inserts = 0;
  db.query = (async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/FROM claw_user_memory_prefs/.test(sql)) {
      return { rows: prefs.has(params[0]) ? [{ enabled: prefs.get(params[0]) }] : [] };
    }
    if (/INSERT INTO claw_user_memory_prefs/.test(sql)) {
      prefs.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\) as cnt FROM claw_memory_entries/.test(sql)) {
      return { rows: [{ cnt: String(memories.filter(m => m.user_id === params[0] && !m.deleted_at).length) }] };
    }
    if (/INSERT INTO claw_memory_entries/.test(sql) && !/user_profile/.test(sql)) {
      inserts++;
      memories.push({ id: memories.length + 1, user_id: params[0], category: params[1], content: params[2], deleted_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM claw_memory_entries WHERE user_id = \$1 AND category = 'user_profile'/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM claw_memory_entries WHERE user_id = \$1 AND deleted_at IS NULL ORDER|FROM claw_memory_entries\s+WHERE user_id = \$1 AND deleted_at IS NULL/.test(sql)) {
      return { rows: memories.filter(m => m.user_id === params[0] && !m.deleted_at) };
    }
    if (/UPDATE claw_memory_entries SET deleted_at = NOW\(\) WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      const m = memories.find(x => String(x.id) === String(params[0]) && x.user_id === params[1] && !x.deleted_at);
      if (m) m.deleted_at = "now";
      return { rows: [], rowCount: m ? 1 : 0 };
    }
    if (/UPDATE claw_memory_entries SET access_count/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM claw_session_summaries/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
});
afterEach(async () => {
  // let the routes' background profile refresh finish against the fake
  await new Promise((r) => setTimeout(r, 20));
  db.query = originalQuery;
});

const entry = { category: "preference", content: "likes tabs over spaces", importance: 0.8 };

test("default is off: no row means no preference", async () => {
  assert.equal(await getMemoryPreference("alice"), false);
});

test("off: the write is refused and nothing is stored", async () => {
  assert.equal(await insertMemoryEntry("alice", entry), false);
  assert.equal(inserts, 0);
});

test("off: stored memories are not injected, and the agent is told memory is off", async () => {
  memories.push({ id: 1, user_id: "alice", category: "preference", content: "SECRET-FACT", deleted_at: null });
  const { parts, memoryTokens } = await buildSystemContextParts("s1", "alice");
  assert.equal(memoryTokens, 0);
  assert.ok(!parts.join("\n").includes("SECRET-FACT"));
  assert.ok(parts.includes(MEMORY_OFF_NOTICE));
});

test("on: the write is stored and the memory is injected", async () => {
  await setMemoryPreference("alice", true);
  assert.equal(await insertMemoryEntry("alice", entry), true);
  assert.equal(inserts, 1);
  const { parts } = await buildSystemContextParts("s1", "alice");
  assert.ok(parts.join("\n").includes("likes tabs over spaces"));
  assert.ok(!parts.includes(MEMORY_OFF_NOTICE));
});

test("turning it off again stops injection but keeps the rows readable", async () => {
  await setMemoryPreference("alice", true);
  await insertMemoryEntry("alice", entry);
  await setMemoryPreference("alice", false);
  const { parts } = await buildSystemContextParts("s1", "alice");
  assert.ok(!parts.join("\n").includes("likes tabs over spaces"));
  assert.equal(memories.length, 1);
});

test("one user's opt-in does not switch on another's", async () => {
  await setMemoryPreference("alice", true);
  assert.equal(await insertMemoryEntry("bob", entry), false);
});

async function appAs(userId: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => { (req as any).user = { userId }; });
  await registerMemoryRoutes(app);
  return app;
}

test("routes: toggle, list, delete; manual add is refused while off", async () => {
  const app = await appAs("alice");
  let r = await app.inject({ method: "GET", url: "/v1/users/me/memory-settings" });
  assert.equal(r.json().data.enabled, false);
  r = await app.inject({ method: "POST", url: "/v1/users/me/memories", payload: entry });
  assert.equal(r.statusCode, 409);
  r = await app.inject({ method: "PUT", url: "/v1/users/me/memory-settings", payload: { enabled: "yes" } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: "PUT", url: "/v1/users/me/memory-settings", payload: { enabled: true } });
  assert.equal(r.json().data.enabled, true);
  r = await app.inject({ method: "POST", url: "/v1/users/me/memories", payload: entry });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: "GET", url: "/v1/users/me/memories" });
  assert.equal(r.json().data.length, 1);
  const id = r.json().data[0].id;
  r = await app.inject({ method: "DELETE", url: `/v1/users/me/memories/${id}` });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: "GET", url: "/v1/users/me/memories" });
  assert.equal(r.json().data.length, 0);
});

test("routes: editing is refused while off, deleting is not", async () => {
  await setMemoryPreference("alice", true);
  await insertMemoryEntry("alice", entry);
  await setMemoryPreference("alice", false);
  const app = await appAs("alice");
  let r = await app.inject({ method: "PUT", url: "/v1/users/me/memories/1", payload: { content: "changed" } });
  assert.equal(r.statusCode, 409);
  assert.equal(memories[0].content, "likes tabs over spaces");
  r = await app.inject({ method: "DELETE", url: "/v1/users/me/memories/1" });
  assert.equal(r.statusCode, 200);
  assert.ok(memories[0].deleted_at);
});

test("routes: a user cannot see, delete or toggle another user's memory", async () => {
  await setMemoryPreference("alice", true);
  await insertMemoryEntry("alice", entry);
  const bob = await appAs("bob");
  for (const [method, url] of [
    ["GET", "/v1/users/alice/memories"],
    ["DELETE", "/v1/users/alice/memories/1"],
    ["DELETE", "/v1/users/alice/memories"],
    ["GET", "/v1/users/alice/memory-settings"],
    ["PUT", "/v1/users/alice/memory-settings"],
  ] as const) {
    const r = await bob.inject({ method, url, payload: method === "PUT" ? { enabled: false } : undefined });
    assert.equal(r.statusCode, 403, `${method} ${url}`);
  }
  assert.equal(prefs.get("alice"), true);
  assert.equal(memories[0].deleted_at, null);
  // and "me" for bob lists only bob's (none)
  const r = await bob.inject({ method: "GET", url: "/v1/users/me/memories" });
  assert.equal(r.json().data.length, 0);
});
