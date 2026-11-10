// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A question of the agent and a rule-held shell command, as Teams shows their cards and as they are answered
 * (teams/tests/test_ask_user_question.py and test_bash_approval_flow.py, the tests that read the cards): the card a turn shows is
 * recorded as the turn records it and drawn by the Teams renderers; a press is answered by the approvals' decisions. The turn's
 * own half (the stream that waits and goes on) is the turn's (W4b).
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import {
  COMMAND_EDGE,
  COMMAND_MAX,
  OPTIONS_MAX,
  OPTION_MAX,
  QUESTIONS_MAX,
  QUESTION_MAX,
  QUESTION_TOOL,
  TARGET_LINES,
  TARGET_MAX,
  cardQuestions,
  cpLength,
  type JsonObject,
  type View,
} from "@primusclaw/personal-agent";

import { ApprovalFlow, settledView, type Settled } from "../../../test-support/assistant/approval-flow.js";
import { ALICE, world } from "../../../test-support/assistant/proactive-world.js";
import { allLines, body, contentOf, str, visible } from "../../../test-support/assistant/teams-cards.js";

import { valid } from "./assistant-cards-valid.js";
import { RENDERERS, renderView } from "../src/views/index.js";
import { answerButton } from "../src/views/approval/index.js";

const BOB = "aad-b";
const SESSION = "sess-ak-alice";
const COMMAND = "git push -u origin fix/parser";
const LABEL = "git push (publishes commits to a remote)";
const QUESTIONS = [
  {
    id: "db",
    question: "Which database?",
    options: [
      { id: "lite", label: "SQLite" },
      { id: "pg", label: "PostgreSQL" },
    ],
  },
  {
    id: "envs",
    question: "Where should it run?",
    allow_multiple: true,
    options: [
      { id: "dev", label: "dev" },
      { id: "prod", label: "prod" },
    ],
  },
];

function cardOfView(view: View): JsonObject {
  const card = contentOf(renderView(RENDERERS, view));
  assert.ok(card !== undefined);
  return card;
}

/** The card a press settled with: its view drawn, or the note it says. */
function settledCard(settled: Settled | undefined): JsonObject {
  const view = settledView(settled);
  assert.ok(view !== undefined, "settled with a note, not a card");
  return cardOfView(view);
}

function words(card: JsonObject): string {
  return allLines(card).join(" ");
}

function actions(card: JsonObject): JsonObject[] {
  return (card["actions"] ?? []) as JsonObject[];
}

/** Alice and Bob, linked; Alice's turn asks QUESTIONS (Brain waits ten minutes). The card it shows, as sent. */
async function asked() {
  const w = world();
  for (const [user, key] of [
    [ALICE, "ak-alice"],
    [BOB, "ak-bob"],
  ] as const) {
    w.store.links.redeemPending(user, user, w.store.links.stashPending(key));
  }
  const flow = new ApprovalFlow(w.store);
  const conversation = w.surface.conversation({
    id: `c-${ALICE}`,
    kind: "personal",
    tenantId: "",
    wire: { conversation: { id: `c-${ALICE}` } },
  });
  const model = {
    questions: cardQuestions(QUESTIONS),
    sessionId: SESSION,
    toolUseId: "toolu_q1",
    group: false,
    ownerName: "",
    note: "",
  };
  const shown = await flow.show(
    conversation,
    { userId: ALICE, sessionId: SESSION, toolUseId: "toolu_q1", tool: QUESTION_TOOL, waitSeconds: 600_000 / 1000 },
    { name: "question", model },
  );
  assert.equal(shown, true);
  const sent = w.surface.outbox.find((r) => r.op === "send");
  assert.ok(sent?.op === "send" && sent.message.body.type === "view");
  return { ...w, flow, card: cardOfView(sent.message.body.view) };
}

it("the question is a card and the answer reaches claw and the run goes on", async () => {
  const w = await asked();
  // the run waits on the user: one card, recorded for Alice for as long as Brain waits, and no answer yet
  const pending = w.store.approvals.getApproval(SESSION, "toolu_q1");
  assert.deepEqual([pending?.userId, pending?.tool, pending?.state], [ALICE, QUESTION_TOOL, "pending"]);
  assert.equal(pending?.expiresAt, w.store.now() + 600);
  const [send] = actions(w.card);
  // Alice picks PostgreSQL, both places, and adds a word
  const settled = await w.flow.press(ALICE, {
    ...(send?.["data"] as JsonObject),
    choice_0: "pg",
    choice_1: "dev,prod",
    text_1: "prod last",
  });
  valid(w.card);
  assert.ok(words(w.card).includes("Which database?") && words(w.card).includes("Where should it run?"));
  const blocks = body(w.card);
  assert.deepEqual(
    blocks
      .filter((b) => b["type"] === "Input.ChoiceSet")
      .map((c) => [c["id"], c["isMultiSelect"], (c["choices"] as JsonObject[]).map((o) => o["title"])]),
    [
      ["choice_0", false, ["SQLite", "PostgreSQL"]],
      ["choice_1", true, ["dev", "prod"]],
    ],
  );
  assert.deepEqual(
    blocks.filter((b) => b["type"] === "Input.Text").map((b) => b["id"]),
    ["text_0", "text_1"],
  );
  // the answer went to Claw with Alice's own key, as labels and words keyed by question id
  assert.deepEqual(w.flow.claw.of("answer"), [
    ["answer", "ak-alice", SESSION, "toolu_q1", { db: "PostgreSQL", envs: "dev, prod. prod last" }, []],
  ]);
  assert.deepEqual(w.flow.claw.of("decide"), [], "an answer is not an approval");
  assert.equal(w.store.approvals.getApproval(SESSION, "toolu_q1")?.state, "decided");
  assert.ok(words(settledCard(settled[0])).startsWith("✅ Answered (you, "), words(settledCard(settled[0])));
  // (the run going on to its answer is the turn's: W4b)
});

it("send with nothing chosen brings the question back and sends nothing", async () => {
  const w = await asked();
  const settled = await w.flow.press(ALICE, actions(w.card)[0]?.["data"] as JsonObject);
  assert.deepEqual(w.flow.claw.of("answer"), []);
  const back = settledCard(settled[0]);
  assert.ok(words(back).includes("Choose an option"), words(back));
  assert.deepEqual(
    body(back)
      .filter((b) => b["type"] === "Input.ChoiceSet")
      .map((b) => b["id"]),
    ["choice_0", "choice_1"],
  );
  assert.equal(actions(back)[0]?.["title"], "Send answer");
  assert.equal(w.store.approvals.getApproval(SESSION, "toolu_q1")?.state, "pending", "it can still be answered");
});

it("only the asker answers in a group", async () => {
  const w = world();
  for (const [user, key] of [
    [ALICE, "ak-alice"],
    [BOB, "ak-bob"],
  ] as const) {
    w.store.links.redeemPending(user, user, w.store.links.stashPending(key));
  }
  const flow = new ApprovalFlow(w.store);
  const envelope = { operation: "send", conversation: "19:g@thread.v2", message: {} };
  w.store.approvals.saveApproval({
    userId: ALICE,
    sessionId: SESSION,
    toolUseId: "toolu_q1",
    tool: QUESTION_TOOL,
    expiresAt: w.store.now() + 600,
    envelope,
  });
  const data = answerButton(SESSION, "toolu_q1", cardQuestions(QUESTIONS))["data"] as JsonObject;
  const group = "19:g@thread.v2";
  const bob = await flow.press(BOB, { ...data, choice_0: "lite" }, group);
  assert.deepEqual(flow.claw.of("answer"), []);
  const back = settledCard(bob[0]);
  assert.ok(words(back).includes("Only the person who asked can answer"), words(back));
  assert.equal(actions(back)[0]?.["title"], "Send answer");
  await flow.press(ALICE, { ...data, choice_0: "lite" }, group);
  assert.deepEqual(flow.claw.of("answer"), [["answer", "ak-alice", SESSION, "toolu_q1", { db: "SQLite" }, ["envs"]]]);
});

it("the card keeps to what teams shows", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: `q${String(i)}`,
    question: "x".repeat(900),
    options: Array.from({ length: 20 }, (_o, j) => ({ id: String(j), label: "y".repeat(300) })),
  }));
  const shown = cardQuestions([...many, { id: "", question: "no id" }, "not a question"]);
  assert.equal(shown.length, QUESTIONS_MAX);
  assert.ok(shown.every((q) => q.options.length === OPTIONS_MAX));
  assert.ok(
    shown.every((q) => cpLength(q.question) <= QUESTION_MAX && q.options.every((o) => cpLength(o.label) <= OPTION_MAX)),
  );
  const card = cardOfView({
    name: "question",
    model: { questions: shown, sessionId: "s", toolUseId: "t", group: true, ownerName: "Alice", note: "" },
  });
  valid(card);
  assert.ok(words(card).includes("Only Alice can answer."), words(card));
});

// --- what the card shows of a shell command (test_bash_approval_flow.py) ---------------------------------------------------------

const LONG =
  "cd /workspace/repo && " +
  "echo checking the tree && ".repeat(30) +
  "git commit -am wip && git push -u origin fix/parser";

function permission(command: string, group = false, event: JsonObject | null = null, lang: string | null = null) {
  const card = cardOfView({
    name: "approval",
    model: {
      tool: "bash",
      input: { command },
      sessionId: "s1",
      toolUseId: "tu1",
      group,
      ownerName: "Alice",
      event,
      lang,
    },
  });
  valid(card);
  return card;
}

function commandLine(card: JsonObject): string {
  const line = visible(card).find((t) => t.startsWith("command: "));
  assert.ok(line !== undefined, visible(card).join(" | "));
  return line;
}

it("a command that fits is shown whole", () => {
  const short = "git push origin HEAD:refs/heads/fix/parser";
  assert.ok(visible(permission(short)).includes(`command: ${short}`));
  const atTheLimit = "x".repeat(COMMAND_MAX);
  assert.ok(visible(permission(atTheLimit)).includes(`command: ${atTheLimit}`));
});

it("a long command keeps its start and its end where the push is", () => {
  const shown = commandLine(permission(LONG));
  assert.ok(LONG.length > COMMAND_MAX);
  assert.ok(shown.startsWith("command: cd /workspace/repo && echo") && shown.endsWith("git push -u origin fix/parser"));
  assert.ok(shown.includes(" … ") && shown.length <= "command: ".length + 2 * COMMAND_EDGE + 3);
  const raw = body(permission(LONG)).find((b) => b["id"] === "approval-details");
  assert.ok(str((raw?.["items"] as JsonObject[])[0]?.["text"]).includes("git commit -am wip")); // the whole call is behind Details
});

it("the limits are these numbers", () => {
  // written out, not taken from the constants: a test that reads its oracle from the code cannot see the code change
  const whole = "a".repeat(300);
  assert.ok(visible(permission(whole)).includes(`command: ${whole}`));
  const shown = commandLine(permission("b".repeat(150) + "c".repeat(151))); // 301 characters
  assert.equal(shown, "command: " + "b".repeat(140) + " … " + "c".repeat(140));
  assert.deepEqual([COMMAND_MAX, COMMAND_EDGE, TARGET_MAX, TARGET_LINES], [300, 140, 300, 4]);
});

it("the rule that held the call is on the card and only in a 1 to 1 chat", () => {
  const event = { approval_label: LABEL };
  assert.ok(visible(permission(COMMAND, false, event)).includes(`Held by a rule: ${LABEL}`));
  assert.ok(!visible(permission(COMMAND, false, {})).some((t) => t.includes("Held by a rule")));
  const group = permission(COMMAND, true, event);
  assert.ok(!visible(group).some((t) => t.includes("Held by a rule") || t.includes(COMMAND))); // a group sees no input and no rule
  assert.ok(!JSON.stringify(group).includes("Held by a rule"));
  const zh = cardOfView({
    name: "approval",
    model: {
      tool: "bash",
      input: { command: COMMAND },
      sessionId: "s1",
      toolUseId: "tu1",
      group: false,
      ownerName: "",
      event,
      lang: "zh",
    },
  });
  assert.ok(visible(zh).includes(`触发规则：${LABEL}`), visible(zh).join(" | "));
});

it("a label cannot smuggle a credential onto the card", () => {
  const event = { approval_label: "push with ghp_" + "A1b2C3d4".repeat(4) + "wxyz" };
  assert.ok(!JSON.stringify(permission(COMMAND, false, event)).includes("ghp_"));
});

/** Claw's approval.requested for a shell command: the target is the command. */
function bashEvent(target: string, toolUseId = "tu1"): JsonObject {
  return {
    event_id: `ap-${toolUseId}`,
    type: "approval.requested",
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: "u-alice",
    session_id: "s-web",
    task_id: "t1",
    trigger_id: null,
    title: "Approval needed",
    summary: "",
    link: "/primus-claw/sessions/s1",
    approval: { tool_use_id: toolUseId, tool: "bash", target, expires_at: "2026-10-27T04:30:00Z" },
  };
}

it("the notification card shows a whole command as its target", () => {
  const until = Date.UTC(2026, 9, 27, 0, 10) / 1000; // 08:10 in Shanghai
  const target =
    "cd /workspace/repo && git add -A && git commit -m 'fix the parser and its tests' && git remote set-url origin " +
    "https://github.com/acme/repo && git push -u origin fix/parser --force-with-lease";
  assert.ok(target.length > 160 && target.length <= TARGET_MAX); // more than the card used to keep
  const notification = (t: string) =>
    cardOfView({
      name: "proactiveApproval",
      model: { event: bashEvent(t), publicBaseUrl: "https://example.test", expiresAt: until, zone: "Asia/Shanghai" },
    });
  const block = body(notification(target))[1];
  assert.equal(block?.["text"], target); // not cut where the push is
  assert.equal(block["maxLines"], TARGET_LINES);
  assert.equal(TARGET_LINES, 4);
  assert.equal(block["fontType"], "Monospace");
  assert.equal(body(notification("x".repeat(400)))[1]?.["text"], "x".repeat(TARGET_MAX - 1) + "…");
});

it("a notification for a shell command is a card with the command and both buttons", async () => {
  const w = world();
  assert.equal(await w.proactive.handle(ALICE, w.reference, bashEvent(COMMAND, "tu7")), "delivered");
  const cards = w.surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "view" ? [cardOfView(r.message.body.view)] : [],
  );
  assert.equal(cards.length, 1);
  const [card] = cards as [JsonObject];
  const lines = allLines(card);
  assert.equal(lines[0], "⚠️ Approval needed: bash");
  assert.equal(lines[2], COMMAND); // (the header's second line: until when)
  assert.deepEqual(
    actions(card)
      .filter((a) => a["type"] === "Action.Execute")
      .map((a) => a["title"]),
    ["Approve", "Deny"],
  );
});
