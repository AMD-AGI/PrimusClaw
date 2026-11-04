// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * GitHub events for work items (Super-agent P2), against a real Postgres with the production schema and a GitHub that is a stub
 * in this process. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   P1  the acceptance: a comment on a watched pull request is stored at the first poll, reaches the worker as one message without
 *       anyone mentioning it, and the worker's answer lands on the pull request exactly once, however often the comment is read
 *       again (a second poll, two polls at once) and however often the answer is replayed
 *   P2  an answer whose outcome was lost (GitHub wrote it and the reply went missing) is found on the pull request, not posted again
 *   P3  two answers to one event at once: one is posted, the other is told to wait
 *   P4  a review comment is answered under its thread (the thread's first comment), from the subscription's pull request
 *   R1  only the owner, signed in themselves, lets the worker answer without asking; nothing a model calls does
 *   R2  pr_reply is refused for a run that is not the item's current one, an ended turn, another item's event, an event not delivered,
 *       a finished item and the router
 *   R3  a review on someone's behalf is never subscribed, and its stored events are dropped, not delivered
 *   F1  what the loop keeps: only what is new since the subscription, never our own answers; CI only when the head failed; a closed
 *       pull request ends the subscription
 *   F2  a finished item's events are dropped with the reason and its subscriptions end
 *   F3  an item that waits for the user goes back to in progress; one in progress keeps its running turn's generation
 *   F4  past the wake limit events wait in the table and are delivered later, not lost
 *   F5  a pull request that cannot be read for ten minutes puts the item in front of the user, once
 *   H1  the routes: owner only, reply needs the person, a key can only take it away, a limit on subscriptions
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const API = "https://api.github.test";
const OWNER = "acme";
const REPO = "app";
const PR = 7;
const HEAD = "a".repeat(40);

interface Posted { method: string; path: string; body: string }

/** A pull request on a GitHub that lives in this process. */
function fakeGithub() {
  const s = {
    pr: { state: "open", merged: false, head: { sha: HEAD }, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}`, closed_at: null as string | null, merged_by: null as unknown },
    issueComments: [] as Array<Record<string, any>>,
    reviewComments: [] as Array<Record<string, any>>,
    reviews: [] as Array<Record<string, any>>,
    checkRuns: [] as Array<Record<string, any>>,
    posts: [] as Posted[],
    reads: 0,
    /** What the next POST does: write and answer, write and lose the answer (502), or refuse without writing. */
    nextPost: "ok" as "ok" | "lost" | "refuse",
    postDelayMs: 0,
    failReads: 0 as number,
  };
  let nextId = 1000;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  /** GitHub's list: by update time from `since`, oldest first, one page of `per_page`. */
  const since = (list: Array<Record<string, any>>, u: URL) => {
    const from = u.searchParams.get("since");
    const all = (from ? list.filter((c) => Date.parse(c.updated_at ?? c.created_at) >= Date.parse(from)) : list)
      .slice().sort((a, b) => Date.parse(a.updated_at ?? a.created_at) - Date.parse(b.updated_at ?? b.created_at));
    const page = Number(u.searchParams.get("page") ?? "1");
    const per = Number(u.searchParams.get("per_page") ?? "30");
    return all.slice((page - 1) * per, page * per);
  };
  const base = `/repos/${OWNER}/${REPO}`;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = u.pathname;
    if (method === "GET") {
      s.reads += 1;
      if (s.failReads > 0) { s.failReads -= 1; return json({ message: "Bad credentials" }, 401); }
      if (path === `${base}/pulls/${PR}`) return json(s.pr);
      if (path === `${base}/issues/${PR}/comments`) return json(since(s.issueComments, u));
      if (path === `${base}/pulls/${PR}/comments`) return json(since(s.reviewComments, u));
      if (path === `${base}/pulls/${PR}/reviews`) return json(Number(u.searchParams.get("page") ?? "1") > 1 ? [] : s.reviews);
      if (path === `${base}/commits/${HEAD}/check-runs`) return json({ total_count: s.checkRuns.length, check_runs: s.checkRuns });
      return json({ message: "Not Found" }, 404);
    }
    const body = JSON.parse(String(init?.body ?? "{}")).body as string;
    if (s.postDelayMs) await new Promise((r) => setTimeout(r, s.postDelayMs));
    const mode = s.nextPost;
    s.nextPost = "ok";
    if (mode === "refuse") return json({ message: "Validation Failed" }, 422);
    s.posts.push({ method, path, body });
    const now = new Date().toISOString();
    const id = nextId++;
    const comment = { id, body, user: { login: "alice" }, created_at: now, updated_at: now, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}#c${id}` };
    if (path === `${base}/issues/${PR}/comments`) s.issueComments.push(comment);
    else if (path.startsWith(`${base}/pulls/${PR}/comments/`) && path.endsWith("/replies")) {
      s.reviewComments.push({ ...comment, in_reply_to_id: Number(path.split("/").at(-2)) });
    } else return json({ message: "Not Found" }, 404);
    return mode === "lost" ? json({ message: "Server Error" }, 502) : json(comment, 201);
  }) as typeof fetch;
  let comments = 0;
  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
  return {
    s, fetchImpl, ago,
    comment(body: string, opts: { by?: string; ageSec?: number } = {}) {
      const at = ago(opts.ageSec ?? 0);
      const c = { id: 500 + ++comments, body, user: { login: opts.by ?? "bob" }, created_at: at, updated_at: at, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}#issuecomment-${500 + comments}` };
      s.issueComments.push(c);
      return c;
    },
    reviewComment(body: string, inReplyTo?: number) {
      const at = ago(0);
      const c = { id: 800 + ++comments, body, path: "src/a.ts", line: 42, user: { login: "carol" }, created_at: at, updated_at: at, html_url: "https://github.com/x#r", ...(inReplyTo ? { in_reply_to_id: inReplyTo } : {}) };
      s.reviewComments.push(c);
      return c;
    },
  };
}

describe("assistant GitHub events", { skip }, () => {
  let w: World;
  let ev: typeof import("../src/assistant/github-events.js");
  let mcp: typeof import("../src/assistant/mcp.js");
  let gh: ReturnType<typeof fakeGithub>;
  let tokens: Record<string, string | null>;
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  let app: FastifyInstance;

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_GITHUB_MAX_SUBSCRIPTIONS: "3" });
    ev = await import("../src/assistant/github-events.js");
    mcp = await import("../src/assistant/mcp.js");
    const { registerAssistantGithubEventRoutes } = await import("../src/routes/assistant-github-events.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
      const method = req.headers["x-test-auth"];
      if (typeof method === "string") (req as any).authMethod = method;
    });
    await registerAssistantGithubEventRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_notification_outbox, claw_work_item_subscriptions, claw_work_item_github_events, claw_work_item_pr_replies CASCADE`);
    w.drains.length = 0;
    gh = fakeGithub();
    tokens = { alice: "ghp_alice_token", bob: "ghp_bob_token" };
    ev.githubEventPorts.fetchImpl = gh.fetchImpl;
    ev.githubEventPorts.apiUrl = () => API;
    ev.githubEventPorts.loadToken = async (userId: string) => tokens[userId] ?? null;
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) { assert.ok(err instanceof w.mod.tools.ToolRefused, `a fault, not a refusal: ${err}`); return (err as { code: string }).code; }
    return assert.fail("accepted");
  };
  const count = async (table: string, where = "TRUE", params: unknown[] = []) => Number((await w.q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n);
  /** Every subscription due now, as the loop would find them a poll interval later. */
  const poll = async () => { await w.q("UPDATE claw_work_item_subscriptions SET polled_at = NULL"); return ev.pollDueSubscriptions(30); };
  const prRef = `${OWNER}/${REPO}#${PR}`;

  async function watched(opts: { reply?: boolean; user?: typeof alice } = {}) {
    const u = opts.user ?? alice;
    const item = await w.createItem(u, "Address the review");
    const sub = await ev.subscribeItem({ userId: u.userId, item: item.itemId, pr: prRef, reply: opts.reply ?? true });
    return { ...item, subId: sub.sub_id };
  }
  /** The worker's queued message was handed to a run, as the drain the stub stood in for would have done. */
  async function handedToRun(workerSid: string) {
    const msgs = await w.pending(workerSid);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [workerSid]);
    return msgs;
  }
  const events = (itemId: string) => w.q("SELECT * FROM claw_work_item_github_events WHERE item_id = $1 ORDER BY created_at, event_id", [itemId]);

  test("P1 a PR comment reaches the worker without a mention and is answered on the pull request exactly once", async () => {
    const it = await watched();
    const t0 = Date.now();
    const c = gh.comment("Please rename foo to bar in the parser.");

    const first = await poll();
    assert.deepEqual({ stored: first.stored, delivered: first.delivered }, { stored: 1, delivered: 1 });
    const [e] = await events(it.itemId);
    assert.equal(e.event_id, `gh:${it.subId}:issue_comment:${c.id}`);
    assert.equal(e.author, "bob");
    assert.ok(e.delivered_at, "delivered in the same poll that stored it");

    // Redelivery: the same comment read again, by a later poll and by two polls at once.
    await poll();
    await w.q("UPDATE claw_work_item_subscriptions SET polled_at = NULL");
    await Promise.all([ev.pollDueSubscriptions(30), ev.pollDueSubscriptions(30), ev.deliverPendingEvents()]);
    assert.equal(await count("claw_work_item_github_events"), 1, "one row, whoever read it");
    const queued = await w.pending(it.workerSid);
    assert.equal(queued.length, 1, "one message to the worker");
    assert.deepEqual(w.drains, [{ sessionId: it.workerSid, userId: "alice" }], "and one start, of the worker, not the router");
    assert.equal(await count("claw_pending_messages", "session_id = $1", [alice.routerSid]), 0, "the router is not in the path");
    const msg = queued[0];
    assert.ok(msg.content.startsWith(ev.GITHUB_EVENT_PREFIX));
    assert.ok(msg.content.includes(`event_id: ${e.event_id}`));
    assert.ok(msg.content.includes("   > Please rename foo to bar in the parser."), "the comment is quoted, not inlined");
    assert.ok(msg.content.includes("mcp__assistant__pr_reply"));
    assert.equal(msg.dedupe_key, `gh-batch:${e.event_id}`);
    assert.equal(msg.user_id, "alice");
    assert.equal(msg.platform_key, "pk-alice", "the turn runs as the owner, with the owner's own credentials");

    await handedToRun(it.workerSid);
    const turn = await w.workerTurn(it.itemId);
    const answer = await ev.prReply(turn, { event_id: e.event_id, body: "Renamed in the latest push." });
    assert.equal(answer.status, "posted");
    assert.equal(gh.s.posts.length, 1);
    assert.equal(gh.s.posts[0].path, `/repos/${OWNER}/${REPO}/issues/${PR}/comments`);
    assert.equal(gh.s.posts[0].body, `Renamed in the latest push.\n\n${ev.replyMarker(e.event_id)}`);
    assert.equal(answer.url, gh.s.issueComments.at(-1)?.html_url);

    // The tool call replayed, and the loop reading our own answer back: neither does anything.
    assert.deepEqual(await ev.prReply(turn, { event_id: e.event_id, body: "Renamed in the latest push." }), { ok: true, status: "already_posted", url: answer.url });
    await poll();
    assert.equal(gh.s.posts.length, 1, "posted exactly once");
    assert.equal(await count("claw_work_item_github_events"), 1, "our own answer is not an event");
    assert.equal((await w.pending(it.workerSid)).length, 0, "and wakes nobody");
    // The bound: the comment was stored at the first poll after it appeared, so the wait is at most one interval of the loop.
    assert.ok(Date.now() - t0 < 120_000);
  });

  test("P2 an answer GitHub wrote but whose reply was lost is found on the pull request, not posted again", async () => {
    const it = await watched();
    gh.comment("Is the cache invalidated on rename?");
    await poll();
    await handedToRun(it.workerSid);
    const [e] = await events(it.itemId);
    const turn = await w.workerTurn(it.itemId);
    gh.s.nextPost = "lost";
    assert.equal(await code(ev.prReply(turn, { event_id: e.event_id, body: "Yes." })), "reply_uncertain");
    assert.equal(await code(ev.prReply(turn, { event_id: e.event_id, body: "Yes." })), "reply_in_progress", "inside the lease: wait");
    await w.q("UPDATE claw_work_item_pr_replies SET attempt_at = NOW() - INTERVAL '2 minutes'");
    const again = await ev.prReply(turn, { event_id: e.event_id, body: "Yes." });
    assert.equal(again.status, "already_posted");
    assert.equal(gh.s.posts.length, 1, "looked for before sending again");
    assert.equal((await w.q("SELECT state FROM claw_work_item_pr_replies"))[0].state, "posted");

    // A refusal GitHub gave is certain: the event is free to be answered again.
    gh.comment("And on delete?");
    await poll();
    const second = (await events(it.itemId))[1];
    gh.s.nextPost = "refuse";
    assert.equal(await code(ev.prReply(turn, { event_id: second.event_id, body: "Also." })), "github_refused");
    assert.equal(await count("claw_work_item_pr_replies", "event_id = $1", [second.event_id]), 0);
    assert.equal((await ev.prReply(turn, { event_id: second.event_id, body: "Also." })).status, "posted");
  });

  test("P3 two answers to one event at once: one is posted", async () => {
    const it = await watched();
    gh.comment("ping");
    await poll();
    await handedToRun(it.workerSid);
    const [e] = await events(it.itemId);
    const turn = await w.workerTurn(it.itemId);
    gh.s.postDelayMs = 200;
    const results = await Promise.allSettled([
      ev.prReply(turn, { event_id: e.event_id, body: "pong" }), ev.prReply(turn, { event_id: e.event_id, body: "pong" }),
    ]);
    assert.equal(gh.s.posts.length, 1);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.status : (r.reason as { code: string }).code)).sort();
    assert.deepEqual(codes, ["posted", "reply_in_progress"]);
  });

  test("P4 a review comment is answered under its thread, on the subscription's pull request", async () => {
    const it = await watched();
    const root = gh.reviewComment("This loop is quadratic.");
    const follow = gh.reviewComment("Also the name is unclear.", root.id);
    await poll();
    await handedToRun(it.workerSid);
    const evs = await events(it.itemId);
    assert.deepEqual(evs.map((e) => [e.kind, e.path, e.line, e.reply_to]), [
      ["review_comment", "src/a.ts", 42, String(root.id)], ["review_comment", "src/a.ts", 42, String(root.id)],
    ]);
    const turn = await w.workerTurn(it.itemId);
    const reply = evs.find((e) => e.github_id === String(follow.id));
    await ev.prReply(turn, { event_id: reply.event_id, body: "Renamed." });
    assert.equal(gh.s.posts[0].path, `/repos/${OWNER}/${REPO}/pulls/${PR}/comments/${root.id}/replies`, "under the thread's first comment");
  });

  test("R1 only the owner, signed in, allows answers without asking; the router's tool never does", async () => {
    const item = await w.createItem(alice, "Fix it");
    const turn = await w.routerTurn(alice);
    const made = await ev.workSubscribe(turn, { item_id: `#${item.seq}`, pr: prRef, reply: true } as never);
    assert.equal(made.reply_allowed, false, "whatever the call carries");
    assert.equal(made.created, true);
    gh.comment("hello");
    await poll();
    await handedToRun(item.workerSid);
    const msg = (await events(item.itemId))[0];
    const worker = await w.workerTurn(item.itemId);
    assert.equal(await code(ev.prReply(worker, { event_id: msg.event_id, body: "hi" })), "reply_not_allowed");
    assert.equal(gh.s.posts.length, 0);
    // The same call again keeps it as it is, and a person allowing it makes it so.
    assert.equal((await ev.workSubscribe(turn, { item_id: item.itemId, pr: prRef })).created, false);
    await ev.subscribeItem({ userId: "alice", item: item.itemId, pr: prRef, reply: true });
    assert.equal((await ev.workSubscribe(turn, { item_id: item.itemId, pr: prRef })).reply_allowed, true, "the router keeps what the person set");
    assert.equal((await ev.prReply(worker, { event_id: msg.event_id, body: "hi" })).status, "posted");
  });

  test("R2 pr_reply is refused outside the item's current run and its delivered events", async () => {
    const it = await watched();
    const other = await watched({ user: bob });
    gh.comment("first");
    await poll();
    await handedToRun(it.workerSid);
    await handedToRun(other.workerSid);
    const [mine] = await events(it.itemId);
    const [theirs] = await events(other.itemId);
    const turn = await w.workerTurn(it.itemId);
    assert.equal(await code(ev.prReply(turn, { event_id: theirs.event_id, body: "x" })), "event_not_found", "another item's event");
    assert.equal(await code(ev.prReply(turn, { event_id: "gh:1:issue_comment:1", body: "x" })), "event_not_found");
    await w.q("UPDATE claw_work_item_github_events SET delivered_at = NULL WHERE event_id = $1", [mine.event_id]);
    assert.equal(await code(ev.prReply(turn, { event_id: mine.event_id, body: "x" })), "event_not_found", "an event the worker was never given");
    await w.q("UPDATE claw_work_item_github_events SET delivered_at = NOW() WHERE event_id = $1", [mine.event_id]);
    assert.equal(await code(ev.prReply({ ...turn, gen: (turn.gen as number) - 1 }, { event_id: mine.event_id, body: "x" })), "stale_run");
    assert.equal(await code(ev.prReply(await w.routerTurn(alice), { event_id: mine.event_id, body: "x" })), "not_allowed");
    assert.equal(await code(ev.workSubscribe(turn, { item_id: it.itemId, pr: prRef })), "not_allowed");
    assert.equal(await code(ev.prReply(turn, { event_id: mine.event_id, body: "x".repeat(ev.REPLY_BODY_MAX + 1) })), "body_too_long");
    await w.closeRun(turn.task_id);
    assert.equal(await code(ev.prReply(turn, { event_id: mine.event_id, body: "x" })), "turn_not_live");
    const live = await w.workerTurn(it.itemId);
    await w.q("UPDATE claw_work_items SET board_state = 'done', outcome = 'stopped' WHERE item_id = $1", [it.itemId]);
    assert.equal(await code(ev.prReply(live, { event_id: mine.event_id, body: "x" })), "item_closed");
    assert.equal(gh.s.posts.length, 0, "nothing reached GitHub");
    assert.equal(await count("claw_work_item_pr_replies"), 0);
  });

  test("R3 a review on someone's behalf is not subscribed, and its stored events are dropped", async () => {
    const it = await watched();
    await w.q("UPDATE claw_work_items SET kind = 'review' WHERE item_id = $1", [it.itemId]);
    await assert.rejects(ev.subscribeItem({ userId: "alice", item: it.itemId, pr: "acme/app#8" }), (e: any) => e.code === "not_a_task_item" && e.status === 400);
    gh.comment("a stranger's words");
    await poll();
    const [e] = await events(it.itemId);
    assert.equal(e.drop_reason, "not_a_task_item");
    assert.equal(e.delivered_at, null);
    assert.equal((await w.pending(it.workerSid)).length, 0, "no turn is started in it");
    assert.equal((await w.q("SELECT state FROM claw_work_item_subscriptions"))[0].state, "ended");
  });

  test("F1 only what is new and not ours; CI when the head failed; a closed pull request ends the watch", async () => {
    const it = await watched();
    // Written before the subscription and edited since: GitHub lists it by its update, and it is still not new.
    const old = gh.comment("before the subscription", { ageSec: 600 });
    old.updated_at = gh.ago(0);
    gh.comment(`our own answer\n\n${ev.replyMarker("gh:9:issue_comment:1")}`);
    gh.s.reviews.push({ id: 61, state: "COMMENTED", body: "", user: { login: "dan" }, submitted_at: gh.ago(0) });
    gh.s.reviews.push({ id: 62, state: "CHANGES_REQUESTED", body: "Needs tests", user: { login: "dan" }, submitted_at: gh.ago(0), html_url: "https://github.com/r" });
    gh.s.checkRuns.push({ name: "build", status: "completed", conclusion: "failure", completed_at: gh.ago(0), details_url: "https://ci/1" });
    gh.s.checkRuns.push({ name: "test", status: "in_progress", conclusion: null });
    await poll();
    assert.deepEqual((await events(it.itemId)).map((e) => [e.kind, e.body]), [["review", "CHANGES_REQUESTED: Needs tests"]], "not while CI still runs");

    gh.s.checkRuns[1] = { name: "test", status: "completed", conclusion: "success", completed_at: gh.ago(0) };
    await poll();
    await poll();
    const ci = (await events(it.itemId)).filter((e) => e.kind === "check_failed");
    assert.equal(ci.length, 1, "one event for the head, however often it is read");
    assert.equal(ci[0].body, "build: failure");
    assert.equal(ci[0].url, "https://ci/1");
    assert.equal(ci[0].event_id, `gh:${it.subId}:check_failed:${HEAD}`);

    Object.assign(gh.s.pr, { state: "closed", merged: true, merged_by: { login: "erin" }, closed_at: gh.ago(0) });
    await poll();
    const sub = (await w.q("SELECT * FROM claw_work_item_subscriptions"))[0];
    assert.deepEqual([sub.state, sub.end_reason], ["ended", "pr_merged"]);
    assert.ok((await events(it.itemId)).some((e) => e.kind === "pr_closed" && e.github_id === "merged"));
    const reads = gh.s.reads;
    await poll();
    assert.equal(gh.s.reads, reads, "an ended subscription is not read");
  });

  test("F2 a finished item's events are dropped with the reason, and its watch ends", async () => {
    const it = await watched();
    await w.q("UPDATE claw_work_items SET board_state = 'done', outcome = 'accepted' WHERE item_id = $1", [it.itemId]);
    await w.q(
      `INSERT INTO claw_work_item_github_events (event_id, sub_id, item_id, kind, github_id, body) VALUES ('gh:x', $1, $2, 'issue_comment', '1', 'late')`,
      [it.subId, it.itemId],
    );
    assert.equal(await ev.deliverItemEvents(it.itemId), "dropped");
    const [e] = await events(it.itemId);
    assert.equal(e.drop_reason, "item_closed");
    assert.equal((await w.q("SELECT state, end_reason FROM claw_work_item_subscriptions"))[0].end_reason, "item_closed");
    assert.equal((await w.pending(it.workerSid)).length, 0);
  });

  test("F3 an item waiting for the user goes back to in progress; one in progress keeps its turn's generation", async () => {
    const it = await watched();
    const running = await w.workerTurn(it.itemId);
    gh.comment("one");
    await poll();
    const item = await w.item(it.itemId);
    assert.equal(item.board_state, "in_progress");
    assert.equal(item.generation, running.gen, "the running turn is not fenced out by news it has not seen");
    await w.closeRun(running.task_id);
    await handedToRun(it.workerSid);

    await w.q("UPDATE claw_work_items SET board_state = 'needs_you', last_report_kind = 'ready', result_version = 1 WHERE item_id = $1", [it.itemId]);
    gh.comment("two");
    await poll();
    const after = await w.item(it.itemId);
    assert.equal(after.board_state, "in_progress");
    assert.equal(after.last_report_kind, "progress", "the old result is no longer the one to accept");
    assert.equal(after.generation, running.gen + 1);
    const reopened = (await w.itemEvents(it.itemId)).at(-1);
    assert.deepEqual([reopened.kind, reopened.source], ["progress", "github"]);
  });

  test("F4 past the wake limit, events wait in the table and are delivered later", async () => {
    const it = await watched();
    for (let i = 0; i < ev.WAKES_PER_WINDOW; i += 1) {
      gh.comment(`c${i}`);
      await poll();
      await handedToRun(it.workerSid);
    }
    gh.comment("one too many");
    await poll();
    assert.equal((await w.pending(it.workerSid)).length, 0, "not delivered now");
    assert.equal(await count("claw_work_item_github_events", "delivered_at IS NULL AND dropped_at IS NULL"), 1, "but kept");
    await w.q("UPDATE claw_work_item_github_events SET delivered_at = delivered_at - INTERVAL '11 minutes' WHERE delivered_at IS NOT NULL");
    await ev.deliverPendingEvents();
    const [late] = await w.pending(it.workerSid);
    assert.ok(late.content.includes("one too many"));
  });

  test("F5 a pull request that cannot be read for ten minutes is put in front of the user, once", async () => {
    const it = await watched();
    tokens.alice = null;
    await poll();
    let sub = (await w.q("SELECT * FROM claw_work_item_subscriptions"))[0];
    assert.equal(sub.last_error, "no_github_token");
    assert.equal((await w.item(it.itemId)).board_state, "in_progress", "not yet: a short outage is not news");
    await w.q("UPDATE claw_work_item_subscriptions SET failing_since = NOW() - INTERVAL '11 minutes'");
    await poll();
    const item = await w.item(it.itemId);
    assert.equal(item.board_state, "needs_you");
    assert.equal(item.last_report_kind, "blocked");
    assert.match(item.pending_question, /GH_TOKEN/);
    assert.equal((await w.pending(alice.routerSid)).length, 1, "the assistant is told");
    await poll();
    assert.equal((await w.itemEvents(it.itemId)).filter((e) => e.kind === "blocked").length, 1, "once per outage");

    tokens.alice = "ghp_alice_token";
    gh.s.failReads = 1;
    await poll();
    sub = (await w.q("SELECT * FROM claw_work_item_subscriptions"))[0];
    assert.equal(sub.last_error, "github_unauthorized");
    await poll();
    sub = (await w.q("SELECT * FROM claw_work_item_subscriptions"))[0];
    assert.deepEqual([sub.last_error, sub.failing_since, sub.failure_reported], [null, null, false], "a good read clears it");
  });

  test("F6 a list cut short at the page limit is read on from where it stopped, not from now", async () => {
    const it = await watched();
    // A subscription an hour old, and more comments since its last read than one poll reads.
    await w.q("UPDATE claw_work_item_subscriptions SET since = NOW() - INTERVAL '1 hour', cursor_at = NOW() - INTERVAL '1 hour'");
    for (let i = 0; i < 550; i += 1) gh.comment(`c${i}`, { ageSec: 3000 - i });
    await poll();
    assert.equal(await count("claw_work_item_github_events"), 500, "one poll reads five pages");
    await poll();
    assert.equal(await count("claw_work_item_github_events"), 550, "the next one reads on, and nothing is skipped");
    assert.equal(await count("claw_work_item_github_events", "item_id = $1", [it.itemId]), 550);
  });

  test("S1 an answer carries its own event's marker and no other", async () => {
    const it = await watched();
    gh.comment("one");
    gh.comment("two", { ageSec: 1 });
    await poll();
    await handedToRun(it.workerSid);
    const [a, b] = await events(it.itemId);
    const turn = await w.workerTurn(it.itemId);
    await ev.prReply(turn, { event_id: a.event_id, body: `quoting: ${ev.replyMarker(b.event_id)}` });
    assert.ok(!gh.s.posts[0].body.includes(ev.replyMarker(b.event_id)), "another event's marker is defused");
    assert.ok(gh.s.posts[0].body.endsWith(ev.replyMarker(a.event_id)));
    await w.q("INSERT INTO claw_work_item_pr_replies (event_id, item_id, sub_id, run_id, generation, body, state, attempt_at) VALUES ($1, $2, $3, $4, $5, 'x', 'posting', NOW() - INTERVAL '2 minutes')",
      [b.event_id, it.itemId, it.subId, turn.task_id, turn.gen]);
    assert.equal((await ev.prReply(turn, { event_id: b.event_id, body: "answer to two" })).status, "posted", "so b is not taken for answered");
    assert.equal(gh.s.posts.length, 2);
  });

  type Res = { status: number; body: any };
  async function call(method: "GET" | "POST" | "DELETE", url: string, opts: { user?: string; auth?: string; payload?: unknown } = {}): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.user) headers["x-test-user"] = opts.user;
    if (opts.auth) headers["x-test-auth"] = opts.auth;
    const r = await app.inject({ method, url, payload: opts.payload as never, headers });
    return { status: r.statusCode, body: r.json() };
  }

  test("H1 the routes: owner only, reply needs the person, a key can only take it away", async () => {
    const item = await w.createItem(alice, "Watch it");
    const url = `/v1/work-items/${item.itemId}/subscriptions`;
    assert.equal((await call("POST", url, { user: "alice", auth: "api_key", payload: { pr: prRef, reply: true } })).body.error, "interactive_sign_in_required");
    assert.equal(await count("claw_work_item_subscriptions"), 0, "nothing made");
    assert.equal((await call("POST", url, { user: "bob", auth: "identity_token", payload: { pr: prRef } })).status, 404, "another user's item");
    assert.equal((await call("POST", url, { user: "alice", payload: { pr: "not a pr" } })).body.error, "invalid_pr");
    const made = await call("POST", url, { user: "alice", auth: "identity_token", payload: { pr: `https://github.com/${OWNER}/${REPO}/pull/${PR}`, reply: true } });
    assert.equal(made.status, 201);
    assert.equal(made.body.data.reply_allowed, true);
    assert.equal(made.body.data.pr, prRef);
    const lowered = await call("POST", url, { user: "alice", auth: "api_key", payload: { pr: prRef, reply: false } });
    assert.deepEqual([lowered.status, lowered.body.data.reply_allowed], [200, false], "taking it away needs no more than ownership");
    assert.equal((await call("GET", url, { user: "bob" })).status, 404);
    const listed = await call("GET", url, { user: "alice" });
    assert.equal(listed.body.data.length, 1);
    assert.equal((await call("DELETE", `${url}/${made.body.data.sub_id}`, { user: "bob" })).status, 404);
    const ended = await call("DELETE", `${url}/${made.body.data.sub_id}`, { user: "alice" });
    assert.deepEqual([ended.body.data.state, ended.body.data.end_reason], ["ended", "user"]);
    for (const n of [1, 2, 3]) assert.equal((await call("POST", url, { user: "alice", payload: { pr: `${OWNER}/${REPO}#${n}` } })).status, 201);
    assert.equal((await call("POST", url, { user: "alice", payload: { pr: `${OWNER}/${REPO}#4` } })).body.error, "too_many_subscriptions");
  });

  test("M1 the tools are offered by role while the switch is on", async () => {
    const names = (claims: Record<string, unknown>) => Object.keys((mcp.createAssistantMcpServer(claims as never) as any)._registeredTools);
    assert.ok(names({ role: "router", sid: "s", mid: "m", task_id: "t", exp: 1 }).includes("work_subscribe"));
    assert.ok(!names({ role: "router", sid: "s", mid: "m", task_id: "t", exp: 1 }).includes("pr_reply"));
    assert.ok(names({ role: "worker", sid: "s", mid: "m", task_id: "t", exp: 1, item_id: "i", gen: 1 }).includes("pr_reply"));
    assert.ok(!names({ role: "worker", sid: "s", mid: "m", task_id: "t", exp: 1, item_id: "i", gen: 1 }).includes("work_subscribe"));
  });
});
