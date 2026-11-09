// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's setup steps (download_skill, load_mcp, load_rule, ...) are not agent actions, so they are not steps
 * (test_preparation_steps.py): setup that is quick shows nothing, setup that lasts shows one "Preparing…" line until the
 * first real step, a setup step that failed shows one "Could not load <name>" line, and everything else is unchanged.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { runTurn } from "../../src/turn/engine/run-turn.js";
import { LIVE_HEADER, LiveView, PREPARING_LINE } from "../../src/turn/live-view.js";
import { PREPARATION_TOOLS, TurnState } from "../../src/turn/turn-state.js";
import { play, quiet, type Run, setUpWorld } from "./play.js";
import { end, ev, said, type Script, textOf, tool } from "./world.js";

const PREP_NAMES = ["download_skill", "load_mcp", "load_rule"];

/** What Brain sends before the first model call: `skills` running+success pairs, `mcps` and `rules` successes. */
function setupBurst(
  start: number,
  skills = 12,
  mcps = 3,
  rules = 1,
  gap = 0.01,
): [Array<[number, ReturnType<typeof ev>]>, number] {
  const script: Array<[number, ReturnType<typeof ev>]> = [];
  let t = start;
  for (let i = 0; i < skills; i += 1) {
    script.push(
      [
        t,
        tool("download_skill", "running", {
          actionId: `plugin_skill_${String(i)}`,
          brief: `Downloading plugin skill: s${String(i)}`,
        }),
      ],
      [t + gap, tool("download_skill", "success", { actionId: `plugin_skill_${String(i)}` })],
    );
    t += 2 * gap;
  }
  for (let i = 0; i < mcps; i += 1) {
    script.push([t, tool("load_mcp", "success", { actionId: `plugin_mcp_${String(i)}` })]);
    t += gap;
  }
  for (let i = 0; i < rules; i += 1) {
    script.push([t, tool("load_rule", "success", { actionId: `plugin_rule_${String(i)}` })]);
    t += gap;
  }
  return [script, t];
}

function progressText(run: Run): string {
  return run.progress.map(([, text]) => text).join("\n");
}

it("test_the_constant_names_every_setup_tool_brain_emits_before_the_first_model_call", () => {
  assert.deepEqual(
    PREPARATION_TOOLS,
    new Set(["resolve_tools", "download_skill", "load_mcp", "load_rule", "load_hooks"]),
  );
});

it("test_a_burst_of_setup_steps_is_not_shown_and_the_real_tools_after_it_are", async () => {
  for (const group of [false, true]) {
    const [burst, t] = setupBurst(0.05);
    const script: Script = [
      ...burst,
      [t + 0.2, tool("bash", "start")],
      [t + 3.0, tool("bash", "success")],
      [t + 3.2, said("All done.")],
      [t + 3.3, end()],
    ];
    const run = await play(script, { request: { group } });
    const shown = progressText(run);
    for (const name of [...PREP_NAMES, "resolve_tools", "load_hooks", "Preparing", "Could not load"]) {
      assert.ok(!shown.includes(name) && !run.bus.everything().includes(name), name);
    }
    assert.ok(shown.includes("Running a command")); // the real tool is still there
    assert.equal(run.final, "All done.");
    assert.deepEqual(run.told, ["started", "delivered"]);
  }
});

it("test_one_to_one_progress_shows_only_the_real_step_that_is_running_after_setup", async () => {
  const [burst, t] = setupBurst(0.05);
  const run = await play([
    ...burst,
    [t + 0.1, tool("bash", "start")],
    [t + 2.0, tool("bash", "success")],
    [t + 2.1, tool("grep", "start")],
    [t + 4.0, tool("grep", "success")],
    [t + 4.2, said("Done.")],
    [t + 4.3, end()],
  ]);
  assert.deepEqual(
    run.progress.map(([, text]) => text),
    [`${LIVE_HEADER}\n\n⏳ Running a command`, `${LIVE_HEADER}\n\n⏳ Searching files`, LIVE_HEADER],
  );
});

it("test_setup_that_lasts_shows_one_preparing_line_after_one_and_a_half_seconds", async () => {
  const run = await play([
    [0.1, tool("download_skill", "running")],
    [0.2, tool("load_mcp", "success")],
    [5.0, tool("download_skill", "success")],
    [5.5, tool("bash", "start")],
    [7.0, tool("bash", "success")],
    [7.2, said("Done.")],
    [7.3, end()],
  ]);
  const preparing = run.progress.filter(([, text]) => text.includes(PREPARING_LINE));
  assert.deepEqual(
    preparing.map(([, text]) => text),
    [`${LIVE_HEADER}\n\n${PREPARING_LINE}`],
  ); // one line, once
  const at = preparing[0]?.[0] ?? 0;
  assert.ok(0.1 + 1.5 - 1e-9 <= at && at < 5.0); // 1.5 s after setup began, not before, not at the end
  assert.ok(!run.progress.some(([t, text]) => t < 1.6 && text.includes(PREPARING_LINE)));
  assert.ok(run.final === "Done." && !run.bus.everything().includes("download_skill"));
});

it("test_a_group_chat_shows_the_preparing_line_and_a_failed_setup_step_like_a_1to1_chat", async () => {
  const scripts: Script[] = [
    [
      [0.1, tool("download_skill", "running")],
      [5.0, tool("download_skill", "success")],
      [5.5, tool("bash", "start")],
      [7.0, tool("bash", "success")],
      [7.2, said("Done.")],
      [7.3, end()],
    ],
    [
      [0.1, tool("download_skill", "running")],
      [1.7, tool("download_skill", "error")],
      [1.8, tool("bash", "start")],
      [4.0, tool("bash", "success")],
      [4.2, said("Done.")],
      [4.3, end()],
    ],
  ];
  for (const script of scripts) {
    const group = await play(script, { request: { group: true } });
    const one = await play(script);
    assert.deepEqual(group.progress, one.progress);
    assert.deepEqual(group.texts, ["Done."]);
    assert.deepEqual(one.texts, ["Done."]);
  }
  const first = await play(scripts[0] ?? [], { request: { group: true } });
  assert.deepEqual(
    first.progress.filter(([, text]) => text.includes(PREPARING_LINE)).map(([, text]) => text),
    [`${LIVE_HEADER}\n\n${PREPARING_LINE}`],
  );
  const second = await play(scripts[1] ?? [], { request: { group: true } });
  assert.ok(`${second.progress.at(-1)?.[1] ?? ""}\n\n`.includes("\n\nCould not load download_skill\n\n"));
});

it("test_the_preparing_line_goes_away_when_the_first_real_step_arrives", async () => {
  const run = await play([
    [0.1, tool("load_rule", "success")],
    [4.0, said("Looking at it now.")],
    [4.2, tool("bash", "start")],
    [8.0, said("Done.")],
    [8.1, end()],
  ]);
  const texts = run.progress.map(([, text]) => text);
  assert.ok(texts.some((t) => t.includes(PREPARING_LINE))); // it was shown while setup was the only thing going on
  const after = texts.filter((t) => t.includes("Looking at it now."));
  assert.ok(after.length > 0 && after.every((t) => !t.includes(PREPARING_LINE))); // and is gone once the agent speaks
  assert.ok(!run.final.includes(PREPARING_LINE));
});

it("test_setup_that_is_quick_shows_no_preparing_line_at_all", async () => {
  const [burst] = setupBurst(0.05); // about 0.3 s of setup
  for (const group of [false, true]) {
    const run = await play([...burst, [1.0, said("Quick answer.")], [1.1, end()]], { request: { group } });
    assert.ok(!run.bus.everything().includes(PREPARING_LINE) && run.final === "Quick answer.");
  }
});

it("test_a_setup_step_that_failed_is_shown", async () => {
  const cases: Array<[string, string[]]> = [
    ["a skill that could not be downloaded", ["download_skill"]],
    ["the tool list that could not be fetched", ["resolve_tools"]],
    ["hooks that could not be loaded", ["load_hooks"]],
    ["two different setup steps", ["download_skill", "load_hooks"]],
  ];
  for (const [name, failed] of cases) {
    const script: Script = [
      ...failed.map((n) => [0.1, tool(n, "running")] as const),
      ...failed.map((n) => [0.2, tool(n, "error", { brief: `Failed: ${n}` })] as const),
      [0.3, tool("load_mcp", "success")],
      [0.4, tool("bash", "start")],
      [2.5, tool("bash", "success")],
      [2.6, said("Done.")],
      [2.7, end()],
    ];
    const run = await play(script);
    const shown = run.progress.at(-1)?.[1] ?? "";
    for (const n of failed) assert.ok(`${shown}\n\n`.includes(`\n\nCould not load ${n}\n\n`), name); // a paragraph each
    assert.ok(!shown.includes("load_mcp") && !shown.includes("failed, continuing"), name);
    assert.ok(
      ![...PREPARATION_TOOLS].some((n) => shown.includes(`Running ${n}`) || shown.includes(`Finished ${n}`)),
      name,
    );
    assert.equal(run.final, "Done.");
  }
});

it("test_failures_of_the_same_step_are_one_line_with_a_count", async () => {
  const run = await play([
    ...Array.from({ length: 5 }, (_, i) => [0.1 + 0.01 * i, tool("download_skill", "error")] as const),
    [0.3, tool("download_skill", "success")],
    [0.4, tool("bash", "start")],
    [2.5, tool("bash", "success")],
    [2.6, said("Done.")],
    [2.7, end()],
  ]);
  const shown = run.progress.at(-1)?.[1] ?? "";
  assert.ok(shown.split("Could not load").length - 1 === 1 && shown.includes("Could not load download_skill (x5)"));
});

it("test_the_final_answer_is_the_same_with_or_without_setup_steps", async () => {
  const walk: Script = [
    [0.2, said("Let me look.")],
    [0.4, tool("bash", "start")],
    [2.0, tool("bash", "success")],
    [2.2, said("All green.")],
    [2.3, end()],
  ];
  const [burst, t] = setupBurst(0.01);
  const withSetup = await play([...burst, ...walk.map(([at, e]) => [at + t + 0.5, e] as const)]);
  const without = await play(walk);
  assert.ok(withSetup.final === without.final && without.final === "All green.");
  assert.deepEqual(withSetup.told, ["started", "delivered"]);
  assert.deepEqual(without.told, ["started", "delivered"]);
});

it("test_a_turn_that_ends_during_setup_leaves_nothing_behind", async () => {
  // Cancelled, or answered with no real step: the preparing timer must not outlive the turn or send after it.
  const run = await play([
    [0.1, tool("download_skill", "running")],
    [0.5, ev("ResultMessage", "m1", { final_text: "Straight answer.", data: { subtype: "success" } })],
  ]);
  assert.ok(run.final === "Straight answer." && !run.final.includes(PREPARING_LINE));
});

it("test_a_turn_cancelled_during_setup_leaves_no_timer_and_sends_nothing_more", async () => {
  // a liveStatus event at 1.0 s keeps virtual time from jumping straight over the timer (due at 1.6 s)
  const w = setUpWorld(
    [
      [0.1, tool("download_skill", "running")],
      [1.0, ev("liveStatus", "m1", { text: "warming up" })],
    ],
    { hang: true },
  );
  const cancel = new AbortController();
  const outcome = runTurn(w.ctx, {
    onSession: () => undefined,
    stopRequested: () => false,
    signal: cancel.signal,
  }).then(
    () => "resolved",
    (err: unknown) => err,
  );
  await w.clock.advanceTo(w.clock.start + 1.0); // setup began at 0.1 s; the preparing timer is waiting
  assert.ok(!w.bus.sent.some((s) => textOf(s.message).includes(PREPARING_LINE))); // not yet: it was due at 1.6 s
  const sentBefore = w.bus.sent.length;
  cancel.abort(new Error("cancelled"));
  assert.notEqual(await w.clock.pump(outcome), "resolved");
  await w.clock.drain();
  assert.ok(quiet(w));
  assert.ok(w.bus.sent.length === sentBefore && w.told.at(-1) === "failed");
});

// --- the pure parts ---------------------------------------------------------------------------------------------------

it("test_feed_turns_a_setup_step_into_nothing_to_show", () => {
  for (const name of [...PREPARATION_TOOLS].sort()) {
    for (const status of ["running", "start", "success"]) {
      const step = new TurnState("m1").feed(ev("toolUsed", "m1", { tool: name, status }));
      assert.deepEqual(step, { preparation: true }, `${name} ${status}`);
    }
  }
});

it("test_feed_keeps_a_failed_setup_step", () => {
  for (const name of [...PREPARATION_TOOLS].sort()) {
    const step = new TurnState("m1").feed(ev("toolUsed", "m1", { tool: name, status: "error" }));
    assert.ok(step.preparation, name);
    assert.deepEqual(step.tool, [name, "error"]);
  }
});

it("test_feed_leaves_every_other_tool_alone", () => {
  for (const name of ["bash", "grep", "task", "hook:PreToolUse", "mcp__github__list_prs", "load_skill", "download"]) {
    const step = new TurnState("m1").feed(ev("toolUsed", "m1", { tool: name, status: "start" }));
    assert.deepEqual(step, { tool: [name, "start"] }, name);
    assert.ok(!step.preparation);
  }
});

it("test_the_live_view_renders_a_setup_step_only_when_it_failed", () => {
  const view = new LiveView();
  assert.ok(!view.apply({ preparation: true }));
  assert.equal(view.render(), LIVE_HEADER);
  view.preparing = true;
  assert.equal(view.render(), `${LIVE_HEADER}\n\n${PREPARING_LINE}`);
  assert.ok(view.apply({ preparation: true, tool: ["load_rule", "error"] }));
  assert.equal(view.render(), `${LIVE_HEADER}\n\nCould not load load_rule\n\n${PREPARING_LINE}`);
});
