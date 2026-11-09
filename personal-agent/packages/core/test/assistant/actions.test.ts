// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { confirmWriteOf } from "../../src/assistant/events.js";
import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import { err, ok } from "../../src/result.js";
import { ALICE, ActionsWorld, BOB, DECLARED } from "./actions-world.js";

// --- what the assistant asks the chat to do (`assistant.action`) ---------------------------------------------------------------

it("an action of a message this chat sent is carried out once as the command", async () => {
  const w = new ActionsWorld();
  const mid = w.message();
  assert.equal(await w.runAction(w.action(mid, "quiet", "22:00-07:00")), "delivered");
  assert.equal(await w.runAction(w.action(mid, "quiet", "22:00-07:00")), "dropped"); // the same event again
  assert.deepEqual(w.ran, ["/quiet 22:00-07:00"]);
});

it("an action is carried out as typed with its words joined by one space", async () => {
  const w = new ActionsWorld();
  const mid = w.message();
  assert.equal(await w.runAction(w.action(mid, "memory", "  off ")), "delivered");
  assert.equal(await w.runAction(w.action(mid, "agent", "attach  laptop/claude", "ev-2")), "delivered");
  assert.deepEqual(w.ran, ["/memory off", "/agent attach laptop/claude"]);
});

it("an action for a message this chat never sent is dropped", async () => {
  const w = new ActionsWorld();
  assert.equal(await w.runAction(w.action("act-elsewhere", "quiet", "off")), "dropped");
  assert.deepEqual(w.ran, []);
  assert.deepEqual(w.warned, ["an assistant action was not carried out: not one this chat declared"]);
});

it("an action for another persons message is dropped", async () => {
  const w = new ActionsWorld();
  const bobs = w.message("act-bob", BOB);
  assert.equal(await w.runAction(w.action(bobs, "quiet", "22:00-07:00")), "dropped");
  assert.deepEqual(w.ran, []);
});

it("an action the message did not declare is dropped", async () => {
  const cases: [string, string][] = [
    ["unlink", ""],
    ["github", "unbind"],
    ["link", "ABCDEFGH"],
    ["agent", "close"],
    ["quiet", "22:00-07:00 " + "x".repeat(300)],
    ["brief", "on 10:00"],
  ];
  for (const [name, args] of cases) {
    const w = new ActionsWorld();
    const mid = w.message();
    assert.equal(await w.runAction(w.action(mid, name, args)), "dropped", name);
    assert.deepEqual(w.ran, [], name);
  }
});

it("an action for a person the assistant no longer understands is dropped", async () => {
  for (const options of [{ understands: false }, { reachable: false }]) {
    const w = new ActionsWorld(options);
    const mid = w.message();
    assert.equal(await w.runAction(w.action(mid, "quiet", "22:00-07:00")), "dropped");
    assert.deepEqual(w.ran, []);
  }
});

it("an action that is no command the worker handles is dropped and claims nothing", async () => {
  const w = new ActionsWorld();
  const mid = w.message("act-1", ALICE, ["deploy", "quiet"]);
  assert.equal(await w.runAction(w.action(mid, "deploy", "prod")), "dropped");
  assert.equal(await w.runAction(w.action(mid, "quiet", "off")), "delivered", "the event id was not used up");
  assert.deepEqual(w.ran, ["/quiet off"]);
});

it("an action the chat could not carry out is dropped and an event without an id is taken once", async () => {
  const w = new ActionsWorld();
  const mid = w.message();
  w.commandDone = false;
  const noId = Object.fromEntries(Object.entries(w.action(mid, "quiet", "off")).filter(([k]) => k !== "event_id"));
  assert.equal(await w.runAction(noId), "dropped");
  w.commandDone = true;
  assert.equal(await w.runAction(noId), "dropped", "assistant-action:None was claimed");
  assert.equal(w.store.idempotency.claimProcessed("assistant-action:None"), false);
  assert.deepEqual(w.ran, ["/quiet off"]);
});

it("a review handoff is not carried out here and is dropped without the review service", async () => {
  const w = new ActionsWorld();
  const mid = w.message("act-1", ALICE, [...DECLARED, "review_for_other"]);
  assert.equal(await w.runAction(w.action(mid, "review_for_other")), "dropped");
  assert.equal(await w.runAction({ ...w.action(mid, "quiet", "off", "ev-2"), review: {} }), "dropped");
  assert.deepEqual(w.ran, []);
});

it("a review handoff goes to the review service as it is and comes back with its outcome", async () => {
  const handed: [string, unknown][] = [];
  const w = new ActionsWorld({
    reviewHandoff: (userId, event) => {
      handed.push([userId, event["event_id"]]);
      return event["event_id"] === "ev-2" ? "dropped" : "delivered";
    },
  });
  const mid = w.message("act-1", ALICE, [...DECLARED, "review_for_other"]);
  const handoff = w.action(mid, "review_for_other");
  assert.equal(await w.runAction(handoff), "delivered");
  assert.equal(await w.runAction({ ...w.action(mid, "quiet", "off", "ev-2"), review: {} }), "dropped");
  assert.deepEqual(handed, [
    [ALICE, handoff["event_id"]],
    [ALICE, "ev-2"],
  ]);
  assert.deepEqual(w.ran, []);
});

// --- Run and Cancel under a command the assistant put to the person (`confirm_action`) -------------------------------------------

it("a command put to the person runs only when they press run and once", async () => {
  const w = new ActionsWorld();
  const card = w.actionCard(w.message(), "quiet", "22:00-07:00");
  assert.deepEqual(w.ran, [], "recording the button runs nothing");
  await w.run(card);
  assert.equal(w.said(), "已执行 /quiet 22:00-07:00。 / Ran /quiet 22:00-07:00.");
  await w.run(card); // a second press
  assert.equal(w.said(), "这个按钮已经按过了。 / That button was already pressed.");
  assert.deepEqual(w.ran, ["/quiet 22:00-07:00"]);
  assert.equal(w.store.assistantButtons.getActionCard(card)?.state, "done");
});

it("a command put to the person is not run when cancelled forged or pressed by someone else", async () => {
  const w = new ActionsWorld();
  const mid = w.message();
  const card = w.actionCard(mid, "quiet", "22:00-07:00");
  await w.run(card, BOB); // someone else's press neither runs it nor uses it up
  assert.equal(w.said(), "这个按钮已失效。 / That button is no longer valid.");
  await w.run(card, BOB, "cancel");
  await w.run("forged-card");
  assert.deepEqual(w.ran, []);
  await w.run(card);
  assert.deepEqual(w.ran, ["/quiet 22:00-07:00"]);
  const cancelled = w.actionCard(mid, "quiet", "off");
  await w.run(cancelled, ALICE, "cancel");
  assert.equal(w.said(), "没有执行 /quiet off。 / /quiet off was not run.");
  await w.run(cancelled);
  assert.equal(w.said(), "这个按钮已经按过了。 / That button was already pressed.");
  assert.deepEqual(w.ran, ["/quiet 22:00-07:00"]);
});

it("a command put to the person that their message did not declare never runs", async () => {
  for (const [name, args] of [
    ["unlink", ""],
    ["github", "unbind"],
    ["brief", "on 10:00"],
  ] as const) {
    const w = new ActionsWorld();
    await w.run(w.actionCard(w.message(), name, args));
    assert.deepEqual(w.ran, [], name);
    assert.ok(w.said().includes("nothing was run"), name);
  }
});

it("a command put for a message this chat never sent never runs", async () => {
  const w = new ActionsWorld();
  await w.run(w.actionCard("act-elsewhere", "quiet", "off"));
  assert.deepEqual(w.ran, []);
});

it("a command put for another persons message never runs", async () => {
  // The card is Alice's, but the message it answers was Bob's: the press is hers and still nothing runs.
  const w = new ActionsWorld();
  const bobs = w.message("act-bob", BOB);
  assert.ok(
    w.store.assistantMessages.assistantMessage(bobs)?.actions.has("quiet"),
    "Bob's message declared the command",
  );
  const card = w.actionCard(bobs, "quiet", "22:00-07:00");
  await w.run(card);
  assert.deepEqual(w.ran, []);
  assert.equal(
    w.said(),
    "这个按钮已失效，没有执行。需要的话请直接发 /quiet 22:00-07:00。 / " +
      "That button is no longer valid, so nothing was run. Send /quiet 22:00-07:00 if you want it.",
  );
  assert.equal(w.store.assistantButtons.getActionCard(card)?.state, "done");
});

it("a recorded card whose command is no command runs nothing", async () => {
  // What Run hands on is checked again when it is pressed: a record whose words are no command the worker handles is not given to
  // the command path, even for a message of this person's that declared that name.
  const w = new ActionsWorld();
  w.message("act-old", ALICE, ["deploy"]);
  await w.run(w.actionCard("act-old", "deploy", "prod"));
  assert.deepEqual(w.ran, []);
  assert.ok(w.said().includes("nothing was run"));
});

it("an agent command is run only with a verb the assistant may ask for", async () => {
  const w = new ActionsWorld();
  const mid = w.message();
  await w.run(w.actionCard(mid, "agent", "close"));
  assert.ok(w.said().includes("nothing was run"));
  await w.run(w.actionCard(mid, "agent", "sessions"));
  assert.deepEqual(w.ran, ["/agent sessions"]);
});

it("what run carries out is the recorded command never the click", async () => {
  // A press whose data names another command (a forged or tampered click) carries out the one the worker recorded.
  const w = new ActionsWorld();
  const card = w.actionCard(w.message(), "quiet", "22:00-07:00");
  const data = { primusclaw: "assistant_action", op: "run", card, command: "/quiet off", name: "quiet", args: "off" };
  await w.actions.actionClick(w.click({ ...data, text: "/quiet off" }), "ak-alice");
  assert.deepEqual(w.ran, ["/quiet 22:00-07:00"]);
});

interface Case {
  readonly name: string;
  readonly arrange?: (w: ActionsWorld) => void;
  readonly press: (w: ActionsWorld) => Promise<void>;
  readonly note: string;
  /** The card comes back, to be pressed again, with this button. */
  readonly again?: string;
}

const RUN_CASES: Case[] = [
  {
    name: "run",
    press: (w) => w.run(w.actionCard(w.message(), "quiet", "22:00-07:00")),
    note: "Ran /quiet 22:00-07:00",
  },
  {
    name: "cancelled",
    press: (w) => w.run(w.actionCard(w.message(), "quiet", "22:00-07:00"), ALICE, "cancel"),
    note: "was not run",
  },
  { name: "a card nobody recorded", press: (w) => w.run("forged"), note: "no longer valid" },
  {
    name: "a card recorded for someone else",
    press: (w) => w.run(w.actionCard(w.message(), "quiet", "x"), BOB),
    note: "no longer valid",
  },
  {
    name: "an op the card never had",
    press: (w) => w.run(w.actionCard(w.message(), "quiet", "x"), ALICE, "frobnicate"),
    note: "no longer valid",
  },
  {
    name: "a command the message did not declare",
    press: (w) => w.run(w.actionCard(w.message("a", ALICE, ["brief"]), "quiet", "x")),
    note: "nothing was run",
  },
  {
    name: "the command could not be run",
    arrange: (w) => {
      w.commandDone = false;
    },
    press: (w) => w.run(w.actionCard(w.message(), "quiet", "x")),
    note: "/quiet x could not be run",
  },
  ...["done", "busy"].map((state) => ({
    name: `a card that is ${state}`,
    press: (w: ActionsWorld) => {
      const card = w.actionCard(w.message(), "quiet", "22:00-07:00");
      w.store.assistantButtons.moveActionCard(card, state);
      return w.run(card);
    },
    note: "already pressed",
  })),
];

/** Each case on a world of its own: the click is settled once, by a note or a card again, and its line is said as well. */
async function eachReplacesTheCard(cases: readonly Case[]): Promise<void> {
  for (const c of cases) {
    const w = new ActionsWorld();
    c.arrange?.(w);
    await c.press(w);
    assert.equal(w.settled.length, 1, c.name);
    const card = w.card();
    assert.ok(card.text.includes(c.note), `${c.name}: ${card.text}`);
    assert.equal(w.said(), card.text, `${c.name}: said as a new message as well`);
    if (c.again === undefined) assert.equal(card.view, "note", c.name);
    else assert.deepEqual([card.view, card.model["allowLabel"]], ["confirmWrite", c.again], c.name);
  }
}

it("every press on run or cancel replaces the card with what happened", async () => {
  await eachReplacesTheCard(RUN_CASES);
});

// --- a write Claw holds until the person answers (`confirm_write`) ----------------------------------------------------------------

it("a held write is answered once as the person and says what came of it", async () => {
  const w = new ActionsWorld();
  const card = w.confirmCard("cf-1", "trigger_create", "创建");
  await w.confirm(card);
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-1", "allow"]], "as Alice, with her exchanged token, never her key");
  assert.ok(w.card().text.includes('Scheduled "PR brief": 0 9 * * * (Asia/Shanghai), next run 2026-11-07 09:00'));
  await w.confirm(card); // a second press
  assert.equal(w.decided.length, 1, "Claw is asked once");
  assert.ok(w.said().includes("already answered"));
});

it("two presses at once answer claw once", async () => {
  // A double tap: both presses read the card open and wait for the token before either claims it, so only the claim itself (the
  // move from open to busy) keeps Claw from being asked twice.
  const w = new ActionsWorld();
  const card = w.confirmCard();
  const plain = w.token;
  w.token = async (user) => {
    await Promise.resolve(); // both presses are past the card's open check here
    await Promise.resolve();
    return plain(user);
  };
  await Promise.all([w.confirm(card), w.confirm(card)]);
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-1", "allow"]], "Claw is asked once");
  assert.equal(w.store.assistantButtons.getConfirmCard(card)?.state, "done");
  assert.ok(
    w.settled.some((s) => typeof s.card === "string" && s.card.includes("already answered")),
    "the other press is told it was answered",
  );
});

it("a card answers only its own confirmation and only for its person", async () => {
  const w = new ActionsWorld();
  const card = w.confirmCard("cf-alice");
  await w.confirm(card, "allow", BOB); // Bob presses Alice's card
  await w.confirm("forged");
  await w.confirm(card, "allow", ALICE, { confirmation_id: "cf-bob" }); // what a click carries besides the id is ignored
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-alice", "allow"]]);
});

it("deny and what claw could not do are said plainly", async () => {
  const w = new ActionsWorld();
  await w.confirm(w.confirmCard("cf-1"), "deny");
  assert.equal(w.decided.at(-1)?.[2], "deny");
  assert.ok(w.said().includes("OK, not created."));
  w.held = { status: "failed", answered_now: true, result: { error: "trigger_limit_reached" } };
  await w.confirm(w.confirmCard("cf-2"));
  assert.ok(w.said().includes("as many scheduled tasks as allowed"));
  w.held = { status: "expired", answered_now: false, result: null };
  await w.confirm(w.confirmCard("cf-3", "trigger_cancel", "取消它"));
  assert.ok(w.said().includes("has expired"));
});

it("claw not answering gives the card back", async () => {
  const w = new ActionsWorld();
  const card = w.confirmCard();
  w.held = new ClawError(502);
  await w.confirm(card);
  assert.ok(w.said().includes("did not answer"));
  assert.equal(w.card().view, "confirmWrite");
  assert.deepEqual(w.card().model, {
    text: "PrimusClaw did not answer; nothing was done. Press it again.",
    cardId: card,
    allowLabel: "Create",
    lang: "en",
  });
  w.held = undefined;
  await w.confirm(card); // the same card, pressed again, now goes through
  assert.deepEqual(
    w.decided.map((d) => d[2]),
    ["allow", "allow"],
  );
  assert.ok(w.said().includes("Scheduled"));
});

it("a press that cannot be made as the person answers nothing and keeps the card", async () => {
  const w = new ActionsWorld();
  const card = w.confirmCard();
  w.token = () => Promise.resolve(err({ kind: "exchange_failed" as const, reason: "503" }));
  await w.confirm(card);
  assert.deepEqual(w.decided, []);
  assert.ok(w.said().includes("could not reach the Primus platform"));
  assert.equal(w.card().view, "confirmWrite");
  w.token = () => Promise.resolve(err({ kind: "not_bound" as const }));
  await w.confirm(card);
  assert.deepEqual(w.decided, []);
  assert.ok(w.said().includes("not connected to your Primus account"));
  assert.equal(w.card().view, "confirmWrite");
  // no identity service here: the card cannot be answered for them, and nothing tries the linked key
  w.exchangeOn = false;
  await w.confirm(card);
  assert.deepEqual(w.decided, []);
  assert.ok(w.said().includes("identity service is not on here"));
  w.held = new ClawError(403, '{"ok":false,"error":"service_client_not_allowed"}');
  w.exchangeOn = true;
  w.token = (user) => Promise.resolve(ok(`tok-${user}`));
  await w.confirm(card);
  assert.equal(w.decided.length, 1);
  assert.equal(
    w.said(),
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client. Nothing was done.",
  );
  assert.equal(w.store.assistantButtons.getConfirmCard(card)?.state, "done");
});

const SERVICE_REFUSED = new ClawError(403, '{"ok":false,"error":"service_client_not_allowed"}');

/** The token exchange answers `kind` instead of a token. */
function exchangeFails(kind: "not_bound" | "exchange_unavailable"): (w: ActionsWorld) => void {
  return (w) => {
    w.token = () => Promise.resolve(err({ kind }));
  };
}

function claw(held: ActionsWorld["held"]): (w: ActionsWorld) => void {
  return (w) => {
    w.held = held;
  };
}

const allow = (w: ActionsWorld) => w.confirm(w.confirmCard());

const CONFIRM_CASES: Case[] = [
  { name: "let through", press: allow, note: 'Scheduled "PR brief"' },
  { name: "not", press: (w) => w.confirm(w.confirmCard(), "deny"), note: "OK, not created." },
  {
    name: "not connected through the identity service: press again once connected",
    arrange: exchangeFails("not_bound"),
    press: allow,
    note: "not connected to your Primus account",
    again: "Create",
  },
  {
    name: "the platform cannot be reached: press again",
    arrange: exchangeFails("exchange_unavailable"),
    press: allow,
    note: "could not reach the Primus platform",
    again: "Create",
  },
  {
    name: "token exchange is off",
    arrange: (w) => {
      w.exchangeOn = false;
    },
    press: allow,
    note: "identity service is not on here",
  },
  { name: "Claw refuses the service", arrange: claw(SERVICE_REFUSED), press: allow, note: "Nothing was done." },
  { name: "a card nobody recorded", press: (w) => w.confirm("forged"), note: "no longer valid" },
  {
    name: "a card recorded for someone else",
    press: (w) => w.confirm(w.confirmCard(), "allow", BOB),
    note: "no longer valid",
  },
  { name: "an op the card never had", press: (w) => w.confirm(w.confirmCard(), "frobnicate"), note: "no longer valid" },
  {
    name: "Claw does not answer: press again",
    arrange: claw(new ClawUnreachable("network", "no route")),
    press: allow,
    note: "did not answer",
    again: "Create",
  },
  { name: "Claw has no such card of theirs", arrange: claw(new ClawError(404)), press: allow, note: "no longer valid" },
  {
    name: "it lapsed at Claw",
    arrange: claw({ status: "expired", answered_now: false, result: null }),
    press: allow,
    note: "has expired",
  },
  {
    name: "Claw could not do it",
    arrange: claw({ status: "failed", answered_now: true, result: { error: "trigger_limit_reached" } }),
    press: allow,
    note: "as many scheduled tasks as allowed",
  },
  ...["done", "busy"].map((state) => ({
    name: `a card that is ${state}`,
    press: (w: ActionsWorld) => {
      const card = w.confirmCard();
      w.store.assistantButtons.moveConfirmCard(card, state);
      return w.confirm(card);
    },
    note: "already answered",
  })),
];

it("every press on a held write replaces the card with what happened", async () => {
  await eachReplacesTheCard(CONFIRM_CASES);
});

it("a held write that is not answered for the person is said in their language", async () => {
  const w = new ActionsWorld();
  w.token = () => Promise.resolve(err({ kind: "not_bound" }));
  await w.confirm(w.confirmCard(), "allow", ALICE, {}, "zh");
  assert.equal(w.said(), "这个聊天还没通过身份服务连到你的 Primus 账号，没法替你确认。连接后再按一次。");
  assert.equal(w.card().model["lang"], "zh");
  w.exchangeOn = false;
  await w.confirm(w.confirmCard("cf-2"), "allow", ALICE, {}, "zh");
  assert.equal(w.said(), "这张卡要用你的登录身份确认，但这里没有开启身份服务，所以没法替你点。它一天后自动失效。");
  w.exchangeOn = true;
  w.token = (user) => Promise.resolve(ok(`tok-${user}`));
  w.held = new ClawError(403, '{"ok":false,"error":"interactive_sign_in_required"}');
  await w.confirm(w.confirmCard("cf-3"), "allow", ALICE, {}, "zh");
  assert.equal(w.said(), "PrimusClaw did not take my credential for you as a sign-in; tell the operator. 什么都没做。");
  w.held = new ClawError(500);
  await w.confirm(w.confirmCard("cf-4"), "allow", ALICE, {}, "zh");
  assert.equal(w.said(), "PrimusClaw 没有回应，什么都没做，请再点一次。");
  w.held = undefined;
  await w.confirm(w.confirmCard("cf-5"), "allow", ALICE, {}, "zh");
  assert.equal(
    w.said(),
    "已创建定时任务「PR brief」：0 9 * * *（Asia/Shanghai），下次 2026-11-07 09:00。每次结果会发到这里。",
  );
});

it("a failure that is not one of claws is not caught", async () => {
  const w = new ActionsWorld();
  const card = w.confirmCard();
  w.held = new TypeError("bug");
  await assert.rejects(w.confirm(card), TypeError);
  assert.equal(w.store.assistantButtons.getConfirmCard(card)?.state, "busy");
});

it("an instruction for an agent on the persons machine is sent only when they press it", async () => {
  const w = new ActionsWorld();
  w.held = {
    confirmation_id: "cf-send",
    kind: "devenv_send",
    status: "done",
    answered_now: true,
    result: { ok: true, seq: 7, machine: "laptop", agent: "claude", session_id: "s-1", item_id: "kwi_1" },
  };
  const card = w.confirmCard("cf-send", "devenv_send", "发送");
  assert.equal(w.decided.length, 0, "showing it sends nothing");
  await w.confirm(card);
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-send", "allow"]], "as Alice, with her exchanged token");
  assert.ok(w.card().text.includes("Sent to claude on laptop as #7."));
  w.held = { status: "failed", answered_now: true, result: { ok: false, error: "connector_offline" } };
  await w.confirm(w.confirmCard("cf-send-2", "devenv_send", "发送"));
  assert.ok(w.said().includes("That machine is offline now; nothing was sent."));
  w.held = undefined;
  await w.confirm(w.confirmCard("cf-send-3", "devenv_send", "发送"), "deny");
  assert.deepEqual(w.decided.at(-1), ["tok-aad-a", "cf-send-3", "deny"]);
});

const COMMENT = {
  type: "assistant.say",
  event_id: "say-cf-c1",
  user_id: "u-alice",
  text: "要以你的 GitHub 账号在 AMD-AGI/PrimusClaw#322 上发这条评论吗？",
  confirm_write: { confirmation_id: "cf-c1", ref: "cf0001", kind: "github_comment", allow_label: "发表" },
};

it("a drafted comment is a card and its press says where it was posted", async () => {
  const w = new ActionsWorld();
  assert.deepEqual(confirmWriteOf(COMMENT), { confirmationId: "cf-c1", kind: "github_comment", allowLabel: "发表" });
  const card = w.confirmCard("cf-c1", "github_comment", "发表");
  assert.deepEqual(w.decided, [], "nothing is posted by showing it");
  w.held = {
    status: "done",
    answered_now: true,
    result: { url: "https://github.com/AMD-AGI/PrimusClaw/pull/322#issuecomment-1" },
  };
  await w.confirm(card);
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-c1", "allow"]]);
  const said = w.card().text;
  assert.ok(said.includes("https://github.com/AMD-AGI/PrimusClaw/pull/322#issuecomment-1"));
  assert.ok(!said.toLowerCase().includes("scheduled") && !said.includes("run again"));
});

it("a drafted comment that could not be posted says why", async () => {
  const w = new ActionsWorld();
  w.held = { status: "failed", answered_now: true, result: { error: "no_github_token" } };
  await w.confirm(w.confirmCard("cf-c1", "github_comment", "发表"));
  assert.ok(w.said().includes("/github bind"));
  w.held = { status: "denied", answered_now: true, result: null };
  await w.confirm(w.confirmCard("cf-c2", "github_comment", "发表"), "deny");
  assert.ok(w.said().includes("not posted"));
});
