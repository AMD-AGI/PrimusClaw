// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn's state on the paths the ported tests do not reach (a queued turn found in a replay, events that are not this
 * turn's), the last answer read from the stream, the fallback model's failures that are not Claw's, the stand-ins for
 * other lines' helpers, and the note view.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawUnreachable } from "../../src/claw/errors.js";
import { noteMessage } from "../../src/note/note.js";
import { lastAnswer } from "../../src/turn/last-answer.js";
import { LiveView } from "../../src/turn/live-view.js";
import { planHead } from "../../src/turn/plan.js";
import { TurnState } from "../../src/turn/turn-state.js";
import { clipPrSummary, looksLikeFailure, serviceRefusal, splitErrorTail } from "../../src/turn/upstream.js";
import { fakeRefusals, RAW403 } from "./fake-refusals.js";
import { play } from "./play.js";
import { Timeline } from "./timeline.js";
import { ev, RecordingErrors, RecordingLogger, result, said, ScriptedClaw } from "./world.js";

it("a queued turn is the first queue-run turn after the one in front of it, replayed or live, never an older one", () => {
  const state = new TurnState(undefined, "claw-5");
  state.feed(ev("toolUsed", "claw-pending-3", { tool: "x", status: "start" })); // before `behind`: an older turn
  state.feed(ev("toolUsed", null, { tool: "x", status: "start" })); // no turn named
  state.feed(ev("toolUsed", "claw-5", { tool: "x", status: "start" })); // the turn in front
  state.feed(ev("toolUsed", "claw-pending-3", { tool: "x", status: "start" })); // replayed before it: still not this one
  assert.equal(state.messageId, undefined);
  state.feed(ev("toolUsed", "m-not-queued", { tool: "x", status: "start" }));
  assert.equal(state.messageId, undefined);
  const step = state.feed(said("mine", "claw-pending-4"));
  assert.equal(state.messageId, "claw-pending-4");
  assert.deepEqual(step, { narration: "mine" });
  const first = new TurnState(undefined, undefined, true);
  first.feed(ev("toolUsed", "claw-pending-1", { tool: "x", status: "start" }));
  assert.equal(first.messageId, "claw-pending-1");
});

it("an event of no turn after this one started is this turn's; an empty request or a subagent's text is nothing", () => {
  const state = new TurnState("m1");
  assert.deepEqual(state.feed(ev("permissionRequest", null)), {}); // not started yet: not this turn's
  state.feed(ev("toolUsed", "m1", { tool: "bash", status: "start" }));
  assert.deepEqual(state.feed({ id: "", name: "permissionRequest", data: {} }), {});
  assert.deepEqual(state.feed({ id: "", name: "userQuestion", data: {} }), {});
  assert.deepEqual(state.feed(ev("userQuestion", null, { actionId: "a" })), { question: { actionId: "a" } });
  assert.deepEqual(
    state.feed(ev("AssistantMessage", "m1", { subagent_id: "s", data: { content: [{ type: "text", text: "sub" }] } })),
    {},
  );
  assert.deepEqual(state.feed(ev("statusUpdate", "m1", { agentStatus: "running" })), {});
  assert.deepEqual(state.feed(ev("chatDelta", "m1", { delta: { content: "" } })), {});
  state.feed(
    ev("toolUsed", "m1", {
      tool: "gh_review_submit",
      status: "success",
      description: '{"status": "submitted", "comments": 2, "pr_summary": "Fixes it"}',
    }),
  );
  assert.deepEqual([state.comments, state.prSummary, state.writes.length], [2, "Fixes it", 1]);
  const refusing = new TurnState("m1", undefined, false, fakeRefusals);
  assert.deepEqual(refusing.feed(said(RAW403)), {}); // a refusal of the model call is no progress
  assert.equal(refusing.text, RAW403);
});

it("a final text of the result's own wins over the last thing said", () => {
  const state = new TurnState("m1");
  state.feed(said("narration"));
  state.feed(ev("ResultMessage", "m1", { data: { subtype: "success", result: "from result" } }));
  assert.equal(state.answer, "from result");
  assert.equal(state.failed, false);
});

function deps(claw: ScriptedClaw, clock: Timeline) {
  return { claw, clock, log: new RecordingLogger(), errors: new RecordingErrors() };
}

it("the last answer read from the stream stops when the history goes quiet after a finished turn", async () => {
  const clock = new Timeline();
  const claw = new ScriptedClaw(clock, [
    [0.1, said("first", "a")],
    [0.2, result("the answer", "a")],
  ]);
  claw.hang = true;
  claw.rows = new ClawUnreachable("timeout", "replay");
  assert.equal(await clock.pump(lastAnswer(deps(claw, clock), "ak", "s1")), "the answer");
});

it("a stream that never finishes a turn is read for twenty seconds at most and has no last answer", async () => {
  const clock = new Timeline();
  const claw = new ScriptedClaw(clock, [[0.1, said("still going", "a")]]);
  claw.hang = true;
  claw.rows = new ClawUnreachable("network", "replay");
  assert.equal(await clock.pump(lastAnswer(deps(claw, clock), "ak", "s1")), undefined);
  assert.ok(clock.elapsed >= 20);
});

it("a last answer that ended in Brain's error keeps the model's words and says the task failed", async () => {
  const clock = new Timeline();
  const claw = new ScriptedClaw(clock);
  const failed = { message_id: "a", data: { subtype: "error" }, final_text: "Half done.\n\nAPI Error: 500 upstream" };
  claw.rows = [{ event_id: "1", event_type: "ResultMessage", data: failed }];
  const d = deps(claw, clock);
  assert.equal(
    await clock.pump(lastAnswer(d, "ak", "s1")),
    "Half done.\n\nThe task ran into an error and did not finish. Reply /feedback to tell the PrimusClaw team.",
  );
  assert.deepEqual(
    d.errors.withheld.map((w) => w.where),
    ["last_answer_failed"],
  );
  claw.rows = [{ event_id: "1", event_type: "ResultMessage", data: { ...failed, final_text: "API Error: 500 x" } }];
  assert.ok((await clock.pump(lastAnswer(deps(claw, clock), "ak", "s1")))?.startsWith("The task ran into an error"));
  claw.rows = [{ event_id: "1", event_type: "ResultMessage", data: { ...failed, final_text: "just failed" } }];
  assert.equal(await clock.pump(lastAnswer(deps(claw, clock), "ak", "s1")), "just failed");
  claw.rows = new TypeError("a bug");
  await assert.rejects(clock.pump(lastAnswer(deps(claw, clock), "ak", "s1")), TypeError);
});

it("a fallback the session cannot be moved to for a reason that is not Claw's fails the turn as a crash", async () => {
  await assert.rejects(
    play([], {
      refusals: fakeRefusals,
      sessionId: "s1",
      request: { model: "main", fallbackModel: "backup" },
      setUp: (w) => {
        w.claw.scripts = () => [
          [0.1, said(RAW403, "m2")],
          [0.2, ev("statusUpdate", "m2", { agentStatus: "failed" })],
        ];
        w.claw.setModel = (_k, _s, model) =>
          model === "backup" ? Promise.reject(new TypeError("bug")) : Promise.resolve();
      },
    }),
    TypeError,
  );
});

it("a fallback turn Claw queued is followed as a queued turn and the session goes back on its model", async () => {
  const run = await play([], {
    refusals: fakeRefusals,
    sessionId: "s1",
    request: { model: "main", fallbackModel: "backup" },
    setUp: (w) => {
      let n = 0;
      const send = w.claw.sendMessage.bind(w.claw);
      w.claw.sendMessage = (...args) => (n++ === 0 ? send(...args) : Promise.resolve(null));
      w.claw.scripts = (attempt) =>
        attempt === 0
          ? [
              [0.1, said(RAW403, "m2")],
              [0.2, ev("statusUpdate", "m2", { agentStatus: "failed" })],
            ]
          : [
              [0.3, ev("historyComplete", null, { type: "historyComplete", count: 0, has_more: false })],
              [0.4, result("backup answer", "claw-pending-2")],
            ];
    },
  });
  assert.ok(run.final.endsWith("backup answer"));
  assert.deepEqual(
    run.claw.calls.filter((c) => c[0] === "set_model").map((c) => c[3]),
    ["main", "backup", "main"],
  );
});

it("a session that cannot be put back on its model for a reason that is not Claw's fails the turn as a crash", async () => {
  await assert.rejects(
    play([], {
      refusals: fakeRefusals,
      sessionId: "s1",
      sessionModel: "main",
      request: { model: "main", fallbackModel: "backup" },
      setUp: (w) => {
        w.claw.scripts = (attempt) =>
          attempt === 0
            ? [
                [0.1, said(RAW403, "m2")],
                [0.2, ev("statusUpdate", "m2", { agentStatus: "failed" })],
              ]
            : [[0.3, result("backup answer", "m2")]];
        w.claw.setModel = (_k, _s, model) =>
          model === "main" ? Promise.reject(new TypeError("bug")) : Promise.resolve();
      },
    }),
    TypeError,
  );
});

it("the stand-ins: a refusal word Claw does not name reads as the last one, a summary is one clipped line", () => {
  assert.equal(
    serviceRefusal("unknown_word", "Nothing."),
    "PrimusClaw says this answer is not yours to give. Nothing.",
  );
  assert.equal(clipPrSummary(5), "");
  assert.equal(clipPrSummary("  "), "");
  assert.equal(clipPrSummary("中".repeat(100)), `${"中".repeat(79)}…`);
  assert.equal(clipPrSummary("a".repeat(200)).length, 160);
  assert.equal(looksLikeFailure(5), false);
  assert.equal(looksLikeFailure("API Error: 500 boom"), true);
  assert.deepEqual(splitErrorTail(5), ["", ""]);
  assert.deepEqual(splitErrorTail("words\n\nmore\n\nAPI Error: 500 x\n\ntail"), [
    "words\n\nmore",
    "API Error: 500 x\n\ntail",
  ]);
  assert.deepEqual(splitErrorTail("just words"), ["just words", ""]);
});

it("the plan's count is a status line in a 1:1 chat, with the agent's newest words, and none in a group", () => {
  const view = new LiveView("zh");
  view.apply({
    todos: [
      ["读", "completed"],
      ["写", "pending"],
      ["删", "cancelled"],
    ],
    tool: ["todo_write", "success"],
  });
  view.apply({ narration: "**Now** `writing`" });
  assert.deepEqual(view.statusLines(true), ["计划：已完成 1/2", "Now writing"]);
  assert.deepEqual(view.statusLines(false), []);
  assert.equal(planHead("en", 1, 2), "**Plan: 1 of 2 done**");
});

it("a note is a view message whose fallback is its text", () => {
  assert.deepEqual(noteMessage({ text: "Gone.", title: "T" }), {
    body: { type: "view", view: { name: "note", model: { text: "Gone.", title: "T" } }, fallbackText: "Gone." },
  });
});
