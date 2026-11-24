// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Auto-delivery of ready results (`CLAW_ASSISTANT_AUTO_DELIVER`), against a real Postgres with the production schema, the worker's
 * and the router's own tools, the board over HTTP, and a GitHub that is a stub in this process. Skipped without DATABASE_URL, and a
 * skip is not a pass.
 *
 *   D1  a ready result is delivered as it lands: the item closes as accepted by policy with the version, holds no slot, the router is
 *       told there is nothing to accept, the board and the say's item show no Accept and the version delivered
 *   D2  a result that names a pull request the item watches keeps it open watching it: no slot, no Accept; a comment there sends it
 *       back to work and its next ready is v2, delivered again; a worker that only answers the news goes back to watching; the merge
 *       closes it as delivered and its watch ends; with two watched, the merge of one keeps it watching the other
 *   D3  what does not keep it open: a pull request the result names but the item does not watch, one it watched that is already
 *       closed, one it watches that the result does not name
 *   D4  a reply changes a delivered result (work_send): it reopens within the window, the worker gets the words and a new run's ready is
 *       v2; a stopped item, one the user accepted themselves and one delivered too long ago stay closed
 *   D5  a watch that ends without news (the user stops it), and one quiet for the idle days, close the item as delivered
 *   D6  a delivered result nobody said is said by the system, with the version and how to change it, once
 *   D7  switched off, a ready result waits for the user's Accept exactly as before
 *   D8  a watching item's worker gives up its sandbox's background work as one waiting for a person does
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const API = "https://api.github.test";
const PR_URL = "https://github.com/acme/app/pull/7";
const PR = "acme/app#7";

/** One pull request on a GitHub that lives in this process: comments, and whether it is closed. */
function fakeGithub() {
  const s = { state: "open", merged: false, comments: [] as Array<Record<string, unknown>> };
  let id = 500;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/repos/acme/app/pulls/7") {
      return json({
        state: s.state, merged: s.merged, head: { sha: "a".repeat(40), ref: "feat/x" }, base: { ref: "main" }, html_url: PR_URL,
        closed_at: s.state === "closed" ? new Date().toISOString() : null, merged_by: s.merged ? { login: "alice" } : null,
      });
    }
    if (path === "/repos/acme/app/issues/7/comments") return json(s.comments);
    if (path === "/user") return json({ login: "alice" });
    if (path.startsWith("/repos/acme/app/collaborators/")) return json({ permission: "write", role_name: "write" });
    if (path === "/repos/acme/app/pulls/7/comments" || path === "/repos/acme/app/pulls/7/reviews") return json([]);
    if (path.startsWith("/repos/acme/app/commits/")) return json({ total_count: 0, check_runs: [] });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return {
    s, fetchImpl,
    comment(body: string) {
      const at = new Date().toISOString();
      s.comments.push({ id: ++id, body, user: { login: "bob" }, created_at: at, updated_at: at, html_url: `${PR_URL}#issuecomment-${id}` });
    },
  };
}

describe("auto-delivery of ready results", { skip }, () => {
  let w: World;
  let ev: typeof import("../src/assistant/github-events.js");
  let gh: ReturnType<typeof fakeGithub>;
  let alice: { userId: string; routerSid: string };
  let app: FastifyInstance;

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_AUTO_DELIVER: "true", CLAW_ASSISTANT_MAX_ACTIVE_ITEMS: "2" });
    ev = await import("../src/assistant/github-events.js");
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
    });
    await registerAssistantRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_work_item_subscriptions, claw_work_item_github_events,
      claw_assistant_messages CASCADE`);
    w.drains.length = 0;
    w.events.length = 0;
    w.mod.workItems.deliveryPolicy.autoDeliver = true;
    gh = fakeGithub();
    ev.githubEventPorts.fetchImpl = gh.fetchImpl;
    ev.githubEventPorts.apiUrl = () => API;
    ev.githubEventPorts.loadToken = async () => "ghp_alice_token";
    alice = await w.user("alice");
  });

  const poll = async () => { await w.q("UPDATE claw_work_item_subscriptions SET polled_at = NULL"); return ev.pollDueSubscriptions(30); };
  const running = async () => Number((await w.q(`SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = 'alice' AND ${w.mod.workItems.RUNNING}`))[0].n);
  const board = async () => {
    const r = await app.inject({ method: "GET", url: "/v1/work-items", headers: { "x-test-user": "alice" } });
    assert.equal(r.statusCode, 200);
    return r.json().data as Array<Record<string, any>>;
  };
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) { assert.ok(err instanceof w.mod.tools.ToolRefused, `a fault, not a refusal: ${err}`); return (err as { code: string }).code; }
    return assert.fail("accepted");
  };
  /** The worker's report, through its own tool, in a live run of the item. */
  async function report(itemId: string, args: Record<string, unknown>) {
    const turn = await w.workerTurn(itemId);
    const out = await w.mod.tools.report(turn, args);
    await w.closeRun(turn.task_id);
    return out;
  }
  const ready = (itemId: string, summary: string, refs: Array<Record<string, string>> = [{ type: "commit", sha: "abc123" }]) =>
    report(itemId, { kind: "ready", summary, result: { refs } });
  /** The router's wake for the item's report, and the message is handed to the router's run. */
  async function routerWake(): Promise<string> {
    const msgs = await w.pending(alice.routerSid);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
    return msgs.map((m) => m.content as string).join("\n");
  }
  async function watched(title: string) {
    const it = await w.createItem(alice, title);
    const sub = await ev.subscribeItem({ userId: "alice", item: it.itemId, pr: PR });
    return { ...it, subId: sub.sub_id };
  }

  test("D1 a ready result closes the item as delivered by policy, with nothing to accept anywhere", async () => {
    const it = await w.createItem(alice, "Fix the flaky test");
    assert.equal(await running(), 1);
    assert.equal((await ready(it.itemId, "Pushed the fix to branch fix-flaky.")).item_state, "done");

    const row = await w.item(it.itemId);
    assert.deepEqual(
      [row.board_state, row.outcome, Number(row.result_version), Number(row.accepted_version), row.params.delivered, row.params.watching_pr],
      ["done", "accepted", 1, 1, 1, undefined],
    );
    assert.ok(row.closed_at, "closed");
    const evs = await w.itemEvents(it.itemId);
    assert.deepEqual(evs.slice(-2).map((e) => [e.kind, e.source]), [["ready", "worker"], ["accepted", "policy"]]);
    assert.deepEqual(evs.at(-1)!.result, { version: 1 });
    assert.equal(await running(), 0, "the slot is free");

    const wake = await routerWake();
    assert.ok(wake.includes("ready v1: Pushed the fix to branch fix-flaky."), wake);
    assert.ok(wake.includes("Claw delivered this result: there is nothing for the user to accept and no Accept button."), wake);
    assert.ok(wake.includes("send such a reply to this item with work_send, which opens it again within 7 days"), wake);
    // The router's item list says so too, in the words it reads.
    const listed = w.mod.role.routerManifest ? await w.mod.role.routerManifest("alice") : [];
    const line = (await import("../src/assistant/prompts.js")).formatManifestLine(listed.find((i) => i.itemId === it.itemId)!);
    assert.ok(line.includes("closed, result v1 delivered with nothing to accept; needs nothing."), line);

    const [b] = await board();
    assert.deepEqual([b.board_state, b.outcome, b.can_accept, b.accepted_version], ["done", "accepted", false, 1]);

    // The router's message about it carries the item as delivered, with no Accept.
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn, { text: "#1 Fix the flaky test: v1 delivered.", item_id: it.itemId }, w.sayDeps);
    const said = w.events.find((e) => e.payload?.item?.item_id === it.itemId || e.item?.item_id === it.itemId);
    const item = (said?.payload ?? said)?.item;
    assert.deepEqual([item?.can_accept, item?.delivered_version, item?.watching_pr], [false, 1, undefined], JSON.stringify(said));
  });

  test("D2 a result naming a watched pull request watches it until it closes; news makes v2; the merge delivers it", async () => {
    const it = await watched("Open the parser PR");
    assert.equal((await ready(it.itemId, "Opened the PR.", [{ type: "pull_request", url: PR_URL }])).item_state, "in_progress");
    let row = await w.item(it.itemId);
    assert.deepEqual(
      [row.board_state, row.outcome, Number(row.accepted_version), row.params.delivered, row.params.watching_pr],
      ["in_progress", null, 1, 1, [PR]],
    );
    assert.equal(await running(), 0, "watching holds no slot");
    assert.deepEqual((await w.itemEvents(it.itemId)).at(-1)!.result, { version: 1, watching_pr: [PR] });
    const wake = await routerWake();
    assert.ok(wake.includes(`The item stays open watching ${PR}`), wake);
    const [b] = await board();
    assert.deepEqual([b.board_state, b.can_accept, b.params.watching_pr], ["in_progress", false, [PR]]);
    const listed = (await w.mod.role.routerManifest("alice")).find((i) => i.itemId === it.itemId)!;
    assert.match((await import("../src/assistant/prompts.js")).itemStatus(listed), /^result v1 delivered with nothing to accept; still watching acme\/app#7/);
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn, { text: "#1 v1 delivered, still watching acme/app#7.", item_id: it.itemId }, w.sayDeps);
    const said = w.events.find((e) => (e.payload ?? e)?.item?.item_id === it.itemId);
    assert.deepEqual([(said?.payload ?? said)?.item?.delivered_version, (said?.payload ?? said)?.item?.watching_pr], [1, [PR]]);

    // A reviewer's comment: the item goes back to work under a new generation, and the worker gets the comment.
    const gen = Number(row.generation);
    gh.comment("Please rename foo.");
    assert.equal((await poll()).delivered, 1);
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, Number(row.generation), row.params.watching_pr, row.params.delivered], ["in_progress", gen + 1, undefined, 1]);
    assert.equal(await running(), 1, "worked on again, it holds a slot");
    const [msg] = await w.pending(it.workerSid);
    assert.ok(msg.content.includes("Please rename foo."));
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);

    // Its fix is v2, delivered again, and it watches again.
    await ready(it.itemId, "Renamed foo.", [{ type: "pull_request", url: PR_URL }]);
    row = await w.item(it.itemId);
    assert.deepEqual([Number(row.result_version), Number(row.accepted_version), row.params.delivered, row.params.watching_pr], [2, 2, 2, [PR]]);
    assert.ok((await routerWake()).includes("ready v2: Renamed foo."));

    // A question on the pull request it only answers: waiting with nothing to ask goes back to watching, with no new version.
    gh.comment("Why foo?");
    await poll();
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);
    assert.equal((await w.item(it.itemId)).params.watching_pr, undefined);
    await report(it.itemId, { kind: "waiting", summary: "Answered the question on the PR." });
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, Number(row.result_version), row.params.watching_pr, row.params.delivered], ["in_progress", 2, [PR], 2]);
    assert.equal(await running(), 0);
    assert.equal(await routerWake(), "", "nothing for the router");

    // The merge: the item closes as delivered, nothing reaches the worker, and its watch ends.
    Object.assign(gh.s, { state: "closed", merged: true });
    await poll();
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.outcome, Number(row.accepted_version), row.params.watching_pr, row.params.delivered], ["done", "accepted", 2, undefined, 2]);
    const last = (await w.itemEvents(it.itemId)).at(-1)!;
    assert.deepEqual([last.kind, last.source, last.summary], ["accepted", "policy", `${PR}: the pull request was merged`]);
    assert.equal((await w.pending(it.workerSid)).length, 0);
    assert.deepEqual((await w.q("SELECT state FROM claw_work_item_subscriptions"))[0].state, "ended");
    const [e] = (await w.q("SELECT kind, drop_reason FROM claw_work_item_github_events WHERE kind = 'pr_closed'"));
    assert.deepEqual([e.kind, e.drop_reason], ["pr_closed", "item_closed"]);
  });

  test("D2b with two pull requests watched, the merge of one keeps the item watching the other", async () => {
    const it = await watched("Two PRs");
    await ev.subscribeItem({ userId: "alice", item: it.itemId, pr: "acme/app#8" });
    await ready(it.itemId, "Opened both.", [{ type: "pull_request", url: PR_URL }, { type: "pull_request", url: "https://github.com/acme/app/pull/8" }]);
    assert.deepEqual((await w.item(it.itemId)).params.watching_pr, [PR, "acme/app#8"]);
    Object.assign(gh.s, { state: "closed", merged: true });
    await poll();
    let row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.params.watching_pr], ["in_progress", ["acme/app#8"]], "still watching the open one");
    assert.equal(await running(), 0);
    assert.equal((await w.pending(it.workerSid)).length, 0, "a closing alone wakes nobody");
    const [closing] = await w.q("SELECT drop_reason FROM claw_work_item_github_events WHERE kind = 'pr_closed'");
    assert.equal(closing.drop_reason, "still_watching");
    // The other one ends too: the item closes as delivered.
    const [other] = await w.q("SELECT id FROM claw_work_item_subscriptions WHERE number = 8");
    await ev.endSubscription("alice", it.itemId, Number(other.id));
    await poll();
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.outcome], ["done", "accepted"]);
  });

  test("D9 a watching item stopped and then retried is worked on again: it holds a slot and no watch closes it", async () => {
    const { retryWorkItem } = await import("../src/assistant/retry.js");
    const it = await watched("Stop then retry");
    await ready(it.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    assert.deepEqual((await w.item(it.itemId)).params.watching_pr, [PR]);
    assert.equal((await w.mod.workItems.stopWorkItem({ userId: "alice", itemId: it.itemId, source: "user" })).status, "ok");
    let row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.outcome, row.params.watching_pr, row.params.delivered], ["done", "stopped", undefined, undefined]);
    await poll();
    assert.equal((await retryWorkItem("alice", it.itemId)).status, "ok");
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.params.watching_pr, row.params.delivered], ["in_progress", undefined, undefined]);
    assert.equal(await running(), 1, "the retried item holds a slot");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);
    await poll();
    assert.equal(await ev.closeEndedWatches(), 0);
    assert.equal((await w.item(it.itemId)).board_state, "in_progress", "no watch closes it under the retried worker");
    // The retried worker's own result is what closes it, delivered (its watch ended with the stop).
    assert.equal((await ready(it.itemId, "Fixed again.", [{ type: "pull_request", url: PR_URL }])).item_state, "done");
    row = await w.item(it.itemId);
    assert.deepEqual([row.outcome, Number(row.accepted_version), row.params.delivered], ["accepted", 2, 2]);

    // A row stopped before stops cleared the marks: Retry clears them itself.
    const old = await watched("Stopped long ago");
    await ready(old.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    await w.mod.workItems.stopWorkItem({ userId: "alice", itemId: old.itemId, source: "user" });
    await w.q(`UPDATE claw_work_items SET params = params || '{"delivered": 1, "watching_pr": ["acme/app#7"]}'::jsonb WHERE item_id = $1`, [old.itemId]);
    assert.equal((await retryWorkItem("alice", old.itemId)).status, "ok");
    row = await w.item(old.itemId);
    assert.deepEqual([row.board_state, row.params.watching_pr, row.params.delivered], ["in_progress", undefined, undefined]);
  });

  test("D10 a run that starts on a watching item, whatever started it, ends the watching: it holds a slot and no watch closes it", async () => {
    const it = await watched("Run starts");
    await ready(it.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    assert.equal(await running(), 0);
    const turn = await w.workerTurn(it.itemId);
    const row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.params.watching_pr, row.params.delivered], ["in_progress", undefined, 1]);
    assert.equal(await running(), 1);
    await ev.endSubscription("alice", it.itemId, it.subId);
    assert.equal(await ev.closeEndedWatches(), 0, "not closed under the run");
    // Its report still lands, and with nothing watched any more its ready closes it as delivered.
    await w.mod.tools.report(turn, { kind: "ready", summary: "Done.", result: { refs: [{ type: "pull_request", url: PR_URL }] } });
    assert.deepEqual([(await w.item(it.itemId)).board_state, (await w.item(it.itemId)).outcome], ["done", "accepted"]);
  });

  test("D3 only a watched, still watched pull request the result names keeps the item open", async () => {
    // Named, not watched.
    const a = await w.createItem(alice, "Comment on a PR");
    assert.equal((await ready(a.itemId, "Commented.", [{ type: "pull_request", url: PR_URL }])).item_state, "done");
    // Watched, not named.
    const b = await watched("Watch but deliver a commit");
    assert.equal((await ready(b.itemId, "Pushed.", [{ type: "commit", sha: "abc" }])).item_state, "done");
    // Watched and named, but the watch already ended (the pull request was closed).
    const c = await w.createItem(alice, "Closed PR");
    const sub = await ev.subscribeItem({ userId: "alice", item: c.itemId, pr: PR });
    await w.q("UPDATE claw_work_item_subscriptions SET state = 'ended', end_reason = 'pr_merged' WHERE id = $1", [sub.sub_id]);
    assert.equal((await ready(c.itemId, "Done.", [{ type: "pull_request", url: "acme/APP#7" }])).item_state, "done");
    for (const it of [a, b, c]) assert.equal((await w.item(it.itemId)).params.watching_pr, undefined);
  });

  test("D4 a reply changes a delivered result; stopped, user-accepted and old items stay closed", async () => {
    const it = await w.createItem(alice, "Write the report");
    await ready(it.itemId, "Report pushed.");
    const before = await w.item(it.itemId);
    const turn = await w.routerTurn(alice);
    const sent = await w.mod.tools.workSend(turn, { item_id: `#${it.seq}`, text: "Add a summary table." });
    assert.equal(sent.status, "in_progress");
    let row = await w.item(it.itemId);
    assert.deepEqual(
      [row.board_state, row.outcome, row.closed_at, Number(row.generation), row.params.delivered],
      ["in_progress", null, null, Number(before.generation) + 1, undefined],
    );
    const [msg] = await w.pending(it.workerSid);
    assert.equal(msg.content, "Add a summary table.");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);
    await ready(it.itemId, "Added the table.");
    row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, Number(row.result_version), Number(row.accepted_version)], ["done", 2, 2]);

    // Stopped by the user: closed for good.
    const stopped = await w.createItem(alice, "Stopped one");
    assert.equal((await w.mod.workItems.stopWorkItem({ userId: "alice", itemId: stopped.itemId, source: "user" })).status, "ok");
    assert.equal(await code(w.mod.tools.workSend(await w.routerTurn(alice), { item_id: stopped.itemId, text: "go on" })), "item_closed");
    // Delivered, then stopped while watching: closed for good too.
    const watchedStop = await watched("Watch then stop");
    await ready(watchedStop.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    await w.mod.workItems.stopWorkItem({ userId: "alice", itemId: watchedStop.itemId, source: "user" });
    assert.equal(await code(w.mod.tools.workSend(await w.routerTurn(alice), { item_id: watchedStop.itemId, text: "go on" })), "item_closed");
    // Accepted by the user (the old way): closed.
    w.mod.workItems.deliveryPolicy.autoDeliver = false;
    const manual = await w.createItem(alice, "Accepted by hand");
    await ready(manual.itemId, "Done by hand.");
    assert.equal((await w.mod.workItems.acceptWorkItem("alice", manual.itemId, 1)).status, "ok");
    w.mod.workItems.deliveryPolicy.autoDeliver = true;
    assert.equal(await code(w.mod.tools.workSend(await w.routerTurn(alice), { item_id: manual.itemId, text: "more" })), "item_closed");
    // Delivered more than seven days ago: closed.
    const old = await w.createItem(alice, "Old one");
    await ready(old.itemId, "Old result.");
    await w.q("UPDATE claw_work_items SET closed_at = NOW() - INTERVAL '8 days' WHERE item_id = $1", [old.itemId]);
    assert.equal(await code(w.mod.tools.workSend(await w.routerTurn(alice), { item_id: old.itemId, text: "more" })), "item_closed");
    for (const x of [stopped, watchedStop, manual, old]) assert.equal((await w.item(x.itemId)).board_state, "done");
  });

  test("D5 a watch that ends without news, or stays quiet for the idle days, closes the item as delivered", async () => {
    const a = await watched("Unwatched");
    await ready(a.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    await ev.endSubscription("alice", a.itemId, a.subId);
    const b = await w.createItem(alice, "Quiet");
    const subB = await ev.subscribeItem({ userId: "alice", item: b.itemId, pr: "acme/app#8" });
    await ready(b.itemId, "Opened.", [{ type: "pull_request", url: "https://github.com/acme/app/pull/8" }]);
    assert.equal((await w.item(b.itemId)).params.watching_pr[0], "acme/app#8");
    assert.equal(await ev.closeEndedWatches(), 1, "only the one that watches nothing");
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '8 days' WHERE item_id = $1", [b.itemId]);
    assert.equal(await ev.closeEndedWatches(), 1);
    for (const [it, why] of [[a, "it no longer watches a pull request"], [b, "nothing new on its pull request for 7 days"]] as const) {
      const row = await w.item(it.itemId);
      assert.deepEqual([row.board_state, row.outcome, row.params.watching_pr], ["done", "accepted", undefined]);
      assert.equal((await w.itemEvents(it.itemId)).at(-1)!.summary, why);
    }
    assert.equal((await w.q("SELECT state FROM claw_work_item_subscriptions WHERE id = $1", [subB.sub_id]))[0].state, "ended");
  });

  test("D6 a delivered result nobody said is said by the system, once, with the version and how to change it", async () => {
    await w.subscribe("alice");
    const it = await w.createItem(alice, "Bump the version");
    await ready(it.itemId, "Bumped to 1.2.3 in the release PR.");
    const w2 = await watched("Open the PR");
    await ready(w2.itemId, "Opened the PR.", [{ type: "pull_request", url: PR_URL }]);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '10 minutes'");
    assert.equal(await w.mod.silent.tellSilentItems(60), 2);
    const says = await w.q("SELECT item_id, text FROM claw_assistant_says WHERE fallback ORDER BY created_at");
    const textOf = (id: string) => says.find((s) => s.item_id === id)?.text as string;
    assert.equal(textOf(it.itemId), `#${it.seq} "Bump the version" v1 delivered: Bumped to 1.2.3 in the release PR.\nReply to me to have it changed.`);
    assert.equal(textOf(w2.itemId), `#${w2.seq} "Open the PR" v1 delivered; still watching ${PR}: Opened the PR.\nReply to me to have it changed.`);
    assert.equal(await w.mod.silent.tellSilentItems(60), 0, "once");
  });

  test("D7 switched off, a ready result waits for the user's Accept as before", async () => {
    w.mod.workItems.deliveryPolicy.autoDeliver = false;
    const it = await watched("Old way");
    assert.equal((await ready(it.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }])).item_state, "needs_you");
    const row = await w.item(it.itemId);
    assert.deepEqual([row.board_state, row.outcome, row.accepted_version, row.params.delivered, row.params.watching_pr], ["needs_you", null, null, undefined, undefined]);
    assert.deepEqual((await w.itemEvents(it.itemId)).map((e) => e.kind), ["created", "run_started", "ready"]);
    assert.equal(await running(), 1);
    const [b] = await board();
    assert.equal(b.can_accept, true);
    assert.ok(!(await routerWake()).includes("Claw delivered"));
    const turn = await w.routerTurn(alice);
    await w.mod.tools.workSend(turn, { item_id: it.itemId, text: "x" });
    await w.mod.workItems.stopWorkItem({ userId: "alice", itemId: it.itemId, source: "user" });
    assert.equal(await code(w.mod.tools.workSend(await w.routerTurn(alice), { item_id: it.itemId, text: "y" })), "item_closed");
  });

  test("D8 a watching item's worker gives up background work in its sandbox as one waiting for a person does", async () => {
    const it = await watched("Sandbox");
    await ready(it.itemId, "Opened.", [{ type: "pull_request", url: PR_URL }]);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '1 hour' WHERE item_id = $1", [it.itemId]);
    const released = await w.mod.sweeper.waitingItemPastRelease(it.workerSid, 60);
    assert.deepEqual([released?.itemId, released?.boardState], [it.itemId, "in_progress"]);
    // Worked on again, it keeps it.
    gh.comment("one more");
    await poll();
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.workerSid]);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '1 hour' WHERE item_id = $1", [it.itemId]);
    assert.equal(await w.mod.sweeper.waitingItemPastRelease(it.workerSid, 60), null);
  });
});
