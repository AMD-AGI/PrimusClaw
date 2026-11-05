// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review-tools evaluation's own parts, offline, with a model that answers from a script: so that a score of 100%
 * against the gateway means the Router did what the case asks, and not that the scoring could not tell.
 *
 *   E1  the Router is given the review prompt and context, and the ten tools
 *   E2  a case is right only when the writes that went through are exactly the expected calls: a missing, extra or
 *       different argument fails, and a call the tools refused is not counted
 *   E3  the stand-in refuses what the real tools refuse: a report's turn, a number not in the message, a person without leave
 *   E4  every case has an id of its own and states what it expects
 */
import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_CASES, type ReviewEvalCase } from "./e2e/assistant-review-eval-cases.js";
import { reviewRouterTools, runReviewCase, scoreReviewCase, standIn, systemFor } from "./e2e/assistant-review-eval-lib.js";
import type { Llm, ModelResponse } from "./e2e/assistant-router-eval-lib.js";

const byId = (id: string): ReviewEvalCase => REVIEW_CASES.find((c) => c.id === id) as ReviewEvalCase;

/** A model that makes the given calls in its first step and then stops. */
const scripted = (calls: Array<{ name: string; input: Record<string, unknown> }>): Llm => {
  let step = 0;
  return async (): Promise<ModelResponse> => {
    step += 1;
    if (step > 1) return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
    return {
      content: calls.map((c, i) => ({ type: "tool_use" as const, id: `t${i}`, name: `mcp__assistant__${c.name}`, input: c.input })),
      stop_reason: "tool_use",
    };
  };
};

test("E1 the Router is given the review prompt and context, and the ten tools", async () => {
  const tools = (await reviewRouterTools()).map((t) => t.name.replace("mcp__assistant__", ""));
  assert.deepEqual(tools, [
    "channel_action", "confirmation_answer", "review_mode_set", "review_restart", "review_start",
    "say", "work_create", "work_recall", "work_send", "work_stop",
  ]);
  const system = systemFor(byId("B4"));
  assert.match(system, /Reviews and settings/);
  assert.match(system, /ref #a3f9c2 \| confirmation_id: a3f9c2d1-5b7e-4c1a-9f00-000000000224 \| merge of AMD-AGI\/PrimusClaw#224 .*批准 #a3f9c2/);
  assert.match(systemFor(byId("B7")), /Wei Lei \(user_id: u-weilei\)/);
  assert.doesNotMatch(systemFor(byId("X11-report-turn")), /Channel repos: AMD/, "a report's turn has no channel context");
});

test("E2 a case is right only when the writes that went through are exactly the expected calls", async () => {
  const tools = await reviewRouterTools();
  const c = byId("B8");
  const score = async (input: Record<string, unknown>) =>
    scoreReviewCase(c, await runReviewCase(c, scripted([{ name: "review_start", input }]), tools)).ok;
  assert.equal(await score({ prs: ["AMD-AGI/PrimusClaw#254", "AMD-AGI/PrimusClaw#257"], merge: true }), true);
  assert.equal(await score({ prs: ["AMD-AGI/PrimusClaw#257", "AMD-AGI/PrimusClaw#254"], merge: true }), true, "the order of prs is not a difference");
  assert.equal(await score({ prs: ["AMD-AGI/PrimusClaw#254"], merge: true }), false, "a missing pull request");
  assert.equal(await score({ prs: ["AMD-AGI/PrimusClaw#254", "AMD-AGI/PrimusClaw#257"], merge: false }), false, "review only is not merge");
  assert.equal(await score({ prs: ["AMD-AGI/PrimusClaw#254", "AMD-AGI/PrimusClaw#257"], merge: true, model: "claude-opus-4-8" }), false, "a model nobody asked for");
  const twice = await runReviewCase(c, scripted([
    { name: "review_start", input: { prs: ["AMD-AGI/PrimusClaw#254", "AMD-AGI/PrimusClaw#257"], merge: true } },
    { name: "review_start", input: { prs: ["AMD-AGI/PrimusClaw#254"], merge: false } },
  ]), tools);
  assert.equal(scoreReviewCase(c, twice).ok, false, "an extra write");
  const quiet = byId("X8-no-number");
  assert.equal(scoreReviewCase(quiet, await runReviewCase(quiet, scripted([{ name: "say", input: { text: "哪个 PR？" } }]), tools)).ok, true);
});

test("E3 the stand-in refuses what the real tools refuse", () => {
  const report = standIn(byId("X11-report-turn"));
  assert.equal(report("review_start", { prs: ["AMD-AGI/PrimusClaw#254"], merge: true }).refused, true);
  const injected = standIn(byId("B6"));
  assert.equal((injected("review_start", { prs: ["AMD-AGI/PrimusClaw#999"], merge: true }).result as { error: string }).error, "pr_not_in_message");
  const noLeave = standIn(byId("X5-no-leave"));
  assert.equal((noLeave("review_start", { prs: ["AMD-AGI/PrimusClaw#254"], merge: false, reviewer: "u-weilei" }).result as { error: string }).error, "pr_check_failed");
  // A yes in words is no approval; the exact command with the write's ref is, and only that write's.
  const words = standIn(byId("B4"));
  assert.equal((words("confirmation_answer", { decision: "allow", pr: "224" }).result as { error: string }).error, "not_an_approval_command");
  const command = standIn(byId("B4-command"));
  assert.equal(command("confirmation_answer", { decision: "allow", pr: "224" }).refused, false);
  // A channel action not typed as its command is put to the user as a button; nothing runs.
  const brief = standIn(byId("B5"));
  assert.equal((brief("channel_action", { name: "brief", args: "on 10:00" }).result as { ran: boolean }).ran, false);
  const loosen = standIn(byId("X13-loosen"));
  assert.equal(loosen("review_mode_set", { mode: "fully_auto" }).refused, true);
});

test("E4 every case has an id of its own and states what it expects", () => {
  const ids = REVIEW_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(REVIEW_CASES.filter((c) => c.kind === "replay").length >= 12);
  for (const c of REVIEW_CASES) assert.ok(Array.isArray(c.expect), c.id);
});
