// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A new item about a pull request watches it from the start (`watchNamedPullRequests`, through the router's `work_create`), on a
 * real Postgres with the assistant and GitHub events on. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   A1  work_create whose brief links a pull request makes the item watch it, read-only, and says so in its result
 *   A2  a brief that names no pull request, or more than three, watches none; one named twice is watched once
 *   A3  a subscription refused (the user's limit) leaves the item standing and says why
 *   A4  pullRequestsNamedIn reads links and owner/repo#n among any punctuation, never a partial name, in one pass over a long text
 *   A5  a user whose GitHub token the loop cannot read gets no watch (it could only fail), and the result says why
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("pull requests watched by their items from the start", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let gh: typeof import("../src/assistant/github-events.js");

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_GITHUB_MAX_SUBSCRIPTIONS: "2" });
    gh = await import("../src/assistant/github-events.js");
    // Alice has a GitHub token the loop can read; Bob has none.
    gh.githubEventPorts.loadToken = async (userId) => (userId === "alice" ? "gh-token-alice" : null);
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_subscriptions, claw_work_item_github_events, claw_work_item_events, claw_work_items,
      claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE`);
    w.drains.length = 0;
    alice = await w.user("alice");
  });

  async function workCreate(turn: Claims, title: string, brief: string): Promise<{ isError: boolean; body: Record<string, any> }> {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createAssistantMcpServer(turn as never, false, false, false);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = await client.callTool({ name: "work_create", arguments: { title, brief } });
      return { isError: Boolean(res.isError), body: JSON.parse((res.content as Array<{ text: string }>)[0].text) };
    } finally {
      await client.close();
    }
  }
  const subs = async () => (await w.q("SELECT item_id, owner, repo, number, reply_allowed, state FROM claw_work_item_subscriptions ORDER BY id"));

  test("A1 an item whose brief links a pull request watches it from the start, read-only", async () => {
    const out = await workCreate(await w.routerTurn(alice), "盯 PR 291",
      "Follow up on https://github.com/AMD-AGI/PrimusClaw/pull/291/files: answer review comments and fix red CI.");
    assert.equal(out.isError, false, JSON.stringify(out.body));
    assert.deepEqual(out.body.watching, ["AMD-AGI/PrimusClaw#291"]);
    assert.deepEqual(await subs(), [{ item_id: out.body.item_id, owner: "AMD-AGI", repo: "PrimusClaw", number: 291, reply_allowed: false, state: "active" }]);
  });

  test("A2 none named, or more than three, watches none; one named twice is watched once", async () => {
    const plain = await workCreate(await w.routerTurn(alice), "Write the weekly report", "Summarise this week's merged work.");
    assert.equal(plain.body.watching, undefined);
    const many = await workCreate(await w.routerTurn(alice), "Triage",
      "Look at a/b#1, a/b#2, a/b#3 and a/b#4 and tell me which matter.");
    assert.equal(many.body.watching, undefined);
    assert.deepEqual(await subs(), []);
    const twice = await workCreate(await w.routerTurn(alice), "AMD-AGI/PrimusClaw#12",
      "Fix amd-agi/primusclaw#12 (https://github.com/AMD-AGI/PrimusClaw/pull/12).");
    assert.deepEqual(twice.body.watching, ["AMD-AGI/PrimusClaw#12"]);
    assert.equal((await subs()).length, 1);
  });

  test("A3 a refused subscription leaves the item standing and says why", async () => {
    await workCreate(await w.routerTurn(alice), "one", "Fix o/r#1 and o/r#2.");
    const out = await workCreate(await w.routerTurn(alice), "two", "Fix o/r#3.");
    assert.equal(out.isError, false);
    assert.ok(out.body.item_id);
    assert.deepEqual(out.body.not_watched, [{ pr: "o/r#3", error: "too_many_subscriptions" }]);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items"))[0].n, 2);
  });

  test("A5 a user without a GitHub token the loop can read gets no watch, and is told why", async () => {
    const bob = await w.user("bob");
    const out = await workCreate(await w.routerTurn(bob), "Fix PR 7", "Fix https://github.com/o/r/pull/7.");
    assert.equal(out.isError, false);
    assert.equal(out.body.watching, undefined);
    assert.deepEqual(out.body.not_watched, [{ pr: "o/r#7", error: "no_github_token" }]);
    assert.deepEqual(await subs(), []);
  });

  test("A4 pullRequestsNamedIn reads full names among any punctuation, in one pass", () => {
    const names = (t: string) => gh.pullRequestsNamedIn(t).map((r) => `${r.owner}/${r.repo}#${r.number}`);
    assert.deepEqual(names("看一下 AMD-AGI/PrimusClaw#307，还有（https://github.com/o/r/pull/9）。"), ["AMD-AGI/PrimusClaw#307", "o/r#9"]);
    assert.deepEqual(names("PR #307, repo/x, o/r#x, https://gitlab.com/o/r/pull/1, https://github.com/o/r/issues/2"), []);
    assert.deepEqual(names("o/r#5. O/R#5! o/r#6?"), ["o/r#5", "o/r#6"]);
    const long = `${"a".repeat(200_000)} ${"a/".repeat(50_000)}b#1 ${"x-".repeat(100_000)}`;
    const started = Date.now();
    assert.deepEqual(names(long), []);
    assert.ok(Date.now() - started < 2000, "linear in the text");
  });
});
