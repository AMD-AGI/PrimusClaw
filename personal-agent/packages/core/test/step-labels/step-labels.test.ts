// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  Label,
  NO_SERVERS,
  failedLine,
  isShell,
  labelFor,
  lookupLabel,
  skillInCommand,
  type Lang,
  type StepServers,
} from "../../src/index.js";

/** A deployment's MCP server whose reads a progress line names: a fictional job service. */
const JOBHUB: StepServers = { mcpServers: new Map([["jobhub", "JobHub"]]), queryServers: new Set(["jobhub"]) };

const LABELS: Array<readonly [string, string | null, Lang, string]> = [
  ["read", null, "en", "Reading a file"],
  ["Read", null, "en", "Reading a file"],
  ["bash", null, "en", "Running a command"],
  ["edit", null, "en", "Editing a file"],
  ["write", null, "en", "Editing a file"],
  ["grep", null, "en", "Searching files"],
  ["glob", null, "en", "Searching files"],
  ["task", null, "en", "Running a sub-task"],
  ["mcp__agent-board__issue_read", null, "en", "Reading a board topic"],
  ["mcp__agent-board__list_issues", null, "en", "Listing board issues"],
  ["mcp__agent-board__list_org_repos", null, "en", "Listing board org repos"],
  ["mcp__agent-board__list_my_repos", null, "en", "Listing board my repos"],
  ["mcp__jobhub__get_plan", null, "en", "Querying JobHub"],
  ["mcp__jobhub__list_runs", null, "en", "Querying JobHub"],
  ["mcp__safe__workload_list", null, "en", "Querying SaFE"],
  ["mcp__safe__node_get", null, "en", "Querying SaFE"],
  ["bash", "jobhub", "en", "Using the jobhub skill"],
  ["bash", "primus-platform", "en", "Using the primus-platform skill"],
  // not known: derived from the name, "Working: <server> <verb>"
  ["mcp__github__list_prs", null, "en", "Working: github list prs"],
  ["mcp__agent-board__issue_write", null, "en", "Working: agent board issue write"],
  ["mcp__jobhub__create_plan", null, "en", "Working: jobhub create plan"],
  ["TodoWrite", null, "en", "Working: todo write"],
  ["", null, "en", "Working: a step"],
  // the person's language
  ["read", null, "zh", "读取文件"],
  ["bash", null, "zh", "执行命令"],
  ["mcp__agent-board__issue_read", null, "zh", "读取看板话题"],
  ["mcp__agent-board__list_issues", null, "zh", "查看看板列表"],
  ["mcp__jobhub__get_plan", null, "zh", "查询 JobHub"],
  ["mcp__safe__node_list", null, "zh", "查询 SaFE"],
  ["bash", "jobhub", "zh", "使用 jobhub 技能"],
  ["mcp__github__list_prs", null, "zh", "处理中：github list prs"],
];

test("a tool gets a human label", async (t) => {
  for (const [tool, skill, lang, expected] of LABELS) {
    await t.test(`${expected} [${tool || "empty"}]`, () => {
      assert.equal(labelFor(tool, skill, lang, JOBHUB).one, expected);
    });
  }
});

test("the steps the assistant takes have plain labels", () => {
  assert.equal(lookupLabel("mcp__safe__node_list", "zh"), "查询 SaFE 节点");
  assert.equal(lookupLabel("mcp__safe__node_list"), "Checking SaFE nodes");
  assert.equal(lookupLabel("mcp__safe__apikey_current", "zh"), "查询 SaFE");
  assert.equal(lookupLabel("mcp__assistant__work_create", "zh"), "创建任务");
  assert.equal(lookupLabel("mcp__assistant__review_start"), "Starting a review");
  const fleet: StepServers = { mcpServers: new Map([["fleetpilot", "FleetPilot"]]), queryServers: new Set() };
  assert.equal(lookupLabel("mcp__fleetpilot__get_status", "zh", fleet), "查询 FleetPilot");
  assert.equal(
    lookupLabel("mcp__agent-board__list_issues", "zh"),
    labelFor("mcp__agent-board__list_issues", null, "zh").one,
  );
  assert.equal(labelFor("mcp__safe__node_cordon").one, "Querying SaFE"); // a plain session's step is labelled as before
});

test("only the skill directory is taken from a shell command", () => {
  const cases: Array<readonly [string, string | null]> = [
    ['export X=1\npython3 /workspace/.skills/jobhub/scripts/api.py GET "/plans/20"', "jobhub"],
    ["cat /workspace/.skills/primus-platform/SKILL.md", "primus-platform"],
    ["python3 ~/.skills/agent-board/scripts/x.py", "agent-board"],
    ["ls -la /workspace && git status", null],
    ["ls /workspace/.skills/", null],
    ["cat /workspace/.skills/../../etc/passwd", null],
    ["cat /workspace/.skills/$(whoami)/x", null],
    [`cat /workspace/.skills/${"a".repeat(80)}/x`, null],
  ];
  for (const [command, skill] of cases) assert.equal(skillInCommand(command), skill, command);
  assert.equal(skillInCommand(42), null);
});

test("a repeated step is counted, and a failed one stays as one line", () => {
  assert.equal(labelFor("read").text(3), "Reading files (3)");
  assert.equal(labelFor("grep").text(2), "Searching files (2)");
  assert.equal(labelFor("read").text(), "Reading a file");
  assert.equal(new Label("x").text(1), "x");
  assert.equal(failedLine(labelFor("bash")), "⚠️ Running a command failed, continuing");
  assert.equal(failedLine(labelFor("bash", null, "zh"), "zh"), "⚠️ 执行命令失败，已继续");
  assert.equal(labelFor(undefined, null, "en", NO_SERVERS).one, "Working: a step");
});

interface Parity {
  servers: Record<string, string>;
  query: string[];
  labels: Array<{
    tool: string;
    lang: Lang;
    skill: string | null;
    one: string;
    many: string | null;
    text3: string;
    failed: string;
  }>;
  lookups: Array<{ tool: string; lang: Lang; label: string }>;
  skills: Array<{ command: string; skill: string | null }>;
  shells: Array<{ tool: string; shell: boolean }>;
}

test("every label, lookup and skill is the Python worker's", () => {
  const p = JSON.parse(readFileSync(new URL("python-parity.json", import.meta.url), "utf8")) as Parity;
  const servers: StepServers = { mcpServers: new Map(Object.entries(p.servers)), queryServers: new Set(p.query) };
  assert.ok(p.labels.length >= 200);
  for (const row of p.labels) {
    const label = labelFor(row.tool, row.skill, row.lang, servers);
    const got = { one: label.one, many: label.many, text3: label.text(3), failed: failedLine(label, row.lang) };
    assert.deepEqual(
      got,
      { one: row.one, many: row.many, text3: row.text3, failed: row.failed },
      `${row.tool} ${row.lang}`,
    );
    assert.ok(!label.one.toLowerCase().includes("mcp__"), row.tool);
  }
  for (const row of p.lookups)
    assert.equal(lookupLabel(row.tool, row.lang, servers), row.label, `${row.tool} ${row.lang}`);
  for (const row of p.skills) assert.equal(skillInCommand(row.command), row.skill, row.command);
  for (const row of p.shells) assert.equal(isShell(row.tool), row.shell, row.tool);
});
