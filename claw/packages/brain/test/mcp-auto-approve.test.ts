// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `auto_approve` on an MCP server spec: an explicit allowlist that lets a
 * session nobody is watching run the listed, `requires_approval`-held tools
 * without a decision, while every held tool that is not listed still waits for
 * a person and is denied when nobody answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { approvalPolicyFromMcp } from "../src/agent/approval-policy.js";
import { HitlController } from "../src/agent/hitl.js";
import { normalizeMcpConfigs } from "../src/clients/mcp-config.js";
import { registry } from "../src/infra/metrics.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";

// Generic example server and tool names; nothing here names a real service.
const base = { url: "https://mcp.example.invalid/mcp", type: "http", token: "t" };
const spec = (extra: Record<string, unknown>) => ({ safe: { ...base, ...extra } });
const T = (bare: string) => `mcp__safe__${bare}`;

// ── the policy ───────────────────────────────────────────────────────────────

test("no auto_approve means today's behaviour: held tools are held, none is released", () => {
  const p = approvalPolicyFromMcp(spec({ requires_approval: ["job_*"] }));
  assert.equal(p.requiresApproval(T("job_requeue")), true);
  assert.equal(p.autoApproves(T("job_requeue"), {}), false);
  for (const none of [undefined, null]) {
    const q = approvalPolicyFromMcp(spec({ requires_approval: true, auto_approve: none }));
    assert.equal(q.autoApproves(T("anything"), {}), false);
  }
});

test("a listed tool is released, an unlisted held tool is not", () => {
  const p = approvalPolicyFromMcp(spec({
    requires_approval: true,
    auto_approve: ["job_requeue", "get_*"],
  }));
  assert.equal(p.autoApproves(T("job_requeue"), { id: "j1" }), true);
  assert.equal(p.autoApproves(T("get_job"), {}), true);
  assert.equal(p.autoApproves(T("get_"), {}), true);
  // Still held, and not released: the rest of the server waits for a person.
  for (const bare of ["job_requeue_all", "job_cancel", "plan_recycle", "xget_job", "job_requeu"]) {
    assert.equal(p.requiresApproval(T(bare)), true, bare);
    assert.equal(p.autoApproves(T(bare), {}), false, bare);
  }
  // Another server's tool of the same name, and the bare name, are no match.
  assert.equal(p.autoApproves("mcp__other__job_requeue", {}), false);
  assert.equal(p.autoApproves("job_requeue", {}), false);
});

test("auto_approve narrows a hold; it never creates one", () => {
  const p = approvalPolicyFromMcp(spec({ requires_approval: ["job_cancel"], auto_approve: ["job_requeue"] }));
  // Not held at all: nothing to release, and nothing is reported as approved.
  assert.equal(p.requiresApproval(T("job_requeue")), false);
  assert.equal(p.autoApproves(T("job_requeue"), {}), false);
  const alone = approvalPolicyFromMcp(spec({ auto_approve: ["job_requeue"] }));
  assert.equal(alone.active, false);
  assert.equal(alone.requiresApproval(T("job_requeue")), false);
  assert.equal(alone.autoApproves(T("job_requeue"), {}), false);
  // requires_approval: false is an explicit no rule, whatever auto_approve says.
  assert.equal(approvalPolicyFromMcp(spec({ requires_approval: false, auto_approve: ["x"] })).active, false);
});

test("when: top-level scalars compared with strict equality", () => {
  const rule = (when: Record<string, unknown>) => approvalPolicyFromMcp(spec({
    requires_approval: true,
    auto_approve: [{ tool: "plan_set_status", when }],
  }));
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, boolean]> = [
    ["equal string", { status: "paused" }, { status: "paused", plan: "p1" }, true],
    ["different string", { status: "paused" }, { status: "running" }, false],
    ["missing key", { status: "paused" }, { plan: "p1" }, false],
    ["number is not its string", { n: 1 }, { n: "1" }, false],
    ["equal number", { n: 1 }, { n: 1 }, true],
    ["boolean true", { dry: true }, { dry: true }, true],
    ["boolean is not its string", { dry: true }, { dry: "true" }, false],
    ["false is not absent", { dry: false }, {}, false],
    ["null equals null", { owner: null }, { owner: null }, true],
    ["null is not absent", { owner: null }, {}, false],
    ["null is not empty string", { owner: null }, { owner: "" }, false],
    ["every key must match", { status: "paused", plan: "p1" }, { status: "paused", plan: "p2" }, false],
    ["every key, all equal", { status: "paused", plan: "p1" }, { status: "paused", plan: "p1" }, true],
    ["a nested value never equals a scalar", { status: "paused" }, { status: { v: "paused" } }, false],
    ["an array never equals a scalar", { status: "paused" }, { status: ["paused"] }, false],
    ["an inherited key is not an argument", { toString: "x" }, {}, false],
  ];
  // An argument that is only inherited (never from JSON, but nothing may rely on that).
  const inherited = Object.create({ status: "paused" }) as Record<string, unknown>;
  assert.equal(rule({ status: "paused" }).autoApproves(T("plan_set_status"), inherited), false, "inherited value");
  for (const [name, when, input, want] of cases) {
    assert.equal(rule(when).autoApproves(T("plan_set_status"), input), want, name);
  }
  // The tool still has to be the listed one.
  assert.equal(rule({ status: "paused" }).autoApproves(T("plan_delete"), { status: "paused" }), false);
});

test("a prefix entry carries its when; one unconditional entry releases the tool", () => {
  const p = approvalPolicyFromMcp(spec({
    requires_approval: true,
    auto_approve: [{ tool: "plan_*", when: { dry_run: true } }, "plan_get"],
  }));
  assert.equal(p.autoApproves(T("plan_pause"), { dry_run: true }), true);
  assert.equal(p.autoApproves(T("plan_pause"), { dry_run: false }), false);
  assert.equal(p.autoApproves(T("plan_pause"), {}), false);
  assert.equal(p.autoApproves(T("plan_get"), {}), true);
});

test("a malformed auto_approve releases nothing of that server, and the holds stay", () => {
  const bad: unknown[] = [
    null, "job_requeue", "true", true, 1, {}, [], [""], ["  "], ["*"], ["ok", "*"], [5], [null], ["ok", 5], [[]],
    [{}], [{ tool: 5 }], [{ tool: "" }], [{ tool: "*" }], [{ when: { a: 1 } }],
    [{ tool: "a", when: [] }], [{ tool: "a", when: {} }], [{ tool: "a", when: "x" }],
    [{ tool: "a", when: { x: {} } }], [{ tool: "a", when: { x: [1] } }], [{ tool: "a", when: { x: Number.NaN } }],
    [{ tool: "a", when: { x: Number.POSITIVE_INFINITY } }], [{ tool: "a", whn: { x: 1 } }],
    // One bad entry voids the list: the good one beside it is not released either.
    ["a", { tool: "b", when: [] }],
  ];
  for (const value of bad) {
    const p = approvalPolicyFromMcp({
      safe: { ...base, requires_approval: true, auto_approve: value },
      other: { ...base, requires_approval: true, auto_approve: ["a"] },
    });
    const label = JSON.stringify(value) ?? String(value);
    assert.equal(p.requiresApproval(T("a")), true, label);
    assert.equal(p.autoApproves(T("a"), { x: 1 }), false, label);
    assert.equal(p.autoApproves(T("b"), {}), false, label);
    // The malformed server does not take another server's list down with it.
    assert.equal(p.autoApproves("mcp__other__a", {}), true, label);
    // A good entry beside the bad one is not released either: the list is void as a whole.
    if (Array.isArray(value) && value.length > 0) {
      const mixed = approvalPolicyFromMcp(spec({ requires_approval: true, auto_approve: ["good", ...value] }));
      assert.equal(mixed.autoApproves(T("good"), { x: 1 }), false, `good + ${label}`);
    }
  }
});

test("both spellings must release a call; one cannot widen the other", () => {
  const p = approvalPolicyFromMcp(spec({
    requires_approval: true,
    auto_approve: ["a", "b"],
    autoApprove: ["b", "c"],
  }));
  assert.equal(p.autoApproves(T("a"), {}), false);
  assert.equal(p.autoApproves(T("b"), {}), true);
  assert.equal(p.autoApproves(T("c"), {}), false);
  // A readable spelling cannot rescue an unreadable one, and an explicit null is unreadable, not absent.
  for (const bad of ["a", null, []]) {
    const q = approvalPolicyFromMcp(spec({ requires_approval: true, auto_approve: ["a"], autoApprove: bad }));
    assert.equal(q.autoApproves(T("a"), {}), false, JSON.stringify(bad));
    const r = approvalPolicyFromMcp(spec({ requires_approval: true, auto_approve: bad, autoApprove: ["a"] }));
    assert.equal(r.autoApproves(T("a"), {}), false, JSON.stringify(bad));
    assert.equal(r.requiresApproval(T("a")), true, JSON.stringify(bad));
  }
  // Absent is absent: the one spelling present decides.
  assert.equal(approvalPolicyFromMcp(spec({ requires_approval: true, auto_approve: ["a"], autoApprove: undefined })).autoApproves(T("a"), {}), true);
  // The camelCase spelling works on its own.
  assert.equal(approvalPolicyFromMcp(spec({ requiresApproval: ["a"], autoApprove: ["a"] })).autoApproves(T("a"), {}), true);
});

test("a tool two servers claim is released only when both release it", () => {
  // Server names may contain "__": `mcp__a__b__c` is tool `b__c` of `a` and tool `c` of `a__b`.
  const only = approvalPolicyFromMcp({
    a: { ...base, requires_approval: ["b__c"], auto_approve: ["b__c"] },
    a__b: { ...base, requires_approval: ["c"] },
  });
  assert.equal(only.requiresApproval("mcp__a__b__c"), true);
  assert.equal(only.autoApproves("mcp__a__b__c", {}), false);
  const both = approvalPolicyFromMcp({
    a: { ...base, requires_approval: ["b__c"], auto_approve: ["b__c"] },
    a__b: { ...base, requires_approval: ["c"], auto_approve: ["c"] },
  });
  assert.equal(both.autoApproves("mcp__a__b__c", {}), true);
});

test("the field survives normalizeMcpConfigs", () => {
  const list = [{ tool: "a", when: { s: "paused" } }, "b_*"];
  const out = normalizeMcpConfigs(spec({ requires_approval: true, auto_approve: list }));
  assert.deepEqual(out.safe.auto_approve, list);
});

// ── the gate, through the real loop, a real HitlController and the real policy ─

function scriptedSession(turns: Array<Partial<LlmTurnResult>>): LlmSession & { calls: Array<{ messages: Message[] }> } {
  const calls: Array<{ messages: Message[] }> = [];
  let i = 0;
  return {
    calls,
    async streamTurn(messages) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)) });
      const turn = turns[i++];
      if (!turn) throw new Error("scripted session exhausted");
      return {
        content: turn.content ?? [], stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  };
}
const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmContentBlock => ({ type: "tool_use", id, name, input });
const text = (t: string): LlmContentBlock => ({ type: "text", text: t });
const TOOLS = [
  { name: T("job_requeue"), description: "requeue", input_schema: { type: "object", properties: {} } },
  { name: T("job_cancel"), description: "cancel", input_schema: { type: "object", properties: {} } },
  { name: T("plan_set_status"), description: "status", input_schema: { type: "object", properties: {} } },
  { name: T("get_job"), description: "read", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

function executor() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    route: async (name: string, input: Record<string, unknown>) => { calls.push({ name, input }); return "executed"; },
    setHands: () => {},
  } as unknown as ToolRouter & { calls: typeof calls };
}

function fakeDispatcher(answer: Partial<NatsDecisionMessage> | Error) {
  const registered: string[] = [];
  return {
    registered,
    register: async (req: { actionId: string }) => {
      registered.push(req.actionId);
      if (answer instanceof Error) throw answer;
      return { type: "decision", session_id: "s", action_id: req.actionId, ...answer } as NatsDecisionMessage;
    },
  };
}

/** The wiring engine.ts does: the real policy feeding the real controller. */
function controllerFor(servers: Record<string, Record<string, unknown>>, d: ReturnType<typeof fakeDispatcher> | null,
  onEvent: (e: unknown) => Promise<void>) {
  const approval = approvalPolicyFromMcp(servers);
  return new HitlController(d as never, onEvent as never, {
    requireApproval: (t) => approval.requiresApproval(t),
    autoApprove: (t, input) => approval.autoApproves(t, input),
  });
}

const SERVER = spec({
  requires_approval: true,
  auto_approve: ["job_requeue", { tool: "plan_set_status", when: { status: "paused" } }],
});

async function run(name: string, input: Record<string, unknown>, d: ReturnType<typeof fakeDispatcher> | null,
  servers: Record<string, Record<string, unknown>> = SERVER) {
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const session = scriptedSession([
    { content: [toolUse("t1", name, input)], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  const router = executor();
  const opts = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, router, onEvent,
    sessionId: "s", userId: "u", llmSession: session, hitl: controllerFor(servers, d, onEvent),
  } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "go" }], TOOLS, opts);
  const result = session.calls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as { type?: string })?.type === "tool_result") as { content: string } | undefined;
  return { router, events, modelSaw: String(result?.content) };
}

const decisions = (events: Array<Record<string, unknown>>) => events.filter((e) => e.type === "decisionResult");

test("unattended session, no approval channel: a listed tool runs, an unlisted held tool does not", async () => {
  const ok = await run(T("job_requeue"), { job: "j1" }, null);
  assert.deepEqual(ok.router.calls.map((c) => [c.name, c.input]), [[T("job_requeue"), { job: "j1" }]]);
  assert.equal(ok.events.some((e) => e.type === "permissionRequest"), false);
  assert.deepEqual(decisions(ok.events).map((e) => [e.action, e.by]), [["allow", "policy"]]);

  const held = await run(T("job_cancel"), { job: "j1" }, null);
  assert.deepEqual(held.router.calls, []);
  assert.match(held.modelSaw, /No approval channel is available/);
  assert.match(held.modelSaw, /not executed/);
});

test("with an approval channel: a listed tool does not wait, an unlisted one asks and is denied on silence", async () => {
  const d = fakeDispatcher({ decision: "deny" });
  const ok = await run(T("job_requeue"), { job: "j1" }, d);
  assert.equal(ok.router.calls.length, 1);
  assert.deepEqual(d.registered, []);
  assert.equal(ok.events.some((e) => e.type === "permissionRequest"), false);

  const silent = fakeDispatcher(new Error("decision_timeout"));
  const held = await run(T("job_cancel"), { job: "j1" }, silent);
  assert.deepEqual(held.router.calls, []);
  assert.deepEqual(silent.registered, ["t1"]);
  assert.ok(held.events.some((e) => e.type === "permissionRequest"));
  assert.match(held.modelSaw, /No decision was received in time; this action was not executed\./);
  assert.deepEqual(decisions(held.events).map((e) => [e.action, e.by]), [["deny", "timeout"]]);
});

test("an unlisted held tool still runs when a person allows it", async () => {
  const d = fakeDispatcher({ decision: "allow" });
  const r = await run(T("job_cancel"), { job: "j1" }, d);
  assert.equal(r.router.calls.length, 1);
  assert.deepEqual(decisions(r.events).map((e) => [e.action, e.by]), [["allow", "user"]]);
});

test("when decides per call: the same tool is released for one argument and held for another", async () => {
  const paused = await run(T("plan_set_status"), { plan: "p1", status: "paused" }, null);
  assert.equal(paused.router.calls.length, 1);
  assert.deepEqual(decisions(paused.events).map((e) => e.by), ["policy"]);
  const resumed = await run(T("plan_set_status"), { plan: "p1", status: "running" }, null);
  assert.deepEqual(resumed.router.calls, []);
  assert.match(resumed.modelSaw, /not executed/);
  const nested = await run(T("plan_set_status"), { plan: "p1", status: { to: "paused" } }, null);
  assert.deepEqual(nested.router.calls, []);
});

test("a malformed auto_approve leaves the whole server held", async () => {
  const bad = spec({ requires_approval: true, auto_approve: ["job_requeue", 5] });
  const r = await run(T("job_requeue"), { job: "j1" }, null, bad);
  assert.deepEqual(r.router.calls, []);
  assert.match(r.modelSaw, /not executed/);
});

test("an unheld tool follows the ordinary settings, and is not recorded as policy-approved", async () => {
  const r = await run(T("get_job"), { job: "j1" }, null, spec({ requires_approval: ["job_*"], auto_approve: ["get_job"] }));
  assert.equal(r.router.calls.length, 1);
  assert.equal(decisions(r.events).length, 0);
});

// ── the controller on its own: what it must never release ───────────────────

test("a per-call hold (the bash rules' form) is never lifted by auto_approve", async () => {
  const d = fakeDispatcher({ decision: "deny" });
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(d as never, async (e) => { events.push(e as never); }, {
    requireApproval: (t) => t === "x",
    requireApprovalFor: () => "a rule",
    autoApprove: () => true,
  });
  assert.equal(c.willAsk("x", {}), true);
  assert.equal((await c.beforeToolUse({ sessionId: "s", actionId: "a1", tool: "x", input: {} })).action, "deny");
  assert.deepEqual(d.registered, ["a1"]);
});

test("a released call is not a wait: willAsk says so, a held one still says yes", () => {
  const approval = approvalPolicyFromMcp(SERVER);
  const mk = (d: unknown) => new HitlController(d as never, async () => {}, {
    requireApproval: (t) => approval.requiresApproval(t),
    autoApprove: (t, input) => approval.autoApproves(t, input),
  });
  for (const d of [fakeDispatcher({ decision: "allow" }), null]) {
    const c = mk(d);
    // The loop parks the run's execution slot around a wait; it must not for a release.
    assert.equal(c.willAsk(T("job_requeue"), {}), false);
    assert.equal(c.willAsk(T("plan_set_status"), { status: "paused" }), false);
    assert.equal(c.willAsk(T("plan_set_status"), { status: "running" }), d !== null);
    assert.equal(c.willAsk(T("job_cancel"), {}), d !== null);
  }
});

test("only an exact true releases a hold", async () => {
  for (const answer of [1, "yes", {}, [], undefined, null, "true"]) {
    const d = fakeDispatcher({ decision: "deny" });
    const c = new HitlController(d as never, async () => {}, {
      requireApproval: () => true,
      autoApprove: () => answer as never,
    });
    assert.equal((await c.beforeToolUse({ sessionId: "s", actionId: "a1", tool: "x", input: {} })).action, "deny", String(answer));
  }
});

test("autoApprove alone creates no hold and no approval", async () => {
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(null, async (e) => { events.push(e as never); }, { autoApprove: () => true });
  const r = await c.beforeToolUse({ sessionId: "s", actionId: "a1", tool: "x", input: {} });
  assert.deepEqual([r.action, (r as { by: string }).by], ["allow", "auto_allow"]);
  assert.equal(events.length, 0);
});

test("a policy release is counted, by tool, and a refusal is not", async () => {
  const count = async (tool: string) => {
    const m = registry.getSingleMetric("claw_hitl_policy_allow_total");
    assert.ok(m, "metric is registered");
    const { values } = await (m as unknown as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }).get();
    return values.find((v) => v.labels.tool === tool)?.value ?? 0;
  };
  const before = await count(T("job_requeue"));
  const beforeHeld = await count(T("job_cancel"));
  await run(T("job_requeue"), { job: "j1" }, null);
  await run(T("job_cancel"), { job: "j1" }, null);
  assert.equal(await count(T("job_requeue")), before + 1);
  assert.equal(await count(T("job_cancel")), beforeHeld);
});
