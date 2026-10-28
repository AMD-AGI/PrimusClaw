// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HITL_SUMMARY_MODEL: the approval card's one-sentence summary can be written by a small, fast model
 * instead of the run's own, and it is paid for with the run's own key.
 *
 * Driven through the real loop and the real Anthropic provider against a local stand-in for the
 * gateway, because the claims are about what goes on the wire: which model name, which key, which
 * knobs, and what happens when the gateway says no. The run's own session is scripted.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The deployment's budget and a deployment-wide key sit in the environment the way they do in a pod. The
// summary must use neither: the budget is shortened so a hung gateway is quick to prove, the key is planted
// so a leak of it onto the wire is visible.
process.env.HITL_SUMMARY_TIMEOUT_MS = "300";
const DEPLOYMENT_KEY = "deployment-shared-key-DO-NOT-USE";
process.env.ANTHROPIC_API_KEY = DEPLOYMENT_KEY;

import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";
const { agentLoop } = await import("../src/agent/agent-loop.js");
type LoopOptions = import("../src/agent/agent-loop.js").LoopOptions;
const { HitlController } = await import("../src/agent/hitl.js");
const { registry } = await import("../src/infra/metrics.js");
const { modelRefusalStatus, summaryCompleter, summarySessionId } = await import("../src/agent/summary-completer.js");
const { getProvider } = await import("../src/llm/index.js");

const TOOL = "mcp__ops__stop_workload";
const INPUT = { workload_id: "train-70b", reason: "stuck" };
const COUNTER = "claw_brain_approval_summary_model_refused_total";

// --- a stand-in for the gateway ---------------------------------------------------------------

interface Seen { path: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }
type Reply = { status: number; body?: unknown } | "hang";

const seen: Seen[] = [];
let reply: (req: Seen) => Reply = () => ({ status: 200 });
const message = (text: string) => ({
  id: "msg_1", type: "message", role: "assistant", model: "stub", stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 },
});
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rec: Seen = { path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
    seen.push(rec);
    const r = reply(rec);
    if (r === "hang") return;   // never answered; the client's budget has to end it
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body ?? message("在 prod-a 中停止 train-70b；理由：stuck")));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

const refusal = (status: number, message = "not allowed") =>
  ({ status, body: { type: "error", error: { type: "permission_error", message } } }) as Reply;

// --- the loop ---------------------------------------------------------------------------------

const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmContentBlock => ({ type: "tool_use", id, name, input });
const text = (t: string): LlmContentBlock => ({ type: "text", text: t });

function runSession(turns: Array<Partial<LlmTurnResult>>, completeCalls: unknown[][]): LlmSession {
  let i = 0;
  return {
    async streamTurn() {
      const turn = turns[i++];
      if (!turn) throw new Error("scripted session exhausted");
      return {
        content: turn.content ?? [], stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete(...args: unknown[]) { completeCalls.push(args); return "the run's own model wrote this"; },
  };
}

/** One run with one approval-gated call per turn. Returns each permissionRequest it raised. */
async function run(o: {
  apiKey: string; model?: string; calls?: number; parallel?: boolean;
  /** The run's session id; `null` is a run that has none. */
  sessionId?: string | null;
  /** Let the run's own completions go over the wire (real provider), so the header they carry can be read. */
  runOnWire?: boolean;
}) {
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const dispatcher = {
    register: async (req: { actionId: string }) =>
      ({ type: "decision", session_id: "s", action_id: req.actionId, decision: "allow" }) as NatsDecisionMessage,
  };
  const hitl = new HitlController(dispatcher as never, onEvent as never, { requireApproval: (t: string) => t === TOOL });
  const executed: string[] = [];
  const router = { route: async (name: string) => { executed.push(name); return "ok"; }, setHands: () => {} } as unknown as ToolRouter;
  const n = o.calls ?? 1;
  const turns: Array<Partial<LlmTurnResult>> = o.parallel
    ? [{ content: Array.from({ length: n }, (_, i) => toolUse(`t${i}`, TOOL, INPUT)), stopReason: "tool_use" }]
    : Array.from({ length: n }, (_, i) => ({ content: [toolUse(`t${i}`, TOOL, INPUT)], stopReason: "tool_use" as const }));
  turns.push({ content: [text("done")], stopReason: "end_turn" });
  const completeCalls: unknown[][] = [];
  const tools = [{ name: TOOL, description: "Stop a workload.", input_schema: { type: "object", properties: {} } }] as unknown as ToolSchema[];
  const sessionId = o.sessionId === null ? undefined : (o.sessionId ?? "s");
  const scripted = runSession(turns, completeCalls);
  const wire = o.runOnWire
    ? getProvider().createSession({ model: "run-model", apiUrl: API_URL, apiKey: o.apiKey, userId: "u", sessionId })
    : undefined;
  const opts = {
    model: "run-model", apiUrl: API_URL, apiKey: o.apiKey, maxTurns: 10, router, onEvent, sessionId, userId: "u",
    llmSession: wire ? { ...scripted, complete: wire.complete.bind(wire) } : scripted, hitl, hitlSummaryModel: o.model,
  } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "停掉 train-70b" } as Message], tools, opts);
  return { asks: events.filter((e) => e.type === "permissionRequest"), executed, completeCalls };
}

async function refusedCount(status: number): Promise<number> {
  const m = registry.getSingleMetric(COUNTER) as unknown as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> };
  return (await m.get()).values.filter((v) => v.labels.status === String(status)).reduce((a, v) => a + v.value, 0);
}
const reset = (r: (req: Seen) => Reply = () => ({ status: 200 })) => { seen.length = 0; reply = r; };

// --- 1. the configured model, on the run's own key --------------------------------------------

test("HITL_SUMMARY_MODEL set: the summary is that model, small and low-effort, and the run's model is not asked", async () => {
  reset();
  const { asks, executed, completeCalls } = await run({ apiKey: "user-key-alice", model: "small-fast" });
  assert.equal(seen.length, 1, "one gateway call: the summary");
  assert.equal(seen[0].path, "/v1/messages");
  assert.equal(seen[0].body.model, "small-fast");
  assert.ok(seen[0].body.max_tokens <= 200, "a small token budget");
  assert.deepEqual(seen[0].body.output_config, { effort: "low" }, "no thinking for a one-sentence answer");
  assert.equal(asks[0].summary, "在 prod-a 中停止 train-70b；理由：stuck");
  assert.equal(asks[0].summary_by, "model");
  assert.equal(completeCalls.length, 0, "the run's own model never wrote it");
  assert.deepEqual(executed, [TOOL], "approval itself is unchanged");
});

test("the summary is billed to the run's own key: the user's, or the platform key in proxy mode, never a deployment key", async () => {
  // `apiKey` is what the engine resolved for the run (resolveRequestLlmKey): the user's virtual key by default,
  // the platform key in proxy mode. Whichever it is, it is the only credential on the summary call.
  for (const key of ["user-key-alice", "user-key-bob", "platform-key-carol"]) {
    reset();
    await run({ apiKey: key, model: "small-fast" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["x-api-key"], key);
    const wire = JSON.stringify(seen[0].headers);
    assert.ok(!wire.includes(DEPLOYMENT_KEY), "the deployment's own key is nowhere on the request");
    for (const other of ["user-key-alice", "user-key-bob", "platform-key-carol"].filter((k) => k !== key)) {
      assert.ok(!wire.includes(other), `another run's key (${other}) is not on this request`);
    }
  }
});

test("concurrent runs for two users each pay with their own key", async () => {
  reset();
  await Promise.all([run({ apiKey: "user-key-alice", model: "small-fast" }), run({ apiKey: "user-key-bob", model: "small-fast" })]);
  assert.deepEqual(seen.map((s) => s.headers["x-api-key"]).sort(), ["user-key-alice", "user-key-bob"]);
});

// --- the affinity key ---------------------------------------------------------------------------

test("the summary call carries its own x-litellm-session-id when it is a different model, and the run's own when it is not", async () => {
  // The gateway's Auto Router pins a session to one backend by this header, and a different model under the run's
  // id would re-pin it: the run's next turn lands on another backend (thinking replay 400s, the prompt cache is lost).
  // Read off the wire, from the real provider, not from what the loop meant to pass.
  const rows: Array<{ name: string; o: Parameters<typeof run>[0]; header: string; metaSessionId: string }> = [
    { name: "summary model set", o: { model: "small-fast", sessionId: "s" }, header: "s:approval-summary", metaSessionId: "s:approval-summary" },
    { name: "summary model set, another run id", o: { model: "small-fast", sessionId: "run-42" }, header: "run-42:approval-summary", metaSessionId: "run-42:approval-summary" },
    { name: "summary model set, run has no id", o: { model: "small-fast", sessionId: null }, header: "", metaSessionId: "" },
    { name: "summary model unset: the run's own model, the run's own id", o: { runOnWire: true, sessionId: "s" }, header: "s", metaSessionId: "s" },
    { name: "summary model blank: the same as unset", o: { runOnWire: true, model: "   ", sessionId: "s" }, header: "s", metaSessionId: "s" },
  ];
  for (const { name, o, header, metaSessionId } of rows) {
    reset();
    const { asks } = await run({ apiKey: "user-key-alice", calls: 2, ...o });
    assert.equal(asks.length, 2, name);
    assert.ok(seen.length >= 1, `${name}: the summary went over the wire`);
    for (const s of seen) {
      assert.equal(s.headers["x-litellm-session-id"] ?? "", header, `${name}: x-litellm-session-id`);
      assert.equal(JSON.parse(String(s.headers["x-litellm-spend-logs-metadata"])).session_id, metaSessionId, `${name}: spend-logs session_id`);
      assert.equal(s.headers["x-litellm-end-user-id"], "u", `${name}: spend still attributes to the user`);
    }
    if (o.model === "small-fast") {
      assert.equal(seen[0].body.model, "small-fast", `${name}: it is the summary model on the wire`);
      if (o.sessionId) assert.notEqual(seen[0].headers["x-litellm-session-id"], o.sessionId, `${name}: not the run's own id`);
    }
  }
});

test("summarySessionId: derived from the run's id, stable, and empty when the run has none", () => {
  assert.equal(summarySessionId("s"), "s:approval-summary");
  assert.equal(summarySessionId("s"), summarySessionId("s"));
  assert.notEqual(summarySessionId("a"), summarySessionId("b"));
  assert.equal(summarySessionId(undefined), undefined);
  assert.equal(summarySessionId(""), undefined);
});

// --- 2. unset: exactly what it was ------------------------------------------------------------

test("HITL_SUMMARY_MODEL unset: the run's own session writes it, with the call it always made", async () => {
  reset();
  const { asks, completeCalls } = await run({ apiKey: "user-key-alice" });
  assert.equal(seen.length, 0, "the gateway is not called by a second client");
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].length, 4, "system, user, max tokens, signal: no new argument");
  assert.equal(asks[0].summary, "the run's own model wrote this");
  const blank = await run({ apiKey: "user-key-alice", model: "   " });
  assert.equal(seen.length, 0, "a blank setting is the same as unset");
  assert.equal(blank.completeCalls.length, 1);
});

// --- 3. the gateway says no -------------------------------------------------------------------

test("a model the key may not call (401, 403, 404, 400 'model not found'): no summary, one counter, same key, no retry on another path", async () => {
  const rows: Array<[number, Reply]> = [
    [401, refusal(401, "key not allowed to access model")],
    [403, refusal(403)],
    [404, refusal(404, "model: small-fast")],
    [400, refusal(400, "Invalid model name passed in model=small-fast")],
  ];
  for (const [status, r] of rows) {
    reset(() => r);
    const before = await refusedCount(status);
    const { asks, executed, completeCalls } = await run({ apiKey: "user-key-alice", model: "small-fast", calls: 2 });
    assert.equal(asks.length, 2, `${status}: both approvals are still asked`);
    for (const ask of asks) { assert.ok(!("summary" in ask), `${status}: no summary`); assert.equal(ask.tool_description, "Stop a workload."); }
    assert.deepEqual(executed, [TOOL, TOOL], `${status}: approval semantics unchanged`);
    assert.equal(seen.length, 1, `${status}: refused once per run, not once per card`);
    assert.equal(seen[0].headers["x-api-key"], "user-key-alice");
    assert.equal(completeCalls.length, 0, `${status}: not rerouted to the run's model`);
    assert.equal(await refusedCount(status) - before, 1, `${status}: one counter`);
  }
});

test("two cards raised at once by one run count one refusal", async () => {
  reset(() => refusal(404));
  const before = await refusedCount(404);
  const { asks } = await run({ apiKey: "user-key-alice", model: "small-fast", calls: 2, parallel: true });
  assert.equal(asks.length, 2);
  assert.equal(await refusedCount(404) - before, 1);
});

test("another run asks again: the refusal is remembered per run, not for the process", async () => {
  reset(() => refusal(403));
  await run({ apiKey: "user-key-alice", model: "small-fast" });
  reset(() => ({ status: 200 }));
  const { asks } = await run({ apiKey: "user-key-bob", model: "small-fast" });
  assert.equal(seen.length, 1);
  assert.equal(asks[0].summary_by, "model", "a user whose key is allowed gets the summary");
});

test("a failure that is not a refusal (400 about max_tokens, 429) is not counted and is tried again on the next card", async () => {
  for (const r of [refusal(400, "max_tokens: too large"), { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } } as Reply]) {
    reset(() => r);
    const before = [await refusedCount(400), await refusedCount(429)];
    const { asks } = await run({ apiKey: "user-key-alice", model: "small-fast", calls: 2 });
    assert.ok(asks.every((a) => !("summary" in a)));
    assert.ok(seen.length >= 2, "the second card tried the gateway again");
    assert.deepEqual([await refusedCount(400), await refusedCount(429)], before);
  }
});

test("a gateway that never answers: the card goes out inside the budget with no summary, never on another key", { timeout: 15_000 }, async () => {
  reset(() => "hang");
  const started = Date.now();
  const { asks, executed, completeCalls } = await run({ apiKey: "user-key-alice", model: "small-fast" });
  assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
  assert.ok(!("summary" in asks[0]));
  assert.deepEqual(executed, [TOOL]);
  assert.equal(completeCalls.length, 0);
  assert.ok(seen.every((s) => s.headers["x-api-key"] === "user-key-alice"));
});

// --- the pieces ---------------------------------------------------------------------------------

test("modelRefusalStatus: 401/403/404 and a 400 that says the model is unknown; nothing else", () => {
  const e = (status: unknown, message = "") => Object.assign(new Error(message), { status });
  assert.equal(modelRefusalStatus(e(401)), 401);
  assert.equal(modelRefusalStatus(e(403)), 403);
  assert.equal(modelRefusalStatus(e(404)), 404);
  assert.equal(modelRefusalStatus(e(400, "400 Invalid model name passed in model=x")), 400);
  assert.equal(modelRefusalStatus(e(400, "Model `x` does not exist")), 400);
  for (const not of [e(400, "max_tokens: too large"), e(429, "model not found"), e(500, "model not found"), new Error("model not found"),
    e("404"), null, undefined, "404"]) assert.equal(modelRefusalStatus(not), undefined);
});

test("summaryCompleter: the session for the configured model is opened lazily, once, and only by name", async () => {
  const opened: string[] = [];
  const calls: unknown[][] = [];
  const c = summaryCompleter({
    model: " small-fast ",
    runSession: { complete: async () => { throw new Error("the run's session must not be used"); } },
    open: (m) => { opened.push(m); return { complete: async (...a: unknown[]) => { calls.push(a); return "ok"; } }; },
  });
  assert.deepEqual(opened, [], "nothing is opened until a card needs it");
  assert.equal(await c("sys", "user", 160), "ok");
  assert.equal(await c("sys", "user", 160), "ok");
  assert.deepEqual(opened, ["small-fast"]);
  assert.deepEqual(calls[0].slice(0, 3), ["sys", "user", 160]);
  assert.deepEqual(calls[0][4], { effort: "low" });
});
