// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The final answer goes out as a rich message; everything else stays as it was (test_rich_answer.py, the turn's side).
 * Live progress edits, status lines and failure notices stay markdown. How a rich message becomes Teams' xml (and its
 * fallback to markdown, and the group's credential mask before the conversion) is the Teams adapter's.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { OutMessage } from "../../src/ports/surface.js";
import { answerParts } from "../../src/turn/answer-parts.js";
import { LIVE_HEADER } from "../../src/turn/live-view.js";
import { StatusMessage } from "../../src/turn/progress/status-message.js";
import { play } from "./play.js";
import { Timeline } from "./timeline.js";
import { Bus, end, RecordingLogger, result, said, type Script, type Sent, textOf, tool } from "./world.js";

const ANSWER =
  "**✅ Deployed to staging**\n\n**Details**\n- ✅ **API** up: 200 in 41 ms\n" +
  "- ⚠️ Slow: queue lag 12 s\n- see [the run](https://example.com/r?a=1&b=2), then `kubectl get pods`";
const PUBLIC = "https://example.test";
const ALICE = { key: "ak-alice", publicBaseUrl: PUBLIC };

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

/** The messages that carry text, in order. */
function shown(sent: readonly Sent[]): OutMessage[] {
  return sent.flatMap((s) => (s.message && textOf(s.message) ? [s.message] : []));
}

const isRich = (m: OutMessage): boolean => m.body.type === "rich";
const lead = (m: OutMessage): boolean => m.body.type === "rich" && m.body.lead;

it("test_a_1to1_answer_is_xml_and_the_status_message_before_it_is_markdown", async () => {
  const run = await play(
    [
      [0.1, tool("bash", "start")],
      [0.2, result(ANSWER)],
    ],
    { request: ALICE },
  );
  const texts = shown(run.bus.sent);
  const answer = texts.at(-1);
  assert.ok(answer);
  const carrying = run.bus.sent.filter((s) => s.message === answer);
  assert.deepEqual(
    carrying.map((s) => s.operation),
    ["send"],
  );
  assert.equal(run.bus.sent.at(-1)?.operation, "delete"); // the progress message goes once the answer is posted
  assert.deepEqual(answer.body, { type: "rich", markdown: ANSWER, lead: true });
  assert.ok(texts.length > 1 && texts.slice(0, -1).every((m) => m.body.type === "text"));
});

it("test_a_group_answer_is_xml_too", async () => {
  const run = await play([[0.2, result(ANSWER)]], { request: { ...ALICE, group: true } });
  const texts = shown(run.bus.sent);
  assert.deepEqual(texts.at(-1)?.body, { type: "rich", markdown: ANSWER, lead: true });
  assert.ok(texts.slice(0, -1).every((m) => m.body.type === "text"));
});

it("test_live_progress_edits_stay_plain_markdown_and_only_the_answer_is_xml", async () => {
  for (const group of [false, true]) {
    const finished = await play(WALK, { request: { group } });
    const posted = shown(finished.bus.sent);
    const progress = posted.filter((m) => textOf(m).startsWith(LIVE_HEADER));
    const answers = posted.filter((m) => !progress.includes(m));
    assert.ok(progress.length && progress.every((m) => m.body.type === "text"), String(group));
    assert.ok(answers.length && answers.every((m) => JSON.stringify(m) === JSON.stringify(answers[0])), String(group));
    assert.ok(answers[0] && isRich(answers[0]) && textOf(answers[0]).includes("All green: 42 tests pass."));
  }
});

it("test_a_long_1to1_answer_is_split_as_before_and_only_the_first_part_has_the_heading", async () => {
  const text = Array.from({ length: 9 }, (_, i) => `**Section ${String(i)}**\n${"x".repeat(880)}`).join("\n\n");
  const parts = answerParts(text, `${PUBLIC}/primus-claw/sess-ak-alice`);
  assert.equal(parts.length, 3);
  const run = await play([[0.2, result(text)]], { request: ALICE });
  const sent = shown(run.bus.sent).filter(isRich);
  assert.deepEqual(
    sent.map((m) => m.body),
    [
      { type: "rich", markdown: parts[0], lead: true },
      { type: "rich", markdown: parts[1], lead: false },
      { type: "rich", markdown: parts[2], lead: false },
    ],
  );
  assert.ok(sent[0] && lead(sent[0]) && !sent.slice(1).some(lead));
});

it("test_a_shortened_answer_keeps_its_open_the_full_answer_link", async () => {
  const text = Array.from({ length: 30 }, (_, i) => `${String(i)}:${"x".repeat(900)}`).join("\n\n");
  const run = await play([[0.2, result(text)]], { request: ALICE });
  const last = shown(run.bus.sent).at(-1);
  assert.ok(last && isRich(last));
  assert.ok(textOf(last).includes(`(shortened)\n\n[Open the full answer](${PUBLIC}/primus-claw/sess-ak-alice)`));
});

it("test_failure_notices_and_command_replies_stay_markdown", async () => {
  const run = await play([], {
    request: ALICE,
    sessionId: "sess-x",
    setUp: (w) => {
      w.claw.failSendWith = 429;
    },
  });
  const last = shown(run.bus.sent).at(-1);
  assert.ok(last && textOf(last).includes("busy") && last.body.type === "text");
});

it("test_the_xml_answer_is_a_new_message_even_when_every_edit_is_refused", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock, { fail: (s) => s.operation === "update", ackTimeout: 1 });
  const status = new StatusMessage(bus, { clock, log: new RecordingLogger() });
  status.begin();
  await clock.pump(status.finish([ANSWER], { rich: true }));
  const answers = bus.sent.filter((s) => textOf(s.message) === ANSWER);
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.operation, "send");
  assert.deepEqual(answers[0]?.message, { body: { type: "rich", markdown: ANSWER, lead: true } });
});
