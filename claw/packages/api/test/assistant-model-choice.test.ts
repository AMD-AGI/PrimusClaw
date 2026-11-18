// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Model choice for the assistant's items (`model-choice.ts`, `model-fallback.ts`) against a real Postgres with the production schema.
 * Skipped without DATABASE_URL, and a skip is not a pass. Only the gateway's model list is stood in for (`modelChoicePorts.listModels`),
 * keyed by the key it is asked with, so each test says which key was asked and what it may use.
 *
 *   M1  precedence, layer by layer: asked > the payer's review default > the payer's default > the deployment's kind default; each test
 *       asserts which model, not that there is one
 *   M2  a review asked of someone else runs on that person's settings, asked of the gateway with that person's key; the model the
 *       requester named is set aside and they are told (`ignored`)
 *   M3  a name off the allow-list is refused with the list: work_create, review_start, model_default_set, PUT /v1/assistant/settings
 *   M4  a model the payer's key cannot use falls back to CLAW_FALLBACK_MODEL, recorded as model_asked and answered as fell_back_from
 *   M5  the gateway's list cannot be read: a model the user named is refused, a default runs unchecked
 *   M6  work_send with a model moves the item to it; without one, the item keeps the model it has
 *   M7  a worker turn keeps its session's model; the deployment's worker model only fills in for a session that names none
 *   M8  review_start takes "the strongest one" without the model's name in the message
 *   M9  model_default_set writes and clears the attended user's defaults, and GET /v1/assistant/settings shows them with the models
 *   M10 the router is shown the allow-list with its labels and the user's current defaults
 *   F1  a worker turn the gateway refused for want of a key binding runs again once on the fallback, the item moves to it, the user is told
 *   F2  a review's first turn runs again with its first message; a later turn of a review is not run again
 *   F3  a router turn answering the user runs again with the user's message and its attendance; only that turn takes the fallback
 *   F4  the completion handler runs it and then records no failure of the refused turn; a second failure is reported as it is
 *   F5  a router turn refused for an invalid bound key (the upstream's 401) runs again once on the fallback too; the user is told the key
 *       is invalid and where to upload a valid one, and a re-run refused the same way says so instead of asking them to say it again
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { redactStoredText } from "@claw/utils";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

const OPUS = "claude-opus-5.5";
const SONNET = "claude-sonnet-5.5";
const HAIKU = "claude-haiku-5.5";
const GLM = "glm-5-3-with-fallback";
const GPT = "gpt-6-luna";
const APIM_403 = "403 {\"error\":\"No APIM Key binding found. Please upload your APIM Key on the SaFE platform first.\"}";
/** A bound subscription key the upstream refused, as a failed turn's text reads in production (the gateway's own fallback found none). */
const APIM_401_INVALID = "401 {\"error\":{\"message\":\"{ \\\"statusCode\\\": 401, \\\"message\\\": \\\"Access denied due to invalid subscription key. "
  + "Make sure to provide a valid key for an active subscription.\\\" }No fallback model group found for original model_group=claude-sonnet-5.5. "
  + "Fallbacks=[{'glm-5-3-with-fallback': ['sonnet-5.5-alt']}]. Received Model Group=claude-sonnet-5.5\\nAvailable Model Group Fallbacks=None\\n"
  + "Error doing the fallback: { \\\"statusCode\\\": 401, \\\"message\\\": \\\"Access denied due to invalid subscription key.\\\" }\"}}";
const APIM_401 = "litellm.AuthenticationError: 401 {\"error\":{\"message\":\"{ \\\"statusCode\\\": 401, \\\"message\\\": \\\"Access denied due to missing subscription key. Make sure to include subscription key\"}}";

describe("assistant model choice", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let mc: typeof import("../src/assistant/model-choice.js");
  let fb: typeof import("../src/assistant/model-fallback.js");
  let ri: typeof import("../src/assistant/review-items.js");
  let rt: typeof import("../src/assistant/review-tools.js");
  let mcp: typeof import("../src/assistant/mcp.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  /** What each key may use; a key not here makes the list unreadable. */
  let usable: Record<string, string[]>;
  let asked: string[];

  before(async () => {
    w = await startWorld({
      CLAW_ASSISTANT_MODEL_CHOICE: "on",
      CLAW_ASSISTANT_MODELS: `${OPUS}=strongest,${SONNET}=default,${HAIKU}=fast,${GLM}=no APIM key needed,${GPT}=GPT`,
      CLAW_ASSISTANT_WORKER_MODEL: SONNET,
      CLAW_ASSISTANT_REVIEW_MODEL: OPUS,
      CLAW_FALLBACK_MODEL: GLM,
      CLAW_ASSISTANT_KEY_BINDING_URL: "https://console.example.com/llm-gateway",
      DEFAULT_MODEL: SONNET,
      CLAW_ASSISTANT_TOOLS: "on",
      CLAW_GITHUB_REVIEW_ENABLED: "true",
      CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40),
      CLAW_ASSISTANT_REVIEW_ITEMS: "true",
      CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: "chat-client",
    });
    mc = await import("../src/assistant/model-choice.js");
    fb = await import("../src/assistant/model-fallback.js");
    ri = await import("../src/assistant/review-items.js");
    rt = await import("../src/assistant/review-tools.js");
    mcp = await import("../src/assistant/mcp.js");
    mc.modelChoicePorts.listModels = async (key: string) => {
      asked.push(key);
      const ids = usable[key];
      if (!ids) throw new Error("the gateway did not answer");
      return ids;
    };
    const { registerAssistantRoutes, actingAsCredentialPorts } = await import("../src/routes/assistant.js");
    const { registerGithubReviewRoutes } = await import("../src/github-review/mcp.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    await registerAssistantRoutes(app);
    actingAsCredentialPorts.verify = async ({ actingAs }) => ({
      ok: true, user: { userId: actingAs, userName: `Name ${actingAs}`, roles: ["default"], platformKey: `pk-${actingAs}`, virtualKey: `vk-${actingAs}` },
    });
    const fakeService = {
      delegationOf: async () => "on",
      checkPullRequest: async () => ({ isError: false, body: { status: "ok", title: "t", head_sha: "a".repeat(40) }, text: "" }),
      decide: async () => ({ http: 200, body: { ok: true } }),
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
      claw_sessions, claw_assistant_messages, claw_user_model_prefs, claw_assistant_model_fallbacks, claw_github_confirmations, claw_github_audit CASCADE`);
    w.drains.length = 0;
    mc.clearModelListCache();
    usable = {};
    asked = [];
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  const PR = (number: number, owner = "AMD-AGI", repo = "PrimusClaw") => ({ owner, repo, number });
  const prefs = (userId: string, p: { default_model?: string | null; review_model?: string | null }) =>
    mc.writeModelPrefs((t, a) => w.h.app.db.db.query(t, a), userId, p);
  const resolve = (kind: "task" | "review", payer: string, askedFor?: string) =>
    mc.resolveItemModel((t, a) => w.h.app.db.db.query(t, a), { kind, payerUserId: payer, payerKey: `vk-${payer}`, asked: askedFor ?? null });
  const sessionModel = async (sid: string) => (await w.q("SELECT model FROM claw_sessions WHERE session_id = $1", [sid]))[0].model as string | null;
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) { return (err as { code?: string }).code ?? `fault: ${err}`; }
    return assert.fail("accepted");
  };

  /** A live router turn answering a message the user sent signed in, written down as the route writes it. */
  async function userTurn(u: { routerSid: string; userId: string }, content: string): Promise<Claims> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, '{"kind":"person"}'::jsonb, '{"repos":["AMD-AGI/PrimusClaw"]}'::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content],
    );
    return turn;
  }
  async function http(method: "GET" | "PUT" | "POST", user: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const r = await app.inject({ method, url, payload: payload as never, headers: { "x-test-user": user, ...headers } });
    return { status: r.statusCode, body: r.json() };
  }

  test("M1 precedence, layer by layer, for a task and for a review", async () => {
    usable["vk-alice"] = [OPUS, SONNET, HAIKU, GLM];
    // Nothing set: the deployment's default for the kind (the worker's for a task, the review default for a review).
    assert.deepEqual(await resolve("task", "alice"), { model: SONNET, source: "platform_kind_default" });
    assert.deepEqual(await resolve("review", "alice"), { model: OPUS, source: "platform_kind_default" });
    assert.deepEqual(asked, [], "the deployment's own defaults are not asked about");
    // The user's own default beats the deployment's, for both kinds.
    await prefs("alice", { default_model: HAIKU });
    assert.deepEqual(await resolve("task", "alice"), { model: HAIKU, source: "user_default" });
    assert.deepEqual(await resolve("review", "alice"), { model: HAIKU, source: "user_default" });
    // Their review default beats their default, for reviews only.
    await prefs("alice", { review_model: GLM });
    assert.deepEqual(await resolve("review", "alice"), { model: GLM, source: "user_kind_default" });
    assert.deepEqual(await resolve("task", "alice"), { model: HAIKU, source: "user_default" });
    // What the message asks for beats every default.
    assert.deepEqual(await resolve("review", "alice", OPUS), { model: OPUS, source: "asked" });
    assert.deepEqual(await resolve("task", "alice", OPUS), { model: OPUS, source: "asked" });
    // A default the allow-list no longer has is passed over.
    await w.q("UPDATE claw_user_model_prefs SET review_model = 'retired-model' WHERE user_id = 'alice'");
    assert.deepEqual(await resolve("review", "alice"), { model: HAIKU, source: "user_default" });
    // Someone else's settings are not alice's.
    assert.deepEqual(await resolve("task", "bob"), { model: SONNET, source: "platform_kind_default" });
  });

  test("M1b work_create puts the chosen model on the worker's session and the item, and says which", async () => {
    usable["vk-alice"] = [OPUS, SONNET, HAIKU];
    await prefs("alice", { default_model: HAIKU });
    const t1 = await w.routerTurn(alice);
    const own = await w.mod.tools.workCreate(t1, { title: "by default", brief: "do it" });
    assert.equal(own.model, HAIKU);
    const t2 = await w.routerTurn(alice);
    const named = await w.mod.tools.workCreate(t2, { title: "named", brief: "do it", model: OPUS });
    assert.equal(named.model, OPUS);
    assert.equal(named.fell_back_from, undefined);
    for (const [r, m] of [[own, HAIKU], [named, OPUS]] as const) {
      const item = await w.item(r.item_id);
      assert.deepEqual(item.params, { model: m });
      assert.equal(await sessionModel(item.worker_session_id), m);
    }
    assert.deepEqual([...new Set(asked)], ["vk-alice"], "asked with the user's own key, the one the worker is sealed with");
  });

  test("M2 a review asked of someone else runs on that person's settings and key; the requester's model is set aside and they are told", async () => {
    usable["vk-bob"] = [OPUS, SONNET, HAIKU];
    usable["vk-alice"] = [OPUS];
    await prefs("bob", { review_model: HAIKU });
    await prefs("alice", { review_model: OPUS });
    const r = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(254)], acting_as: "bob", model: OPUS },
      { "x-acting-as-token": "tok-bob", "x-acting-as-api-key": "ak-bob" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [answer] = r.body.data.items;
    assert.equal(answer.model, HAIKU, "the reviewer's own review default");
    assert.deepEqual(answer.ignored, ["model"], "the requester is told their model was not used");
    const item = await w.item(answer.item_id);
    assert.equal(item.user_id, "bob");
    assert.equal(item.params.model, HAIKU);
    assert.equal(await sessionModel(item.worker_session_id), HAIKU);
    assert.deepEqual(asked, ["vk-bob"], "asked with the reviewer's key, never the requester's");
    // With no setting of the reviewer's, the deployment's review default, whatever the requester's own setting is.
    await w.q("DELETE FROM claw_user_model_prefs WHERE user_id = 'bob'");
    const again = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(255)], acting_as: "bob" },
      { "x-acting-as-token": "tok-bob", "x-acting-as-api-key": "ak-bob" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.items[0].model, OPUS);
    assert.equal(again.body.data.items[0].ignored, undefined);
  });

  test("M3 a name off the allow-list is refused with the list, everywhere a model is named", async () => {
    const t1 = await userTurn(alice, "do it with gpt-4o");
    let err: any;
    try { await w.mod.tools.workCreate(t1, { title: "x", brief: "y", model: "gpt-4o" }); } catch (e) { err = e; }
    assert.equal(err?.code, "model_not_allowed");
    assert.deepEqual(err.data.models.map((m: { name: string }) => m.name), [OPUS, SONNET, HAIKU, GLM, GPT]);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items"))[0].n, 0, "nothing made");
    const t2 = await userTurn(alice, "review AMD-AGI/PrimusClaw#254 with gpt-4o");
    assert.equal(await code(rt.reviewStart(t2 as never, { prs: ["AMD-AGI/PrimusClaw#254"], merge: false, model: "gpt-4o" })), "model_not_allowed");
    const t3 = await userTurn(alice, "以后默认用 gpt-4o");
    assert.equal(await code(w.mod.tools.modelDefaultSet(t3 as never, { model: "gpt-4o" })), "model_not_allowed");
    const put = await http("PUT", "alice", "/v1/assistant/settings", { review_model: "gpt-4o" });
    assert.equal(put.status, 400);
    assert.equal(put.body.error, "model_not_allowed");
    const reviews = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(254)], acting_as: "alice", model: "gpt-4o" });
    assert.equal(reviews.status, 400);
    assert.equal(reviews.body.error, "model_not_allowed");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_user_model_prefs"))[0].n, 0, "no setting written");
  });

  test("M4 a model the payer's key cannot use falls back to the fallback model, recorded and answered", async () => {
    usable["vk-alice"] = [SONNET, GLM];
    const t1 = await w.routerTurn(alice);
    const created = await w.mod.tools.workCreate(t1, { title: "opus task", brief: "do it", model: OPUS });
    assert.equal(created.model, GLM);
    assert.equal(created.fell_back_from, OPUS);
    const item = await w.item(created.item_id);
    assert.deepEqual(item.params, { model: GLM, model_asked: OPUS });
    assert.equal(await sessionModel(item.worker_session_id), GLM);
    // A review falls back the same way; with the fallback unusable too, to the deployment's review default.
    const r = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(254)], acting_as: "alice", model: HAIKU });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.items[0].model, r.body.data.items[0].fell_back_from], [GLM, HAIKU]);
    assert.equal((await w.item(r.body.data.items[0].item_id)).params.model_asked, HAIKU);
    usable["vk-alice"] = [SONNET];
    mc.clearModelListCache();
    assert.deepEqual(await resolve("review", "alice", HAIKU), { model: OPUS, source: "asked", fellBackFrom: HAIKU });
  });

  test("M5 the list cannot be read: a named model is refused, a default runs unchecked", async () => {
    const t1 = await w.routerTurn(alice);
    assert.equal(await code(w.mod.tools.workCreate(t1, { title: "named", brief: "do it", model: OPUS })), "model_unverifiable");
    await prefs("alice", { default_model: HAIKU });
    const t2 = await w.routerTurn(alice);
    const created = await w.mod.tools.workCreate(t2, { title: "default", brief: "do it" });
    assert.equal(created.model, HAIKU, "the user's default runs, unchecked");
    assert.equal(created.fell_back_from, undefined);
  });

  test("M6 work_send with a model moves the item to it; without one the item keeps its model", async () => {
    usable["vk-alice"] = [OPUS, SONNET, HAIKU];
    const made = await w.createItem(alice, "task");
    assert.equal(await sessionModel(made.workerSid), SONNET);
    const t1 = await w.routerTurn(alice);
    const sent = await w.mod.tools.workSend(t1, { item_id: made.itemId, text: "go on, with opus", model: OPUS });
    assert.equal(sent.model, OPUS);
    assert.equal(await sessionModel(made.workerSid), OPUS);
    assert.equal((await w.item(made.itemId)).params.model, OPUS);
    await w.closeRun(t1.task_id);
    const t2 = await w.routerTurn(alice);
    const plain = await w.mod.tools.workSend(t2, { item_id: made.itemId, text: "and the docs" });
    assert.equal(plain.model, undefined);
    assert.equal(await sessionModel(made.workerSid), OPUS, "kept");
  });

  test("M7 a worker turn keeps its session's model; the worker model fills in only for a session that names none", async () => {
    usable["vk-alice"] = [HAIKU, SONNET];
    const t1 = await w.routerTurn(alice);
    const created = await w.mod.tools.workCreate(t1, { title: "haiku", brief: "do it", model: HAIKU });
    const sid = (await w.item(created.item_id)).worker_session_id;
    const run = await w.openRun(sid);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "do it", model: HAIKU };
    await w.mod.role.applySessionRoleToTask(task, sid);
    assert.equal(task.model, HAIKU, "the item's model, not CLAW_ASSISTANT_WORKER_MODEL");
    const run2 = await w.openRun(sid);
    const bare: Record<string, unknown> = { task_id: run2.taskId, message_id: run2.messageId, prompt: "do it" };
    await w.mod.role.applySessionRoleToTask(bare, sid);
    assert.equal(bare.model, SONNET, "a session that names none gets the deployment's worker model");
  });

  test("M8 review_start takes a model the message names only by kind", async () => {
    usable["vk-alice"] = [OPUS, SONNET, HAIKU];
    const starts: Array<Record<string, unknown>> = [];
    const real = rt.reviewToolPorts.startReviews;
    rt.reviewToolPorts.startReviews = (async (_u: unknown, _m: unknown, request: Record<string, unknown>) => { starts.push(request); return []; }) as never;
    try {
      const t = await userTurn(alice, "用最强的模型 review AMD-AGI/PrimusClaw#254");
      const out = await rt.reviewStart(t as never, { prs: ["AMD-AGI/PrimusClaw#254"], merge: false, model: OPUS });
      assert.equal(out.ok, true);
      assert.equal(starts[0].model, OPUS);
    } finally {
      rt.reviewToolPorts.startReviews = real;
    }
  });

  test("M9 model_default_set and the settings routes write, show and clear the user's defaults", async () => {
    usable["vk-alice"] = [OPUS, SONNET, GLM];
    const t1 = await userTurn(alice, "以后 review 默认用 opus");
    assert.deepEqual(await w.mod.tools.modelDefaultSet(t1 as never, { kind: "review", model: OPUS }), { ok: true, kind: "review", model: OPUS });
    const got = await http("GET", "alice", "/v1/assistant/settings");
    assert.equal(got.status, 200);
    assert.equal(got.body.data.review_model, OPUS);
    assert.equal(got.body.data.default_model, null);
    assert.deepEqual(got.body.data.models.map((m: { name: string }) => m.name), [OPUS, SONNET, GLM], "the allow-list, less what the key cannot use");
    assert.equal(got.body.data.models_checked, true);
    assert.deepEqual(got.body.data.platform, { task: SONNET, review: OPUS });
    const put = await http("PUT", "alice", "/v1/assistant/settings", { default_model: SONNET });
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.data.default_model, put.body.data.review_model], [SONNET, OPUS], "a field left out is kept");
    const t2 = await userTurn(alice, "review 不用默认了");
    assert.deepEqual(await w.mod.tools.modelDefaultSet(t2 as never, { kind: "review", model: null }), { ok: true, kind: "review", model: null });
    assert.deepEqual(await mc.readModelPrefs((t, a) => w.h.app.db.db.query(t, a), "alice").then((p) => [p.default_model, p.review_model]), [SONNET, null]);
    // A turn that answers no message of the user's (a report's) cannot change their settings.
    const report = await w.routerTurn(alice);
    assert.equal(await code(w.mod.tools.modelDefaultSet(report as never, { model: OPUS })), "not_attended");
    // Bob's settings are his: alice's route reads and writes only hers.
    assert.equal((await http("GET", "bob", "/v1/assistant/settings")).body.data.default_model, null);
  });

  test("M10 the router is shown the allow-list with its labels and the user's defaults, and is offered the tools' model arguments", async () => {
    await prefs("alice", { review_model: HAIKU });
    const run = await w.openRun(alice.routerSid);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "hi" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    const text = String(task.system_append);
    for (const line of [`- ${OPUS} (strongest)`, `- ${HAIKU} (fast)`, `- ${GLM} (no APIM key needed)`, `- ${GPT} (GPT)`]) assert.ok(text.includes(line), line);
    assert.ok(text.includes(`tasks ${SONNET} (not set by them); reviews ${HAIKU} (their setting)`), text.slice(text.indexOf("The user's defaults")));
    assert.equal(task.model, undefined, "the router's model is not the user's to choose");
    const server = mcp.createAssistantMcpServer({ sid: alice.routerSid, role: "router", mid: "m", task_id: "t", exp: 0 } as never);
    const tools = (server as any)._registeredTools as Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    assert.ok(tools.model_default_set, "model_default_set is offered");
    assert.ok("model" in (tools.work_create.inputSchema?.shape ?? {}), "work_create takes model");
    assert.ok("model" in (tools.work_send.inputSchema?.shape ?? {}), "work_send takes model");
  });

  test("F1 a worker turn refused for want of a key binding runs again once on the fallback, and the user is told", async () => {
    const made = await w.createItem(alice, "an opus task", "build the thing");
    const run = await w.openRun(made.workerSid);
    await w.q("UPDATE claw_tasks SET prompt = 'build the thing' WHERE task_id = $1", [run.taskId]);
    await w.closeRun(run.taskId, "failed", "agent_error", 0);
    const end = { sessionId: made.workerSid, runIds: [run.taskId], messageId: run.messageId, failed: true, interrupted: false, finalText: APIM_403 };
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "rerun");
    const queued = await w.pending(made.workerSid);
    assert.deepEqual(queued.map((p) => p.content), ["build the thing"], "the run's own words, queued again");
    assert.equal(await sessionModel(made.workerSid), GLM, "the item runs on the fallback from now on");
    assert.deepEqual((await w.item(made.itemId)).params, { model: GLM, model_asked: SONNET });
    assert.ok((await w.itemEvents(made.itemId)).some((e) => e.kind === "model_fallback"), "the item's log says so");
    const says = await w.q("SELECT text, fallback FROM claw_assistant_says WHERE user_id = 'alice'");
    assert.equal(says.length, 1);
    assert.ok(says[0].fallback);
    assert.match(says[0].text, new RegExp(`#${made.seq} .*${SONNET}.*${GLM}.*https://console\\.example\\.com/llm-gateway`, "s"));
    // Once: the same refused turn again, and the re-run's own refusal, are left to be reported as they are.
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "skipped");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [made.workerSid]);
    const second = await w.openRun(made.workerSid);
    await w.q("UPDATE claw_tasks SET prompt = 'build the thing', input = jsonb_build_object('model', $2::text) WHERE task_id = $1", [second.taskId, GLM]);
    await w.closeRun(second.taskId, "failed", "agent_error", 0);
    assert.equal(await fb.rerunOnFallback({ ...end, runIds: [second.taskId], messageId: second.messageId, finalText: APIM_401 }, w.sayDeps), "skipped");
    // An answer that merely quotes the refusal is not one; neither is a turn that did not fail.
    assert.equal(fb.isMissingKeyRefusal(`The proxy said: ${APIM_403}`), false);
    assert.equal(fb.isMissingKeyRefusal(APIM_401), true);
    assert.equal(await fb.rerunOnFallback({ ...end, failed: false }, w.sayDeps), "skipped");
    // A turn that failed for any other reason is not run again.
    const other = await w.createItem(alice, "another task", "build another thing");
    const failedRun = await w.openRun(other.workerSid);
    await w.q("UPDATE claw_tasks SET prompt = 'build another thing' WHERE task_id = $1", [failedRun.taskId]);
    await w.closeRun(failedRun.taskId, "failed", "agent_error", 0);
    assert.equal(await fb.rerunOnFallback({
      sessionId: other.workerSid, runIds: [failedRun.taskId], messageId: failedRun.messageId, failed: true, interrupted: false,
      finalText: "529 overloaded", failureReason: "agent_error",
    }, w.sayDeps), "skipped");
    assert.equal((await w.pending(other.workerSid)).length, 0);
  });

  test("F2 a review's first turn runs again with its first message; a later turn is not run again", async () => {
    const r = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(254)], acting_as: "alice" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const it = r.body.data.items[0];
    const item = await w.item(it.item_id);
    const [first] = await w.pending(item.worker_session_id);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [item.worker_session_id]);
    const run = await w.openRun(item.worker_session_id);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [run.taskId, first.content]);
    await w.closeRun(run.taskId, "failed", "agent_error", 0);
    const end = { sessionId: item.worker_session_id, runIds: [run.taskId], messageId: run.messageId, failed: true, interrupted: false, finalText: APIM_403 };
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "rerun");
    assert.deepEqual((await w.pending(item.worker_session_id)).map((p) => p.content), [first.content], "the first message, with the person's say");
    // A review stopped (or restarted) before its refused turn is handled is not run again: its row is read under the lock a stop takes.
    const r3 = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(256)], acting_as: "alice" });
    const item3 = await w.item(r3.body.data.items[0].item_id);
    const [first3] = await w.pending(item3.worker_session_id);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [item3.worker_session_id]);
    const run3 = await w.openRun(item3.worker_session_id);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [run3.taskId, first3.content]);
    await w.closeRun(run3.taskId, "failed", "agent_error", 0);
    await w.q("UPDATE claw_work_items SET board_state = 'done', outcome = 'stopped', closed_at = NOW() WHERE item_id = $1", [item3.item_id]);
    assert.equal(await fb.rerunOnFallback({ ...end, sessionId: item3.worker_session_id, runIds: [run3.taskId], messageId: run3.messageId }, w.sayDeps), "skipped");
    assert.equal((await w.pending(item3.worker_session_id)).length, 0, "nothing queued in a stopped review");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_model_fallbacks WHERE session_id = $1", [item3.worker_session_id]))[0].n, 0,
      "and nothing recorded: the attempt is rolled back with it");
    assert.deepEqual([(await w.item(it.item_id)).params.model, (await w.item(it.item_id)).params.model_asked], [GLM, OPUS]);
    // A second review whose refused turn is not its first: nothing is queued in it by the server.
    const r2 = await http("POST", "alice", "/v1/assistant/reviews", { prs: [PR(255)], acting_as: "alice" });
    const item2 = await w.item(r2.body.data.items[0].item_id);
    const [first2] = await w.pending(item2.worker_session_id);
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [item2.worker_session_id]);
    const done = await w.openRun(item2.worker_session_id);
    await w.q("UPDATE claw_tasks SET prompt = $2, created_at = NOW() - INTERVAL '1 minute' WHERE task_id = $1", [done.taskId, first2.content]);
    await w.closeRun(done.taskId, "completed", undefined, 0);
    // The person's own later message in the session, even in the same words as the first, is theirs alone to send again.
    const later = await w.openRun(item2.worker_session_id);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [later.taskId, first2.content]);
    await w.closeRun(later.taskId, "failed", "agent_error", 0);
    assert.equal(await fb.rerunOnFallback({ ...end, sessionId: item2.worker_session_id, runIds: [later.taskId], messageId: later.messageId }, w.sayDeps), "skipped");
    assert.equal((await w.pending(item2.worker_session_id)).length, 0);
    assert.equal(await sessionModel(item2.worker_session_id), OPUS, "unchanged");
  });

  test("F3b a router turn run again is given the user's words as the model first was, not the masked copy stored of them", async () => {
    // Assembled from pieces so no scanner reads this file as holding a credential.
    const words = `deploy with ak-${"Q7w8E9r0T1y2".repeat(4)} please`;
    const turn = await userTurn(alice, redactStoredText(words).text);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [turn.task_id, words]);
    await w.closeRun(turn.task_id, "failed", "agent_error", 0);
    const end = { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: true, interrupted: false, finalText: APIM_401 };
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "rerun");
    const [queued] = await w.pending(alice.routerSid);
    assert.equal(queued.content, words);
    const copied = await w.q("SELECT content FROM claw_assistant_messages WHERE session_id = $1", [alice.routerSid]);
    assert.ok(copied.every((r: { content: string }) => r.content === "deploy with <redacted> please"), "the stored copies stay masked");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);

    // A run whose prompt is not that message (masking it does not give the stored words) is run again with the stored words.
    const other = await userTurn(alice, "review AMD-AGI/PrimusClaw#255");
    await w.q("UPDATE claw_tasks SET prompt = 'something else' WHERE task_id = $1", [other.task_id]);
    await w.closeRun(other.task_id, "failed", "agent_error", 0);
    assert.equal(await fb.rerunOnFallback({ ...end, runIds: [other.task_id], messageId: other.mid }, w.sayDeps), "rerun");
    assert.equal((await w.pending(alice.routerSid))[0].content, "review AMD-AGI/PrimusClaw#255");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
  });

  test("F3 a router turn answering the user runs again with their message and its attendance, and only that turn takes the fallback", async () => {
    const turn = await userTurn(alice, "review AMD-AGI/PrimusClaw#254");
    await w.closeRun(turn.task_id, "failed", "agent_error", 0);
    const end = { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: true, interrupted: false, finalText: APIM_401 };
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "rerun");
    const [queued] = await w.pending(alice.routerSid);
    assert.equal(queued.content, "review AMD-AGI/PrimusClaw#254");
    const rerunId = `claw-pending-${queued.id}`;
    const copied = await w.q("SELECT content, attended_via, received_at FROM claw_assistant_messages WHERE session_id = $1 ORDER BY message_id", [alice.routerSid]);
    assert.equal(copied.length, 2);
    assert.deepEqual(copied[0].attended_via, copied[1].attended_via);
    assert.equal(new Date(copied[0].received_at).getTime(), new Date(copied[1].received_at).getTime(), "goes stale when the first would have");
    assert.equal(await fb.rerunModelOf(alice.routerSid, rerunId), GLM);
    assert.equal(await fb.rerunModelOf(alice.routerSid, turn.mid), null);
    assert.equal(await sessionModel(alice.routerSid), null, "the router session's own model is unchanged");
    // Once per refused turn: its completion delivered again queues nothing more.
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "skipped");
    assert.equal((await w.pending(alice.routerSid)).length, 1);
    // ... and not after the re-run was taken off the queue either.
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
    assert.equal(await fb.rerunOnFallback(end, w.sayDeps), "skipped");
    assert.equal((await w.pending(alice.routerSid)).length, 0);
    const run = await w.openRun(alice.routerSid, { messageId: rerunId });
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: rerunId, prompt: queued.content };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.equal(task.model, GLM, "the turn run again takes the fallback");
    // A turn a worker's report started is not run again.
    const report = await w.routerTurn(alice);
    await w.closeRun(report.task_id, "failed", "agent_error", 0);
    assert.equal(await fb.rerunOnFallback({ ...end, runIds: [report.task_id], messageId: report.mid }, w.sayDeps), "skipped");
  });

  test("F4 the completion handler runs it, and records no failure of the refused turn; the re-run's failure is reported", async () => {
    const turn = await userTurn(alice, "看一下 254");
    const { consumeEventDelivery, tombstoneReader } = w.mod.consumer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const complete = async (mid: string, taskId: string, seq: number) => consumeEventDelivery({
      subject: `events.${alice.routerSid}`,
      data: sc.encode(JSON.stringify({
        type: "exec_complete", session_id: alice.routerSid, user_id: "alice", message_id: mid, task_id: taskId,
        final_text: APIM_403, failed: true, failure_reason: "agent_error", error_count: 1, skills_used: {},
      })),
      seq, ack: () => {}, nak: () => {},
    });
    try {
      await complete(turn.mid, turn.task_id, 1);
      const says = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at");
      assert.equal(says.length, 1, says.map((s) => s.text).join(" | "));
      assert.match(says[0].text, /APIM Key/, "the fallback notice, not the turn-lost one");
      const [queued] = await w.pending(alice.routerSid);
      assert.ok(queued, "queued again");
      const rerunId = `claw-pending-${queued.id}`;
      await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
      const run = await w.openRun(alice.routerSid, { messageId: rerunId });
      await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [run.taskId, queued.content]);
      await complete(rerunId, run.taskId, 2);
      const after = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at");
      assert.equal(after.length, 2);
      assert.match(after[1].text, /还没有绑定 APIM Key[^]*https:\/\/console\.example\.com\/llm-gateway/,
        "the re-run's refusal is told as the key's, with where to bind one");
      assert.doesNotMatch(after[1].text, /请再说一次/);
      assert.equal((await w.pending(alice.routerSid)).length, 0, "and not run a third time");
    } finally {
      Object.assign(tombstoneReader, originalTombstone);
      resetDeletedSessionCache();
    }
  });
  test("F5 a router turn refused for an invalid bound key runs again on the fallback, and the user is told the key is invalid and where to fix it", async () => {
    assert.equal(fb.isMissingKeyRefusal(APIM_401_INVALID), false, "not the missing-key refusal");
    const kr = await import("../src/assistant/key-refusal.js");
    assert.equal(kr.keyRefusalOf(APIM_401_INVALID), "invalid");
    assert.equal(kr.keyRefusalOf(`litellm.AuthenticationError: ${APIM_401_INVALID}`), "invalid");
    assert.equal(kr.keyRefusalOf(APIM_401), "missing");
    assert.equal(kr.keyRefusalOf(APIM_403), "missing");
    assert.equal(kr.keyRefusalOf(`Your key was refused: ${APIM_401_INVALID}`), null, "an answer that quotes it is an answer");
    assert.equal(kr.keyRefusalOf("500 internal error: invalid subscription key"), null, "only the 401");
    const turn = await userTurn(alice, "为什么没有回答我？");
    const { consumeEventDelivery, tombstoneReader } = w.mod.consumer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const complete = async (mid: string, taskId: string, seq: number) => consumeEventDelivery({
      subject: `events.${alice.routerSid}`,
      data: sc.encode(JSON.stringify({
        type: "exec_complete", session_id: alice.routerSid, user_id: "alice", message_id: mid, task_id: taskId,
        final_text: APIM_401_INVALID, failed: true, failure_reason: "agent_error", error_count: 1, skills_used: {},
      })),
      seq, ack: () => {}, nak: () => {},
    });
    try {
      await complete(turn.mid, turn.task_id, 1);
      const says = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at");
      assert.equal(says.length, 1, says.map((s) => s.text).join(" | "));
      assert.equal(says[0].text,
        `你绑定的 APIM Key 无效或已过期，用不了 默认模型，这条消息改用 ${GLM} 处理。重新上传有效的 APIM Key 后即可使用 默认模型：\nhttps://console.example.com/llm-gateway`,
        "the router runs on the deployment's model, which its session does not name");
      const [queued] = await w.pending(alice.routerSid);
      assert.equal(queued?.content, "为什么没有回答我？", "the user's message, queued again");
      const rerunId = `claw-pending-${queued.id}`;
      const [fell] = await w.q("SELECT model, from_model, rerun_message_id FROM claw_assistant_model_fallbacks WHERE session_id = $1", [alice.routerSid]);
      assert.deepEqual(fell, { model: GLM, from_model: null, rerun_message_id: rerunId });
      // The re-run refused the same way: told what to fix and where, not asked to say it again, and not run a third time.
      await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
      const run = await w.openRun(alice.routerSid, { messageId: rerunId });
      await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [run.taskId, queued.content]);
      await complete(rerunId, run.taskId, 2);
      const after = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at");
      assert.equal(after.length, 2, after.map((s) => s.text).join(" | "));
      assert.equal(after[1].text, "你绑定的 APIM Key 无效或已过期，模型网关拒绝了这条消息。重新上传有效的 APIM Key 后再发一次即可：\nhttps://console.example.com/llm-gateway");
      assert.equal((await w.pending(alice.routerSid)).length, 0, "not run a third time");
      assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_model_fallbacks WHERE session_id = $1", [alice.routerSid]))[0].n, 1);
    } finally {
      Object.assign(tombstoneReader, originalTombstone);
      resetDeletedSessionCache();
    }
  });
});
