// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bash approval rules: which commands they hold, and that a held command never
 * reaches the executor without a person saying yes. Also the one shared
 * refusal text the model sees for a denied or timed-out call, MCP or bash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { HitlController, refusalMessage } from "../src/agent/hitl.js";
import {
  bashApprovalFromEnvValue, bashApprovalFromToolConfig, bashApprovalPolicyFrom, MALFORMED_LABEL,
} from "../src/agent/bash-approval.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";

// Generic example rules; nothing here names a real service.
const RULES = [
  { label: "http write", http: { methods: ["POST", "PUT", "PATCH", "DELETE"], url_prefix: "console.example.invalid/api" } },
  { label: "console client write", program: ["python3", "python"], args_regex: "\\bclient\\.py\\s+(POST|PUT|PATCH|DELETE)\\b" },
  { label: "rm of data", regex: "\\brm\\s+-rf?\\s+/data\\b" },
];
const policy = () => bashApprovalPolicyFrom([{ source: "test", value: RULES }]);

test("no rules means no policy", () => {
  for (const v of [undefined, null, false]) assert.equal(bashApprovalPolicyFrom([{ source: "t", value: v }]).active, false);
  assert.equal(bashApprovalPolicyFrom([]).active, false);
});

test("http rule: method plus url prefix, with implied methods and quoting", () => {
  const p = policy();
  const held = [
    "curl -X POST https://console.example.invalid/api/plans/1/stop",
    "curl -XDELETE 'https://console.example.invalid/api/plans/1'",
    "curl --request=put console.example.invalid/api/x",
    "curl -s -H 'Authorization: Bearer x' -d '{\"a\":1}' https://console.example.invalid/api/plans",
    "curl -F file=@a https://CONSOLE.example.invalid/api/up",
    "wget --method=DELETE https://console.example.invalid/api/p/2",
    "wget --post-data=a=b https://console.example.invalid/api/p",
    "cd /tmp && /usr/bin/curl -X POST https://console.example.invalid/api/p | jq .",
    "sudo -u x curl -X POST https://console.example.invalid/api/p",
    "bash -c \"curl -X POST https://console.example.invalid/api/p\"",
    "echo $(curl -X POST https://console.example.invalid/api/p)",
  ];
  for (const c of held) assert.equal(p.check(c), "http write", c);
  const run = [
    "curl https://console.example.invalid/api/plans",
    "curl -X GET https://console.example.invalid/api/plans",
    "curl -G -d q=1 https://console.example.invalid/api/plans",
    "curl -I https://console.example.invalid/api/plans",
    "curl -X POST https://other.example.invalid/api/plans",
    "wget https://console.example.invalid/api/file",
    "echo curl -X POST https://console.example.invalid/api/p",
  ];
  // The last one is an echo: its program is echo, not curl, so the http rule does not apply.
  for (const c of run) assert.equal(p.check(c), null, c);
});

test("http url_regex sees the URL as written, so a variable base still matches", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: [
    { label: "admin write", http: { methods: ["POST", "PUT", "DELETE"], url_regex: "/v1/admin/" } },
  ] }]);
  assert.equal(p.check('curl -sS -X POST -H "Content-Type: application/json" -d \'{"a":1}\' "$C/v1/admin/pools/x/limits"'), "admin write");
  assert.equal(p.check('curl -sS -d x "$C/v1/admin/pools/x/limits"'), "admin write");
  assert.equal(p.check('curl -sS "$C/v1/admin/pools"'), null);
  assert.equal(p.check('curl -X POST "$C/v1/public/x"'), null);
});

test("curl -T / --upload-file is a PUT, so a PUT rule holds it", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: [
    { label: "put", http: { methods: ["PUT"], url_prefix: "console.example.invalid/api" } },
  ] }]);
  for (const c of [
    "curl -T f.bin https://console.example.invalid/api/up",
    "curl --upload-file f.bin https://console.example.invalid/api/up",
    "curl -Tf.bin https://console.example.invalid/api/up",
    "curl --upload-file=f.bin https://console.example.invalid/api/up",
  ]) assert.equal(p.check(c), "put", c);
  assert.equal(p.check("curl -d x https://console.example.invalid/api/up"), null);
});

test("program + args_regex rule, and a whole-line regex rule", () => {
  const p = policy();
  assert.equal(p.check("python3 client.py POST /plans/20/stop"), "console client write");
  assert.equal(p.check("cd x && FOO=1 python client.py DELETE /plans/20"), "console client write");
  assert.equal(p.check("python3 client.py GET /plans/20"), null);
  assert.equal(p.check("node client.py POST /plans"), null);
  assert.equal(p.check("rm -rf /data/x"), "rm of data");
  assert.equal(p.check("ls /data"), null);
});

test("malformed rules fail closed: every command is held, and nothing matched is not 'run'", () => {
  const bad: unknown[] = [
    "POST", 5, {}, [], [{}], [{ label: "x" }], [{ regex: "x" }], [{ label: "x", regex: "(" }],
    [{ label: "x", regex: "a", typo: 1 }], [{ label: "x", http: {} }], [{ label: "x", http: { methods: [] } }],
    [{ label: "x", program: 3 }], [{ label: "x", regex: "a", flags: "g" }], ["not an object"],
    [{ label: "ok", regex: "a" }, { label: "" , regex: "b" }],
  ];
  for (const value of bad) {
    const p = bashApprovalPolicyFrom([{ source: "t", value }]);
    assert.equal(p.active, true, JSON.stringify(value));
    assert.equal(p.check("ls"), MALFORMED_LABEL, JSON.stringify(value));
  }
  // One bad source holds everything even next to a good one.
  const mixed = bashApprovalPolicyFrom([{ source: "a", value: RULES }, { source: "b", value: "oops" }]);
  assert.equal(mixed.check("ls"), MALFORMED_LABEL);
  // An env value that is not JSON is malformed, not ignored; an empty one is unset.
  assert.equal(bashApprovalPolicyFrom([{ source: "env", value: bashApprovalFromEnvValue("{not json") }]).check("ls"), MALFORMED_LABEL);
  assert.equal(bashApprovalPolicyFrom([{ source: "env", value: bashApprovalFromEnvValue("  ") }]).active, false);
  assert.equal(bashApprovalPolicyFrom([{ source: "env", value: bashApprovalFromEnvValue(JSON.stringify(RULES)) }]).check("rm -rf /data/a"), "rm of data");
});

test("an unreadable command is held when rules exist", () => {
  const p = policy();
  assert.notEqual(p.check(undefined), null);
  assert.notEqual(p.check(42), null);
  assert.notEqual(p.check("a".repeat(100_001)), null);
});

test("tool config: both spellings are read", () => {
  assert.deepEqual(bashApprovalFromToolConfig({ bash_approval: [1], bashApproval: [2] }), [[1], [2]]);
  assert.deepEqual(bashApprovalFromToolConfig({ s3_key: "k" }), []);
  assert.deepEqual(bashApprovalFromToolConfig(undefined), []);
});

// ── the gate, driven through the real loop and a real HitlController ─────────

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
  { name: "bash", description: "run", input_schema: { type: "object", properties: {} } },
  { name: "read", description: "read", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

/** The executor spy: every command that reaches it is recorded. */
function executor() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const router = {
    calls,
    route: async (name: string, input: Record<string, unknown>) => { calls.push({ name, input }); return "executed"; },
    setHands: () => {},
  } as unknown as ToolRouter & { calls: typeof calls };
  return router;
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

async function run(command: string, d: ReturnType<typeof fakeDispatcher> | null, rules: unknown = RULES, tool = "bash") {
  const bash = bashApprovalPolicyFrom([{ source: "test", value: rules }]);
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const hitl = new HitlController(d as never, onEvent as never, {
    requireApprovalFor: (t, input) => (t === "bash" ? bash.check(input.command) : null),
    requireApproval: (t) => t === "mcp__safe__node_cordon",
  });
  const session = scriptedSession([
    { content: [toolUse("t1", tool, { command })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  const router = executor();
  const opts = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, router, onEvent,
    sessionId: "s", userId: "u", llmSession: session, hitl,
  } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "go" }], TOOLS, opts);
  const result = session.calls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as { type?: string })?.type === "tool_result") as { content: string } | undefined;
  return { router, events, modelSaw: String(result?.content) };
}

const WRITE = "curl -X POST https://console.example.invalid/api/plans/9/stop";

test("a matching bash call emits a permissionRequest before it runs, and runs on allow", async () => {
  const d = fakeDispatcher({ decision: "allow" });
  const { router, events } = await run(WRITE, d);
  const ask = events.findIndex((e) => e.type === "permissionRequest");
  assert.ok(ask >= 0, "permissionRequest emitted");
  assert.equal(events[ask].tool, "bash");
  assert.equal(events[ask].approval_label, "http write");
  assert.deepEqual(d.registered, ["t1"]);
  assert.deepEqual(router.calls.map((c) => c.input.command), [WRITE]);
});

test("deny: the command never reaches the executor, and the model is told it was denied", async () => {
  const { router, events, modelSaw } = await run(WRITE, fakeDispatcher({ decision: "deny" }));
  assert.deepEqual(router.calls, []);
  assert.ok(events.some((e) => e.type === "permissionRequest"));
  assert.match(modelSaw, /The user denied this action; it was not executed\./);
  assert.match(modelSaw, /Tell the user it was not done because they denied it\./);
  assert.doesNotMatch(modelSaw, /API|not found/i);
});

test("an MCP tool held by requires_approval gets the same denial text", async () => {
  const { router, modelSaw } = await run("n1", fakeDispatcher({ decision: "deny" }), RULES, "mcp__safe__node_cordon");
  assert.deepEqual(router.calls, []);
  assert.match(modelSaw, /The user denied this action; it was not executed\./);
  const t = await run("n1", fakeDispatcher(new Error("decision_timeout")), RULES, "mcp__safe__node_cordon");
  assert.deepEqual(t.router.calls, []);
  assert.match(t.modelSaw, /No decision was received in time; this action was not executed\./);
});

test("a note typed by the user is passed on with the denial", async () => {
  const { modelSaw } = await run(WRITE, fakeDispatcher({ decision: "deny", feedback: "wrong plan" }));
  assert.match(modelSaw, /denied this action/);
  assert.match(modelSaw, /wrong plan/);
});

test("timeout: never executed, and the model is told nobody decided in time", async () => {
  const { router, modelSaw } = await run(WRITE, fakeDispatcher(new Error("decision_timeout")));
  assert.deepEqual(router.calls, []);
  assert.match(modelSaw, /No decision was received in time; this action was not executed\./);
});

test("no approval channel: never executed", async () => {
  const { router, modelSaw } = await run(WRITE, null);
  assert.deepEqual(router.calls, []);
  assert.match(modelSaw, /not executed/);
});

test("a non-matching command runs unchanged and is never asked about", async () => {
  const d = fakeDispatcher({ decision: "deny" });
  const { router, events } = await run("curl https://console.example.invalid/api/plans", d);
  assert.deepEqual(router.calls.map((c) => c.input.command), ["curl https://console.example.invalid/api/plans"]);
  assert.deepEqual(d.registered, []);
  assert.equal(events.some((e) => e.type === "permissionRequest"), false);
});

test("malformed rules hold every command: asked, and denied means never run", async () => {
  const d = fakeDispatcher({ decision: "deny" });
  const { router, events } = await run("ls -la", d, "oops");
  assert.deepEqual(router.calls, []);
  assert.ok(events.some((e) => e.type === "permissionRequest"));
});

test("remember never turns a held bash call into an auto-allow", async () => {
  const d = fakeDispatcher({ decision: "allow", remember: true });
  const bash = bashApprovalPolicyFrom([{ source: "t", value: RULES }]);
  const c = new HitlController(d as never, async () => {}, {
    requireApprovalFor: (t, i) => (t === "bash" ? bash.check(i.command) : null),
  });
  const input = { command: WRITE };
  assert.equal((await c.beforeToolUse({ sessionId: "s", actionId: "a1", tool: "bash", input })).action, "allow");
  assert.equal(c.willAsk("bash", input), true);
  await c.beforeToolUse({ sessionId: "s", actionId: "a2", tool: "bash", input });
  assert.deepEqual(d.registered, ["a1", "a2"]);
  // And the same tool with a command no rule holds is not asked.
  assert.equal(c.willAsk("bash", { command: "ls" }), false);
});

test("refusalMessage: one helper, distinct and unambiguous per cause", () => {
  assert.match(refusalMessage({ cause: "denied", reason: "denied by user" }), /^The user denied this action; it was not executed\./);
  assert.doesNotMatch(refusalMessage({ cause: "denied", reason: "denied by user" }), /note/);
  assert.match(refusalMessage({ cause: "skipped" }), /skipped this action; it was not executed/);
  assert.match(refusalMessage({ cause: "timeout" }), /No decision was received in time; this action was not executed/);
  assert.match(refusalMessage({ cause: "no_channel" }), /not executed/);
  assert.match(refusalMessage({ reason: "legacy" }), /not executed: legacy/);
});
