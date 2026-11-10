// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn reads only its own part of the session, and reading a session's last answer never holds its whole history
 * (test_turn_stream_tail.py). A turn's stream starts after the newest event the session held just before the message was
 * sent; `lastAnswer` reads the last LAST_ANSWER_TAIL events of the JSON replay and keeps the newest LAST_ANSWER_TURNS
 * states.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, ClawUnreachable, ReplayRefused } from "../../src/claw/errors.js";
import type { SseEvent } from "../../src/claw/model.js";
import type { JsonObject } from "../../src/json.js";
import { LAST_ANSWER_TAIL, LAST_ANSWER_TURNS, lastAnswer, Turns } from "../../src/turn/last-answer.js";
import { play } from "./play.js";
import { Timeline } from "./timeline.js";
import {
  ev,
  RecordingErrors,
  RecordingLogger,
  result,
  type Script,
  ScriptedClaw,
  textOf,
  type World,
} from "./world.js";

function marker(more: Record<string, unknown> = {}): SseEvent {
  return { id: "", name: "historyComplete", data: { type: "historyComplete", count: 0, ...more } };
}

const at0 = (events: SseEvent[]): Script => events.map((e) => [0, e] as const);

/** A linked person whose chat holds session s1, whose newest stored event is `lastEvent`. */
function chat(lastEvent: string | Error = "claw-41"): Parameters<typeof play>[1] {
  return {
    request: { key: "ak-alice", text: "hello" },
    sessionId: "s1",
    setUp: (w) => {
      w.claw.lastEvent = lastEvent;
    },
  };
}

function cursorReads(w: World): unknown[] {
  return w.claw.calls.filter((c) => c[0] === "last_event_id").map((c) => c[2]);
}

function streamAfters(w: World): unknown[] {
  return w.claw.calls.filter((c) => c[0] === "stream").map((c) => c[3]);
}

function answered(w: World, text: string): boolean {
  return w.bus.sent.some((s) => textOf(s.message).includes(text));
}

it("test_a_turn_streams_after_the_newest_event_stored_before_its_message", async () => {
  const run = await play(at0([marker({ has_more: false }), result("the answer", "m2")]), chat());
  assert.deepEqual(cursorReads(run), ["s1"]);
  assert.deepEqual(streamAfters(run), ["claw-41"]);
  assert.ok(answered(run, "the answer"));
});

it("test_a_claw_whose_after_compares_as_text_is_read_again_from_its_start", async () => {
  // Its marker has no `has_more`: `after=claw-41` there leaves out e.g. claw-100, so the history is read again without it.
  const run = await play(at0([marker(), result("the answer", "m2")]), chat());
  assert.deepEqual(streamAfters(run), ["claw-41", null]);
  assert.ok(answered(run, "the answer"));
});

/** A Claw whose stream is `connection(n)` for its n-th connection (0-based). */
function streaming(connection: (n: number) => Array<SseEvent | Error>): Parameters<typeof play>[1] {
  return {
    ...chat(),
    setUp: (w) => {
      w.claw.lastEvent = "claw-41";
      const claw = w.claw;
      let n = 0;
      claw.stream = async function* (key: string, sessionId: string, after?: string): AsyncGenerator<SseEvent> {
        claw.calls.push(["stream", key, sessionId, after ?? null]);
        await Promise.resolve();
        for (const item of connection(n++)) {
          if (item instanceof Error) throw item;
          yield item;
        }
      };
    },
  };
}

it("test_a_reconnect_resumes_from_the_last_event_seen", async () => {
  const run = await play(
    [],
    streaming((n) =>
      n === 0
        ? [
            marker({ has_more: false }),
            ev("toolUsed", "m2", { tool: "bash", status: "running" }),
            new ClawUnreachable("network", "dropped"),
          ]
        : [marker({ has_more: false }), result("the answer", "m2")],
    ),
  );
  const afters = streamAfters(run);
  assert.equal(afters[0], "claw-41");
  assert.ok(afters[1] !== null && afters[1] !== "claw-41");
  assert.ok(answered(run, "the answer"));
});

it("test_a_legacy_claw_is_never_resumed_with_after", async () => {
  // Once a marker without `has_more` was seen, a dropped connection is read again from Claw's start, never from the last
  // event: that Claw would compare the id as text and could leave out what follows it.
  const run = await play(
    [],
    streaming((n) =>
      n === 1
        ? [
            marker(),
            ev("toolUsed", "m2", { tool: "bash", status: "running" }),
            new ClawUnreachable("network", "dropped"),
          ]
        : [marker(), result("the answer", "m2")],
    ),
  );
  assert.deepEqual(streamAfters(run), ["claw-41", null, null]);
  assert.ok(answered(run, "the answer"));
});

it("test_a_queued_message_streams_without_the_cursor", async () => {
  // A queued turn is found by coming after the turn in front of it; every event of that turn may be stored before the cursor.
  const run = await play(
    at0([result("front answer", "m-front"), marker({ has_more: false }), result("queued answer", "claw-pending-7")]),
    {
      ...chat(),
      setUp: (w) => {
        w.claw.lastEvent = "claw-41";
        w.claw.queueSends = true;
        w.claw.busy = true;
        w.claw.gate = "m-front";
      },
    },
  );
  assert.deepEqual(cursorReads(run), ["s1"]);
  assert.deepEqual(streamAfters(run), [null]);
  assert.ok(answered(run, "queued answer"));
});

it("test_without_the_newest_event_the_stream_starts_where_claw_starts_it", async () => {
  for (const failure of [
    new ClawError(500),
    new ReplayRefused("too large"),
    new ClawUnreachable("network", "no route"),
  ]) {
    const run = await play(at0([marker({ has_more: false }), result("the answer", "m2")]), chat(failure));
    assert.deepEqual(streamAfters(run), [null], failure.name);
    assert.ok(answered(run, "the answer"), failure.name);
  }
});

it("test_a_new_session_reads_no_cursor", async () => {
  const run = await play(at0([marker({ has_more: false }), result("the answer", "m1")]), {
    request: { key: "ak-alice", text: "hello" },
  });
  assert.deepEqual(cursorReads(run), []);
  assert.deepEqual(streamAfters(run), [null]);
});

// --- lastAnswer ----------------------------------------------------------------------------------------------------------

function turn(n: number): SseEvent[] {
  const mid = `m${String(n)}`;
  return [
    ev("UserMessage", mid),
    ev("AssistantMessage", mid, { data: { content: [{ type: "text", text: `answer ${String(n)}` }] } }),
    result(`answer ${String(n)}`, mid),
  ];
}

function rowsOf(events: SseEvent[]): JsonObject[] {
  return events.map((e) => ({ event_id: e.id, event_type: e.name, data: e.data, created_at: null }));
}

function reader(events: SseEvent[]): { clock: Timeline; claw: ScriptedClaw; deps: Parameters<typeof lastAnswer>[0] } {
  const clock = new Timeline();
  const claw = new ScriptedClaw(clock, at0(events));
  claw.rows = rowsOf(events);
  return { clock, claw, deps: { claw, clock, log: new RecordingLogger(), errors: new RecordingErrors() } };
}

it("test_last_answer_reads_the_tail_of_the_replay_not_the_stream", async () => {
  const { clock, claw, deps } = reader([1, 2, 3].flatMap(turn));
  assert.equal(await clock.pump(lastAnswer(deps, "ak-alice", "s1")), "answer 3");
  assert.ok(
    claw.calls.some((c) => c[0] === "events" && c[1] === "ak-alice" && c[2] === "s1" && c[3] === LAST_ANSWER_TAIL),
  );
  assert.ok(!claw.calls.some((c) => c[0] === "stream"));
});

it("test_last_answer_falls_back_to_the_stream_when_the_replay_cannot_be_read", async () => {
  const { clock, claw, deps } = reader([...turn(1), ...turn(2)]);
  claw.rows = new ReplayRefused("an older Claw sent everything");
  assert.equal(await clock.pump(lastAnswer(deps, "ak-alice", "s1")), "answer 2");
  assert.ok(claw.calls.some((c) => c[0] === "stream"));
});

it("test_last_answer_of_a_session_that_is_not_yours_is_refused", async () => {
  const { clock, claw, deps } = reader([]);
  claw.rows = new ClawError(404); // Claw answers a session only to its owner
  await assert.rejects(clock.pump(lastAnswer(deps, "ak-alice", "s1")), ClawError);
});

it("test_reading_a_long_history_keeps_only_the_newest_turns_states", () => {
  const turns = new Turns();
  for (let n = 1; n <= 200; n += 1) {
    for (const event of turn(n)) turns.feed(event);
    assert.ok(turns.states.size <= LAST_ANSWER_TURNS);
  }
  assert.equal(turns.lastDone?.answer, "answer 200");
  assert.equal([...turns.states.keys()].at(-1), "m200");
});

it("test_a_turn_still_running_does_not_hide_the_last_finished_one", () => {
  const turns = new Turns();
  for (const event of [
    ...turn(1),
    ev("UserMessage", "m2"),
    ev("toolUsed", "m2", { tool: "bash", status: "running" }),
  ]) {
    turns.feed(event);
  }
  assert.equal(turns.lastDone?.answer, "answer 1");
});
