// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A person whose model calls the gateway refuses for want of a key (test_apim_key.py, the turn's side): Claw's turn ends
 * with the gateway's raw refusal as the assistant message. The person is told what to do (the policy's guidance), in
 * their language; every other error keeps its handling. The refusal rules are a deployment's plugin: here a neutral fake
 * (fake-refusals.ts) stands in for them.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { SseEvent } from "../../src/claw/model.js";
import { TurnState } from "../../src/turn/turn-state.js";
import { fakeRefusals, LINK, LIVE401, LIVE_INVALID401, RAW401, RAW403 } from "./fake-refusals.js";
import { play, type Run } from "./play.js";
import { ev, type Script, textOf } from "./world.js";

const REPORT = "Did something go wrong? You can tell the PrimusClaw team.";

/** What Claw streams for such a turn, in its order. */
function failingTurn(text: string = RAW403): SseEvent[] {
  return [
    ev("AssistantMessage", "m1", { data: { content: [{ type: "text", text }] } }),
    ev("ResultMessage", "m1"),
    ev("statusUpdate", "m1", { agentStatus: "failed" }),
  ];
}

const at0 = (events: SseEvent[]): Script => events.map((e) => [0, e] as const);

function answering(text: string): Script {
  return at0([
    ev("AssistantMessage", "m1", { data: { content: [{ type: "text", text }] } }),
    ev("ResultMessage", "m1", { data: { subtype: "success" } }),
  ]);
}

function turnOf(script: Script, text: string): Promise<Run> {
  return play(script, {
    request: { key: "ak-alice", text },
    refusals: fakeRefusals,
    hooks: { reportMessage: () => ({ body: { type: "text", text: REPORT } }) },
  });
}

/** What the person was left reading, one entry per message sent or edited. */
function said(run: Run): string[] {
  return run.bus.sent
    .filter((s) => (s.operation === "send" || s.operation === "update") && s.kind === "message")
    .map((s) => textOf(s.message))
    .filter((t) => t);
}

const last = (run: Run): string => said(run).at(-1) ?? "";

/** No "Report a problem": nothing to report. */
function reported(run: Run): boolean {
  return said(run).some((t) => t.includes("Did something go wrong"));
}

// --- the turn --------------------------------------------------------------------------------------------------------

it("test_the_raw_error_is_not_progress", () => {
  for (const raw of [RAW403, RAW401, LIVE401]) {
    const state = new TurnState("m1", undefined, false, fakeRefusals);
    const step = state.feed(failingTurn(raw)[0] as SseEvent);
    assert.ok(step.narration === undefined && !step.finished, raw); // the live view never shows the raw refusal
  }
});

it("test_the_turn_says_whether_claw_failed_it", () => {
  const cases: Array<[string, SseEvent[], boolean | undefined]> = [
    ["bare-result", [ev("ResultMessage")], true], // a failed turn's: bare, no data (measured live)
    ["empty-data", [ev("ResultMessage", "m1", { data: {} })], true],
    ["error-subtype", [ev("ResultMessage", "m1", { data: { subtype: "error" } })], true],
    ["success", [ev("ResultMessage", "m1", { data: { subtype: "success" } })], false], // a good turn's
    ["success-with-text", [ev("ResultMessage", "m1", { final_text: "x", data: { subtype: "success" } })], false],
    ["failed-status", [ev("statusUpdate", "m1", { agentStatus: "failed" })], true],
    ["error-event", [ev("error")], true],
    ["stopped-status", [ev("statusUpdate", "m1", { agentStatus: "stopped" })], false], // (a stop is not a failure)
    ["running-status", [ev("statusUpdate", "m1", { agentStatus: "running" })], undefined], // not an end
    ["no-end", [ev("AssistantMessage", "m1", { data: { content: [{ type: "text", text: "hi" }] } })], undefined],
    ["other-turn", [ev("ResultMessage", "m9")], undefined],
    ["subagent", [ev("ResultMessage", "m1", { subagent_id: "s1" })], undefined],
  ];
  for (const [name, events, failed] of cases) {
    const state = new TurnState("m1");
    for (const event of events) state.feed(event);
    assert.equal(state.failed, failed, name); // undefined, until Claw has said how the turn ended
  }
});

it("test_a_failed_status_after_a_good_result_does_not_undo_it_and_the_other_way_round", () => {
  const state = new TurnState("m1");
  state.feed(ev("ResultMessage", "m1", { data: { subtype: "success" } }));
  assert.ok(!state.failed);
  state.feed(ev("statusUpdate", "m1", { agentStatus: "failed" }));
  assert.ok(state.failed); // once failed, failed
});

it("test_a_user_without_a_key_is_told_what_to_do_in_english", async () => {
  const run = await turnOf(at0(failingTurn()), "what projects do we have?");
  assert.ok(
    last(run).includes(LINK) && last(run).includes("not uploaded your model key") && last(run).includes("ask me again"),
  );
  assert.deepEqual(
    said(run).filter((s) => s.includes("NO-MODEL-KEY") || s.includes("403")),
    [],
  ); // not as the answer, not as progress
  assert.ok(!said(run).join(" ").includes("ran into an error"));
  const lastMessage = run.bus.sent.filter((s) => s.operation !== "delete" && s.kind === "message").at(-1)?.message;
  assert.ok(!lastMessage?.feedback); // no thumbs under a message that is not an answer
  assert.ok(!reported(run)); // no "Report a problem" card: nothing to report
});

it("test_the_live_error_of_a_group_chat_user_is_told_what_to_do_not_shown", async () => {
  const run = await turnOf(at0(failingTurn(LIVE401)), "who am I signed in as?");
  assert.ok(
    last(run).includes(LINK) && last(run).includes("not uploaded your model key") && last(run).includes("ask me again"),
  );
  assert.deepEqual(
    said(run).filter((s) => s.includes("401") || s.includes("MODEL-KEY") || s.includes("fallback model group")),
    [],
  );
  assert.ok(!said(run).join(" ").includes("ran into an error"));
  assert.ok(!reported(run));
});

it("test_a_failed_turn_that_begins_with_the_refusal_is_told_what_to_do_whatever_follows_it", async () => {
  // Claw ends the turn failed, so a shape of the refusal nobody has seen yet is still the refusal.
  const run = await turnOf(at0(failingTurn(`${RAW401}\nRetrying with another model. (router 2027.1)`)), "hello");
  assert.ok(last(run).includes(LINK) && last(run).includes("not uploaded your model key"));
  assert.deepEqual(
    said(run).filter((s) => s.includes("401") || s.includes("Retrying")),
    [],
  );
});

it("test_a_good_turn_whose_answer_begins_with_the_same_words_is_an_answer", async () => {
  const answer = `${RAW401}\nThat is the error the gateway sends when no key is bound; upload one.`;
  const run = await turnOf(answering(answer), "show me the raw error the gateway sends");
  assert.equal(last(run), answer);
  assert.ok(!said(run).join(" ").includes(LINK));
});

it("test_a_good_turn_whose_answer_is_nothing_but_the_raw_error_is_still_an_answer", async () => {
  // A person with a key who asks what the error looks like: Claw ends the turn as a success, so it is an answer.
  for (const answer of [LIVE401, RAW401, RAW403]) {
    const run = await turnOf(answering(answer), "print the exact error the gateway sends for a missing key");
    assert.ok(!said(run).join(" ").includes(LINK) && !said(run).join(" ").includes("not uploaded"), answer);
    assert.ok(last(run).includes(answer), answer);
  }
});

it("test_another_failed_401_keeps_its_handling", async () => {
  const text = '401 {"error":{"message":"Invalid API key"}}';
  const run = await turnOf(at0(failingTurn(text)), "hello");
  // not the refusal, so no upload guidance; and the raw error is not posted either
  assert.ok(!run.bus.everything().includes("Invalid API key"));
  assert.ok(said(run).join(" ").includes("ran into an error and did not finish"));
  assert.ok(!said(run).join(" ").includes(LINK));
});

it("test_a_user_who_wrote_chinese_is_answered_in_chinese", async () => {
  const run = await turnOf(at0(failingTurn()), "你好，我们现在有哪些项目？");
  assert.ok(last(run).includes(LINK) && last(run).includes("还没有上传模型 Key") && last(run).includes("再问我一次"));
  assert.ok(!run.bus.everything().includes("NO-MODEL-KEY"));
});

it("test_the_guidance_also_comes_when_the_failed_status_arrives_first", async () => {
  const [said0, , status] = failingTurn();
  // no ResultMessage: the turn ends on statusUpdate failed
  const run = await turnOf(at0([said0 as SseEvent, status as SseEvent]), "hello");
  assert.ok(last(run).includes(LINK) && !said(run).join(" ").includes("ran into an error"));
});

it("test_other_errors_keep_their_handling", async () => {
  const run = await turnOf(at0(failingTurn('403 {"error":"forbidden"}')), "hello");
  const all = said(run).join(" ");
  assert.ok(!all.includes("forbidden") && all.includes("ran into an error and did not finish")); // a raw error is never the answer
  assert.ok(!all.includes(LINK));
});

it("test_a_failed_turn_without_text_keeps_its_error_message", async () => {
  const run = await turnOf(at0([ev("error")]), "hello");
  const all = said(run).join(" ");
  assert.ok(all.includes("ran into an error") && all.includes("Did something go wrong") && !all.includes(LINK)); // and the report card
});

it("test_an_answer_that_quotes_the_sentence_is_still_an_answer", async () => {
  const answer = "That error means the gateway said: NO-MODEL-KEY. Upload one.";
  const run = await turnOf(answering(answer), "what does a 403 from the gateway mean?");
  assert.equal(last(run), answer);
});

it("test_a_user_whose_key_apim_no_longer_accepts_is_told_to_upload_a_valid_one", async () => {
  const run = await turnOf(at0(failingTurn(LIVE_INVALID401)), "what projects do we have?");
  assert.ok(last(run).includes(LINK) && last(run).includes("invalid or expired") && last(run).includes("ask me again"));
  assert.ok(!last(run).includes("not uploaded"));
  assert.deepEqual(
    said(run).filter((s) => s.includes("401") || s.includes("MODEL-KEY") || s.includes("fallback model group")),
    [],
  );
  assert.ok(!said(run).join(" ").includes("ran into an error"));
  assert.ok(!reported(run));
});
