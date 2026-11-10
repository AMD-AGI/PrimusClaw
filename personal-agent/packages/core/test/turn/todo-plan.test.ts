// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The agent's todo list (`todo_write`) in the live view: parsing the event, drawing the plan, the budget it shares with
 * the agent's lines, and the whole thing through a running turn (test_todo_plan.py).
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "../../src/json.js";
import { LIVE_HEADER, LIVE_HEADERS, LIVE_MAX_CHARS, LiveView } from "../../src/turn/live-view.js";
import { planText, type Todo, TODO_FULL_MAX, TODO_ITEM_MAX, TODO_MARKS, todosOf } from "../../src/turn/plan.js";
import { TurnState } from "../../src/turn/turn-state.js";
import { play } from "./play.js";
import { end, ev, said, type Script, tool } from "./world.js";

const DONE = TODO_MARKS.completed;
const ACTIVE = TODO_MARKS.in_progress;
const TODO = TODO_MARKS.pending;
const CANCELLED = TODO_MARKS.cancelled;
const len = (text: string): number => Array.from(text).length;

/** Brain's items: `todo_write` answers with {id, content, status} for each. */
function items(...pairs: Array<readonly [string, string]>): JsonObject[] {
  return pairs.map(([text, state], n) => ({ id: `t${String(n)}`, content: text, status: state }));
}

function eventData(todos: unknown, extra: Record<string, unknown> = {}): JsonObject {
  return { argumentsDetail: { todo_write: { todos } }, ...extra } as JsonObject;
}

/** `done` finished items, then `active` in progress, then `pending` to do, then `cancelled` dropped. */
function numbered(done = 0, active = 0, pending = 0, cancelled = 0): Todo[] {
  const out: Todo[] = [];
  for (const [state, count] of [
    ["completed", done],
    ["in_progress", active],
    ["pending", pending],
    ["cancelled", cancelled],
  ] as const) {
    const before = out.length;
    for (let n = 0; n < count; n += 1) out.push([`${state} ${String(before + n + 1)}`, state]);
  }
  return out;
}

// --- reading the event -----------------------------------------------------------------------------------------------

it("test_todos_of_reads_a_successful_todo_write_and_nothing_else", () => {
  const cases: Array<[string, string, string, JsonObject, Todo[] | undefined]> = [
    [
      "a list",
      "todo_write",
      "success",
      eventData(items(["A", "pending"], ["B", "completed"])),
      [
        ["A", "pending"],
        ["B", "completed"],
      ],
    ],
    [
      "the tool's name in another spelling",
      " TodoWrite ",
      "success",
      eventData(items(["A", "pending"])),
      [["A", "pending"]],
    ],
    ["the agent cleared its list", "todo_write", "success", eventData([]), []],
    ["another tool carrying the same shape", "bash", "success", eventData(items(["A", "pending"])), undefined],
    ["a call that failed", "todo_write", "error", eventData(items(["A", "pending"])), undefined],
    ["a call that has only started", "todo_write", "start", eventData(items(["A", "pending"])), undefined],
    ["no detail at all", "todo_write", "success", {}, undefined],
    ["a detail that is not an object", "todo_write", "success", { argumentsDetail: "todos" }, undefined],
    [
      "a todo_write that is not an object",
      "todo_write",
      "success",
      { argumentsDetail: { todo_write: [1, 2] } },
      undefined,
    ],
    ["todos that are not a list", "todo_write", "success", eventData("A; B"), undefined],
    ["todos missing", "todo_write", "success", { argumentsDetail: { todo_write: {} } }, undefined],
    [
      "the input rather than the detail",
      "todo_write",
      "success",
      { input: { todos: items(["A", "pending"]) } },
      undefined,
    ],
    [
      "items that are not objects, or have no usable text",
      "todo_write",
      "success",
      eventData([
        "A",
        7,
        null,
        { status: "pending" },
        { content: "" },
        { content: "   \n" },
        { content: 12 },
        { content: "Real", status: "pending" },
      ]),
      [["Real", "pending"]],
    ],
    [
      "a status Brain does not know",
      "todo_write",
      "success",
      eventData([{ content: "A", status: "blocked" }, { content: "B" }, { content: "C", status: ["completed"] }]),
      [
        ["A", "pending"],
        ["B", "pending"],
        ["C", "pending"],
      ],
    ],
    [
      "text on several lines, with a code fence",
      "todo_write",
      "success",
      eventData([{ content: "Fix\n  the   parser\n```sh\nrm -rf x\n```", status: "in_progress" }]),
      [["Fix the parser 'sh rm -rf x '", "in_progress"]],
    ],
  ];
  for (const [name, toolName, status, data, expected] of cases) {
    assert.deepEqual(todosOf(toolName, status, data), expected, name);
  }
});

it("test_an_item_is_one_clipped_line_and_only_its_text_and_status_are_read", () => {
  const long = "word ".repeat(40);
  const todos = todosOf(
    "todo_write",
    "success",
    eventData([
      { id: "x", content: long, status: "completed", secret: `ghp_${"a".repeat(36)}`, notes: "internal detail" },
    ]),
  );
  assert.equal(todos?.length, 1);
  const [text, state] = todos[0] ?? ["", ""];
  assert.ok(state === "completed" && len(text) === TODO_ITEM_MAX && text.endsWith("…") && !text.includes("\n"));
  assert.ok(!text.includes("ghp_") && !text.includes("internal"));
  const solid = todosOf("todo_write", "success", eventData(items(["x".repeat(200), "pending"])));
  assert.equal(solid?.length, 1);
  assert.equal(solid[0]?.[0], `${"x".repeat(TODO_ITEM_MAX - 1)}…`); // a text with no spaces is cut at the limit exactly
});

it("test_a_list_longer_than_a_person_reads_is_cut_at_a_hundred_items", () => {
  const todos = todosOf(
    "todo_write",
    "success",
    eventData(items(...Array.from({ length: 250 }, (_, n) => [`item ${String(n)}`, "pending"] as const))),
  );
  assert.equal(todos?.length, 100);
  assert.deepEqual(todos.at(-1), ["item 99", "pending"]);
});

// --- drawing the plan -------------------------------------------------------------------------------------------------

it("test_the_plan_is_a_count_and_one_paragraph_per_item", () => {
  const cases: Array<[string, Todo[], string]> = [
    ["nothing planned", [], ""],
    ["everything cancelled", numbered(0, 0, 0, 3), ""],
    [
      "partly done",
      [
        ["Read the test", "completed"],
        ["Fix the parser", "in_progress"],
        ["Run the suite", "pending"],
      ],
      `**Plan: 1 of 3 done**\n\n${DONE} Read the test\n\n${ACTIVE} Fix the parser\n\n${TODO} Run the suite`,
    ],
    [
      "not started",
      [
        ["A", "pending"],
        ["B", "pending"],
      ],
      `**Plan: 0 of 2 done**\n\n${TODO} A\n\n${TODO} B`,
    ],
    [
      "all done",
      [
        ["A", "completed"],
        ["B", "completed"],
        ["C", "completed"],
      ],
      "**Plan: all 3 steps done** ✅",
    ],
    [
      "all done but one that was dropped",
      [
        ["A", "completed"],
        ["B", "cancelled"],
        ["C", "completed"],
      ],
      "**Plan: all 2 steps done** ✅",
    ],
    [
      "a dropped item still shows while the plan is open",
      [
        ["A", "completed"],
        ["B", "cancelled"],
        ["C", "pending"],
      ],
      `**Plan: 1 of 2 done**\n\n${DONE} A\n\n${CANCELLED} B\n\n${TODO} C`,
    ],
  ];
  for (const [name, todos, expected] of cases) assert.equal(planText(todos), expected, name);
});

it("test_the_marks_are_these_and_no_others", () => {
  // written out, not taken from TODO_MARKS: a test that reads its oracle from the code cannot see the code change
  assert.equal(
    planText([
      ["a", "completed"],
      ["b", "in_progress"],
      ["c", "pending"],
      ["d", "cancelled"],
    ]),
    "**Plan: 1 of 3 done**\n\n✅ a\n\n\u{1f504} b\n\n⬜ c\n\n\u{1f6ab} d",
  );
});

it("test_the_plan_is_in_chinese_for_a_user_who_writes_chinese", () => {
  assert.equal(
    planText(
      [
        ["读测试", "completed"],
        ["修复", "in_progress"],
      ],
      "zh",
    ),
    `**计划：已完成 1/2**\n\n${DONE} 读测试\n\n${ACTIVE} 修复`,
  );
  assert.equal(planText([["读测试", "completed"]], "zh"), "**计划：1 项已全部完成** ✅");
  assert.equal(planText([["a", "pending"]], "xx"), planText([["a", "pending"]], "en")); // an unknown language is English
});

it("test_a_plan_of_the_full_size_is_listed_whole_and_one_more_item_folds_it", () => {
  const whole = planText(numbered(3, 1, TODO_FULL_MAX - 4));
  assert.ok(whole.split("\n\n").length - 1 === TODO_FULL_MAX && !whole.includes("more ("));
  const folded = planText(numbered(3, 1, TODO_FULL_MAX - 3));
  assert.ok(folded.split("\n\n").length - 1 < TODO_FULL_MAX + 1 && folded.includes("...and"));
});

const FOLDED: Array<[string, Todo[], string[]]> = [
  [
    "a long plan keeps the last finished item, what is in progress and the next three",
    numbered(10, 1, 14),
    [
      "**Plan: 10 of 25 done**",
      `${DONE} completed 10`,
      `${ACTIVE} in_progress 11`,
      `${TODO} pending 12`,
      `${TODO} pending 13`,
      `${TODO} pending 14`,
      "...and 20 more (9 done, 11 to do)",
    ],
  ],
  [
    "at most two items in progress are shown",
    numbered(1, 4, 5),
    [
      "**Plan: 1 of 10 done**",
      `${DONE} completed 1`,
      `${ACTIVE} in_progress 2`,
      `${ACTIVE} in_progress 3`,
      `${TODO} pending 6`,
      `${TODO} pending 7`,
      `${TODO} pending 8`,
      "...and 4 more (0 done, 4 to do)",
    ],
  ],
  [
    "nothing in progress: the first items still to do",
    numbered(4, 0, 8),
    [
      "**Plan: 4 of 12 done**",
      `${DONE} completed 4`,
      `${TODO} pending 5`,
      `${TODO} pending 6`,
      `${TODO} pending 7`,
      "...and 8 more (3 done, 5 to do)",
    ],
  ],
  [
    "a plan not yet started has nothing finished to show",
    numbered(0, 0, 12),
    [
      "**Plan: 0 of 12 done**",
      `${TODO} pending 1`,
      `${TODO} pending 2`,
      `${TODO} pending 3`,
      "...and 9 more (0 done, 9 to do)",
    ],
  ],
  [
    "only one item left: no line for what is hidden when everything else fits",
    numbered(1, 1, 2, 6),
    [
      "**Plan: 1 of 4 done**",
      `${DONE} completed 1`,
      `${ACTIVE} in_progress 2`,
      `${TODO} pending 3`,
      `${TODO} pending 4`,
    ],
  ],
  [
    "a pending item ahead of the one in progress is not one of the next",
    [
      ["early", "pending"],
      ["now", "in_progress"],
      ...Array.from({ length: 8 }, (_, n): Todo => [`later ${String(n)}`, "pending"]),
    ],
    [
      "**Plan: 0 of 10 done**",
      `${ACTIVE} now`,
      `${TODO} later 0`,
      `${TODO} later 1`,
      `${TODO} later 2`,
      "...and 6 more (0 done, 6 to do)",
    ],
  ],
  [
    "cancelled items are not counted or shown in a folded plan",
    numbered(2, 0, 10, 5),
    [
      "**Plan: 2 of 12 done**",
      `${DONE} completed 2`,
      `${TODO} pending 3`,
      `${TODO} pending 4`,
      `${TODO} pending 5`,
      "...and 8 more (1 done, 7 to do)",
    ],
  ],
];

it("test_a_long_plan_is_folded_and_the_line_that_counts_the_rest_adds_up", () => {
  for (const [name, todos, expected] of FOLDED) assert.deepEqual(planText(todos).split("\n\n"), expected, name);
});

it("test_a_long_plan_never_takes_more_than_a_phones_worth_of_lines", () => {
  for (const todos of [numbered(40, 3, 57), numbered(0, 0, 100), numbered(99, 1)]) {
    const lines = planText(todos).split("\n\n");
    // count, six items, the rest
    assert.ok(lines.length <= 8 && lines.every((line) => len(line) <= TODO_ITEM_MAX + 3), lines.join("|"));
  }
});

// --- the live view --------------------------------------------------------------------------------------------------

it("test_the_plan_sits_under_the_header_ahead_of_the_agents_lines_and_is_redrawn_on_every_update", () => {
  const view = new LiveView();
  view.apply({ narration: "Reading the failing test." });
  assert.equal(view.render(), `${LIVE_HEADER}\n\nReading the failing test.`); // no plan yet: the view is what it was
  view.apply({
    tool: ["todo_write", "success"],
    todos: [
      ["Read", "in_progress"],
      ["Fix", "pending"],
    ],
  });
  assert.equal(
    view.render(),
    `${LIVE_HEADER}\n\n**Plan: 0 of 2 done**\n\n${ACTIVE} Read\n\n${TODO} Fix\n\nReading the failing test.`,
  );
  assert.ok(
    view.apply({
      tool: ["todo_write", "success"],
      todos: [
        ["Read", "completed"],
        ["Fix", "in_progress"],
      ],
    }),
  );
  assert.ok(view.render().startsWith(`${LIVE_HEADER}\n\n**Plan: 1 of 2 done**\n\n${DONE} Read\n\n${ACTIVE} Fix`));
  view.apply({ tool: ["bash", "start"] });
  assert.ok(view.render().endsWith("Reading the failing test.\n\n⏳ Running a command")); // the step running now stays last
});

it("test_a_step_that_says_nothing_about_the_plan_leaves_it_and_an_empty_list_takes_it_down", () => {
  const view = new LiveView();
  view.apply({ todos: [["A", "pending"]] });
  assert.ok(view.render().includes("Plan"));
  assert.ok(!view.apply({})); // nothing changed, nothing to send
  assert.ok(!view.apply({ todos: [["A", "pending"]] })); // the same list again is not an edit either
  view.apply({ todos: [] });
  assert.equal(view.render(), LIVE_HEADER);
});

it("test_a_long_run_of_lines_cannot_push_the_plan_out_and_the_view_stays_under_its_limit", () => {
  const view = new LiveView();
  view.apply({ todos: numbered(2, 1, 5) });
  for (let n = 0; n < 60; n += 1) view.apply({ narration: `Paragraph ${String(n)}: ${"x".repeat(300)}` });
  const out = view.render();
  assert.ok(out.includes("**Plan: 2 of 8 done**") && out.includes(`${ACTIVE} in_progress 3`));
  assert.ok(out.includes("Paragraph 59") && !out.includes("Paragraph 0:") && out.includes("...\n\n"));
  assert.ok(len(out) <= len(LIVE_HEADER) + LIVE_MAX_CHARS + len("...\n\n") + 2);
  // and one huge paragraph is cut from its start to fit what the plan leaves
  view.apply({ narration: "y".repeat(9000) });
  assert.ok(
    view.render().includes("**Plan: 2 of 8 done**") && len(view.render()) <= len(LIVE_HEADER) + LIVE_MAX_CHARS + 10,
  );
});

it("test_the_plan_is_in_the_users_language", () => {
  const view = new LiveView("zh");
  view.apply({
    todos: [
      ["读测试", "completed"],
      ["修复", "pending"],
    ],
  });
  assert.equal(view.render(), `${LIVE_HEADERS.zh}\n\n**计划：已完成 1/2**\n\n${DONE} 读测试\n\n${TODO} 修复`);
});

// --- events to view ---------------------------------------------------------------------------------------------------

function sse(name: string, data: Record<string, unknown>): ReturnType<typeof ev> {
  return ev(name, "m1", data);
}

it("test_a_todo_write_event_becomes_a_step_that_carries_the_list_and_is_still_a_finished_tool", () => {
  const state = new TurnState("m1");
  const step = state.feed(
    sse("toolUsed", {
      tool: "todo_write",
      status: "success",
      actionId: "a1",
      ...eventData(items(["Read", "completed"], ["Fix", "in_progress"])),
    }),
  );
  assert.deepEqual(step.todos, [
    ["Read", "completed"],
    ["Fix", "in_progress"],
  ]);
  assert.deepEqual(step.tool, ["todo_write", "success"]);
  const other = state.feed(
    sse("toolUsed", { tool: "bash", status: "success", actionId: "a2", ...eventData(items(["X", "pending"])) }),
  );
  assert.equal(other.todos, undefined);
  const failed = state.feed(
    sse("toolUsed", { tool: "todo_write", status: "error", ...eventData(items(["X", "pending"])) }),
  );
  assert.equal(failed.todos, undefined);
});

it("test_events_walk_the_plan_forward_and_the_listed_items_turn_to_done", () => {
  const state = new TurnState("m1");
  const view = new LiveView();
  const frames: string[] = [];
  for (const data of [
    items(["Read", "in_progress"], ["Fix", "pending"], ["Test", "pending"]),
    items(["Read", "completed"], ["Fix", "in_progress"], ["Test", "pending"]),
    items(["Read", "completed"], ["Fix", "completed"], ["Test", "completed"]),
  ]) {
    view.apply(state.feed(sse("toolUsed", { tool: "todo_write", status: "success", ...eventData(data) })));
    frames.push(view.render());
  }
  assert.deepEqual(
    frames.map((f) => f.split("\n\n")[1]),
    ["**Plan: 0 of 3 done**", "**Plan: 1 of 3 done**", "**Plan: all 3 steps done** ✅"],
  );
  const mid = frames[1] ?? "";
  assert.ok(mid.includes(`${ACTIVE} Fix`) && mid.includes(`${DONE} Read`) && mid.includes(`${TODO} Test`));
});

it("test_a_malformed_event_changes_nothing_and_does_not_raise", () => {
  const state = new TurnState("m1");
  const view = new LiveView();
  view.apply(
    state.feed(sse("toolUsed", { tool: "todo_write", status: "success", ...eventData(items(["A", "pending"])) })),
  );
  const before = view.render();
  for (const bad of [
    { argumentsDetail: null },
    { argumentsDetail: { todo_write: null } },
    eventData(null),
    eventData("x"),
    eventData({ "0": { content: "A" } }),
  ]) {
    view.apply(state.feed(sse("toolUsed", { tool: "todo_write", status: "success", ...bad })));
  }
  assert.equal(view.render(), before);
});

// --- through a running turn -------------------------------------------------------------------------------------------

const PLAN_1 = items(
  ["Read the failing test", "in_progress"],
  ["Fix the parser", "pending"],
  ["Run the suite", "pending"],
);
const PLAN_2 = items(
  ["Read the failing test", "completed"],
  ["Fix the parser", "in_progress"],
  ["Run the suite", "pending"],
);
const PLAN_3 = items(
  ["Read the failing test", "completed"],
  ["Fix the parser", "completed"],
  ["Run the suite", "completed"],
);
const WALK: Script = [
  [0.2, said("Let me look at it.")],
  [2.0, tool("todo_write", "success", eventData(PLAN_1))],
  [4.0, tool("bash", "start")],
  [6.0, tool("bash", "success")],
  [8.0, tool("todo_write", "success", eventData(PLAN_2))],
  [10.0, tool("bash", "start")],
  [12.0, tool("bash", "success")],
  [14.0, tool("todo_write", "success", eventData(PLAN_3))],
  [16.0, said("Fixed: 3 tests pass.")],
  [16.1, end()],
];

it("test_the_chat_shows_the_plan_ticking_off_while_the_turn_runs_and_the_answer_is_only_the_answer", async () => {
  const run = await play(WALK);
  const shown = run.progress.map(([, text]) => text);
  const plans = shown.filter((t) => t.includes("**Plan")).map((t) => t.split("\n\n")[1] ?? "");
  assert.ok(plans[0] === "**Plan: 0 of 3 done**" && plans.at(-1) === "**Plan: all 3 steps done** ✅");
  const key = (p: string): string => `${p.startsWith("**Plan: all") ? "1" : "0"}${p}`;
  assert.ok(plans.includes("**Plan: 1 of 3 done**"));
  assert.deepEqual(
    plans,
    [...plans].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
  );
  const mid = shown.find((t) => t.includes("**Plan: 1 of 3 done**")) ?? "";
  assert.ok(
    mid.includes(`${DONE} Read the failing test`) &&
      mid.includes(`${ACTIVE} Fix the parser`) &&
      mid.includes(`${TODO} Run the suite`),
  );
  assert.ok(mid.startsWith(LIVE_HEADER) && len(mid) <= len(LIVE_HEADER) + LIVE_MAX_CHARS + 8);
  assert.ok(run.final === "Fixed: 3 tests pass." && !run.final.includes("Plan")); // progress only: the answer does not repeat it
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_no_other_tools_input_reaches_the_view_with_a_plan_on_screen", async () => {
  const secret = "curl -H 'Authorization: Bearer sk-EXAMPLE-4242' https://internal.example/x";
  const run = await play([
    [0.2, tool("todo_write", "success", eventData(PLAN_1))],
    [2.0, tool("bash", "start", { input: { command: secret } })],
    [3.0, tool("bash", "success", { input: { command: secret }, argumentsDetail: { bash: { command: secret } } })],
    [4.0, said("Done.")],
    [4.1, end()],
  ]);
  const seen = run.progress.map(([, text]) => text).join("\n");
  assert.ok(
    seen.includes("Plan: 0 of 3 done") &&
      !run.bus.everything().includes("sk-EXAMPLE-4242") &&
      !run.bus.everything().includes("internal.example"),
  );
});
