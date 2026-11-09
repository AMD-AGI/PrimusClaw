// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The live progress shows the agent's own short lines and ONE humanized line for the step running now
 * (test_progress_humanized.py): no "Finished <tool>" list, no raw tool names, consecutive repeats collapsed, a failure
 * kept as one line, and every line a paragraph of its own. 1:1 and group alike.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";

import { LIVE_HEADER, LIVE_HEADERS, LiveView } from "../../src/turn/live-view.js";
import type { Step } from "../../src/turn/step.js";
import { TurnState } from "../../src/turn/turn-state.js";
import { labelFor, setIntegrations, skillInCommand } from "../../src/turn/upstream.js";
import { play } from "./play.js";
import { end, ev, said, type Script, tool } from "./world.js";

/** A deployment's MCP server whose reads a progress line names: a fictional job service. */
beforeEach(() => {
  setIntegrations({ jobhub: "JobHub" }, ["jobhub"]);
});
afterEach(() => {
  setIntegrations({}, []);
});

// --- the label mapping -------------------------------------------------------------------------------------------------

const LABELS: Array<[string, string | undefined, string, string]> = [
  ["read", undefined, "en", "Reading a file"],
  ["Read", undefined, "en", "Reading a file"],
  ["bash", undefined, "en", "Running a command"],
  ["edit", undefined, "en", "Editing a file"],
  ["write", undefined, "en", "Editing a file"],
  ["grep", undefined, "en", "Searching files"],
  ["glob", undefined, "en", "Searching files"],
  ["task", undefined, "en", "Running a sub-task"],
  ["mcp__agent-board__issue_read", undefined, "en", "Reading a board topic"],
  ["mcp__agent-board__list_issues", undefined, "en", "Listing board issues"],
  ["mcp__agent-board__list_org_repos", undefined, "en", "Listing board org repos"],
  ["mcp__agent-board__list_my_repos", undefined, "en", "Listing board my repos"],
  ["mcp__jobhub__get_plan", undefined, "en", "Querying JobHub"],
  ["mcp__jobhub__list_runs", undefined, "en", "Querying JobHub"],
  ["mcp__safe__workload_list", undefined, "en", "Querying SaFE"],
  ["mcp__safe__node_get", undefined, "en", "Querying SaFE"],
  ["bash", "jobhub", "en", "Using the jobhub skill"],
  ["bash", "primus-platform", "en", "Using the primus-platform skill"],
  // not known: derived from the name, "Working: <server> <verb>"
  ["mcp__github__list_prs", undefined, "en", "Working: github list prs"],
  ["mcp__agent-board__issue_write", undefined, "en", "Working: agent board issue write"],
  ["mcp__jobhub__create_plan", undefined, "en", "Working: jobhub create plan"],
  ["TodoWrite", undefined, "en", "Working: todo write"],
  ["", undefined, "en", "Working: a step"],
  // the user's language
  ["read", undefined, "zh", "读取文件"],
  ["bash", undefined, "zh", "执行命令"],
  ["mcp__agent-board__issue_read", undefined, "zh", "读取看板话题"],
  ["mcp__agent-board__list_issues", undefined, "zh", "查看看板列表"],
  ["mcp__jobhub__get_plan", undefined, "zh", "查询 JobHub"],
  ["mcp__safe__node_list", undefined, "zh", "查询 SaFE"],
  ["bash", "jobhub", "zh", "使用 jobhub 技能"],
  ["mcp__github__list_prs", undefined, "zh", "处理中：github list prs"],
];

it("test_a_tool_gets_a_human_label", () => {
  for (const [toolName, skill, lang, expected] of LABELS) {
    assert.equal(labelFor(toolName, skill, lang).one, expected, `${expected} [${toolName || "empty"}]`);
  }
});

const ODD_NAMES = [
  "mcp__",
  "mcp__x",
  "mcp__a__b__c",
  "MCP__Foo__Bar",
  "mcp__mcp__mcp__",
  "mcp__s__",
  "hook:PreToolUse",
  "mcp__weird server__do it!",
  `mcp__ok__${"v".repeat(200)}`,
  " mcp__padded__tool ",
  "mcp__safe",
  "mcp__agent-board",
];

it("test_no_label_ever_carries_a_raw_mcp_name", () => {
  for (const name of ODD_NAMES) {
    for (const lang of ["en", "zh"]) {
      const view = new LiveView(lang);
      view.apply({ tool: [name, "start"] });
      view.apply({ tool: [name, "error"] });
      view.apply({ tool: [name, "start"] });
      const out = view.render();
      assert.ok(!out.toLowerCase().includes("mcp__") && Array.from(out).length < 400, `${name} ${lang}`);
    }
  }
});

// --- the view, step by step --------------------------------------------------------------------------------------------

function start(name: string, action = "", skill?: string): Step {
  return { tool: [name, "start"], ...(action ? { actionId: action } : {}), ...(skill ? { skill } : {}) };
}

function done(name: string, action = ""): Step {
  return { tool: [name, "success"], ...(action ? { actionId: action } : {}) };
}

function fail(name: string, action = ""): Step {
  return { tool: [name, "error"], ...(action ? { actionId: action } : {}) };
}

function say(text: string): Step {
  return { narration: text };
}

/** One finished board read. */
function board(n: number): Step[] {
  return [
    start("mcp__agent-board__issue_read", `b${String(n)}`),
    done("mcp__agent-board__issue_read", `b${String(n)}`),
  ];
}

const VIEWS: Array<[string, "en" | "zh", Step[], string[]]> = [
  ["a running step is one humanized line", "en", [start("read")], ["⏳ Reading a file"]],
  [
    "steps that went well leave nothing behind",
    "en",
    [start("read", "a"), done("read", "a"), start("bash", "b"), done("bash", "b")],
    [],
  ],
  [
    "the agent's line stays, the running step follows it",
    "en",
    [say("Let me read the topic."), start("mcp__agent-board__issue_read")],
    ["Let me read the topic.", "⏳ Reading a board topic"],
  ],
  [
    "narration and five tools: the narration and only the step running now",
    "en",
    [
      say("First the board."),
      ...board(1),
      start("read", "r"),
      done("read", "r"),
      say("Then the machine."),
      start("bash", "c"),
      done("bash", "c"),
      start("mcp__safe__workload_list", "w"),
      done("mcp__safe__workload_list", "w"),
      start("mcp__jobhub__get_plan", "d"),
    ],
    ["First the board.", "Then the machine.", "⏳ Querying JobHub"],
  ],
  [
    "consecutive repeats collapse into one counted line",
    "en",
    [...board(1), ...board(2), start("mcp__agent-board__issue_read", "b3")],
    ["⏳ Reading board topics (3)"],
  ],
  [
    "two repeats, finished and running",
    "en",
    [...board(1), start("mcp__agent-board__issue_read", "b2")],
    ["⏳ Reading board topics (2)"],
  ],
  [
    "a label without a plural just counts",
    "en",
    [start("grep", "g"), done("grep", "g"), start("glob", "h")],
    ["⏳ Searching files (2)"],
  ],
  [
    "a different step in between ends the run",
    "en",
    [...board(1), start("read", "r"), done("read", "r"), start("mcp__agent-board__issue_read", "b2")],
    ["⏳ Reading a board topic"],
  ],
  [
    "the agent speaking ends the run",
    "en",
    [...board(1), say("One more."), start("mcp__agent-board__issue_read", "b2")],
    ["One more.", "⏳ Reading a board topic"],
  ],
  [
    "a failure is one line that stays",
    "en",
    [start("read", "r"), fail("read", "r")],
    ["⚠️ Reading a file failed, continuing"],
  ],
  [
    "a failure of a skill script names the skill",
    "en",
    [start("bash", "s", "jobhub"), fail("bash", "s")],
    ["⚠️ Using the jobhub skill failed, continuing"],
  ],
  [
    "the same failure again collapses",
    "en",
    [
      start("read", "1"),
      fail("read", "1"),
      start("read", "2"),
      fail("read", "2"),
      start("read", "3"),
      fail("read", "3"),
    ],
    ["⚠️ Reading a file failed, continuing (3)"],
  ],
  [
    "a failure, then the next step",
    "en",
    [start("bash", "1"), fail("bash", "1"), say("Trying another way."), start("read", "2")],
    ["⚠️ Running a command failed, continuing", "Trying another way.", "⏳ Reading a file"],
  ],
  [
    "a failure with no start before it",
    "en",
    [fail("mcp__safe__node_cordon")],
    ["⚠️ Querying SaFE failed, continuing"],
  ],
  ["a skill script", "en", [start("bash", "s", "jobhub")], ["⏳ Using the jobhub skill"]],
  ["a tool nobody mapped", "en", [start("mcp__github__list_prs")], ["⏳ Working: github list prs"]],
  [
    "parallel steps: one line, the newest step",
    "en",
    [start("read", "r"), start("bash", "b")],
    ["⏳ Running a command"],
  ],
  [
    "parallel steps: the older one takes over when the newer ends",
    "en",
    [start("read", "r"), start("bash", "b"), done("bash", "b")],
    ["⏳ Reading a file"],
  ],
  [
    "parallel steps both over",
    "en",
    [start("read", "r"), start("bash", "b"), done("bash", "b"), done("read", "r")],
    [],
  ],
  [
    "the same call reported twice is not a repeat",
    "en",
    [start("read", "r"), start("read", "r")],
    ["⏳ Reading a file"],
  ],
  [
    "a finish that never came does not pin the line once the agent speaks",
    "en",
    [start("read", "r"), say("Done reading.")],
    ["Done reading."],
  ],
  [
    "a chinese user gets chinese lines",
    "zh",
    [say("先看看看板。"), ...board(1), start("mcp__agent-board__issue_read", "b2")],
    ["先看看看板。", "⏳ 读取看板话题 (2)"],
  ],
  ["a chinese failure", "zh", [start("bash", "1"), fail("bash", "1")], ["⚠️ 执行命令失败，已继续"]],
];

it("test_the_view_shows_what_the_agent_said_and_one_line_for_the_step_running_now", () => {
  for (const [name, lang, steps, expected] of VIEWS) {
    const view = new LiveView(lang);
    for (const step of steps) view.apply(step);
    const out = view.render();
    assert.equal(out, [LIVE_HEADERS[lang], ...expected].join("\n\n"), name); // (the header in the person's language too)
    assert.ok(!out.includes("Finished") && !out.includes("mcp__"), name);
    assert.ok(out.split("⏳").length - 1 <= 1, name); // at most one live line
    assert.ok(!out.replaceAll("\n\n", "").includes("\n"), name); // every line has its own paragraph
  }
});

it("test_a_repeat_count_is_not_a_list_of_finished_tools", () => {
  const view = new LiveView();
  for (let n = 1; n < 31; n += 1) for (const step of board(n)) view.apply(step);
  view.apply(start("mcp__agent-board__issue_read", "last"));
  assert.equal(view.render(), `${LIVE_HEADER}\n\n⏳ Reading board topics (31)`);
});

it("test_apply_says_when_the_view_changed", () => {
  const view = new LiveView();
  assert.ok(view.apply(start("read", "r")));
  assert.ok(!view.apply(start("read", "r"))); // the same call again: nothing new to send
  assert.ok(view.apply(done("read", "r")));
  assert.ok(!view.apply(done("read", "r")));
  assert.ok(!view.apply({}));
});

// --- from the event to the step ----------------------------------------------------------------------------------------

const SKILL_COMMAND =
  'export JOBHUB_CONSOLE_URL=https://x.test/jobhub\npython3 /workspace/.skills/jobhub/scripts/api.py GET "/plans/20"';

it("test_only_the_skill_directory_is_taken_from_a_shell_call", () => {
  const cases: Array<[string, string, string | undefined]> = [
    ["a skill's script", SKILL_COMMAND, "jobhub"],
    ["a skill's file", "cat /workspace/.skills/primus-platform/SKILL.md", "primus-platform"],
    ["a home directory", "python3 ~/.skills/agent-board/scripts/x.py", "agent-board"],
    ["an ordinary command", "ls -la /workspace && git status", undefined],
    ["the skills directory itself", "ls /workspace/.skills/", undefined],
    ["a path that climbs out", "cat /workspace/.skills/../../etc/passwd", undefined],
    ["a name that is not a plain name", "cat /workspace/.skills/$(whoami)/x", undefined],
    ["a very long name", `cat /workspace/.skills/${"a".repeat(80)}/x`, undefined],
  ];
  for (const [name, command, skill] of cases) {
    assert.equal(skillInCommand(command), skill, name);
    const step = new TurnState("m1").feed(
      tool("bash", "start", {
        actionId: "call_1",
        argumentsDetail: { bash: { command: `${command} --token sk-EXAMPLE-4242` } },
      }),
    );
    assert.deepEqual(step, { tool: ["bash", "start"], actionId: "call_1", ...(skill ? { skill } : {}) }, name);
    assert.ok(!JSON.stringify(step).includes("sk-EXAMPLE-4242"), name);
  }
});

it("test_the_finish_of_a_call_carries_nothing_of_it", () => {
  const finish = tool("bash", "success", {
    actionId: "call_1",
    description: "SECRET-OUTPUT",
    argumentsDetail: { bash: { command: SKILL_COMMAND } },
  });
  assert.deepEqual(new TurnState("m1").feed(finish), { tool: ["bash", "success"], actionId: "call_1" });
});

it("test_a_skill_in_the_command_of_another_tool_is_not_read", () => {
  const step = new TurnState("m1").feed(
    tool("read", "start", { argumentsDetail: { read: { command: SKILL_COMMAND } } }),
  );
  assert.equal(step.skill, undefined);
});

it("test_real_event_shapes_become_the_lines_a_person_expects", () => {
  // The shapes Brain really sends: start with argumentsDetail, then success with a description.
  const state = new TurnState("m1");
  const view = new LiveView();
  view.apply(
    state.feed(
      ev("toolUsed", "m1", {
        tool: "mcp__safe__node_get",
        actionId: "call_1",
        status: "start",
        argumentsDetail: { mcp__safe__node_get: { node_id: "n1" } },
      }),
    ),
  );
  assert.equal(view.render(), `${LIVE_HEADER}\n\n⏳ Querying SaFE`);
  view.apply(
    state.feed(
      ev("toolUsed", "m1", {
        tool: "mcp__safe__node_get",
        actionId: "call_1",
        status: "success",
        description: "api GET /nodes/n1: 404 Not Found (NotFound)",
      }),
    ),
  );
  assert.equal(view.render(), LIVE_HEADER);
  view.apply(
    state.feed(
      ev("toolUsed", "m1", {
        tool: "bash",
        actionId: "call_2",
        status: "start",
        argumentsDetail: { bash: { command: SKILL_COMMAND } },
      }),
    ),
  );
  assert.equal(view.render(), `${LIVE_HEADER}\n\n⏳ Using the jobhub skill`);
});

// --- whole turns: what reaches the chat -------------------------------------------------------------------------------

const BOARD = "mcp__agent-board__issue_read";
const FIVE_CALLS: Script = [
  [0.2, said("Checking the board topic.")],
  [2.0, tool(BOARD, "start", { actionId: "a1" })],
  [4.0, tool(BOARD, "success", { actionId: "a1" })],
  [6.0, tool(BOARD, "start", { actionId: "a2" })],
  [8.0, tool(BOARD, "success", { actionId: "a2" })],
  [10.0, said("Now the files.")],
  [12.0, tool("read", "start", { actionId: "a3" })],
  [14.0, tool("read", "success", { actionId: "a3" })],
  [16.0, tool("bash", "start", { actionId: "a4" })],
  [18.0, tool("bash", "success", { actionId: "a4" })],
  [20.0, tool("mcp__safe__workload_list", "start", { actionId: "a5" })],
  [22.0, tool("mcp__safe__workload_list", "success", { actionId: "a5" })],
  [24.0, said("All set: two topics, one file, one command, one list.")],
  [24.1, end()],
];

it("test_a_turn_with_narration_and_five_tool_calls_shows_the_narration_and_only_the_current_step", async () => {
  const run = await play(FIVE_CALLS);
  const A = `${LIVE_HEADER}\n\nChecking the board topic.`;
  const B = `${A}\n\nNow the files.`;
  assert.deepEqual(
    run.progress.map(([, text]) => text),
    [
      A,
      `${A}\n\n⏳ Reading a board topic`,
      A,
      `${A}\n\n⏳ Reading board topics (2)`,
      A,
      B,
      `${B}\n\n⏳ Reading a file`,
      B,
      `${B}\n\n⏳ Running a command`,
      B,
      `${B}\n\n⏳ Querying SaFE`,
      B,
      `${B}\n\nAll set: two topics, one file, one command, one list.`,
    ],
  );
  assert.equal(run.final, "All set: two topics, one file, one command, one list.");
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_no_progress_update_has_a_finished_line_a_raw_name_or_two_live_lines", async () => {
  for (const group of [false, true]) {
    const run = await play(FIVE_CALLS, { request: { group } });
    const everything = run.bus.everything();
    for (const banned of ["Finished", "mcp__", "issue_read", "workload_list", "Running bash", "Running read"]) {
      assert.ok(!everything.includes(banned), banned);
    }
    assert.ok(run.progress.length > 0 && run.progress.every(([, text]) => text.split("⏳").length - 1 <= 1));
    assert.ok(run.progress.every(([, text]) => text.startsWith(LIVE_HEADER)));
  }
});

it("test_a_group_chat_sees_what_a_1to1_chat_sees", async () => {
  assert.deepEqual((await play(FIVE_CALLS, { request: { group: true } })).progress, (await play(FIVE_CALLS)).progress);
});

it("test_every_progress_line_is_its_own_paragraph_in_every_update", async () => {
  // The bug: lines went to the chat separated by one newline (or none) and ran together on one line.
  const run = await play([
    [0.2, said("Looking.")],
    [2.0, tool("read", "start", { actionId: "1" })],
    [4.0, tool("read", "error", { actionId: "1" })],
    [6.0, tool("bash", "start", { actionId: "2" })],
    [8.0, tool("bash", "error", { actionId: "2" })],
    [10.0, tool("grep", "start", { actionId: "3" })],
    [12.0, said("Giving up on that.")],
    [12.1, end()],
  ]);
  assert.deepEqual(
    (run.progress.at(-2)?.[1] ?? "").split("\n\n").filter((line) => line),
    [
      LIVE_HEADER,
      "Looking.",
      "⚠️ Reading a file failed, continuing",
      "⚠️ Running a command failed, continuing",
      "⏳ Searching files",
    ],
  );
  assert.equal(run.progress.length, 7);
  for (const [, text] of run.progress) {
    assert.ok(!text.replaceAll("\n\n", "").includes("\n"), text); // never two lines joined by a single newline
    assert.ok(!/\S(Finished|⚠️|⏳)/u.test(text.replace(LIVE_HEADER, "")), text); // and never run together on one line
  }
});

it("test_a_failed_step_stays_visible_as_one_line_and_the_turn_goes_on", async () => {
  const run = await play([
    [0.2, tool("bash", "start", { actionId: "1" })],
    [2.0, tool("bash", "error", { actionId: "1" })],
    [4.0, tool("read", "start", { actionId: "2" })],
    [6.0, tool("read", "success", { actionId: "2" })],
    [8.0, said("It worked the second way.")],
    [8.1, end()],
  ]);
  const shown = run.progress.map(([, text]) => text);
  assert.ok(shown.includes(`${LIVE_HEADER}\n\n⏳ Running a command`));
  assert.ok(shown.includes(`${LIVE_HEADER}\n\n⚠️ Running a command failed, continuing`));
  assert.ok(shown.includes(`${LIVE_HEADER}\n\n⚠️ Running a command failed, continuing\n\n⏳ Reading a file`));
  assert.equal(run.final, "It worked the second way.");
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_a_chinese_message_gets_chinese_progress", async () => {
  const run = await play(
    [
      [0.2, said("先看一下。")],
      [2.0, tool(BOARD, "start", { actionId: "1" })],
      [4.0, tool(BOARD, "error", { actionId: "1" })],
      [6.0, tool("read", "start", { actionId: "2" })],
      [8.0, said("好了。")],
      [8.1, end()],
    ],
    { request: { text: "帮我看一下看板上的话题" } },
  );
  const shown = run.bus.updates.map(([, text]) => text).join("\n");
  assert.ok(shown.includes("⚠️ 读取看板话题失败，已继续") && shown.includes("⏳ 读取文件"));
  assert.ok(!shown.includes("Finished") && !shown.includes("mcp__"));
});
