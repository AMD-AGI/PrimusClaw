// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn refused for want of a model key is run again, once, on the fallback model, and the person is told to upload the
 * key (test_apim_fallback.py, the turn's side). The session is moved to the fallback model for that one turn, the message
 * is sent again, the session is put back on the worker's model, and the answer has one line in front. Where there is
 * nothing to run it on, the person is told to upload the key. The refusal rules are the neutral fake of fake-refusals.ts.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import type { SseEvent } from "../../src/claw/model.js";
import type { SendOptions } from "../../src/ports/claw/sessions.js";
import { runTurn } from "../../src/turn/engine/run-turn.js";
import { fakeRefusals, LINK, LIVE401, LIVE_INVALID401, RAW401, RAW403 } from "./fake-refusals.js";
import { Timeline } from "./timeline.js";
import { Bus, ev, result, type Script, ScriptedClaw, textOf, world } from "./world.js";

const MODEL = "model-main";
const FALLBACK = "model-backup";
const LEAD_MISSING = `You have no model key, so a backup model answered. Upload one to get yours back: ${LINK}`;

/** ScriptedClaw whose every message has its own turn (m2, m3, ...) and whose N-th setModel (1-based) can fail. */
class Claw extends ScriptedClaw {
  sends = 0;
  modelCalls = 0;
  failModelCalls = new Map<number, number | Error>();
  failSecondSend = false;

  override async sendMessage(
    key: string,
    sessionId: string,
    text: string,
    options?: SendOptions,
  ): Promise<string | null> {
    await super.sendMessage(key, sessionId, text, options);
    this.sends += 1;
    if (this.failSecondSend && this.sends === 1) throw new ClawError(500);
    return `m${String(this.sends + 1)}`; // m1 is the first message of a new chat
  }

  override setModel(key: string, sessionId: string, model: string): Promise<void> {
    this.modelCalls += 1;
    this.calls.push(["set_model", key, sessionId, model]);
    const failure = this.failModelCalls.get(this.modelCalls);
    if (failure === undefined) return Promise.resolve();
    return Promise.reject(failure instanceof Error ? failure : new ClawError(failure));
  }
}

/** What Claw streams for a turn the gateway refused: the raw error as the assistant message, then the failed status. */
function refused(text: string, messageId = "m1"): SseEvent[] {
  return [
    ev("AssistantMessage", messageId, { data: { content: [{ type: "text", text }] } }),
    ev("ResultMessage", messageId),
    ev("statusUpdate", messageId, { agentStatus: "failed" }),
  ];
}

const at0 = (events: SseEvent[]): Script => events.map((e) => [0, e] as const);

/** One person's chat: their session and the model it is known to have, carried from message to message (the store). */
class Chat {
  readonly clock = new Timeline();
  readonly bus = new Bus(this.clock);
  readonly claw = new Claw(this.clock);
  session: string | undefined;
  sessionModel = "";
  stopped = false;

  constructor(
    readonly model = MODEL,
    readonly fallback = FALLBACK,
  ) {}

  async say(text: string, script: Script, options: { group?: boolean; stopWhen?: () => boolean } = {}): Promise<void> {
    this.claw.scripts = () => script;
    const w = world(this.clock, this.bus, this.claw, {
      request: {
        key: "ak-alice",
        text,
        model: this.model,
        fallbackModel: this.fallback,
        group: options.group ?? false,
      },
      refusals: fakeRefusals,
      ...(this.session === undefined ? {} : { sessionId: this.session }),
      sessionModel: this.sessionModel,
    });
    const record = w.ctx.record;
    await this.clock.pump(
      runTurn(w.ctx, {
        onSession: (id) => {
          this.session = id;
          this.sessionModel = record.sessionModel; // what the store records with the session
        },
        stopRequested: options.stopWhen ?? (() => false),
      }),
    );
    await this.clock.drain();
  }

  /** The calls that matter, in order: create, set_model <model>, send. */
  kinds(from = 0): string[] {
    return this.claw.calls
      .slice(from)
      .filter((c) => c[0] === "create" || c[0] === "send" || c[0] === "set_model")
      .map((c) => (c[0] === "set_model" ? `set_model ${String(c[3])}` : String(c[0])));
  }

  said(): string[] {
    return this.bus.sent
      .filter((s) => (s.operation === "send" || s.operation === "update") && s.kind === "message")
      .map((s) => textOf(s.message))
      .filter((t) => t);
  }

  last(): string {
    return this.said().at(-1) ?? "";
  }
}

const MOVED = ["create", `set_model ${FALLBACK}`, "send", `set_model ${MODEL}`];

it("test_a_refused_turn_is_run_again_on_the_fallback_and_the_session_goes_back", async () => {
  for (const raw of [RAW403, RAW401, LIVE401]) {
    const chat = new Chat();
    await chat.say("what projects do we have?", at0([...refused(raw), result("Here are the projects.", "m2")]));
    assert.deepEqual(chat.kinds(), MOVED, raw);
    const pins = chat.claw.calls.filter((c) => c[0] === "set_model").map((c) => [c[1], c[2]]);
    assert.deepEqual(pins, [
      ["ak-alice", "sess-ak-alice"],
      ["ak-alice", "sess-ak-alice"],
    ]); // the person's own key
    assert.equal(chat.last(), `${LEAD_MISSING}\n\nHere are the projects.`, raw);
    assert.deepEqual(
      chat.said().filter((t) => t.includes("403") || t.includes("401") || t.includes("MODEL-KEY")),
      [],
      raw,
    );
    assert.ok(!chat.said().join(" ").includes("ran into an error"), raw);
    const last = chat.bus.sent.filter((s) => s.operation !== "delete" && s.kind === "message").at(-1)?.message;
    assert.ok(last?.feedback, raw); // the chat's thumbs: it is an answer, not an error message
    assert.ok(chat.session === "sess-ak-alice" && chat.sessionModel === MODEL, raw);
  }
});

it("test_the_second_message_of_the_chat_goes_out_on_the_users_model_without_another_patch", async () => {
  const chat = new Chat();
  await chat.say("first", at0([...refused(RAW401), result("ok", "m2")]));
  const before = chat.claw.calls.length;
  await chat.say("second", at0([result("fine", "m3")]));
  assert.deepEqual(
    chat.kinds(before).filter((k) => k !== "create"),
    ["send"],
  ); // no extra patch: it is back on MODEL
});

it("test_an_existing_session_is_moved_for_the_one_turn_and_restored", async () => {
  const chat = new Chat();
  chat.session = "old-sess";
  chat.sessionModel = MODEL;
  await chat.say("hi", at0([...refused(RAW401, "m2"), result("answer", "m3")])); // the first send is turn m2, the second m3
  assert.deepEqual(chat.kinds(), ["send", `set_model ${FALLBACK}`, "send", `set_model ${MODEL}`]);
  const sends = chat.claw.calls.filter((c) => c[0] === "send");
  assert.deepEqual(
    sends.map((c) => c[2]),
    ["old-sess", "old-sess"],
  );
  assert.deepEqual(
    sends.map((c) => c[3]),
    ["hi", "hi"],
  ); // the same message, once more
  assert.equal(chat.sessionModel, MODEL);
});

it("test_a_user_who_wrote_chinese_gets_the_line_in_chinese", async () => {
  const chat = new Chat();
  await chat.say("你好，我们现在有哪些项目？", at0([...refused(RAW401), result("这是项目列表。", "m2")]));
  assert.equal(chat.last(), `你还没有上传模型 Key，这次用的是备用模型；上传后即可恢复： ${LINK}\n\n这是项目列表。`);
});

it("test_a_turn_that_went_well_is_never_moved_or_run_twice", async () => {
  const chat = new Chat();
  await chat.say("hello", at0([result("all good")]));
  assert.deepEqual(chat.kinds(), ["create"]);
  assert.equal(chat.last(), "all good");
});

it("test_another_failure_is_not_run_again", async () => {
  const chat = new Chat();
  await chat.say("hello", at0([ev("error")]));
  assert.deepEqual(chat.kinds(), ["create"]);
  assert.ok(!chat.said().join(" ").includes(LINK));
});

it("test_the_run_is_once_the_fallback_refused_too_and_the_user_is_told_to_upload", async () => {
  const chat = new Chat();
  await chat.say("hi", at0([...refused(RAW401), ...refused(RAW401, "m2")]));
  assert.deepEqual(chat.kinds(), MOVED); // no third run
  assert.ok(chat.last().includes(LINK) && chat.last().includes("not uploaded your model key"));
  assert.deepEqual(
    chat.said().filter((t) => t.includes("401") || t.includes("MODEL-KEY")),
    [],
  );
  assert.equal(chat.sessionModel, MODEL);
});

it("test_with_no_other_model_to_run_it_on_the_user_is_told_to_upload", async () => {
  // Without a worker model nothing is pinned, so a session moved to the fallback could never be put back: it is not moved.
  for (const [model, fallback] of [
    [MODEL, ""],
    [MODEL, MODEL],
    ["", FALLBACK],
  ] as const) {
    const chat = new Chat(model, fallback);
    await chat.say("hi", at0(refused(RAW401)));
    assert.deepEqual(chat.kinds(), ["create"], `${model}/${fallback}`); // no PATCH, no second message
    assert.ok(chat.last().includes(LINK) && chat.last().includes("not uploaded your model key"));
    assert.equal(chat.sessionModel, model);
  }
});

it("test_a_fallback_that_is_the_users_own_model_is_not_run_even_when_the_session_is_not_known_to_have_it", async () => {
  const chat = new Chat(MODEL, MODEL);
  chat.session = "old-plain";
  chat.claw.failModelCalls.set(1, 400);
  await chat.say("hi", at0(refused(RAW401, "m2")));
  assert.deepEqual(chat.kinds(), [`set_model ${MODEL}`, "send"]); // the refused pin, the message, and nothing else
  assert.ok(chat.last().includes(LINK) && chat.last().includes("not uploaded your model key"));
});

it("test_when_claw_will_not_move_the_session_the_user_is_told_to_upload", async () => {
  for (const failure of [400, 404, 500]) {
    const chat = new Chat();
    chat.claw.failModelCalls.set(1, failure);
    await chat.say("hi", at0([...refused(RAW401), result("must not be shown", "m2")]));
    assert.deepEqual(chat.kinds(), ["create", `set_model ${FALLBACK}`], String(failure)); // no second message, nothing to put back
    assert.ok(chat.last().includes(LINK) && chat.last().includes("not uploaded your model key"));
    assert.ok(!chat.said().join(" ").includes("must not be shown"));
    assert.equal(chat.sessionModel, MODEL); // what the create gave it: never recorded as moved
  }
});

it("test_when_claw_will_not_move_the_session_the_user_is_told_to_upload (refused connection)", async () => {
  const chat = new Chat();
  chat.claw.failModelCalls.set(1, new ClawUnreachable("connect", "connection refused"));
  await chat.say("hi", at0([...refused(RAW401), result("must not be shown", "m2")]));
  assert.equal(chat.sessionModel, MODEL);
});

it("test_a_restore_that_fails_still_delivers_the_answer_and_the_next_message_pins_the_model_again", async () => {
  for (const failure of [400, 409, 500, new ClawUnreachable("network", "down")] as const) {
    const name = failure instanceof Error ? "network" : String(failure);
    const chat = new Chat();
    chat.claw.failModelCalls.set(2, failure);
    await chat.say("hi", at0([...refused(RAW401), result("the answer", "m2")]));
    assert.ok(chat.last().endsWith("the answer") && chat.last().includes(LINK), name);
    assert.equal(chat.sessionModel, FALLBACK, name); // what the session really has: the record says so
    const before = chat.claw.calls.length;
    await chat.say("next", at0([result("fine", "m3")]));
    assert.deepEqual(chat.kinds(before).slice(0, 1), [`set_model ${MODEL}`], name);
    assert.equal(chat.sessionModel, MODEL, name);
  }
});

it("test_a_failing_second_run_still_puts_the_session_back", async () => {
  const chat = new Chat();
  chat.claw.failSecondSend = true;
  await chat.say("hi", at0(refused(RAW401)));
  assert.deepEqual(chat.kinds(), MOVED);
  assert.ok(chat.said().some((t) => t.includes("could not take that request")));
  assert.equal(chat.sessionModel, MODEL);
});

it("test_a_stop_during_the_second_run_is_honoured", async () => {
  // (the /stop that interrupts Claw is the router's; here the stop is asked for while the second run is on)
  const chat = new Chat();
  let stop = false;
  const claw = chat.claw;
  let streams = 0;
  claw.stream = async function* (key: string, sessionId: string, after?: string): AsyncGenerator<SseEvent> {
    claw.calls.push(["stream", key, sessionId, after ?? null]);
    await Promise.resolve();
    streams += 1;
    if (streams === 1) {
      yield* refused(RAW401);
      return;
    }
    stop = true; // while the second run is on
    yield ev("ResultMessage", "m2", { data: { subtype: "success" } });
  };
  await chat.say("hi", [], { stopWhen: () => stop });
  assert.deepEqual(chat.kinds(), MOVED); // and the session is put back
  assert.ok(chat.said().includes("Stopped."));
  assert.deepEqual(
    chat.said().filter((t) => t.includes("Upload one to get yours back")),
    [],
  );
});

it("test_a_group_chat_turn_is_run_again_the_same_way", async () => {
  // A group chat runs the same turn as a 1:1 chat: the same detection and the same second run.
  for (const raw of [RAW401, LIVE401]) {
    const chat = new Chat();
    await chat.say("what projects?", at0([...refused(raw), result("group answer", "m2")]), { group: true });
    assert.deepEqual(chat.kinds(), MOVED, raw);
    assert.ok(chat.last().endsWith("group answer") && chat.last().includes(LINK), raw);
    assert.deepEqual(
      chat.said().filter((t) => t.includes("401") || t.includes("MODEL-KEY")),
      [],
      raw,
    );
  }
});

// A turn on a model that is down, as Claw ends it: the error as the assistant message, then the end. Not a refusal of the
// person's key: the fallback model's own failure.
const DOWN503 =
  '503 {"error":{"message":"ServiceUnavailableError: Service Unavailable. Received Model Group=model-backup\\nAvailable Model Group Fallbacks=None","code":"503"}}';
const downSaid = (): SseEvent => ev("AssistantMessage", "m2", { data: { content: [{ type: "text", text: DOWN503 }] } });
const DOWN_SHAPES: Record<string, () => SseEvent[]> = {
  "failed-turn": () => refused(DOWN503, "m2"),
  "error-subtype": () => [downSaid(), ev("ResultMessage", "m2", { data: { subtype: "error" } })],
  "error-event": () => [downSaid(), ev("error", "m2")],
  "failed-status-only": () => [downSaid(), ev("statusUpdate", "m2", { agentStatus: "failed" })],
};

it("test_a_fallback_that_is_down_leaves_the_user_the_guidance_not_another_raw_error", async () => {
  for (const [down, shape] of Object.entries(DOWN_SHAPES)) {
    for (const first of [RAW401, LIVE401, RAW403]) {
      const name = `${down}/${first.slice(0, 3)}`;
      const chat = new Chat();
      await chat.say("hi", at0([...refused(first), ...shape()]));
      assert.deepEqual(chat.kinds(), MOVED, name); // once, and the session goes back
      assert.ok(chat.last().includes(LINK) && chat.last().includes("not uploaded your model key"), name);
      assert.ok(chat.last().includes("ask me again"), name);
      const leaked = chat
        .said()
        .filter(
          (t) =>
            t.includes("503") ||
            t.includes("Unavailable") ||
            t.includes("401") ||
            t.includes("403") ||
            t.toLowerCase().includes("fallback"),
        );
      assert.deepEqual(leaked, [], name);
      assert.ok(!chat.said().join(" ").includes("ran into an error"), name);
      assert.equal(chat.sessionModel, MODEL, name);
    }
  }
});

it("test_a_fallback_that_is_down_leaves_the_user_the_guidance_in_a_group_chat_too", async () => {
  const chat = new Chat();
  await chat.say("what projects?", at0([...refused(LIVE401), ...refused(DOWN503, "m2")]), { group: true });
  assert.deepEqual(chat.kinds(), MOVED);
  assert.ok(chat.last().includes(LINK));
  assert.deepEqual(
    chat.said().filter((t) => t.includes("503") || t.includes("401")),
    [],
  );
});

it("test_a_fallback_that_is_down_and_does_not_end_the_turn_keeps_the_stream_handling", async () => {
  // Nothing but a dropped stream: the person hears about the connection, not a raw error and not the guidance.
  const chat = new Chat();
  const claw = chat.claw;
  let streams = 0;
  claw.stream = async function* (key: string, sessionId: string, after?: string): AsyncGenerator<SseEvent> {
    claw.calls.push(["stream", key, sessionId, after ?? null]);
    await Promise.resolve();
    streams += 1;
    if (streams === 1) {
      yield* refused(LIVE401);
      return;
    }
    throw new ClawUnreachable("network", "dropped");
  };
  await chat.say("hi", []);
  assert.ok(chat.said().some((t) => t.includes("lost the connection")));
  assert.deepEqual(
    chat.said().filter((t) => t.includes("401")),
    [],
  );
  assert.equal(chat.sessionModel, MODEL); // and the session is back on the person's model
});

it("test_a_good_turn_whose_answer_is_the_raw_error_is_neither_moved_nor_run_again", async () => {
  for (const answer of [LIVE401, RAW401, RAW403]) {
    const chat = new Chat();
    await chat.say(
      "print the exact error the gateway sends for a missing key",
      at0([
        ev("AssistantMessage", "m1", { data: { content: [{ type: "text", text: answer }] } }),
        ev("ResultMessage", "m1", { data: { subtype: "success" } }),
      ]),
    );
    assert.deepEqual(chat.kinds(), ["create"], answer);
    assert.ok(!chat.said().join(" ").includes(LINK) && chat.last().includes(answer), answer);
  }
});

it("test_a_move_whose_answer_was_lost_may_have_happened_so_the_next_message_pins_the_model_again", async () => {
  // The PATCH may have been applied before the answer was lost: the record must not say the session is on the worker's
  // model, or the next message would skip the pin and the chat would stay on the fallback for good.
  for (const failure of [
    new ClawUnreachable("network", "read"),
    new ClawUnreachable("timeout", "read"),
    new ClawUnreachable("network", "protocol"),
  ]) {
    const chat = new Chat();
    chat.claw.failModelCalls.set(1, failure);
    await chat.say("hi", at0([...refused(RAW401), result("must not be shown", "m2")]));
    assert.deepEqual(chat.kinds(), ["create", `set_model ${FALLBACK}`]); // no second message
    assert.ok(chat.last().includes(LINK) && !chat.said().join(" ").includes("must not be shown"));
    assert.equal(chat.sessionModel, FALLBACK); // what the session may have
    const before = chat.claw.calls.length;
    await chat.say("next", at0([result("fine", "m2")]));
    assert.deepEqual(chat.kinds(before).slice(0, 1), [`set_model ${MODEL}`]);
    assert.equal(chat.sessionModel, MODEL);
  }
});

it("test_a_move_that_never_left_the_worker_is_not_recorded", async () => {
  // A refused connection is a request that was not made: nothing to put back.
  const chat = new Chat();
  chat.claw.failModelCalls.set(1, new ClawUnreachable("connect", "connection refused"));
  await chat.say("hi", at0(refused(RAW401)));
  assert.equal(chat.sessionModel, MODEL);
});

it("test_the_fallback_answer_that_went_well_is_still_shown_with_its_line", async () => {
  // The failed flag belongs to the run it was read in: the first run's failure does not follow the second run's answer.
  const chat = new Chat();
  await chat.say("what projects do we have?", at0([...refused(LIVE401), result("Here are the projects.", "m2")]));
  assert.ok(chat.last().endsWith("Here are the projects.") && chat.last().includes("Upload one to get yours back"));
  assert.ok(!chat.said().join(" ").includes("not uploaded your model key"));
});

it("test_a_shape_of_the_refusal_nobody_has_seen_is_still_run_again_when_claw_says_the_turn_failed", async () => {
  const chat = new Chat();
  await chat.say(
    "what projects do we have?",
    at0([
      ...refused(`${RAW401}\nRetrying with another model. (router 2027.1)`),
      result("Here are the projects.", "m2"),
    ]),
  );
  assert.deepEqual(chat.kinds(), MOVED);
  assert.ok(chat.last().endsWith("Here are the projects."));
  assert.deepEqual(
    chat.said().filter((t) => t.includes("401") || t.includes("Retrying")),
    [],
  );
});

it("test_a_turn_refused_for_a_key_apim_no_longer_accepts_is_run_again_and_says_the_key_is_not_valid", async () => {
  const chat = new Chat();
  await chat.say(
    "what projects do we have?",
    at0([...refused(LIVE_INVALID401), result("Here are the projects.", "m2")]),
  );
  assert.deepEqual(chat.kinds(), MOVED);
  assert.equal(
    chat.last(),
    `Your model key is invalid or expired, so a backup model answered. Upload a valid one to get yours back: ${LINK}\n\nHere are the projects.`,
  );
  assert.deepEqual(
    chat.said().filter((t) => t.includes("401") || t.includes("MODEL-KEY")),
    [],
  );
  assert.equal(chat.sessionModel, MODEL);
});

it("test_a_fallback_that_is_down_after_an_invalid_key_leaves_the_invalid_key_guidance", async () => {
  const chat = new Chat();
  await chat.say("hi", at0([...refused(LIVE_INVALID401), ...refused(DOWN503, "m2")]));
  assert.ok(
    chat.last().includes(LINK) && chat.last().includes("invalid or expired") && !chat.last().includes("not uploaded"),
  );
  assert.deepEqual(
    chat.said().filter((t) => t.includes("401") || t.includes("503") || t.includes("MODEL-KEY")),
    [],
  );
});
