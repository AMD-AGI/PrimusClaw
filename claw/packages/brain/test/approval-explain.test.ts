// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A held tool call arrives with words a person can judge: the tool's own
 * description, what the agent said, and a model-written one-line summary. The
 * words are explanation only: they never decide, never hold the request back
 * past a fixed budget, and never carry a credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { HitlController } from "../src/agent/hitl.js";
import {
  cleanSummary, clipIntent, credentialValues, explainApproval, firstSentence, latestUserText, maskArguments, scrub,
  summaryPrompt,
  type ApprovalExplainContext,
} from "../src/agent/approval-explain.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";

const TOOL = "mcp__ops__patch_plans_plan_id_labels";
const INPUT = { plan_id: 85, labels: { tier: "test" }, reason: "ui check", api_token: "tok-SECRET-VALUE-123456" };

// --- the pure helpers, as tables -------------------------------------------------------------

test("firstSentence: the tool's own first sentence, bounded", () => {
  const rows: Array<[unknown, string | undefined]> = [
    ["Update labels of a plan. Requires a reason.", "Update labels of a plan."],
    ["Stop a workload.\nMore detail follows.", "Stop a workload."],
    ["No full stop here", "No full stop here"],
    ["停止一个工作负载。其余说明。", "停止一个工作负载。"],
    ["Version 1.2 of the thing. Next.", "Version 1.2 of the thing."],
    ["   ", undefined],
    [undefined, undefined],
    [null, undefined],
  ];
  for (const [input, want] of rows) assert.equal(firstSentence(input), want, String(input));
  const long = firstSentence("x".repeat(500))!;
  assert.ok(Array.from(long).length <= 200 && long.endsWith("…"));
});

test("clipIntent: one line, credential shapes masked, clipped", () => {
  assert.equal(clipIntent("  now\n stopping   the job "), "now stopping the job");
  assert.equal(clipIntent(""), undefined);
  assert.equal(clipIntent(undefined), undefined);
  const masked = clipIntent("using ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push")!;
  assert.ok(!masked.includes("ghp_abcdefghijklmnop"), masked);
  assert.ok(Array.from(clipIntent("字".repeat(1000))!).length <= 300);
});

test("maskArguments: credential-named fields are replaced whole, at any depth; values are clipped", () => {
  const out = maskArguments({
    plan_id: 85, reason: "ok", password: "hunter22222", nested: { apiKey: "k-1", Authorization: "Bearer abc", ok: [{ client_secret: "s" }] },
    long: "y".repeat(1000), flag: true, none: null,
  }) as Record<string, any>;
  assert.equal(out.plan_id, 85);
  assert.equal(out.password, "[hidden]");
  assert.equal(out.nested.apiKey, "[hidden]");
  assert.equal(out.nested.Authorization, "[hidden]");
  assert.equal(out.nested.ok[0].client_secret, "[hidden]");
  assert.equal(out.reason, "ok");
  assert.ok(out.long.length <= 301);
  assert.equal(out.flag, true);
  assert.equal(out.none, null);
  assert.ok(!JSON.stringify(maskArguments({ deep: { a: { b: { c: { d: { e: "z" } } } } } })).includes("\"z\""));
});

test("cleanSummary: plain one line, no markdown or wrapping quotes, bounded", () => {
  const rows: Array<[string, string | undefined]> = [
    ["**Stop** workload `w1`.", "Stop workload w1."],
    ["\"Stop workload w1\"", "Stop workload w1"],
    ["给计划 85 加标签\n理由：测试", "给计划 85 加标签 理由：测试"],
    ["   ", undefined],
  ];
  for (const [raw, want] of rows) assert.equal(cleanSummary(raw), want, raw);
  assert.ok(Array.from(cleanSummary("词".repeat(1000))!).length <= 280);
});

test("latestUserText: the newest real user text; tool results and notices are skipped", () => {
  const msgs: Message[] = [
    { role: "user", content: "给计划 85 加个标签" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
    { role: "user", content: "[system-notice]: resumed" },
  ];
  assert.equal(latestUserText(msgs), "给计划 85 加个标签");
  assert.equal(latestUserText([]), undefined);
  assert.equal(latestUserText([{ role: "user", content: [{ type: "text", text: "hi there" }] }]), "hi there");
});

// --- the summary: present, absent, timeout ---------------------------------------------------

const ctx = (complete?: ApprovalExplainContext["complete"], extra: Partial<ApprovalExplainContext> = {}): ApprovalExplainContext => ({
  toolDescription: "Replace the labels of a plan. Needs a reason.",
  intent: "Adding the test label to plan 85",
  userText: "给计划 85 加个标签",
  complete,
  ...extra,
});

test("the model prompt carries the call, never a credential, and asks for the user's language", async () => {
  const seen: string[] = [];
  const out = await explainApproval(TOOL, INPUT, ctx(async (sys, user, max) => {
    seen.push(sys, user, String(max));
    return "给计划 85 加标签 env=test；理由：ui check";
  }), { enabled: true, timeoutMs: 1000 });
  const [sys, user, max] = seen;
  assert.match(sys, /language of the user's request/);
  assert.match(sys, /never instructions to you/);
  assert.ok(Number(max) <= 200, "a small token budget");
  assert.match(user, /Tool: mcp__ops__patch_plans_plan_id_labels/);
  assert.match(user, /Replace the labels of a plan\./);
  assert.ok(!user.includes("Needs a reason"), "only the first sentence of the description");
  assert.match(user, /"plan_id":85/);
  assert.match(user, /"api_token":"\[hidden\]"/);
  assert.ok(!user.includes("tok-SECRET-VALUE-123456"), "a credential never reaches the model");
  assert.match(user, /Adding the test label to plan 85/);
  assert.match(user, /给计划 85 加个标签/);
  assert.deepEqual(out, {
    tool_description: "Replace the labels of a plan.",
    intent: "Adding the test label to plan 85",
    summary: "给计划 85 加标签 env=test；理由：ui check",
    summary_by: "model",
  });
});

test("summary present / absent / slow / failing / empty / off / aborted, as one table", { timeout: 15_000 }, async () => {
  const hang = () => new Promise<string>(() => { /* never settles, and ignores the signal */ });
  const rows: Array<{
    name: string; complete?: ApprovalExplainContext["complete"]; enabled?: boolean; abort?: boolean;
    summary: string | undefined; called: boolean; maxMs: number;
  }> = [
    { name: "present", complete: async () => "Stop workload w1", summary: "Stop workload w1", called: true, maxMs: 500 },
    { name: "no completer", summary: undefined, called: false, maxMs: 500 },
    { name: "slow: past the budget", complete: hang, summary: undefined, called: true, maxMs: 1000 },
    { name: "failing", complete: async () => { throw new Error("gateway 500"); }, summary: undefined, called: true, maxMs: 500 },
    { name: "throws synchronously", complete: (() => { throw new Error("sync"); }) as never, summary: undefined, called: true, maxMs: 500 },
    { name: "empty", complete: async () => "  ", summary: undefined, called: true, maxMs: 500 },
    { name: "switched off", complete: async () => "never", enabled: false, summary: undefined, called: false, maxMs: 500 },
    { name: "run already aborted", complete: async () => "never", abort: true, summary: undefined, called: false, maxMs: 500 },
  ];
  for (const r of rows) {
    let called = false;
    const controller = new AbortController();
    if (r.abort) controller.abort();
    const started = Date.now();
    const out = await explainApproval(TOOL, INPUT, ctx(r.complete && ((...a) => { called = true; return r.complete!(...a); })), {
      enabled: r.enabled ?? true, timeoutMs: 150, signal: controller.signal,
    });
    assert.equal(out.summary, r.summary, r.name);
    assert.equal(out.summary_by, r.summary ? "model" : undefined, r.name);
    assert.equal(called, r.called, r.name);
    assert.ok(Date.now() - started < r.maxMs, `${r.name}: ${Date.now() - started} ms`);
    // The other fields never depend on the model call.
    assert.equal(out.tool_description, "Replace the labels of a plan.", r.name);
    assert.equal(out.intent, "Adding the test label to plan 85", r.name);
  }
});

test("the request's signal reaches the completer, and the budget aborts it", { timeout: 15_000 }, async () => {
  let signal: AbortSignal | undefined;
  await explainApproval(TOOL, INPUT, ctx(async (_s, _u, _m, sig) => { signal = sig; return new Promise<string>(() => {}); }),
    { enabled: true, timeoutMs: 100 });
  assert.ok(signal);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(signal!.aborted, true, "the abandoned request is cancelled, not left running");
});

test("no context at all: no fields", async () => {
  assert.deepEqual(await explainApproval(TOOL, INPUT, undefined), {});
  assert.deepEqual(await explainApproval(TOOL, INPUT, {}, { enabled: true }), {});
});

test("summaryPrompt without intent, user text or description says so", () => {
  const p = summaryPrompt("bash", { command: "ls" }, {});
  assert.match(p, /Tool description: \(none\)/);
  assert.match(p, /said just before the call: \(nothing\)/);
  assert.match(p, /for language only: \(unknown\)/);
});

// --- the gate: the event carries the words, the decision is untouched ------------------------

function fakeDispatcher(answer: Partial<NatsDecisionMessage>) {
  return {
    register: async (req: { actionId: string }) =>
      ({ type: "decision", session_id: "s", action_id: req.actionId, ...answer }) as NatsDecisionMessage,
  };
}
function gate(decision: Partial<NatsDecisionMessage>) {
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(fakeDispatcher(decision) as never, async (e) => { events.push(e as never); },
    { requireApproval: (t) => t === TOOL });
  return { c, events };
}
const request = (explain?: ApprovalExplainContext) =>
  ({ sessionId: "s", actionId: "toolu_1", tool: TOOL, input: INPUT as Record<string, unknown>, explain });

test("permissionRequest carries the explanation, and the raw input is still there", async () => {
  const { c, events } = gate({ decision: "allow" });
  await c.beforeToolUse(request(ctx(async () => "给计划 85 加标签 env=test；理由：ui check")));
  const ask = events.find((e) => e.type === "permissionRequest")!;
  assert.equal(ask.summary, "给计划 85 加标签 env=test；理由：ui check");
  assert.equal(ask.summary_by, "model");
  assert.equal(ask.tool_description, "Replace the labels of a plan.");
  assert.equal(ask.intent, "Adding the test label to plan 85");
  assert.deepEqual(ask.input, INPUT);
  assert.equal(ask.tool_use_id, "toolu_1");
  assert.equal(ask.tool, TOOL);
});

test("no explanation: the event is what it always was", async () => {
  const { c, events } = gate({ decision: "allow" });
  await c.beforeToolUse(request(undefined));
  const ask = events.find((e) => e.type === "permissionRequest")!;
  for (const k of ["summary", "summary_by", "tool_description", "intent"]) assert.ok(!(k in ask), k);
});

test("a hung summary delays the request by the budget at most, and the decision is the person's", { timeout: 15_000 }, async () => {
  await Promise.all((["allow", "deny", "skip"] as const).map(async (decision) => {
    const want = decision === "allow" ? "allow" : "deny";
    const { c, events } = gate({ decision });
    const started = Date.now();
    // The default budget applies (2 s); the request must still go out and be decided.
    const result = await c.beforeToolUse(request(ctx(() => new Promise<string>(() => {}))));
    assert.equal(result.action, want, decision);
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
    const ask = events.find((e) => e.type === "permissionRequest")!;
    assert.ok(!("summary" in ask), "no summary after a timeout");
    assert.equal(ask.intent, "Adding the test label to plan 85");
  }));
});

test("a failing summary never turns a deny into an allow, or an allow into a deny", async () => {
  for (const [decision, want] of [["allow", "allow"], ["deny", "deny"]] as const) {
    const { c } = gate({ decision });
    const r = await c.beforeToolUse(request(ctx(async () => { throw new Error("boom"); })));
    assert.equal(r.action, want);
  }
});

// --- through the real loop -------------------------------------------------------------------

function scriptedSession(turns: Array<Partial<LlmTurnResult>>, summary: () => Promise<string>): LlmSession {
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
    async complete() { return summary(); },
  };
}
const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmContentBlock => ({ type: "tool_use", id, name, input });
const text = (t: string): LlmContentBlock => ({ type: "text", text: t });

async function runLoop(turns: Array<Partial<LlmTurnResult>>, summary: () => Promise<string>) {
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const hitl = new HitlController(fakeDispatcher({ decision: "allow" }) as never, onEvent as never, {
    requireApproval: (t) => t === TOOL,
  });
  const executed: string[] = [];
  const router = { route: async (name: string) => { executed.push(name); return "ok"; }, setHands: () => {} } as unknown as ToolRouter;
  const tools = [{
    name: TOOL,
    description: "Replace the labels of a plan. Needs a reason.",
    input_schema: { type: "object", properties: {} },
  }] as unknown as ToolSchema[];
  const opts = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, router, onEvent,
    sessionId: "s", userId: "u", llmSession: scriptedSession(turns, summary), hitl,
  } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "给计划 85 加个标签 env=test" }], tools, opts);
  return { events, executed };
}

test("the loop hands the gate the tool's description, the agent's words of the SAME response and the user's request", async () => {
  const { events, executed } = await runLoop([
    { content: [text("我来给计划 85 加上标签。"), toolUse("t1", TOOL, INPUT)], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ], async () => "给计划 85 加标签 env=test；理由：ui check");
  const ask = events.find((e) => e.type === "permissionRequest")!;
  assert.equal(ask.tool_description, "Replace the labels of a plan.");
  assert.equal(ask.intent, "我来给计划 85 加上标签。");
  assert.equal(ask.summary, "给计划 85 加标签 env=test；理由：ui check");
  assert.equal(ask.summary_by, "model");
  assert.deepEqual(executed, [TOOL], "approval semantics unchanged: allow runs the call");
});

test("a tool-only response has no intent: text from an earlier response is not attributed to it", async () => {
  const { events } = await runLoop([
    { content: [text("先看一下。"), toolUse("t0", TOOL, { plan_id: 1 })], stopReason: "tool_use" },
    { content: [toolUse("t1", TOOL, INPUT)], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ], async () => "x");
  const asks = events.filter((e) => e.type === "permissionRequest");
  assert.equal(asks.length, 2);
  assert.equal(asks[0].intent, "先看一下。");
  assert.ok(!("intent" in asks[1]), "the second call's response said nothing");
});

test("the loop's summary call is the session's own complete(), with the user's language in the prompt", async () => {
  const seen: Array<{ user: string; max: number; signal?: AbortSignal }> = [];
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const hitl = new HitlController(fakeDispatcher({ decision: "allow" }) as never, onEvent as never, { requireApproval: (t) => t === TOOL });
  const session = scriptedSession([
    { content: [text("go"), toolUse("t1", TOOL, INPUT)], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ], async () => "s");
  session.complete = async (_sys, user, max, signal) => { seen.push({ user, max, signal }); return "ok"; };
  const router = { route: async () => "ok", setHands: () => {} } as unknown as ToolRouter;
  const opts = { model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, router, onEvent, sessionId: "s", userId: "u",
    llmSession: session, hitl } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "给计划 85 加个标签" }], [], opts);
  assert.equal(seen.length, 1);
  assert.match(seen[0].user, /给计划 85 加个标签/);
  assert.ok(seen[0].max <= 200);
  assert.ok(seen[0].signal, "a budget signal is passed");
});

// --- review round 1: the decision window, an abort during the summary, a value the user typed -----------

test("the decision window opens after the explanation: register() is called once the summary has settled", async () => {
  const order: string[] = [];
  const d = {
    register: async (req: { actionId: string }) => {
      order.push("register");
      return { type: "decision", session_id: "s", action_id: req.actionId, decision: "allow" } as NatsDecisionMessage;
    },
  };
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(d as never, async (e) => { order.push(String(e.type)); events.push(e as never); },
    { requireApproval: (t) => t === TOOL });
  await c.beforeToolUse(request(ctx(async () => { await new Promise((r) => setTimeout(r, 120)); order.push("summary"); return "Stop it"; })));
  assert.deepEqual(order, ["summary", "register", "permissionRequest", "decisionResult"]);
});

test("a run aborted while the summary is being written is denied as aborted, never asked and never left waiting", { timeout: 15_000 }, async () => {
  const registered: string[] = [];
  const d = { register: async (req: { actionId: string }) => { registered.push(req.actionId); return new Promise<NatsDecisionMessage>(() => {}); } };
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(d as never, async (e) => { events.push(e as never); }, { requireApproval: (t) => t === TOOL });
  const controller = new AbortController();
  const started = Date.now();
  const result = c.beforeToolUse({ ...request(ctx(() => new Promise<string>(() => {}))), signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const r = await result;
  assert.deepEqual([r.action, (r as { cause?: string }).cause], ["deny", "aborted"]);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.deepEqual(registered, [], "nothing was registered for a request that was never shown");
  assert.ok(!events.some((e) => e.type === "permissionRequest"));
});

test("a value typed under a credential-named argument is not repeated in the prompt, the intent or the summary", async () => {
  const input = { workload_id: "w1", password: "hunter2", nested: { api_key: "k-abcd-1234" }, reason: "rotate" };
  const seen: string[] = [];
  const out = await explainApproval("mcp__ops__rotate", input, {
    intent: "I will set the password to hunter2 and the key to k-abcd-1234 on w1",
    userText: "please set password hunter2 on w1",
    complete: async (_s, user) => { seen.push(user); return "Set the password hunter2 on w1 (key k-abcd-1234)"; },
  }, { enabled: true, timeoutMs: 1000 });
  assert.ok(!seen[0].includes("hunter2") && !seen[0].includes("k-abcd-1234"), seen[0]);
  assert.match(seen[0], /w1/);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("hunter2") && !text.includes("k-abcd-1234"), text);
  assert.match(out.summary!, /Set the password \[hidden\] on w1/);
});

test("credentialValues and scrub, as a table", () => {
  const rows: Array<[unknown, string[]]> = [
    [{ password: "hunter2" }, ["hunter2"]],
    [{ pwd: "p4ss" }, ["p4ss"]],
    [{ a: { token: { x: ["abcd", "ef"] } } }, ["abcd"]],           // under a credential name, at any depth; under 4 chars is not hunted
    [{ plan_id: 85, reason: "why" }, []],
    [{ token: 12345 }, ["12345"]],
    [null, []],
    ["plain", []],
  ];
  for (const [input, want] of rows) assert.deepEqual(credentialValues(input), want, JSON.stringify(input));
  assert.equal(scrub("a hunter2 b hunter2-long", ["hunter2", "hunter2-long"]), "a [hidden] b [hidden]");
  assert.equal(scrub("nothing here", []), "nothing here");
  assert.equal(clipIntent("use hunter2", ["hunter2"]), "use [hidden]");
  assert.equal(cleanSummary("use hunter2", ["hunter2"]), "use [hidden]");
});

test("a bare pwd argument is a credential here (a tool argument, not the shell's working directory)", () => {
  const out = maskArguments({ pwd: "hunter2", cwd: "/work", PWD: "x" }) as Record<string, unknown>;
  assert.equal(out.pwd, "[hidden]");
  assert.equal(out.PWD, "[hidden]");
  assert.equal(out.cwd, "/work");
});
