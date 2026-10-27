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
import { resolveToolIds } from "../src/tools/resolve.js";
import { resolvePluginToolsFromMessage } from "../src/tasks/plugin-from-message.js";
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

// Each row: a command a reviewer showed (or the same family) that must be held by a POST rule.
const POST_RULE = [{ label: "post", http: { methods: ["POST"], url_prefix: "api.example.invalid" } }];
const U = "https://api.example.invalid/v1/items";
const BYPASS_TABLE: Array<[string, string]> = [
  ["bundled -sX with the value as the next word", `curl -sX POST ${U}`],
  ["bundled -sXPOST with the value attached", `curl -sXPOST ${U}`],
  ["bundled -sd implies POST", `curl -sd @body.json ${U}`],
  ["bundled -fsSL -X", `curl -fsSL -X POST ${U}`],
  ["bundled -fsSLXPOST", `curl -fsSLXPOST ${U}`],
  ["bundled body flag after others", `curl -sSd '{}' ${U}`],
  ["--request=POST", `curl --request=POST ${U}`],
  ["--request POST", `curl --request POST ${U}`],
  ["$(...) inside double quotes", `RESP="$(curl -s -X POST ${U} -d '{}')"`],
  ["backticks inside double quotes", `echo "\`curl -X POST ${U}\`"`],
  ["nested substitution in double quotes", `echo "got: $(echo $(curl -X POST ${U}))"`],
  ["timeout wrapper", `timeout 30 curl -X POST ${U}`],
  ["timeout with flags", `timeout -k 5 -s KILL 30 curl -X POST ${U}`],
  ["xargs wrapper", `echo x | xargs curl -X POST ${U}`],
  ["xargs with its own flags", `echo x | xargs -n 1 -P 4 curl -sX POST ${U}`],
  ["nice / nohup / stdbuf / time", `nice -n 5 nohup stdbuf -oL time curl -X POST ${U}`],
  ["env then timeout", `env A=1 timeout 5 curl -sXPOST ${U}`],
  ["bash -c with an inner substitution built by echo", `bash -c "$(echo curl -X POST ${U})"`],
  ["eval of the same", `eval "curl -X POST ${U}"`],
  ["sh -c with bundled flags", `sh -c 'curl -sX POST ${U}'`],
  ["sudo with a flag value", `sudo -u svc curl -X POST ${U}`],
];
test("bypasses shown in review are held by a POST rule", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const [why, cmd] of BYPASS_TABLE) assert.equal(p.check(cmd), "post", `${why}: ${cmd}`);
});

test("the same families with a non-matching method or host still run", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const cmd of [
    `curl -sX GET ${U}`, `curl -fsSL ${U}`, `timeout 30 curl ${U}`, `RESP="$(curl -s ${U})"`,
    `curl -sX POST https://elsewhere.example.invalid/x`, `xargs echo hi`, `bash -c "$(echo ls)"`,
    `curl -sG -d q=1 ${U}`,
  ]) assert.equal(p.check(cmd), null, cmd);
});

test("a command nested deeper than the parser follows is held, not run", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  let c = `curl -X POST ${U}`;
  for (let i = 0; i < 6; i++) c = `bash -c "${c.replace(/(["\\$`])/g, "\\$1")}"`;
  assert.notEqual(p.check(c), null);
});

test("program names that are Object.prototype keys do not crash the parser", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const c of ["constructor -x curl", "toString -a", "__proto__ x", "hasOwnProperty -n 1 ls"]) assert.equal(p.check(c), null, c);
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

// ── compound commands, shell-string wrappers, unresolved tools ───────────────

const FAMILY_TABLE: Array<[string, string]> = [
  ["if", `if curl -fsS -X POST ${U}; then echo ok; fi`],
  ["if with !", `if ! curl -X POST ${U}; then echo failed; fi`],
  ["elif / else", `if false; then :; elif curl -X POST ${U}; then :; else :; fi`],
  ["while", `while curl -sX POST ${U}; do sleep 1; done`],
  ["until", `until curl -X POST ${U}; do sleep 1; done`],
  ["for ... do", `for i in 1 2; do curl -X POST ${U}; done`],
  ["brace group", `{ curl -X POST ${U}; } > out`],
  ["bare !", `! curl -X POST ${U}`],
  ["subshell", `( curl -X POST ${U} )`],
  ["case arm", `case $x in a) curl -X POST ${U} ;; esac`],
  ["function body", `f() { curl -X POST ${U}; }; f`],
  ["watch with a quoted command", `watch -n 5 'curl -X POST ${U}'`],
  ["watch with bare words", `watch -n 5 curl -X POST ${U}`],
  ["flock -c", `flock /tmp/l -c 'curl -X POST ${U}'`],
  ["flock with a command", `flock /tmp/l curl -X POST ${U}`],
  ["su -c", `su -c 'curl -X POST ${U}' svc`],
  ["su user -c", `su - svc -c "curl -sX POST ${U}"`],
  ["sudo sh -c", `sudo sh -c 'curl -X POST ${U}'`],
  ["ssh host command", `ssh -p 22 -i key host 'curl -X POST ${U}'`],
  ["ssh host bare words", `ssh host curl -X POST ${U}`],
  ["kubectl exec --", `kubectl -n ns exec -i deploy/x -- curl -X POST ${U}`],
];
test("compound commands and shell-string wrappers are looked into", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const [why, cmd] of FAMILY_TABLE) assert.equal(p.check(cmd), "post", `${why}: ${cmd}`);
});

test("the same shapes with a read-only call still run", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const cmd of [
    `if curl -fsS ${U}; then echo ok; fi`, `for i in 1 2; do curl ${U}; done`, `watch -n 5 'curl ${U}'`,
    `flock /tmp/l -c 'ls'`, `ssh host ls`, `su -c 'ls' svc`, `kubectl get pods`, `! false`,
  ]) assert.equal(p.check(cmd), null, cmd);
});

const REVIEW_TABLE: Array<[string, string]> = [
  ["kubectl exec sh -c", `kubectl exec -it p -- sh -c 'curl -X POST ${U}'`],
  ["kubectl exec bash -c double quotes", `kubectl exec -it p -- bash -c "curl -X POST ${U}"`],
  ["kubectl exec /bin/sh -c", `kubectl -n ns exec p -- /bin/sh -c 'curl -X POST ${U}'`],
  ["oc exec sh -c", `oc exec -it p -- sh -c 'curl -sX POST ${U}'`],
  ["kubectl exec env then curl", `kubectl exec p -- env A=1 curl -X POST ${U}`],
  ["watch -d with a quoted command", `watch -d 'curl -X POST ${U}'`],
  ["watch --differences", `watch --differences curl -X POST ${U}`],
  ["watch --differences=permanent", `watch --differences=permanent 'curl -X POST ${U}'`],
  ["watch -d -n 5 bare words", `watch -d -n 5 curl -X POST ${U}`],
  ["watch -dn 5", `watch -dn 5 'curl -X POST ${U}'`],
  ["flock --command=", `flock /tmp/l --command='curl -X POST ${U}'`],
  ["flock -nc bundled", `flock /tmp/l -nc 'curl -X POST ${U}'`],
  ["env -S", `env -S 'curl -X POST ${U}'`],
  ["function keyword, no parens", `function retry { curl -X POST ${U}; }; retry`],
  ["function keyword with parens", `function retry() { curl -X POST ${U}; }; retry`],
  ["function keyword on one line after another command", `echo hi; function f { curl -X POST ${U}; }`],
  ["leading redirection", `> /tmp/out curl -X POST ${U}`],
  ["leading fd redirection", `2>/dev/null curl -X POST ${U}`],
  ["redirection then wrapper", `>> /tmp/o sudo curl -X POST ${U}`],
  ["curl --config file (opaque)", `curl --config /tmp/c.cfg`],
  ["curl -K file (opaque)", `curl -K /tmp/c.cfg`],
  ["xargs -l is not a value flag", `echo x | xargs -l curl -X POST ${U}`],
  ["xargs --replace is not a value flag", `echo x | xargs --replace curl -X POST ${U}`],
];
test("review round 4: exec -- quoting, watch -d, bundled flags, function keyword", () => {
  const p = bashApprovalPolicyFrom([{ source: "t", value: POST_RULE }]);
  for (const [why, cmd] of REVIEW_TABLE) assert.equal(p.check(cmd), "post", `${why}: ${cmd}`);
  for (const cmd of [
    `kubectl exec -it p -- sh -c 'ls /tmp'`, `watch -d 'curl ${U}'`, `watch -dn 5 ls`, `flock /tmp/l --command='ls'`,
    `function retry { curl ${U}; }; retry`, `env -S 'ls -l'`,
  ]) assert.equal(p.check(cmd), null, cmd);
});

function stubTools(handler: (url: string) => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof globalThis.fetch;
  return () => { globalThis.fetch = real; };
}
const rulesOf = (r: { bashApproval: unknown[] }) =>
  bashApprovalPolicyFrom(r.bashApproval.map((value) => ({ source: "tool_config", value })));

test("marketplace tools that failed to resolve hold every bash command; a deleted tool does not", async () => {
  const claw404 = () => new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
  const holds: Array<[string, () => Response]> = [
    ["tools API 500", () => new Response("boom", { status: 500 })],
    ["tools API unreachable", () => { throw new Error("ECONNRESET"); }],
    ["forbidden", () => new Response("no", { status: 403 })],
    ["gateway 404 with no listing entry", () => new Response("<html>", { status: 404 })],
  ];
  for (const [why, handler] of holds) {
    const restore = stubTools(handler);
    try {
      const policy = rulesOf(await resolveToolIds([42], "k"));
      assert.equal(policy.active, true, why);
      assert.equal(policy.check("ls"), MALFORMED_LABEL, why);
    } finally { restore(); }
  }
  // Deleted tool (the API says so): skipped, nothing is held.
  let restore = stubTools(claw404);
  try {
    const policy = rulesOf(await resolveToolIds([42], "k"));
    assert.equal(policy.active, false, "deleted tool");
    assert.equal(policy.check("ls"), null);
  } finally { restore(); }
  // Resolved fine, with rules: those rules apply and nothing else is held.
  restore = stubTools(() => new Response(JSON.stringify({ data:
    { id: 42, name: "t", type: "mcp", config: { mcpServers: {}, bash_approval: RULES } },
  }), { status: 200 }));
  try {
    const policy = rulesOf(await resolveToolIds([42], "k"));
    assert.equal(policy.check("ls"), null);
    assert.equal(policy.check("rm -rf /data/x"), "rm of data");
  } finally { restore(); }
});

test("a plugin tool row that cannot be read holds every bash command", async () => {
  const req = (tools: unknown[]) => ({ plugin_id: 9, plugin_tools: tools, session_id: "s" }) as never;
  const bad = await resolvePluginToolsFromMessage(req([null, { type: "rule" }]), undefined, "/tmp/ba-plugin-work/s");
  assert.equal(rulesOf(bad).check("ls"), MALFORMED_LABEL);
  for (const missing of [null, undefined]) {
    const r = await resolvePluginToolsFromMessage({ plugin_id: 9, plugin_tools: missing, session_id: "s" } as never, undefined, "/tmp/ba-plugin-work/s3");
    assert.equal(rulesOf(r).check("ls"), MALFORMED_LABEL, `plugin_tools ${missing}`);
  }
  const none = await resolvePluginToolsFromMessage({ plugin_id: 9, plugin_tools: [], session_id: "s" } as never, undefined, "/tmp/ba-plugin-work/s4");
  assert.equal(rulesOf(none).active, false, "a plugin that declares no tools holds nothing");
  const ok = await resolvePluginToolsFromMessage(
    req([{ id: 1, type: "mcp", config: { mcpServers: {}, bash_approval: RULES } }]), undefined, "/tmp/ba-plugin-work/s2");
  assert.equal(rulesOf(ok).check("ls"), null);
});
