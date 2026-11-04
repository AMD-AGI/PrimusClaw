// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review on someone's behalf as a work item (`assistant/review-items.ts`), over HTTP against a real Postgres with the production schema.
 * Skipped without DATABASE_URL, and a skip is not a pass. GitHub is the one thing faked: the pull request check answers what each test says.
 *
 *   V1  start: one item per pull request, its session made as `POST /v1/sessions` makes an acting one, and its first message queued
 *   V2  only a person's identity-provider token (or an allowed service's) may start one; anything else is refused and leaves nothing
 *   V3  a request that is wrong is refused before anything is asked or made
 *   V4  one open review per pull request, whoever asked; another person's item is not named; a batch with one is refused whole
 *   V5  the hourly limits are asked before any session is made, and say how many more fit; two creates at once cannot both take the last
 *   V6  a review counts toward the user's limit of unfinished items, and says that is what was met
 *   V7  GitHub is asked before a session is made: a refusal, or an outage, makes nothing
 *   S1  stop denies what the session holds, in the same transaction; a merge being made, or made, refuses the stop and changes nothing
 *   S2  the assistant's work_stop passes those two refusals on as they are
 *   S3  a merge being made without a confirmation (the write lock is held) refuses the stop too; after the stop the tools see it
 *   R1  restart: the same pull request with what changed, the old item stopped by the stop's rules
 *   M1  the state, from every confirmation status and every way a turn ends (table)
 *   M2  the state written to the item: entering "needs you" wakes the assistant once, done does not, a repeat writes nothing
 *   D1  an answer to a held write closes the item; a held write of a stopped review is denied whatever the answer
 *   G1  a review session is no worker: no role profile, no worker report at its turn's end, not an orphan to the task sweep
 *   G2  nothing the server queues reaches an acting session without the person's proof: work_send into a review is refused
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant review items", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let ri: typeof import("../src/assistant/review-items.js");
  let readTrustedSessionCredentials: typeof import("../src/auth/sealed-session-credentials.js").readTrustedSessionCredentials;
  let checks: Array<{ actor: Record<string, unknown>; pr: Record<string, unknown> }>;
  let checkAnswer: (pr: { owner: string; repo: string; number: number }) => { isError: boolean; body: Record<string, unknown> };
  let interrupts: string[];
  let decisions: Array<{ id: string; decision: string }>;
  let decideEffect: (id: string) => Promise<void>;

  before(async () => {
    w = await startWorld({
      CLAW_GITHUB_REVIEW_ENABLED: "true",
      CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40),
      CLAW_ASSISTANT_REVIEW_ITEMS: "true",
      CLAW_ASSISTANT_MAX_ACTIVE_ITEMS: "4",
      CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR: "3",
      CLAW_GITHUB_REVIEWS_PER_HOUR: "5",
      CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: "clawy",
    });
    ri = await import("../src/assistant/review-items.js");
    ({ readTrustedSessionCredentials } = await import("../src/auth/sealed-session-credentials.js"));
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    const { registerGithubReviewRoutes } = await import("../src/github-review/mcp.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      const client = req.headers["x-test-client"];
      (req as any).user = {
        userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"],
        ...(typeof client === "string" ? { delegation: { actorSub: "svc", clientId: client } } : {}),
      };
      const method = req.headers["x-test-method"];
      if (method !== "none") (req as any).authMethod = typeof method === "string" ? method : "identity_token";
    });
    await registerAssistantRoutes(app);
    const fakeService = {
      checkPullRequest: async (actor: Record<string, unknown>, pr: { owner: string; repo: string; number: number }) => {
        checks.push({ actor, pr });
        return { ...checkAnswer(pr), text: "" };
      },
      decide: async (_user: string, id: string, decision: string) => {
        decisions.push({ id, decision });
        await decideEffect(id);
        return { http: 200, body: { ok: true, status: decision === "allow" ? "merged" : "denied" } };
      },
    };
    await registerGithubReviewRoutes(app, { service: fakeService as never });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_github_confirmations, claw_github_audit CASCADE`);
    w.drains.length = 0;
    checks = [];
    decisions = [];
    checkAnswer = () => ({ isError: false, body: { status: "ok", title: "t", head_sha: "a".repeat(40) } });
    decideEffect = async () => {};
    interrupts = [];
    w.h.app.chatRun.chatRunPorts.publishInterrupt = (subject: string) => { interrupts.push(subject); };
  });

  type Res = { status: number; body: any };
  async function call(user: string, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await app.inject({ method: "POST", url, payload: payload as never, headers: { "x-test-user": user, ...headers } });
    return { status: r.statusCode, body: r.json() };
  }
  const start = (user: string, body: unknown, headers: Record<string, string> = {}) => call(user, "/v1/assistant/reviews", body, headers);
  const PR = (number: number, owner = "AMD-AGI", repo = "PrimusClaw") => ({ owner, repo, number });
  const count = async (table: string, where = "TRUE") => Number((await w.q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`))[0].n);
  /** What a refused request must have left alone. */
  async function nothingMade(): Promise<void> {
    assert.equal(await count("claw_work_items"), 0, "no item");
    assert.equal(await count("claw_sessions", "config ? 'acting_as'"), 0, "no review session");
    assert.equal(await count("claw_pending_messages"), 0, "nothing queued");
    assert.equal(w.drains.length, 0, "nothing drained");
  }
  async function one(user = "alice", body: Record<string, unknown> = {}): Promise<{ item_id: string; seq: number; session_id: string }> {
    const r = await start(user, { prs: [PR(254)], ...body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.items[0];
  }
  /** The first message was handed to a run and its turn ended: what the stub drain stood in for. */
  async function turnRan(sessionId: string, status: "completed" | "failed" = "completed"): Promise<void> {
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [sessionId]);
    const run = await w.openRun(sessionId);
    await w.closeRun(run.taskId, status);
  }
  async function confirmation(sessionId: string, status: string, kind = "merge", actor = "alice", ageMinutes = 0): Promise<string> {
    const id = (await w.q(
      `INSERT INTO claw_github_confirmations (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, status, kind, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, 'alice', $2, 'AMD-AGI/PrimusClaw', 254, $3, $4, $5, NOW() + INTERVAL '1 day', NOW() - make_interval(mins => $6::int))
       RETURNING confirmation_id`,
      [sessionId, actor, "a".repeat(40), status, kind, ageMinutes],
    ))[0].confirmation_id as string;
    return id;
  }
  async function audit(sessionId: string, tool: string, result: string, detail: string, actor = "alice", write = false): Promise<void> {
    await w.q(
      `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, repo, pr, head_sha, tool, result, detail, write)
       VALUES ('alice', $2, $1, 'AMD-AGI/PrimusClaw', 254, $3, $4, $5, $6, $7)`,
      [sessionId, actor, "a".repeat(40), tool, result, detail, write],
    );
  }

  test("V1 start makes one item per pull request, an acting session as the create route makes one, and queues its first message", async () => {
    const r = await start("alice", {
      prs: [PR(254), { ...PR(257), message: "Review https://github.com/AMD-AGI/PrimusClaw/pull/257 and answer in Chinese." }],
      acting_as: "bob", acting_as_name: "Bob B", model: "claude-opus-5.5", effort: "high", review_only: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const items = r.body.data.items as Array<Record<string, any>>;
    assert.deepEqual(items.map((i) => [i.seq, i.title, i.pr.number]), [[1, "Review+merge PrimusClaw#254", 254], [2, "Review+merge PrimusClaw#257", 257]]);
    for (const it of items) {
      const item = await w.item(it.item_id);
      assert.equal(item.kind, "review");
      assert.equal(item.board_state, "in_progress");
      assert.equal(item.worker_session_id, it.session_id);
      assert.deepEqual({ ...item.params, brief: undefined }, {
        pr: it.pr, acting_as: "bob", acting_as_name: "Bob B", model: "claude-opus-5.5", effort: "high", review_only: false, brief: undefined,
      });
      const [s] = await w.q("SELECT user_id, model, effort, config, parent_session_id FROM claw_sessions WHERE session_id = $1", [it.session_id]);
      assert.equal(s.user_id, "alice");
      assert.equal(s.model, "claude-opus-5.5");
      assert.equal(s.effort, "high");
      assert.equal(s.parent_session_id, null);
      assert.deepEqual(
        [s.config.acting_as, s.config.review_target, s.config.review_only, s.config.acting_as_requester, s.config.notify_on_finish],
        ["bob", it.pr, false, "Name alice", true],
      );
      // Sealed, as every server-stamped credential is (`auth/sealed-session-credentials.ts`): the turn runs with the requester's keys.
      assert.deepEqual([s.config.platform_key, s.config.llm_api_key, s.config._server_managed_credentials], [undefined, undefined, true]);
      assert.deepEqual(readTrustedSessionCredentials(s.config), { platformKey: "pk-alice", llmApiKey: "vk-alice" });
      const queued = await w.pending(it.session_id);
      assert.equal(queued.length, 1);
      assert.equal(it.message_id, `claw-pending-${queued[0].id}`, "the answer names the first message's turn");
      assert.equal(queued[0].content, item.params.brief);
    }
    assert.match((await w.pending(items[0].session_id))[0].content, /^Review https:\/\/github\.com\/AMD-AGI\/PrimusClaw\/pull\/254\. If the review finds nothing that blocks it, approve and merge it/);
    assert.equal((await w.pending(items[1].session_id))[0].content, "Review https://github.com/AMD-AGI/PrimusClaw/pull/257 and answer in Chinese.");
    assert.deepEqual(w.drains.map((d) => d.sessionId), items.map((i) => i.session_id), "each review's turn is started");
    assert.deepEqual(checks.map((c) => [c.actor.requesterUserId, c.actor.actorUserId, c.actor.sessionId, (c.pr as any).number]),
      items.map((i) => ["alice", "bob", i.session_id, i.pr.number]), "GitHub was asked with the acting user's account, for the session to be made");
    // The board shows what kind of item it is, and what it was asked with.
    const board = await app.inject({ method: "GET", url: "/v1/work-items", headers: { "x-test-user": "alice" } });
    assert.deepEqual(board.json().data.map((r: any) => [r.kind, r.params.pr.number, r.params.review_only, r.can_accept]).sort(), [["review", 254, false, false], ["review", 257, false, false]]);
    // Merging is asked for, never assumed.
    const only = await start("carol", { prs: [PR(300)] });
    const onlyItem = await w.item(only.body.data.items[0].item_id);
    assert.equal(onlyItem.params.review_only, true);
    assert.equal((await w.q("SELECT config FROM claw_sessions WHERE session_id = $1", [onlyItem.worker_session_id]))[0].config.review_only, true);
    assert.match(onlyItem.params.brief, /Review only: post your review and do not merge it\./);
  });

  test("V2 only an identity-provider token starts one: a key, a cookie, a connector, no method or a service not allowed is refused and leaves nothing", async () => {
    for (const method of ["api_key", "x_api_key", "cookie", "connector_token", "query_token", "none"]) {
      const r = await start("alice", { prs: [PR(254)] }, { "x-test-method": method });
      assert.equal(r.status, 403, method);
      assert.equal(r.body.error, "interactive_sign_in_required", method);
    }
    const svc = await start("alice", { prs: [PR(254)] }, { "x-test-client": "someone-else" });
    assert.deepEqual([svc.status, svc.body.error], [403, "service_client_not_allowed"]);
    await nothingMade();
    assert.equal(checks.length, 0, "GitHub was not asked");
    const allowed = await start("alice", { prs: [PR(254)] }, { "x-test-client": "clawy" });
    assert.equal(allowed.status, 200, "an allowed service, speaking for the user its token names");
  });

  test("V3 a request that is wrong is refused before anything is asked or made", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => PR(i + 1));
    for (const [body, field] of [
      [{ prs: [] }, "prs"], [{ prs: eleven }, "prs"], [{}, "prs"], [{ prs: [PR(1), PR(1, "amd-agi", "primusclaw")] }, "prs[1]"],
      [{ prs: [{ owner: "AMD-AGI", repo: "x", number: "7" }] }, "prs[0]"], [{ prs: [PR(0)] }, "prs[0]"], [{ prs: [PR(1, "bad owner")] }, "prs[0]"],
      [{ prs: [PR(1)], review_only: "yes" }, "review_only"], [{ prs: [PR(1)], acting_as: 7 }, "acting_as"],
      [{ prs: [{ ...PR(1), message: 7 }] }, "prs[0].message"],
    ] as const) {
      const r = await start("alice", body);
      assert.deepEqual([r.status, r.body.error, r.body.data?.field], [400, "invalid_request", field], JSON.stringify(body));
    }
    for (const body of [{ prs: [PR(1)], model: "has space" }, { prs: [PR(1)], effort: "max" }, { prs: [PR(1)], acting_as: "has space" }]) {
      const r = await start("alice", body);
      assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], JSON.stringify(body));
    }
    await nothingMade();
    assert.equal(checks.length, 0);
  });

  test("V4 one open review per pull request, whoever asked; another person's is not named; a batch with one is refused whole", async () => {
    const first = await one("alice");
    const mine = await start("alice", { prs: [PR(254, "amd-agi", "PRIMUSCLAW")] });
    assert.deepEqual([mine.status, mine.body.error, mine.body.data], [409, "review_in_progress", { pr: PR(254, "amd-agi", "PRIMUSCLAW"), item_id: first.item_id, seq: 1 }]);
    const theirs = await start("bob", { prs: [PR(300), PR(254)] });
    assert.deepEqual([theirs.status, theirs.body.error, theirs.body.data], [409, "review_in_progress_by_other", { pr: PR(254) }]);
    assert.equal(await count("claw_work_items"), 1, "the batch made nothing, not even its first pull request");
    // Stopped, it is no longer open, and the pull request can be reviewed again.
    assert.equal((await call("alice", `/v1/work-items/${first.item_id}/stop`, {})).status, 200);
    assert.equal((await start("bob", { prs: [PR(254)] })).status, 200);
  });

  test("V4b two requests for the same pull request at once make one item; the other is told it is under review", async () => {
    const [a, b] = await Promise.all([start("alice", { prs: [PR(254)] }), start("bob", { prs: [PR(254)] })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.ok([a, b].some((r) => r.body.error === "review_in_progress_by_other"));
    assert.equal(await count("claw_work_items"), 1);
    assert.equal(await count("claw_sessions", "config ? 'acting_as'"), 1, "the loser's session was rolled back with it");
  });

  test("V5 the hourly limits are asked before anything is made, and say how many more fit", async () => {
    // bob's account: one session wrote in the hour, one open review has not written yet. The limit is 3, so one more fits.
    await audit("s-old", "gh_review_submit", "ok", "submitted", "bob", true);
    await one("carol", { acting_as: "bob" });
    checks = [];
    const two = await start("alice", { prs: [PR(300), PR(301)], acting_as: "bob" });
    assert.deepEqual([two.status, two.body.error, two.body.data], [429, "rate_limited", { scope: "account", limit: 3, remaining: 1 }]);
    assert.equal(await count("claw_work_items"), 1);
    assert.equal(checks.length, 0, "GitHub was not asked");
    assert.equal((await start("alice", { prs: [PR(300)], acting_as: "bob" })).status, 200, "the one that fits");
    // An old write does not count, and neither does a dry run.
    await w.q("UPDATE claw_github_audit SET at = NOW() - INTERVAL '2 hours'");
    // The deployment's 5: three open reviews (two as bob, one as dave) leave two.
    await one("dave", { acting_as: "dave", prs: [PR(400)] });
    const over = await start("erin", { prs: [PR(500), PR(501), PR(502)] });
    assert.deepEqual([over.status, over.body.data], [429, { scope: "deployment", limit: 5, remaining: 2 }]);
  });

  test("V5b two requesters using the same account at once cannot both take its last start", async () => {
    await one("carol", { acting_as: "bob", prs: [PR(1)] });
    await one("dave", { acting_as: "bob", prs: [PR(2)] });
    const [a, b] = await Promise.all([start("alice", { prs: [PR(3)], acting_as: "bob" }), start("erin", { prs: [PR(4)], acting_as: "bob" })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
    assert.equal(await count("claw_work_items", "params->>'acting_as' = 'bob'"), 3);
  });

  test("V6 a review counts toward the user's limit of unfinished items, and the refusal says it is that limit", async () => {
    await w.user("alice");
    for (let i = 0; i < 3; i++) await w.createItem(await w.user("alice"), `task ${i}`);
    await one("alice");
    const r = await start("alice", { prs: [PR(300)] });
    assert.deepEqual([r.status, r.body.error, r.body.data], [409, "too_many_active_items", { limit: 4 }]);
    assert.match(r.body.message, /the most one person may have/);
    assert.equal(await count("claw_work_items", "kind = 'review'"), 1);
    assert.equal(await count("claw_sessions", "config ? 'acting_as'"), 1, "the session it would have used was rolled back");
  });

  test("V7 GitHub is asked first: a pull request it refuses, or an outage, makes nothing", async () => {
    checkAnswer = (pr) => pr.number === 2
      ? { isError: true, body: { status: "refused", reason: "github_not_found", message: "Not Found" } }
      : { isError: false, body: { status: "ok" } };
    const r = await start("alice", { prs: [PR(1), PR(2), PR(3)] });
    assert.deepEqual([r.status, r.body.error, r.body.data], [422, "pr_check_failed", { pr: PR(2), reason: "github_not_found" }]);
    assert.deepEqual(checks.map((c) => (c.pr as any).number), [1, 2], "it stopped at the first refusal");
    for (const reason of ["owner_not_allowed", "already_merged", "delegation_off", "actor_not_bound"]) {
      checkAnswer = () => ({ isError: true, body: { status: "refused", reason } });
      const refused = await start("alice", { prs: [PR(9)] });
      assert.deepEqual([refused.status, refused.body.data.reason], [422, reason]);
    }
    checkAnswer = () => ({ isError: true, body: { status: "refused", reason: "identity_unavailable" } });
    const outage = await start("alice", { prs: [PR(9)] });
    assert.deepEqual([outage.status, outage.body.error], [503, "pr_check_unavailable"]);
    await nothingMade();
  });

  test("S1 stop denies what the session holds in the same transaction; a merge being made or made refuses it and changes nothing", async () => {
    const it = await one("alice", { review_only: false });
    const held = await confirmation(it.session_id, "pending");
    const r = await call("alice", `/v1/work-items/${it.item_id}/stop`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.board_state, r.body.data.outcome], ["done", "stopped"]);
    const [c] = await w.q("SELECT status, result FROM claw_github_confirmations WHERE confirmation_id = $1", [held]);
    assert.deepEqual([c.status, c.result], ["denied", { by: "requester", reason: "stopped" }]);
    assert.equal(interrupts.length, 1, "and the session was interrupted");
    assert.equal(await count("claw_pending_messages", `session_id = '${it.session_id}'`), 0, "its first message will not start a turn");

    const merging = await one("alice", { prs: [PR(300)] });
    const claimed = await confirmation(merging.session_id, "merging");
    const other = await confirmation(merging.session_id, "pending", "review");
    const busy = await call("alice", `/v1/work-items/${merging.item_id}/stop`, {});
    assert.deepEqual([busy.status, busy.body.error, busy.body.data.board_state], [409, "merge_in_progress", "in_progress"]);
    const statuses = await w.q("SELECT confirmation_id, status FROM claw_github_confirmations WHERE session_id = $1", [merging.session_id]);
    assert.deepEqual(Object.fromEntries(statuses.map((s) => [s.confirmation_id, s.status])), { [claimed]: "merging", [other]: "pending" }, "nothing was denied");

    const merged = await one("alice", { prs: [PR(400)] });
    await audit(merged.session_id, "gh_pr_merge", "ok", "merged");
    const late = await call("alice", `/v1/work-items/${merged.item_id}/stop`, {});
    assert.deepEqual([late.status, late.body.error, late.body.data.board_state, late.body.data.outcome], [409, "already_merged", "done", "accepted"],
      "and the board says what happened");
    assert.equal(interrupts.length, 1, "neither refused stop interrupted anything");
  });

  test("S3 a merge the session is making right now (it holds the write lock, no confirmation says so) refuses the stop; a later one finds the review stopped", async () => {
    const it = await one("alice", { review_only: false });
    const held = await confirmation(it.session_id, "pending");
    const key = "alice|amd-agi/primusclaw#254";
    await w.q("INSERT INTO claw_github_write_locks (lock_key, holder, expires_at) VALUES ($1, 'tool-call', NOW() + INTERVAL '1 minute')", [key]);
    const busy = await call("alice", `/v1/work-items/${it.item_id}/stop`, {});
    assert.deepEqual([busy.status, busy.body.error, busy.body.data.board_state], [409, "merge_in_progress", "in_progress"]);
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [held]))[0].status, "pending", "nothing was denied");
    assert.equal((await w.q("SELECT holder FROM claw_github_write_locks WHERE lock_key = $1", [key]))[0].holder, "tool-call", "and the lock is still the tool's");
    // The tool call finished (its lock lapsed): the stop goes ahead, and leaves no lock behind it.
    await w.q("UPDATE claw_github_write_locks SET expires_at = NOW() - INTERVAL '1 second' WHERE lock_key = $1", [key]);
    assert.equal((await call("alice", `/v1/work-items/${it.item_id}/stop`, {})).status, 200);
    assert.equal(await count("claw_github_write_locks", `lock_key = '${key}'`), 0);
    assert.equal(await ri.reviewSessionStopped(it.session_id), true, "what the review tools ask before an approval or a merge");
    assert.equal(await ri.reviewSessionStopped((await one("alice", { prs: [PR(300)] })).session_id), false);
  });

  test("S2 the assistant's work_stop says what the stop said: a merge being made, or made, is not reported as a finished item", async () => {
    const alice = await w.user("alice");
    const merging = await one("alice", { prs: [PR(300)] });
    await confirmation(merging.session_id, "merging");
    const merged = await one("alice", { prs: [PR(400)] });
    await audit(merged.session_id, "gh_pr_merge", "ok", "merged");
    for (const [it, code, pr] of [[merging, "merge_in_progress", 300], [merged, "already_merged", 400]] as const) {
      const turn = await w.routerTurn(alice);
      // Stopping a review is the person's say (`attendedTurn`): the turn answers their signed-in message, which names it.
      await w.q(
        `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, attended_via) VALUES ($1, $2, 'alice', $3, '{"kind":"person"}'::jsonb)`,
        [alice.routerSid, turn.mid, `stop ${pr}`],
      );
      await assert.rejects(w.mod.tools.workStop(turn, { item_id: it.item_id, reason: "stop it" }), (err: any) => err.code === code, code);
      await w.closeRun(turn.task_id);
    }
  });

  test("R1 restart: the same pull request with what changed, the old item stopped by the stop's rules", async () => {
    const it = await one("alice", { model: "claude-sonnet-5", acting_as: "bob", acting_as_name: "Bob B" });
    const held = await confirmation(it.session_id, "pending", "merge", "bob");
    const r = await call("alice", `/v1/assistant/reviews/${it.item_id}/restart`, { model: "claude-opus-5.5", review_only: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.stopped, { item_id: it.item_id, seq: 1 });
    const old = await w.item(it.item_id);
    assert.deepEqual([old.board_state, old.outcome], ["done", "stopped"]);
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [held]))[0].status, "denied");
    const fresh = await w.item(r.body.data.item.item_id);
    assert.deepEqual([fresh.params.acting_as, fresh.params.acting_as_name, fresh.params.model, fresh.params.review_only, fresh.params.pr], ["bob", "Bob B", "claude-opus-5.5", false, PR(254)]);
    assert.match(fresh.params.brief, /approve and merge it/, "a review that now merges is told so");
    assert.equal((await w.q("SELECT model FROM claw_sessions WHERE session_id = $1", [fresh.worker_session_id]))[0].model, "claude-opus-5.5");
    assert.equal(r.body.data.item.message_id, `claw-pending-${(await w.pending(fresh.worker_session_id))[0].id}`, "a restart names its first turn too");
    assert.equal(interrupts.length, 1, "the old session was interrupted");
    // Nothing changed but the model: the old words are sent again.
    const again = await call("alice", `/v1/assistant/reviews/${fresh.item_id}/restart`, { model: null });
    assert.equal((await w.item(again.body.data.item.item_id)).params.brief, fresh.params.brief);

    assert.equal((await call("alice", `/v1/assistant/reviews/${again.body.data.item.item_id}/restart`, {}, { "x-test-method": "api_key" })).status, 403);
    assert.equal((await call("bob", `/v1/assistant/reviews/${again.body.data.item.item_id}/restart`, {})).status, 404, "another user's item is not there");
    const task = await w.createItem(await w.user("alice"), "a task");
    assert.deepEqual([(await call("alice", `/v1/assistant/reviews/${task.itemId}/restart`, {})).body.error], ["not_a_review_item"]);
    await audit(again.body.data.item.session_id, "gh_pr_merge", "ok", "queued");
    const merged = await call("alice", `/v1/assistant/reviews/${again.body.data.item.item_id}/restart`, {});
    assert.deepEqual([merged.status, merged.body.error], [409, "already_merged"]);
    assert.equal(await count("claw_work_items", "kind = 'review' AND board_state <> 'done'"), 1, "the refused restart made nothing and stopped nothing");
  });

  test("M1 the state of a review, from every confirmation status and every way its turn ends", () => {
    const base = { ownerUserId: "alice", actingAs: "alice", actingAsName: null, reviewOnly: false, pr: PR(7), confirmations: [], writes: [], turn: "finished" as const };
    const c = (status: string, at = 10, kind = "merge") => ({ status, kind, at });
    const wr = (tool: string, result: string, detail: string, at = 5) => ({ tool, result, detail, at });
    const cases: Array<[string, Partial<typeof base> & Record<string, unknown>, string]> = [
      ["merged", { confirmations: [c("merged")] }, "done/accepted"],
      ["queued", { confirmations: [c("queued")] }, "done/accepted"],
      ["merged at once", { writes: [wr("gh_pr_merge", "ok", "merged")] }, "done/accepted"],
      ["queued at once", { writes: [wr("gh_pr_merge", "ok", "queued")] }, "done/accepted"],
      ["submitted held review", { confirmations: [c("submitted", 10, "review")] }, "done/accepted"],
      ["review posted", { writes: [wr("gh_review_submit", "ok", "submitted")] }, "done/accepted"],
      ["review already posted", { writes: [wr("gh_review_submit", "ok", "already_submitted")] }, "done/accepted"],
      ["denied", { confirmations: [c("denied")] }, "done/stopped"],
      ["merging", { confirmations: [c("merging")], turn: "finished" }, "in_progress"],
      ["pending for the owner", { confirmations: [c("pending")] }, "needs_you/blocked"],
      ["pending for someone else", { actingAs: "bob", actingAsName: "Bob B", confirmations: [c("pending")] }, "in_progress"],
      ["stale", { confirmations: [c("stale")] }, "needs_you/blocked"],
      ["expired", { confirmations: [c("expired")] }, "needs_you/blocked"],
      ["refused", { confirmations: [c("refused")] }, "needs_you/blocked"],
      ["stale after a posted review", { confirmations: [c("stale", 10)], writes: [wr("gh_review_submit", "ok", "submitted", 5)] }, "needs_you/blocked"],
      ["a review posted after an expired one", { confirmations: [c("expired", 5)], writes: [wr("gh_review_submit", "ok", "submitted", 10)] }, "done/accepted"],
      ["merge refused after the review", { writes: [wr("gh_review_submit", "ok", "submitted", 5), wr("gh_pr_merge", "refused", "ci_not_green", 6)] }, "needs_you/blocked"],
      ["merge refused, review only", { reviewOnly: true, writes: [wr("gh_review_submit", "ok", "submitted", 5), wr("gh_pr_merge", "refused", "review_only", 6)] }, "done/accepted"],
      ["turn still running", { turn: "running", writes: [wr("gh_review_submit", "ok", "submitted")] }, "in_progress"],
      ["never ran yet", { turn: "none" }, "in_progress"],
      ["turn failed", { turn: "failed" }, "needs_you/failed"],
      ["writes off", { writes: [wr("gh_pr_merge", "ok", "dry_run")] }, "needs_you/blocked"],
      ["ended and posted nothing", {}, "needs_you/blocked"],
    ];
    for (const [name, facts, expected] of cases) {
      const s = ri.reviewState({ ...base, ...facts } as never);
      const got = s.boardState === "done" ? `done/${s.outcome}` : s.boardState === "needs_you" ? `needs_you/${s.reportKind}` : s.boardState;
      assert.equal(got, expected, name);
    }
    const waiting = ri.reviewState({ ...base, actingAs: "bob", actingAsName: "Bob B", confirmations: [c("pending")] } as never);
    assert.equal(waiting.boardState === "in_progress" && waiting.question, "Waiting for Bob B to confirm the merge");
    // Every status the confirmations table allows is in the table above.
    const statuses = new Set(cases.flatMap(([, f]) => ((f.confirmations ?? []) as Array<{ status: string }>).map((x) => x.status)));
    assert.deepEqual([...statuses].sort(), ["denied", "expired", "merged", "merging", "pending", "queued", "refused", "stale", "submitted"]);
  });

  test("M2 the state is written to the item: needs-you wakes the assistant once, done does not, a repeat writes nothing", async () => {
    const it = await one("alice", { review_only: false });
    // The user has talked to their assistant: its session holds the credentials a wake is queued with.
    const { routerSid } = await w.user("alice");
    await turnRan(it.session_id);
    await confirmation(it.session_id, "pending");
    w.drains.length = 0;
    await w.mod.turnEnd.recordWorkerTurnEnd({ sessionId: it.session_id, runIds: ["r1"], failed: false, interrupted: false, finalText: "held" });
    let item = await w.item(it.item_id);
    assert.deepEqual([item.board_state, item.last_report_kind, item.pending_question, item.attention_seq],
      ["needs_you", "blocked", "Confirm or deny the merge of AMD-AGI/PrimusClaw#254", 1]);
    const wakes = await w.pending(routerSid);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0].content, /^\[work_event\] #1 .* blocked: the merge of AMD-AGI\/PrimusClaw#254 is held/);
    assert.deepEqual(w.drains.map((d) => d.sessionId), [routerSid]);
    const eventsBefore = (await w.itemEvents(it.item_id)).length;
    await ri.syncReviewItem(it.item_id);
    await ri.sweepReviewItems();
    assert.equal((await w.itemEvents(it.item_id)).length, eventsBefore, "the same facts write nothing again");
    assert.equal((await w.pending(routerSid)).length, 1, "and wake nobody again");

    await w.q("UPDATE claw_github_confirmations SET status = 'merged', decided_at = NOW() WHERE session_id = $1", [it.session_id]);
    await ri.sweepReviewItems();
    item = await w.item(it.item_id);
    assert.deepEqual([item.board_state, item.outcome, item.pending_question], ["done", "accepted", null]);
    const last = (await w.itemEvents(it.item_id)).at(-1);
    assert.deepEqual([last.kind, last.source], ["accepted", "policy"]);
    assert.equal((await w.pending(routerSid)).length, 1, "a finished review is the channel's review card to tell, not the assistant's");
  });

  test("M2b a held write that runs out moves the item to needs-you on the sweep", async () => {
    const it = await one("alice", { review_only: false });
    await turnRan(it.session_id);
    const held = await confirmation(it.session_id, "pending", "merge", "bob");
    await w.q("UPDATE claw_work_items SET params = params || '{\"acting_as\":\"bob\"}'::jsonb WHERE item_id = $1", [it.item_id]);
    await ri.sweepReviewItems();
    assert.deepEqual([(await w.item(it.item_id)).board_state, (await w.item(it.item_id)).pending_question], ["in_progress", "Waiting for bob to confirm the merge"]);
    await w.q("UPDATE claw_github_confirmations SET expires_at = NOW() - INTERVAL '1 minute' WHERE confirmation_id = $1", [held]);
    await ri.sweepReviewItems();
    const item = await w.item(it.item_id);
    assert.deepEqual([item.board_state, item.last_report_kind], ["needs_you", "blocked"]);
    assert.match(item.summary, /nobody answered/);
  });

  test("D1 an answer closes the item; a held write of a stopped review is denied whatever the answer", async () => {
    const it = await one("alice", { review_only: false });
    await turnRan(it.session_id);
    const held = await confirmation(it.session_id, "pending");
    decideEffect = async (id) => { await w.q("UPDATE claw_github_confirmations SET status = 'merged', decided_at = NOW() WHERE confirmation_id = $1", [id]); };
    const r = await call("alice", `/v1/github-review/confirmations/${held}/decision`, { decision: "allow" });
    assert.deepEqual([r.status, r.body.status], [200, "merged"]);
    assert.deepEqual([(await w.item(it.item_id)).board_state, (await w.item(it.item_id)).outcome], ["done", "accepted"]);

    // A tool call still in flight when the stop came opened this one after it.
    const stopped = await one("alice", { prs: [PR(300)] });
    assert.equal((await call("alice", `/v1/work-items/${stopped.item_id}/stop`, {})).status, 200);
    const late = await confirmation(stopped.session_id, "pending");
    decisions = [];
    const allow = await call("alice", `/v1/github-review/confirmations/${late}/decision`, { decision: "allow" });
    assert.deepEqual([allow.status, allow.body.status, allow.body.reason], [200, "denied", "review_stopped"]);
    assert.equal(decisions.length, 0, "the write was never tried");
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [late]))[0].status, "denied");
    // And the sweep denies such a card even if nobody answers it.
    const later = await confirmation(stopped.session_id, "pending", "review");
    await ri.sweepReviewItems();
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [later]))[0].status, "denied");
  });

  test("D1b only the acting user answers a held write of a stopped review, at the route and at the assistant's confirmation_answer alike", async () => {
    const stopped = await one("alice", { prs: [PR(301)] });
    assert.equal((await call("alice", `/v1/work-items/${stopped.item_id}/stop`, {})).status, 200);
    const late = await confirmation(stopped.session_id, "pending");
    const r = await call("bob", `/v1/github-review/confirmations/${late}/decision`, { decision: "deny" });
    assert.deepEqual([r.status, r.body.error], [403, "only_the_acting_user_can_decide"]);
    // The assistant's tool answers through the route's own function, so it cannot answer for someone else either.
    const { reviewToolPorts } = await import("../src/assistant/review-tools.js");
    const t = await reviewToolPorts.decide("bob", late, "deny", null);
    assert.deepEqual([t.http, t.body.error], [403, "only_the_acting_user_can_decide"]);
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [late]))[0].status, "pending",
      "nobody else's answer touched it");
    assert.equal(decisions.length, 0);
    // The acting user's own answer, through the tool, is the route's: denied as stopped.
    const own = await reviewToolPorts.decide("alice", late, "allow", null);
    assert.deepEqual([own.http, own.body.status, own.body.reason], [200, "denied", "review_stopped"]);
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [late]))[0].status, "denied");
  });

  test("G1 a review session is no worker: no role profile, no worker report at its turn's end, not an orphan to the task sweep", async () => {
    const it = await one("alice");
    assert.equal(await w.mod.role.sessionRole(it.session_id), null, "no report tool, no worker prompt, no worker model");
    const task: Record<string, unknown> = { task_id: "t1", message_id: "m1", model: "claude-opus-5.5" };
    await w.mod.role.applySessionRoleToTask(task, it.session_id);
    assert.equal(task.model, "claude-opus-5.5");
    assert.equal((task.mcp_servers as Record<string, unknown> | undefined)?.assistant, undefined);
    // Nothing has run for it for a long time: the task sweep's orphan pass must not call it failed.
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.session_id]);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '1 hour' WHERE item_id = $1", [it.item_id]);
    assert.equal(await w.mod.turnEnd.reconcileOrphanedItems(), 0);
    assert.equal((await w.item(it.item_id)).board_state, "in_progress");
    // Its turn ends having posted a review: the facts decide, and the end is not recorded as a worker's ready.
    await turnRan(it.session_id);
    await audit(it.session_id, "gh_review_submit", "ok", "submitted");
    await w.mod.turnEnd.recordWorkerTurnEnd({ sessionId: it.session_id, runIds: ["r1"], failed: false, interrupted: false, finalText: "LGTM, merged" });
    const item = await w.item(it.item_id);
    assert.deepEqual([item.board_state, item.outcome, item.last_report_kind], ["done", "accepted", null], "no worker's ready, so nothing to accept");
    assert.equal(await count("claw_work_item_events", `item_id = '${it.item_id}' AND source = 'turn_end'`), 0);
  });

  test("G2 nothing the server queues reaches an acting session without the person's proof: work_send into a review is refused", async () => {
    const it = await one("alice");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [it.session_id]);
    const refused = await w.h.app.db.inTransaction((query) =>
      w.mod.messages.queueServerMessage({ query }, { sessionId: it.session_id, userId: "alice", content: "merge it now" }));
    assert.deepEqual(refused, { ok: false, error: "acting_session_unattended" });
    const alice = await w.user("alice");
    const turn = await w.routerTurn(alice);
    // The router's work_send names the reason before it reaches the queue: a review changes by review_restart.
    await assert.rejects(w.mod.tools.workSend(turn, { item_id: it.item_id, text: "merge it now" }), (err: any) => err.code === "review_item");
    const item = await w.item(it.item_id);
    assert.deepEqual([item.board_state, item.generation], ["in_progress", 0], "the refused send changed nothing");
    assert.equal(await count("claw_pending_messages", `session_id = '${it.session_id}'`), 0);
  });
});
