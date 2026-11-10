// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  MAX_OTHER_ARGS,
  RAW_MAX,
  VALUE_MAX,
  approvalView,
  argumentLines,
  clipCommand,
  humanizeTool,
  rawDetails,
} from "../../src/approvals/approval-view.js";
import { credentialValues, isSensitiveName, maskValue, nameWords, scrub } from "../../src/approvals/sensitive.js";
import { answerLang, pickLang, writtenLang } from "../../src/language/detect.js";

const TOOL = "mcp__ops__patch_plans_plan_id_labels";
const INPUT = { plan_id: 85, labels: { "clawy-test": "1" }, reason: "clawy MCP verification" };
const FULL = {
  summary: "Clawy 想给计划 85 (nightly-eval) 加标签 clawy-test=1；理由：clawy MCP verification",
  summary_by: "model",
  tool_description: "Replace the labels of a plan.",
  intent: "我来给计划 85 加上验证标签。",
};

const SECRET_NAMES = [
  "token",
  "api_key",
  "apiKey",
  "password",
  "secret",
  "client_secret",
  "Authorization",
  "access_token",
  "private_key",
  "ssh_key",
  "DB_PASSWORD",
  "x-api-key",
  "refresh_token",
  "passphrase",
  "cookie",
  "dsn",
  "pwd",
  "PWD",
  "db_pwd",
];
const ORDINARY_NAMES = [
  "tokenizer",
  "key",
  "token_usage",
  "max_tokens",
  "plan_id",
  "reason",
  "description",
  "cwd",
  "author",
  "monkey",
  "keyboard",
  "label_key",
];

it("the card leads with what will change then the action then the arguments then the reason", () => {
  const view = approvalView({ tool: TOOL, toolInput: INPUT, event: FULL, group: false });
  assert.equal(view.lang, "zh");
  assert.equal(view.summary, FULL.summary);
  assert.equal(view.action, "patch plans plan id labels (ops)");
  assert.equal(view.description, "Replace the labels of a plan.");
  assert.deepEqual(view.args, [
    ["plan_id", "85"],
    ["labels", '{"clawy-test":"1"}'],
  ]);
  assert.equal(view.reason, "clawy MCP verification");
  assert.ok(view.details.includes(TOOL) && view.details.includes('"plan_id": 85'));
});

for (const [name, event] of [
  ["no event at all", null],
  ["empty event", {}],
  ["fields of the wrong type", { summary: { a: 1 }, intent: 7, tool_description: ["x"] }],
  ["blank fields", { summary: "  ", intent: "", tool_description: null }],
] as const) {
  it(`an older brain still gets the readable name the key arguments and the reason (${name})`, () => {
    const view = approvalView({ tool: TOOL, toolInput: INPUT, event, group: false, lang: "zh" });
    assert.equal(view.summary, "");
    assert.equal(view.action, "patch plans plan id labels (ops)");
    assert.equal(view.description, "");
    assert.equal(view.args.length, 2);
    assert.notEqual(view.details, "");
  });
}

it("language follows the most specific text that has any", () => {
  const rows: [unknown[], string][] = [
    [[FULL.summary, "x"], "zh"],
    [["Stop workload w1", "停掉它"], "en"],
    [["", null, "停掉它"], "zh"],
    [["", null, "stop it"], "en"],
    [[], "en"],
    [["Stop it", "ok"], "en"],
  ];
  for (const [texts, want] of rows) assert.equal(pickLang(...texts), want, JSON.stringify(texts));
});

it("language without a hint follows the summary", () => {
  assert.equal(approvalView({ tool: TOOL, toolInput: INPUT, event: FULL, group: false }).lang, "zh");
  assert.equal(
    approvalView({ tool: TOOL, toolInput: INPUT, event: { summary: "Stop workload w1" }, group: false }).lang,
    "en",
  );
});

it("a group card carries no input no details no arguments", () => {
  const secrets = {
    workload_id: "w-7777",
    note: "Ada",
    reason: "because-of-this-reason",
    api_token: "tok-SECRET-0123456789abcdef",
  };
  for (const event of [null, FULL, { intent: "I will use the token for plan 85", summary: "" }]) {
    const view = approvalView({ tool: TOOL, toolInput: secrets, event, group: true, owner: "Alice" });
    const blob = JSON.stringify(view);
    for (const leaked of ["SECRET", "tok-", "because-of-this-reason", "workload_id", "api_token", "Ada", "7777"]) {
      assert.ok(!blob.includes(leaked), leaked);
    }
    assert.equal(view.details, "");
    assert.equal(view.description, "");
    assert.equal(view.owner, "Alice");
    if (event?.summary) assert.equal(view.summary, event.summary);
  }
});

it("values and the raw call are clipped", () => {
  const labels = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, "v".repeat(50)]));
  const big = { plan_id: "9".repeat(500), note: "n".repeat(5000), labels };
  const view = approvalView({ tool: TOOL, toolInput: big, event: FULL, group: false });
  for (const [, value] of view.args) assert.ok(Array.from(value).length <= VALUE_MAX);
  assert.ok(Array.from(view.details).length <= RAW_MAX + TOOL.length + 2);
});

it("only five other fields are listed and the rest are counted", () => {
  const many = {
    plan_id: 1,
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${String(i)}`, i])),
    reason: "r",
  };
  const { lines, reason, more } = argumentLines(TOOL, many);
  assert.deepEqual(
    lines.map(([n]) => n),
    ["plan_id", "f0", "f1", "f2", "f3", "f4"],
  );
  assert.deepEqual(reason, ["reason", "r"]);
  assert.equal(more, 9 - MAX_OTHER_ARGS);
});

it("the ids the call is about come first and the reason is apart", () => {
  const { lines, reason, more } = argumentLines(TOOL, { labels: { a: 1 }, reason: "why", plan_id: 85, note: "n" });
  assert.deepEqual(
    lines.map(([n]) => n),
    ["plan_id", "labels", "note"],
  );
  assert.deepEqual(reason, ["reason", "why"]);
  assert.equal(more, 0);
  assert.deepEqual(argumentLines("bash", { command: "ls", reason: "r" }), {
    lines: [["command", "ls"]],
    reason: ["reason", "r"],
    more: 0,
  });
});

it("any shape of input renders", () => {
  for (const input of [null, {}, [], "just text", ["a", "b"], 7, { reason: "only" }]) {
    const view = approvalView({ tool: TOOL, toolInput: input, event: FULL, group: false });
    assert.equal(view.lang, "zh");
  }
});

it("an empty input has no details", () => {
  for (const empty of [null, {}, []])
    assert.equal(approvalView({ tool: TOOL, toolInput: empty, group: false }).details, "");
});

for (const name of SECRET_NAMES) {
  it(`a credential named argument is hidden in the lines and in the raw call (${name})`, () => {
    const view = approvalView({
      tool: TOOL,
      toolInput: { plan_id: 85, [name]: "VALUE-12345-ABCDEF", reason: "r" },
      event: FULL,
      group: false,
    });
    assert.ok(!JSON.stringify(view).includes("VALUE-12345-ABCDEF"));
    assert.ok(view.args.some(([n, v]) => n === name && v === "[hidden]"));
    assert.ok(view.details.includes("[hidden]"));
  });
}

it("a credential nested deeper is hidden too", () => {
  const nested = {
    plan_id: 1,
    config: { db: { password: "hunter2-hunter2", host: "h" }, list: [{ token: "t-t-t-t-t" }] },
  };
  const view = approvalView({ tool: TOOL, toolInput: nested, event: FULL, group: false });
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes("hunter2") && !blob.includes("t-t-t-t-t"));
  const lines = view.args.map(([, v]) => v).join("");
  assert.ok(lines.includes('"host":"h"') && lines.includes('"password":"[hidden]"'));
});

for (const name of ORDINARY_NAMES) {
  it(`an ordinary name is not hidden (${name})`, () => {
    assert.equal(isSensitiveName(name), false);
    const view = approvalView({ tool: TOOL, toolInput: { [name]: "plain-value" }, event: FULL, group: false });
    assert.ok(JSON.stringify(view).includes("plain-value"));
  });
}

it("a secret shaped value under an innocent name is masked", () => {
  const gh = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const view = approvalView({
    tool: TOOL,
    toolInput: {
      plan_id: 1,
      note: `use ${gh} to push`,
      command: `curl -H 'Authorization: Bearer ${"z".repeat(40)}' x`,
    },
    event: { ...FULL, summary: `Push with ${gh}`, intent: `using ${gh}` },
    group: false,
  });
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes(gh) && !blob.includes("z".repeat(40)));
});

it("a secret in the summary or the agents words is masked in a group too", () => {
  const gh = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  for (const event of [{ summary: `Push with ${gh}` }, { intent: `using ${gh}` }]) {
    assert.ok(
      !JSON.stringify(approvalView({ tool: TOOL, toolInput: INPUT, event, group: true, owner: "Alice" })).includes(gh),
    );
  }
});

it("the tool name never decides what is hidden", () => {
  assert.equal(humanizeTool("mcp__ops__patch_plans_plan_id_labels"), "patch plans plan id labels (ops)");
  assert.equal(humanizeTool("bash"), "bash");
  assert.equal(humanizeTool(""), "");
  assert.equal(humanizeTool("mcp__a__b-c_d"), "b c d (a)");
  assert.equal(approvalView({ tool: "", toolInput: null, group: false }).action, "");
});

for (const group of [false, true]) {
  for (const lang of ["zh", "en"]) {
    it(`a value typed under a credential name is not repeated by the summary or the agents words (${group} ${lang})`, () => {
      const view = approvalView({
        tool: TOOL,
        toolInput: { workload_id: "w1", password: "hunter2", nested: { api_key: "k-abcd-1234" } },
        event: {
          summary: "Set the password hunter2 on w1 (key k-abcd-1234)",
          intent: "I will use hunter2 on w1",
          tool_description: "Sets hunter2.",
        },
        group,
        owner: "Alice",
        lang,
      });
      const blob = JSON.stringify(view);
      assert.ok(!blob.includes("hunter2") && !blob.includes("k-abcd-1234"));
      assert.ok(blob.includes("w1"));
    });
  }
}

it("credential values and scrub as a table", () => {
  const rows: [unknown, string[]][] = [
    [{ password: "hunter2" }, ["hunter2"]],
    [{ pwd: "p4ss" }, ["p4ss"]],
    [{ a: { token: { x: ["abcd", "ef"] } } }, ["abcd"]],
    [{ plan_id: 85, reason: "why" }, []],
    [{ token: 12345 }, ["12345"]],
    [{ token: true }, []],
    [null, []],
    ["plain", []],
    [[{ secret: "abcdef" }], ["abcdef"]],
  ];
  for (const [value, want] of rows) assert.deepEqual(credentialValues(value), want, JSON.stringify(value));
  assert.equal(scrub("a hunter2 b hunter2-long", ["hunter2", "hunter2-long"]), "a [hidden] b [hidden]");
});

it("a credential value repeated in another argument is hidden there too", () => {
  const view = approvalView({
    tool: TOOL,
    toolInput: { workload_id: "w1", password: "hunter2", reason: "rotate hunter2 now", note: { t: "x hunter2" } },
    event: FULL,
    group: false,
    lang: "en",
  });
  assert.ok(!JSON.stringify(view).includes("hunter2"));
  assert.equal(view.reason, "rotate [hidden] now");
});

it("a long command keeps its start and its end", () => {
  const command = `${"a".repeat(400)} && git push origin main`;
  const shown = clipCommand(command);
  assert.ok(shown.startsWith("a".repeat(140)) && shown.endsWith("git push origin main") && shown.includes(" … "));
  assert.equal(clipCommand("ls -la"), "ls -la");
});

it("mask value replaces deep structures with an ellipsis", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 8; i += 1) deep = { d: deep };
  assert.ok(JSON.stringify(maskValue(deep)).includes("…"));
  assert.equal(rawDetails("t", { a: [1, true, null] }), 't\n{"a": [1, true, null]}');
});

it("written lang says only what a sentence says", () => {
  assert.equal(writtenLang("修一下这个测试"), "zh");
  assert.equal(writtenLang("fix the failing test"), "en");
  assert.equal(writtenLang("tests failed again"), "en");
  assert.equal(writtenLang("LGTM"), undefined);
  assert.equal(writtenLang("AMD-AGI/PrimusClaw #228"), undefined);
  assert.equal(writtenLang("Clawy review PR"), undefined);
  assert.equal(writtenLang("gpt-6-luna please"), undefined);
});

it("answer lang prefers what was said then the client then the texts", () => {
  assert.equal(answerLang("en", "zh-cn", "中文"), "en");
  assert.equal(answerLang("", "zh-CN", "hello"), "zh");
  assert.equal(answerLang("", "en-US", "中文"), "en");
  assert.equal(answerLang("", "", "中文"), "zh");
});

it("an mcp name is read as the shortest server and the rest without a line break", async () => {
  const { mcpParts } = await import("../../src/approvals/approval-view.js");
  assert.deepEqual(mcpParts("mcp__a___b"), ["a", "_b"]);
  assert.deepEqual(mcpParts("mcp_____x"), ["_", "x"]);
  assert.deepEqual(mcpParts("mcp__a____"), ["a", "__"]);
  assert.equal(mcpParts("mcp__ab__"), undefined);
  assert.equal(mcpParts("mcp__a__b\nc"), undefined);
  assert.equal(mcpParts("bash"), undefined);
  assert.equal(humanizeTool("_bash_"), "bash");
  const started = Date.now();
  assert.ok(humanizeTool(`mcp__${"_".repeat(50000)}`).endsWith(" (_)"));
  assert.ok(Date.now() - started < 2000);
});

it("a long run of capitals in an argument name splits in linear time (the Python regex takes seconds)", () => {
  // Python's re.sub(r"([A-Z]+)([A-Z][a-z])", ...) takes 3.3 s on 20 000 capitals; the expected words are its own.
  assert.deepEqual(nameWords("AAPIKeyToken"), ["aapi", "key", "token"]);
  const started = Date.now();
  assert.deepEqual(nameWords(`${"A".repeat(100_000)}b`), [`${"a".repeat(99_999)}`, "ab"]);
  assert.deepEqual(nameWords("A".repeat(100_000)), ["a".repeat(100_000)]);
  assert.ok(Date.now() - started < 2000);
});

it("a long run of separators reads in linear time", () => {
  const started = Date.now();
  assert.equal(writtenLang(`${"!".repeat(100000)} fix the test`), "en");
  assert.equal(writtenLang("x".repeat(50000) + "1"), undefined);
  assert.ok(Date.now() - started < 2000);
});
