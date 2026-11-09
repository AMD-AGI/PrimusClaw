// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn replies the way the chat's own agents do (test_reply_style.py, the turn's side): a floating status while it runs
 * and the answer as the stream's final message, the AI label on what an agent wrote, suggested replies, text streamed
 * into the bubble. Every one of them degrades to the plain messages of before, never to silence. How the Teams adapter
 * paces a stream (a request a second), retries a refused final without its decorations and keeps one stream per
 * conversation is the adapter's own (W3).
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { SUGGESTED_REPLIES, turnText } from "../../src/locales/turn.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { LIVE_HEADER } from "../../src/turn/live-view.js";
import { LIVE_MIN_INTERVAL, StatusMessage } from "../../src/turn/progress/status-message.js";
import { statusText } from "../../src/turn/progress/status-text.js";
import { play, type PlayOptions, type Run } from "./play.js";
import { Timeline } from "./timeline.js";
import { Bus, end, ev, RecordingLogger, said, type Script, type StreamOp, textOf, tool } from "./world.js";

const USER_MESSAGE = "user-msg-1";
const NARRATION = "Looking at Alice Chen's salary review in hr/2026/alice.xlsx."; // personal: never in a group's status

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

interface StreamRun extends Run {
  readonly ops: readonly StreamOp[];
  readonly replyTos: string[];
  /** Every stream request tried, taken or refused. */
  readonly tried: StreamOp[];
}

/** One turn shown by a live stream that answers the user's message (unless `stream: false`). */
async function turn(
  script: Script,
  options: PlayOptions & {
    readonly stream?: boolean;
    readonly refuse?: (op: StreamOp, n: number) => number | undefined;
  } = {},
): Promise<StreamRun> {
  const replyTos: string[] = [];
  const tried: StreamOp[] = [];
  const run = await play(script, {
    ...options,
    request: { ...(options.stream === false ? {} : { streamReplyTo: USER_MESSAGE }), ...options.request },
    bus: {
      ...options.bus,
      stream: {
        refuse: (op) => {
          tried.push(op);
          return options.refuse?.(op, tried.length);
        },
      },
    },
    setUp: (w) => {
      const open = w.bus.openStream.bind(w.bus);
      w.bus.openStream = (replyTo, status) => {
        replyTos.push(replyTo);
        return open(replyTo, status);
      };
      options.setUp?.(w);
    },
  });
  return { ...run, ops: run.bus.streamOps, replyTos, tried };
}

const informs = (run: StreamRun): string[] => run.ops.filter((o) => o.op === "inform").map((o) => o.text);
const finals = (run: StreamRun): StreamOp[] => run.ops.filter((o) => o.op === "finish");
const plainMessages = (run: StreamRun): OutMessage[] =>
  run.bus.sent.flatMap((s) => (s.operation === "send" && s.kind === "message" && s.message ? [s.message] : []));

function finalOf(run: StreamRun): OutMessage {
  const [final, ...more] = finals(run);
  assert.ok(final?.message && more.length === 0, `one final, not ${String(finals(run).length)}`);
  return final.message;
}

it("test_a_turn_shows_teams_floating_status_and_ends_with_the_answer_as_the_streams_final_message", async () => {
  const run = await turn(WALK);
  const [first] = run.ops;
  assert.ok(first?.op === "open" && first.text === "Thinking…" && run.replyTos[0] === USER_MESSAGE);
  const shown = informs(run).join(" | ");
  for (const line of ["Let me look at the repo.", "⏳ Running a command", "⏳ Searching files"]) {
    assert.ok(shown.includes(line), line);
  }
  const final = finalOf(run);
  assert.ok(textOf(final).includes("All green: 42 tests pass."));
  assert.equal(final.feedback, true); // the chat's thumbs under the answer
  assert.equal(final.aiGenerated, true);
  // nothing else reached the chat: no "Working on it..." message, no edit, no delete, no bare typing indicator
  assert.deepEqual(run.bus.sent, []);
  assert.ok(!run.bus.everything().includes(LIVE_HEADER));
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_the_status_never_exceeds_one_request_a_second_however_fast_the_agent_goes", async () => {
  const names = ["bash", "grep", "read", "web_fetch"];
  const burst: Script = Array.from({ length: 100 }, (_, k) => {
    const i = k + 1;
    const name = names[k % 4] ?? "bash";
    return [0.1 * i, tool(name, i % 2 ? "start" : "success", { actionId: `a${String(Math.floor(i / 2))}` })] as const;
  });
  const run = await turn([...burst, [10.3, said("Done.")], [10.4, end()]]);
  const updates = run.ops.filter((o) => o.op === "inform").map((o) => o.at);
  assert.ok(run.ops.length >= 4);
  for (let i = 1; i < updates.length; i += 1) {
    assert.ok((updates[i] ?? 0) - (updates[i - 1] ?? 0) >= LIVE_MIN_INTERVAL - 1e-9, String(updates));
  }
  assert.ok(updates.length <= 10.4 / LIVE_MIN_INTERVAL + 2); // 100 events, coalesced
  assert.ok(textOf(finalOf(run)).includes("Done."));
});

it("test_a_long_turn_closes_its_stream_before_teams_limit_and_the_answer_follows_as_a_message", async () => {
  const run = await turn(
    [
      [0.2, said("Starting a long build.")],
      [1.0, tool("bash", "start")],
      [700.0, tool("bash", "success")],
      [720.0, said("The build passed.")],
      [720.5, end()],
    ],
    { request: { lang: "zh" } },
  );
  const [final] = finals(run);
  assert.ok(final && finals(run).length === 1);
  assert.ok(final.at >= 530 && final.at <= 541, String(final.at));
  assert.equal(final.text, turnText.in("zh").stillWorking);
  assert.equal(final.text, "仍在处理，完成后另发结果。");
  assert.ok(run.ops.every((o) => o.at <= 541)); // nothing on the stream after it was closed
  const [answer, ...more] = plainMessages(run);
  assert.ok(answer && more.length === 0 && textOf(answer).includes("The build passed.") && answer.aiGenerated === true);
  assert.deepEqual(run.told, ["started", "delivered"]);
});

it("test_a_stream_teams_refuses_falls_back_to_the_progress_message_and_the_answer_still_comes", async () => {
  // a refused opening: 403 ContentStreamNotAllowed, 429, a 2xx without the stream's id, 500
  for (const status of [403, 429, 200, 500]) {
    const run = await turn(WALK, { refuse: (op) => (op.op === "open" ? status : undefined) });
    assert.equal(run.tried.length, 1, String(status)); // the refused opening, and no stream request after it
    const posted = run.bus.sent
      .filter((s) => s.operation === "send" && s.kind === "message")
      .map((s) => textOf(s.message));
    assert.equal(posted[0], LIVE_HEADER, String(status));
    assert.ok(posted.at(-1)?.includes("All green: 42 tests pass."), String(status));
    assert.ok(run.bus.sent.some((s) => s.operation === "update") && run.bus.sent.some((s) => s.operation === "delete"));
    assert.deepEqual(run.told, ["started", "delivered"]);
  }
});

it("test_a_final_teams_refuses_is_sent_as_an_ordinary_message", async () => {
  const run = await turn(WALK, { refuse: (op) => (op.op === "finish" ? 403 : undefined) });
  const [answer, ...more] = plainMessages(run);
  assert.ok(answer && more.length === 0);
  assert.ok(textOf(answer).includes("All green: 42 tests pass.") && answer.feedback === true);
});

it("test_a_status_update_teams_refuses_hands_over_to_the_progress_message_and_the_stream_is_still_closed", async () => {
  for (const finalToo of [false, true]) {
    const run = await turn(WALK, {
      // the stream's second request (its first status update after the opening), and with `finalToo` its final
      refuse: (op, n) => (n === 2 || (finalToo && op.op === "finish") ? 403 : undefined),
    });
    const posted = plainMessages(run).map(textOf);
    assert.ok(posted[0]?.startsWith(LIVE_HEADER), String(finalToo)); // the progress message took over
    assert.ok(run.bus.sent.some((s) => s.operation === "delete")); // ... and is retired once the answer is there
    if (finalToo) {
      // the stream could not be closed: the answer is a message of its own
      assert.ok(posted.at(-1)?.includes("All green: 42 tests pass."));
      assert.equal(run.tried.filter((o) => o.op === "finish").length, 1);
    } else {
      // the stream is closed with the answer, in the status's place
      assert.ok(textOf(finalOf(run)).includes("All green: 42 tests pass."));
      assert.ok(!posted.some((t) => t.includes("All green")));
    }
  }
});

it("test_the_queue_keeps_the_progress_message_of_before", async () => {
  // no stream for this chat (Python: the queue cannot carry one): the bare typing indicator and the progress message
  const run = await turn(WALK, { stream: false });
  assert.equal(run.bus.sent[0]?.kind, "typing");
  const texts = run.bus.sent.slice(1).map((s) => textOf(s.message));
  assert.equal(texts[0], LIVE_HEADER);
  assert.ok(run.tried.length === 0 && run.ops.length === 0);
  assert.ok(run.bus.sent.some((s) => s.operation === "update"));
  assert.ok(texts.some((t) => t.includes("All green: 42 tests pass.")));
});

it("test_a_group_turn_streams_in_reply_to_the_message_and_its_status_carries_none_of_the_agents_words", async () => {
  const run = await turn(
    [
      [0.2, said(NARRATION)],
      [
        0.3,
        ev("toolUsed", "m1", {
          tool: "todo_write",
          status: "success",
          argumentsDetail: { todo_write: { todos: [{ content: "Ask Alice", status: "pending" }] } },
        }),
      ],
      [0.4, tool("read", "start")],
      [3.0, tool("read", "success")],
      [3.2, said("Summary: on track.")],
      [3.3, end()],
    ],
    { request: { group: true } },
  );
  assert.ok(run.replyTos.length > 0 && run.replyTos.every((r) => r === USER_MESSAGE));
  const status = [run.ops[0]?.text ?? "", ...informs(run)].join(" ");
  assert.ok(!status.includes("Alice") && !status.includes("salary") && !status.includes("Plan"));
  assert.ok(status.includes("⏳ Reading a file"));
  const final = finalOf(run);
  assert.ok(textOf(final).includes("Summary: on track.") && final.suggestions === undefined); // (none in a group)
});

it("test_the_informative_text_is_cut_to_teams_limits_keeping_the_newest", () => {
  const lines = ["old ".repeat(200), "x".repeat(500), "最新的一步：读取文件"];
  const text = statusText(lines);
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  assert.ok(Array.from(text).length <= 1000 && bytes(text) <= 1024);
  assert.ok(text.startsWith("…") && text.endsWith("最新的一步：读取文件"));
  const wide = statusText(["字".repeat(900)]);
  assert.ok(bytes(wide) <= 1024 && wide.endsWith("字"));
  assert.equal(statusText(["a\n b", "", "c"]), "a b · c");
});

it("test_a_chat_turns_links_stay_links_and_its_label_is_one_root_entity_teams_takes", async () => {
  // A link an agent wrote is an address the model chose, not a source: it stays a link and gets no citation. (That the
  // label is one root entity Teams takes is the adapter's.)
  const run = await turn([
    [0.2, said("See [the PR](https://github.com/o/r/pull/1) and [the run](https://ci.test/r/2).")],
    [0.3, end()],
  ]);
  const final = finalOf(run);
  assert.equal(final.aiGenerated, true);
  assert.equal(final.citations, undefined);
  assert.ok(!textOf(final).includes("[1]") && textOf(final).includes("https://github.com/o/r/pull/1"));
});

it("test_only_what_an_agent_wrote_carries_the_label", async () => {
  const failed = await turn([[0.2, ev("error")]], { stream: false });
  assert.ok(!plainMessages(failed).some((m) => m.aiGenerated));
  const plain = await turn(WALK, { stream: false });
  const posted = plainMessages(plain);
  const labelled = posted.filter((m) => m.aiGenerated);
  assert.deepEqual(labelled.map(textOf), [textOf(posted.at(-1) ?? { body: { type: "text", text: "" } })]);
  assert.ok(textOf(labelled[0] ?? { body: { type: "text", text: "" } }).includes("All green"));
  // (TEAMS_AI_LABEL off: the adapter drops the label; the turn still says what an agent wrote)
});

it("test_a_finished_1on1_answer_offers_three_replies_and_the_switch_takes_them_away", async () => {
  const run = await turn(WALK, { request: { lang: "zh" } });
  assert.deepEqual(
    finalOf(run).suggestions,
    SUGGESTED_REPLIES.zh.map(([title, value]) => ({ title, value })),
  );
  const off = await turn(WALK, { style: { suggestedReplies: false } });
  assert.equal(finalOf(off).suggestions, undefined);
  const failed = await turn([
    [0.2, said("Half way.")],
    [0.3, ev("error")],
  ]);
  const shown = [...plainMessages(failed), ...finals(failed).flatMap((o) => (o.message ? [o.message] : []))];
  assert.ok(shown.length > 0 && !shown.some((m) => m.suggestions !== undefined));
});

it("test_with_text_streaming_the_agents_text_fills_the_bubble_as_it_grows", async () => {
  const delta = (text: string) => ev("chatDelta", "m1", { delta: { content: text } });
  const script: Script = [
    [0.2, delta("All ")],
    [1.7, delta("green: ")],
    [3.4, delta("42 tests pass.")],
    [3.5, said("All green: 42 tests pass.")],
    [3.6, end()],
  ];
  const run = await turn(script, { style: { streamText: true } });
  const texts = run.ops.filter((o) => o.op === "emit").map((o) => o.text);
  assert.ok(texts.length > 0);
  for (let i = 1; i < texts.length; i += 1) assert.ok((texts[i] ?? "").startsWith(texts[i - 1] ?? ""));
  assert.ok(texts[0] === "All " || texts[0] === "All green: "); // streamed while the model turn was being written
  const final = finalOf(run);
  assert.ok(textOf(final) === "All green: 42 tests pass." && final.aiGenerated === true);
  assert.deepEqual(plainMessages(run), []);
  const off = await turn(script);
  assert.equal(off.ops.filter((o) => o.op === "emit").length, 0);
});

it("test_a_status_message_without_a_stream_is_the_status_message_of_before", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock);
  const status = new StatusMessage(bus, { clock, log: new RecordingLogger() });
  status.begin();
  status.progress({ narration: "Hi" });
  await clock.pump(status.finish(["answer"], { ai: true }));
  assert.equal(textOf(bus.sent[0]?.message), LIVE_HEADER);
  assert.equal(bus.streamOps.length, 0);
});
