// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A chat (1:1 or group) shows the turn while it runs, then the answer (test_live_progress.py). The turn runs through
 * `runTurn` against a scripted Claw stream and a recording conversation, on virtual time: events arrive at simulated
 * times, and the throttle's waits move that same clock. The answer always reaches the chat as new message(s), and the
 * progress message is deleted (or, where it cannot be, edited down to DONE_LINE).
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { turnEnglish } from "../../src/locales/turn.js";
import { runTurn } from "../../src/turn/engine/run-turn.js";
import { LIVE_HEADER, LIVE_MAX_CHARS, LiveView } from "../../src/turn/live-view.js";
import { StatusMessage } from "../../src/turn/progress/status-message.js";
import type { Step } from "../../src/turn/step.js";
import { play, quiet, setUpWorld } from "./play.js";
import { Timeline } from "./timeline.js";
import { Bus, end, ev, RecordingLogger, said, type Script, type Sent, textOf, tool } from "./world.js";

const DONE_LINE = turnEnglish.doneLine;
const SECRET_INPUT = "curl -H 'Authorization: Bearer sk-EXAMPLE-4242' https://internal.example/x";

const WALK: Script = [
  [0.2, said("Let me look at the repo.")],
  [0.4, tool("bash", "start")],
  [2.0, tool("bash", "success")],
  [2.2, said("Now checking the tests.")],
  [2.4, tool("grep", "start")],
  [4.0, tool("grep", "success")],
  [4.2, said("All green: 42 tests pass.")],
  [4.3, end()],
];

const isUpdate = (s: Sent): boolean => s.operation === "update";

it("test_one_to_one_shows_narration_and_tools_live_and_ends_with_only_the_final_text", async () => {
  const run = await play(WALK);
  assert.equal(run.final, "All green: 42 tests pass.");
  assert.deepEqual(run.told, ["started", "delivered"]);
  assert.ok(run.progress.length >= 2);
  assert.ok(run.progress.every(([, text]) => text.startsWith(LIVE_HEADER)));
  const seen = run.progress.map(([, text]) => text).join("\n");
  for (const expected of [
    "Let me look at the repo.",
    "⏳ Running a command",
    "Now checking the tests.",
    "⏳ Searching files",
  ]) {
    assert.ok(seen.includes(expected), expected);
  }
  // the newest progress edit already carries the second narration; a finished tool leaves no line behind
  const last = run.progress.at(-1)?.[1] ?? "";
  assert.ok(last.includes("Now checking the tests.") && !run.bus.everything().includes("Finished"));
  // the progress message is posted once and is the only message ever edited; the answer is a new message after which
  // the progress message is deleted, so the user is left with the answer alone
  const posts = run.bus.sent.filter((s) => s.operation === "send" && textOf(s.message));
  assert.deepEqual(
    posts.map((s) => textOf(s.message)),
    [LIVE_HEADER, run.final],
  );
  assert.deepEqual(new Set(run.bus.sent.filter(isUpdate).map((s) => s.activityId)), new Set(["teams-2"]));
  assert.deepEqual(run.texts, [run.final]);
  assert.deepEqual(
    run.bus.sent.filter((s) => s.operation === "delete").map((s) => s.activityId),
    ["teams-2"],
  );
  // earlier narration and tool lines are gone from the answer
  assert.ok(!run.final.includes("Let me look") && !run.final.includes("Running") && !run.final.includes(LIVE_HEADER));
});

it("test_a_running_tool_line_goes_away_when_the_tool_finishes", () => {
  const view = new LiveView();
  view.apply({ tool: ["bash", "start"] });
  assert.equal(view.render(), `${LIVE_HEADER}\n\n⏳ Running a command`);
  view.apply({ tool: ["bash", "success"] });
  assert.equal(view.render(), LIVE_HEADER); // nothing says "Finished bash"; a step that went well leaves no line
});

{
  const cases: Array<[string, Script, string[], string]> = [
    [
      "thinking blocks in an assistant message",
      [
        [
          0.2,
          ev("AssistantMessage", "m1", {
            data: {
              content: [
                { type: "thinking", thinking: "PLAN-SECRET-A" },
                { type: "text", text: "Visible one." },
              ],
            },
          }),
        ],
        [2.0, tool("bash", "start")],
        [3.8, tool("bash", "success")],
        [4.0, said("Final.")],
        [4.1, end()],
      ],
      ["PLAN-SECRET-A"],
      "Visible one.",
    ],
    [
      "a thinking event of its own",
      [
        [0.2, said("Visible two.")],
        [0.3, ev("ThinkingMessage", "m1", { data: { content: [{ type: "thinking", thinking: "PLAN-SECRET-B" }] } })],
        [2.0, tool("bash", "start")],
        [4.0, said("Final.")],
        [4.1, end()],
      ],
      ["PLAN-SECRET-B"],
      "Visible two.",
    ],
    [
      "subagent text",
      [
        [0.2, said("Visible three.")],
        [
          0.3,
          ev("AssistantMessage", "m1", { subagent_id: "s1", data: { content: [{ type: "text", text: "SUB-TEXT" }] } }),
        ],
        [2.0, tool("bash", "start")],
        [4.0, said("Final.")],
        [4.1, end()],
      ],
      ["SUB-TEXT"],
      "Visible three.",
    ],
    [
      "tool inputs",
      [
        [0.2, said("Visible four.")],
        [0.3, tool("bash", "start", { input: { command: SECRET_INPUT } })],
        [2.0, tool("bash", "success", { input: { command: SECRET_INPUT }, output: SECRET_INPUT })],
        [4.0, said("Final.")],
        [4.1, end()],
      ],
      ["sk-EXAMPLE-4242", "internal.example", "Authorization"],
      "Visible four.",
    ],
    [
      "a live status line that may carry reasoning",
      [
        [0.2, said("Visible five.")],
        [0.3, ev("liveStatus", "m1", { text: "PLAN-SECRET-C" })],
        [2.0, tool("bash", "start")],
        [4.0, said("Final.")],
        [4.1, end()],
      ],
      ["PLAN-SECRET-C"],
      "Visible five.",
    ],
  ];
  it("test_what_must_not_be_shown_never_appears_in_any_update", async () => {
    for (const [name, script, forbidden, shown] of cases) {
      const run = await play(script);
      assert.ok(
        run.progress
          .map(([, text]) => text)
          .join("\n")
          .includes(shown),
        name,
      );
      for (const text of forbidden) assert.ok(!run.bus.everything().includes(text), `${name}: ${text}`);
      assert.equal(run.final, "Final.");
    }
  });
}

it("test_updates_are_throttled_and_the_newest_view_wins", async () => {
  const script: Script = [
    ...Array.from({ length: 30 }, (_, i) => [0.1 * (i + 1), tool(`tool${String(i + 1)}`, "success")] as const),
    [3.2, said("Done.")],
    [3.3, end()],
  ];
  const run = await play(script);
  const times = run.progress.map(([t]) => t);
  assert.ok(times.length >= 1 && times.length <= 3); // 3.2 simulated seconds at one edit per 1.5 s
  for (let i = 1; i < times.length; i += 1) assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= 1.5 - 1e-9); // literal: 1.5 s
  assert.ok((times[0] ?? 0) >= 1.5 - 1e-9); // not right after the "Working on it..." post either
  assert.ok(!(run.progress[0]?.[1] ?? "").includes("tool30") && run.final === "Done.");
});

it("test_a_coalesced_update_is_sent_when_the_interval_ends_not_when_the_next_event_comes", async () => {
  const run = await play([
    [0.1, said("First thought.")],
    [60.0, said("Done.")],
    [60.1, end()],
  ]);
  const [at, text] = run.progress[0] ?? [0, ""];
  assert.ok(text.includes("First thought.") && at < 3); // about 1.5 s in, not at the 60 s event
});

it("test_the_answer_is_never_dropped_or_overtaken_by_a_progress_edit", async () => {
  const run = await play([
    [0.1, said("Thinking out loud.")],
    [1.6, tool("bash", "start")],
    [1.7, said("Done.")],
    [1.8, end()],
  ]);
  assert.deepEqual(run.texts, ["Done."]);
  const lastProgressAt = run.progress.at(-1)?.[0] ?? 0;
  // the answer is a new message, so it needs no wait; it is the progress message that goes, a second after its last edit
  const deleted = run.bus.sent.flatMap((s, i) => (s.operation === "delete" ? [run.bus.at[i] ?? 0] : []));
  assert.equal(deleted.length, 1);
  assert.ok((deleted[0] ?? 0) >= lastProgressAt + 1.0 - 1e-9 && run.bus.sent.at(-1)?.operation === "delete");
  assert.deepEqual(
    run.bus.at,
    [...run.bus.at].sort((a, b) => a - b),
  );
});

{
  const cases: Array<[string, (s: Sent) => boolean]> = [
    ["every edit fails", isUpdate],
    ["only the progress edits fail", (s) => isUpdate(s) && !textOf(s.message).includes("Done.")],
  ];
  it("test_a_failed_edit_does_not_fail_the_turn", async () => {
    for (const [name, fail] of cases) {
      const run = await play([...WALK.slice(0, -2), [4.2, said("Done.")], [4.3, end()]], { bus: { fail } });
      assert.deepEqual(run.told, ["started", "delivered"], name);
      const answers = run.bus.sent.filter((s) => textOf(s.message) === "Done.");
      // one message carries the answer, and it is a new message whatever happens to the edits
      assert.deepEqual(
        answers.map((s) => s.operation),
        ["send"],
        name,
      );
      assert.equal(run.final, "Done.", name);
    }
  });
}

it("test_a_failed_progress_edit_does_not_stop_the_later_ones", async () => {
  const failures: Sent[] = [];
  const first = (s: Sent): boolean => {
    if (isUpdate(s) && failures.length === 0 && !textOf(s.message).includes("Done.")) {
      failures.push(s);
      return true;
    }
    return false;
  };
  const run = await play(WALK, { bus: { fail: first } });
  assert.ok(failures.length === 1 && run.progress.length >= 1);
  assert.ok((run.progress.at(-1)?.[1] ?? "").includes("Now checking the tests."));
  assert.equal(run.final, "All green: 42 tests pass.");
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_a_late_progress_edit_cannot_leave_the_progress_view_as_the_last_word", async () => {
  // A progress edit the queue holds back arrives after the progress message was edited down: the queue cannot delete
  // it (it is left as one line), and the repeated edit puts that line back.
  const run = await play(WALK, {
    bus: {
      delay: (s) => (isUpdate(s) && textOf(s.message).startsWith(LIVE_HEADER) ? 4.0 : 0),
      fail: (s) => s.operation === "delete",
    },
  });
  const late = run.bus.sent.flatMap((s, i) =>
    isUpdate(s) && textOf(s.message).startsWith(LIVE_HEADER) ? [run.bus.at[i] ?? 0] : [],
  );
  const doneAt = Math.min(
    ...run.bus.sent.flatMap((s, i) => (textOf(s.message) === DONE_LINE ? [run.bus.at[i] ?? 0] : [])),
  );
  assert.ok(late.some((t) => t > doneAt)); // the setup really does let a progress edit land on top of the one line
  assert.equal(run.bus.shown.get("teams-2"), DONE_LINE);
  assert.deepEqual(run.texts, [DONE_LINE, "All green: 42 tests pass."]); // and the answer is still there, below it
});

it("test_a_turn_without_live_edits_sends_the_answer_as_a_new_message_and_edits_nothing", async () => {
  const run = await play([
    [0.2, said("Done.")],
    [0.3, end()],
  ]);
  assert.equal(run.bus.sent.filter(isUpdate).length, 0);
  assert.equal(run.bus.sent.filter((s) => s.operation === "delete").length, 1);
  assert.deepEqual(run.texts, ["Done."]);
});

it("test_no_live_edit_lands_after_the_turn_is_cancelled", async () => {
  const w = setUpWorld(
    [
      [0.1, said("one")],
      [2.0, said("two")],
      [2.1, said("three")],
    ],
    { hang: true },
  );
  const cancel = new AbortController();
  const turn = runTurn(w.ctx, { onSession: () => undefined, stopRequested: () => false, signal: cancel.signal });
  const outcome = turn.then(
    () => "resolved",
    (err: unknown) => err,
  );
  await w.clock.advanceTo(w.clock.start + 2.1);
  const lastText = textOf(w.bus.sent.at(-1)?.message);
  assert.ok(lastText.split("one").length - 1 === 1 && !lastText.includes("three"));
  const sentBefore = w.bus.sent.length;
  cancel.abort(new Error("cancelled"));
  assert.notEqual(await w.clock.pump(outcome), "resolved");
  await w.clock.drain();
  assert.equal(w.bus.sent.length, sentBefore);
  assert.equal(w.told.at(-1), "failed");
  assert.ok(quiet(w));
});

it("test_a_flusher_that_is_mid_send_when_the_turn_is_cancelled_does_not_outlive_it", async () => {
  const w = setUpWorld([[0.1, said("one")]], { hang: true });
  const real = w.bus.publish;
  w.bus.publish = async (s) => {
    if (isUpdate(s)) await w.clock.sleep(5000); // a queue that takes 5 s to accept a progress edit
    return real(s);
  };
  const cancel = new AbortController();
  const outcome = runTurn(w.ctx, {
    onSession: () => undefined,
    stopRequested: () => false,
    signal: cancel.signal,
  }).then(
    () => "resolved",
    (err: unknown) => err,
  );
  await w.clock.advanceTo(w.clock.start + 1.5);
  assert.equal(w.bus.sent.filter(isUpdate).length, 0);
  cancel.abort(new Error("cancelled"));
  assert.notEqual(await w.clock.pump(outcome), "resolved");
  await w.clock.drain();
  assert.equal(w.bus.sent.filter(isUpdate).length, 0);
  assert.ok(quiet(w));
});

{
  const cases: Array<[string, Step[], (out: string) => boolean]> = [
    [
      "one huge narration keeps its end",
      [{ narration: `${"x".repeat(9000)}THE-END` }],
      (out) => out.endsWith("THE-END"),
    ],
    [
      "many narrations keep the newest",
      Array.from({ length: 60 }, (_, i) => ({ narration: `paragraph ${String(i)} ${"y".repeat(300)}` })),
      (out) => out.includes("paragraph 59") && !out.includes("paragraph 0 "),
    ],
    [
      "a cut code block stays balanced",
      [{ narration: `\`\`\`\n${"code line\n".repeat(600)}\`\`\`\nafter` }],
      (out) => (out.split("```").length - 1) % 2 === 0,
    ],
    [
      "a long turn keeps a bounded number of blocks",
      Array.from({ length: 500 }, (_, i): Step => ({ tool: [`t${String(i)}`, "error"] })),
      (out) => out.includes("t499") && !out.includes("t0 "),
    ],
  ];
  it("test_the_live_view_is_bounded_and_readable", () => {
    for (const [name, steps, ok] of cases) {
      const view = new LiveView();
      for (const step of steps) view.apply(step);
      const out = view.render();
      assert.ok(out.startsWith(LIVE_HEADER) && Array.from(out).length <= LIVE_MAX_CHARS + 200, name);
      assert.ok(ok(out), name);
    }
  });
}

it("test_a_group_chat_gets_the_same_live_view_and_answer_as_a_1to1_chat", async () => {
  const group = await play(WALK, { request: { group: true } });
  const one = await play(WALK);
  assert.deepEqual(group.progress, one.progress);
  assert.deepEqual(group.texts, ["All green: 42 tests pass."]);
  assert.deepEqual(one.texts, group.texts);
  assert.ok(group.progress.length >= 2 && group.bus.everything().includes("Let me look at the repo.")); // the narration is shown
  assert.deepEqual(group.told, ["started", "delivered"]);
});

it("test_a_group_progress_edit_that_fails_does_not_fail_the_turn", async () => {
  const run = await play(WALK, { request: { group: true }, bus: { fail: isUpdate } });
  assert.deepEqual(run.told, ["started", "delivered"]);
  const answers = run.bus.sent.filter((s) => textOf(s.message) === "All green: 42 tests pass.");
  assert.ok(answers.length === 1 && run.final === "All green: 42 tests pass.");
});

it("test_the_throttle_counts_from_when_a_slow_edit_finished_not_from_when_it_began", async () => {
  const starts: number[] = [];
  const run = await play(
    [
      [0.1, said("one")],
      [2.0, said("two")],
      [30.0, said("Done.")],
      [30.1, end()],
    ],
    {
      setUp: (w) => {
        const real = w.bus.publish;
        w.bus.publish = async (s) => {
          if (isUpdate(s) && textOf(s.message).startsWith(LIVE_HEADER)) {
            starts.push(w.clock.elapsed);
            await w.clock.sleep(4000); // a queue that takes 4 s to accept a progress edit
          }
          return real(s);
        };
      },
    },
  );
  assert.equal(run.final, "Done.");
  assert.ok(starts.length >= 2 && (starts[1] ?? 0) - (starts[0] ?? 0) >= 4 + 1.5 - 1e-9); // literal: 4 s, then 1.5 s
});

it("test_a_pending_repeat_of_the_done_line_is_cancelled_with_the_turn", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock, { fail: (s) => s.operation === "delete" }); // (it cannot delete: edited down instead)
  const status = new StatusMessage(bus, { clock, log: new RecordingLogger() });
  status.begin();
  status.progress({ narration: "one" });
  await clock.advanceTo(clock.start + 1.5);
  await clock.pump(status.finish(["the answer"]));
  const edits = bus.sent.filter(isUpdate).length;
  assert.equal(edits, 2); // the live view and the one line; the repeat is waiting
  status.close(true);
  await clock.drain();
  assert.equal(bus.sent.filter(isUpdate).length, edits);
});
