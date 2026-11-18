// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's receipt follows its turn (tests/test_assistant_live_status.py): the steps the turn takes show in the status, the
 * words of its reply stream into it, and the reply closes it with the same words, whole. Everything degrades to the receipt of
 * before.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { flushMicrotasks } from "../../../../test-support/clock.js";
import { finals, liveWorld, sent, streamed } from "../../../../test-support/assistant/live-world.js";
import { modelOf, viewsOf } from "../../../../test-support/assistant/view-of.js";
import { LIVE_ONLY, SAY_TOOL, TurnFollower } from "../../src/assistant/follow.js";
import type { AssistantChat as AssistantChatPort } from "../../src/routing/features.js";
import { ALICE as ROUTER_ALICE } from "../../../../test-support/routing/fixtures.js";
import { message, world as routerWorld } from "../../../../test-support/routing/world.js";
import type { JsonObject } from "../../src/json.js";
import type { OutMessage } from "../../src/ports/surface.js";

const ANSWER = "节点：12 个就绪，3 个忙。";
const ASKED = "现在有多少节点在忙？";
const RECEIVED = "收到，处理中";
const BOTH = "查询 SaFE 节点 · 查询 SaFE 工作负载…";

type Live = Awaited<ReturnType<typeof liveWorld>>;

/** A router turn that looks up two things at once (and a step of another turn of the session between), then its words. */
async function turn(l: Live, options: { words?: boolean; steps?: number } = {}) {
  const events: [string, Record<string, string>, string?][] = [
    ["statusUpdate", { agentStatus: "running" }],
    ["toolUsed", { tool: "mcp__safe__node_list", actionId: "t1", status: "start" }],
    ["toolUsed", { tool: "mcp__safe__workload_list", actionId: "t2", status: "start" }],
    ["toolUsed", { tool: "mcp__safe__node_list", actionId: "t1", status: "success" }],
    ["toolUsed", { tool: "mcp__assistant__work_create", actionId: "t9", status: "start" }, "m-wake"],
  ];
  if (options.words ?? true) {
    events.push(["toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: " 节点：" }]);
    events.push(["toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: " 节点：12 个就绪" }]);
  }
  events.push(["toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" }], ["AssistantSay", { text: ANSWER }]);
  for (const [name, data, id] of events.slice(0, options.steps ?? events.length)) await l.live(name, data, id);
}

async function liveTurn(
  play: (l: Live) => Promise<void>,
  options: { reply?: string; item?: JsonObject; progress?: boolean; streamSay?: boolean } = {},
) {
  const l = await liveWorld({
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.streamSay === undefined ? {} : { streamSay: options.streamSay }),
  });
  assert.equal(await l.w.say(ASKED), true);
  await play(l);
  const reply = options.reply ?? ANSWER;
  const event = {
    type: "assistant.say",
    event_id: "e-1",
    text: reply,
    ...(options.item ? { item: options.item } : {}),
  };
  assert.equal(await l.push(event), "delivered");
  await flushMicrotasks();
  return l;
}

const wordsOf = (m: OutMessage | undefined) =>
  m === undefined ? "" : m.body.type === "text" ? m.body.text : m.body.type === "rich" ? m.body.markdown : "";

it("the receipt shows the steps then streams the words and the reply closes it with them whole", async () => {
  const l = await liveTurn((x) => turn(x));
  const outbox = l.w.surface.outbox;
  assert.deepEqual(streamed(outbox, "open"), [RECEIVED]);
  const informative = streamed(outbox, "inform");
  assert.ok(
    informative.some((line) => line.includes("查询 SaFE 节点")),
    informative.join("|"),
  );
  assert.equal(informative.at(-1), BOTH, "only this message's turn: not the step of another");
  const words = streamed(outbox, "emit");
  assert.equal(words.at(-1), "节点：12 个就绪");
  assert.ok(words.every((t) => ANSWER.startsWith(t)));
  const [final, ...more] = finals(outbox);
  assert.deepEqual(more, []);
  assert.ok(final?.body.type === "text" && final.body.text === ANSWER, "the streamed words, now whole");
  assert.deepEqual([final.aiGenerated, final.feedback], [true, true], "the thumbs and the AI label");
  assert.ok(!sent(outbox).some((m) => wordsOf(m).includes(ANSWER)), "not also sent as a message");
  assert.deepEqual(l.w.feed.afters, [LIVE_ONLY], "only the live part of the session's stream: none of its history");
});

it("without words from claw the steps show and the reply closes the receipt as before", async () => {
  const l = await liveTurn((x) => turn(x, { words: false }));
  const outbox = l.w.surface.outbox;
  assert.equal(streamed(outbox, "inform").at(-1), BOTH);
  assert.deepEqual(streamed(outbox, "emit"), []);
  const [final] = finals(outbox);
  assert.ok(
    final?.body.type === "rich" && final.body.markdown.includes(ANSWER),
    "the reply's own rich message, as before",
  );
});

it("a reply that is not what was streamed replaces those words", async () => {
  const other = "抱歉，刚才说错了：有 12 个节点。";
  const l = await liveTurn((x) => turn(x), { reply: other });
  const [final] = finals(l.w.surface.outbox);
  assert.ok(wordsOf(final).includes(other));
  assert.ok(!wordsOf(final).includes("节点：12 个就绪"));
  assert.ok(
    !sent(l.w.surface.outbox).some((m) => wordsOf(m).includes(other)),
    "one message: the reply is not sent again",
  );
});

it("the stream followed is closed once the reply has closed the receipt", async () => {
  const l = await liveWorld();
  await l.w.say(ASKED);
  await turn(l, { words: false, steps: 3 }); // (the steps, then silence)
  const following = l.w.feed.open;
  assert.equal(await l.push({ type: "assistant.say", event_id: "e-1", text: ANSWER }), "delivered");
  await flushMicrotasks();
  assert.deepEqual([following, l.w.feed.open], [1, 0]);
});

it("a second message while the first ones receipt is open shows nothing in it", async () => {
  const l = await liveWorld();
  await l.w.say(ASKED);
  await turn(l, { words: false, steps: 2 }); // (the first turn looks at the nodes, and its reply is late)
  await l.w.say("帮我把 CI 修一下");
  await l.live("toolUsed", { tool: "mcp__assistant__work_create", actionId: "w1", status: "start" }, "msg-2");
  await l.live("toolTextDelta", { tool: SAY_TOOL, actionId: "w2", text: "已接手" }, "msg-2");
  const informative = streamed(l.w.surface.outbox, "inform");
  assert.ok(
    informative.some((line) => line.includes("查询 SaFE 节点")),
    informative.join("|"),
  );
  assert.ok(!informative.some((line) => line.includes("创建任务")));
  assert.deepEqual(streamed(l.w.surface.outbox, "emit"), []);
});

it("with progress off nothing is followed", async () => {
  const l = await liveTurn((x) => turn(x), { progress: false });
  assert.deepEqual(l.w.feed.afters, []);
  assert.deepEqual(
    [
      streamed(l.w.surface.outbox, "open"),
      streamed(l.w.surface.outbox, "inform"),
      streamed(l.w.surface.outbox, "emit"),
    ],
    [[RECEIVED], [], []],
  );
});

it("with streaming of the words off only the steps show", async () => {
  const l = await liveTurn((x) => turn(x), { streamSay: false });
  assert.deepEqual(streamed(l.w.surface.outbox, "emit"), []);
  assert.ok(streamed(l.w.surface.outbox, "open").length + streamed(l.w.surface.outbox, "inform").length >= 2);
});

it("a queued message shows nothing of the turn that is running", async () => {
  const l = await liveWorld();
  l.w.claw.queue = true;
  await l.w.say("还有呢？");
  await l.live("toolUsed", { tool: "mcp__safe__node_list", status: "start" }, "m-earlier");
  assert.deepEqual(streamed(l.w.surface.outbox, "open"), [RECEIVED]);
  assert.deepEqual(streamed(l.w.surface.outbox, "inform"), []);
  assert.equal(l.w.feed.open, 0, "the stream it opened is closed again");
  assert.ok(l.w.receipts.take("c-aad-a"), "the receipt is left as it was, for the reply to close");
});

const flat = (t: string) => t.replace(/\s+/gu, "");

it("a long reply after streamed words says nothing twice", async () => {
  const paragraphs = Array.from({ length: 64 }, (_, i) => `第${String(i)}段：${"这是一段很长的回答，".repeat(14)}`);
  const long = paragraphs.join("\n\n").slice(0, 9000).trimEnd();
  const shown = long.slice(0, 3500);
  const l = await liveTurn(
    async (x) => {
      await x.live("statusUpdate", { agentStatus: "running" });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: long.slice(0, 1200) });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: shown });
      await x.live("toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" });
    },
    { reply: long },
  );
  const [final] = finals(l.w.surface.outbox);
  assert.equal(wordsOf(final), shown);
  const after = sent(l.w.surface.outbox)
    .map(wordsOf)
    .filter((t) => t.trim());
  assert.ok(after.length >= 1 && after.length <= 2, String(after.length));
  assert.ok(!after.some((t) => t.includes(long.slice(3000, 3400))), "what the receipt shows is not said again");
  assert.equal(flat(wordsOf(final)) + after.map(flat).join(""), flat(long), "the reply, whole, once");
});

it("a long reply streamed whole with a trailing blank is not said again", async () => {
  const long = Array.from({ length: 30 }, (_, i) => `第${String(i)}段：${"这是一段很长的回答，".repeat(14)}`)
    .join("\n\n")
    .slice(0, 3900)
    .trimEnd();
  const l = await liveTurn(
    async (x) => {
      await x.live("statusUpdate", { agentStatus: "running" });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: long.slice(0, 1500) });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: `${long} ` });
      await x.live("toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" });
    },
    { reply: long },
  );
  assert.equal(wordsOf(finals(l.w.surface.outbox)[0]).trimEnd(), long);
  assert.deepEqual(
    sent(l.w.surface.outbox)
      .map(wordsOf)
      .filter((t) => t.trim()),
    [],
    "nothing of it is said again",
  );
});

it("a streamed reply about a result is said once and its card follows with the buttons", async () => {
  const words = "结果已经好了，请看一下再决定是否接受。";
  const item = {
    item_id: "it-1",
    seq: 1,
    title: "周报",
    board_state: "needs_you",
    result_version: 1,
    can_accept: true,
    last_report_kind: "ready",
  };
  const l = await liveTurn(
    async (x) => {
      await x.live("statusUpdate", { agentStatus: "running" });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: words.slice(0, 8) });
      await x.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text: words });
      await x.live("toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" });
    },
    { reply: words, item },
  );
  assert.equal(wordsOf(finals(l.w.surface.outbox)[0]), words);
  const cards = viewsOf(sent(l.w.surface.outbox));
  assert.deepEqual(
    cards.map((c) => c.name),
    ["workCard"],
  );
  const model = modelOf(cards[0], "workCard");
  assert.equal(model.item.canAccept, true);
  assert.ok(!model.text.includes(words), "the words are not said again in the card");
});

// --- a reply closes only the receipt of the message it answers (internal #496) -------------------------------------------------

const RESULT_796 = "**❌ #796 删除 SaFE workload（global-cpu）未执行**：你在审批卡片上拒绝了删除。";
const STARTED_797 = "已开始：#797 写问候语存成 hello.md。有结果或需要你时我会告诉你。";
const ALICE = "aad-a";
const SID = "asst-ak-alice"; // (the fake's assistant session of Alice's key)

/**
 * A 1:1 message to the assistant while another turn of its session (a task's report woke it) is running, the turn
 * `claw-pending-3934`. An event of `otherKind` arrives while the message's receipt is open, then the message's own reply, said
 * by `ownTurn`. With `queued`, Claw queued the message behind the running turn (no message id). `when` the other event arrives:
 * "after" the message was handed over, "before_send" (the receipt is open and the message not yet handed over) or "in_flight"
 * (Claw has the message and has not answered the send yet). Returns the outbox and whether the receipt was still open after the
 * other event (Python `other_turn_meanwhile`).
 */
async function otherTurnMeanwhile(o: {
  queued: boolean;
  otherKind: string;
  otherText: string;
  otherExtra: JsonObject;
  ownTurn: string;
  when?: "after" | "before_send" | "in_flight";
  /** The message comes through the worker's router (its 1:1 chat, as Teams sends it), not straight to the assistant. */
  viaRouter?: boolean;
}) {
  const when = o.when ?? "after";
  const l = await liveWorld();
  l.w.claw.running.add(SID);
  l.w.claw.turnMessage = "claw-pending-3934";
  l.w.claw.queue = o.queued;
  const conversation = `c-${ALICE}`;
  const seen: boolean[] = [];
  const pushOther = async (): Promise<void> => {
    assert.ok(l.w.receipts.openOf(conversation) !== undefined, "the message has a receipt of its own");
    const other = { type: o.otherKind, event_id: "e-other", text: o.otherText, ...o.otherExtra };
    assert.equal(await l.push(other), "delivered");
    seen.push(l.w.receipts.openOf(conversation) !== undefined);
  };
  const send = l.w.claw.assistant.send;
  (l.w.claw.assistant as { send: typeof send }).send = async (...args) => {
    const out = await send(...args);
    if (when === "in_flight") await pushOther();
    return out;
  };
  // (the turn in front is read once the receipt is open and before the message is handed over)
  l.w.claw.onTurn = async () => {
    if (when !== "before_send") return;
    // (the read starts beside the receipt being opened and is waited for before the message is handed over)
    for (let i = 0; i < 50 && l.w.receipts.openOf(conversation) === undefined; i += 1) await flushMicrotasks();
    await pushOther();
  };
  const asked = "写一句问候语存成 hello.md，先问我中文还是英文";
  try {
    if (o.viaRouter === true) {
      const r = routerWorld({
        testStore: { store: l.w.store, clock: l.w.clock } as never,
        surface: l.w.surface,
        // (the assistant as the assembly hands it to the router: its methods, bound)
        assistant: {
          on: (userId) => l.w.chat.on(userId),
          understands: (userId) => l.w.chat.understands(userId),
          reachable: (userId) => l.w.chat.reachable(userId),
          route: (request) => l.w.chat.route(request),
        } satisfies Partial<AssistantChatPort>,
      });
      const inbound = message(asked, { user: { ...ROUTER_ALICE, id: ALICE }, conversation, id: "act-1" });
      // (Teams' reference of the chat names the activity being answered: the receipt stands under it)
      const wire = { ...inbound.conversation.wire, activityId: "act-1" };
      await r.router.handle({ ...inbound, conversation: { ...inbound.conversation, wire } });
      await r.router.settled();
      assert.deepEqual(l.w.heard(), [asked]);
    } else {
      assert.equal(await l.w.say(asked), true);
    }
  } finally {
    l.w.claw.running.delete(SID);
  }
  if (when === "after") await pushOther();
  await flushMicrotasks();
  const openAfterOther = seen.length === 1 && seen[0] === true && l.w.receipts.openOf(conversation) !== undefined;
  const own = { type: "assistant.say", event_id: "e-own", text: STARTED_797, turn_message_id: o.ownTurn };
  assert.equal(await l.push(own), "delivered");
  await flushMicrotasks();
  return { outbox: l.w.surface.outbox, openAfterOther, calls: [...l.w.claw.calls] };
}

const textOf = (m: OutMessage) =>
  m.body.type === "text" ? m.body.text : m.body.type === "rich" ? m.body.markdown : JSON.stringify(m.body);

function assertClosedByItsOwnReply(r: Awaited<ReturnType<typeof otherTurnMeanwhile>>, otherMark: string): void {
  assert.ok(r.openAfterOther, "the other turn's words leave the receipt open");
  const closedWith = finals(r.outbox).map(textOf);
  assert.ok(closedWith.length === 1 && closedWith[0]?.includes("#797"), JSON.stringify(closedWith));
  const messages = sent(r.outbox).map(textOf);
  assert.ok(
    messages.some((t) => t.includes(otherMark)),
    JSON.stringify(messages),
  );
  assert.ok(!messages.some((t) => t.includes("#797")), JSON.stringify(messages));
}

it("another turns reply while a queued message waits is a message of its own", async () => {
  // The release gate's failure (2026-11-10 05:11Z): the message asking for #797 was queued behind the turn reporting #796
  // (claw-pending-3934), whose "❌ #796 … 未执行" closed the receipt under the #797 message.
  const r = await otherTurnMeanwhile({
    queued: true,
    otherKind: "assistant.say",
    otherText: RESULT_796,
    otherExtra: { turn_message_id: "claw-pending-3934" },
    ownTurn: "claw-pending-3935",
  });
  assertClosedByItsOwnReply(r, "#796");
  // (what goes to Claw, in order: the assistant's session, the turn in front of the message, the message)
  assert.deepEqual(
    r.calls.filter((c) => c !== "upload"),
    ["session", "turn", "send"],
  );
});

it("another turns reply while a queued message waits is a message of its own, through the router", async () => {
  // (the same, end to end: Alice's message as Teams sends it, read by the router, which hands it to the assistant)
  const r = await otherTurnMeanwhile({
    queued: true,
    otherKind: "assistant.say",
    otherText: RESULT_796,
    otherExtra: { turn_message_id: "claw-pending-3934" },
    ownTurn: "claw-pending-3935",
    viaRouter: true,
  });
  assertClosedByItsOwnReply(r, "#796");
});

it("another turns reply does not close the receipt of a message claw took at once", async () => {
  const r = await otherTurnMeanwhile({
    queued: false,
    otherKind: "assistant.say",
    otherText: RESULT_796,
    otherExtra: { turn_message_id: "claw-pending-3934" },
    ownTurn: "msg-1", // (the message's id, as Claw gave it at once)
  });
  assertClosedByItsOwnReply(r, "#796");
});

for (const queued of [true, false]) {
  for (const when of ["before_send", "in_flight"] as const) {
    it(`another turns reply while the message is being handed over is a message of its own (${when}, ${queued ? "queued" : "taken"})`, async () => {
      const r = await otherTurnMeanwhile({
        queued,
        otherKind: "assistant.say",
        otherText: RESULT_796,
        otherExtra: { turn_message_id: "claw-pending-3934" },
        ownTurn: queued ? "claw-pending-3935" : "msg-1",
        when,
      });
      assertClosedByItsOwnReply(r, "#796");
    });
  }
}

it("a reply naming no turn before the message is handed over is a message of its own", async () => {
  // (Claw's notice of a lost turn is an assistant.say with no turn_message_id)
  const r = await otherTurnMeanwhile({
    queued: true,
    otherKind: "assistant.say",
    otherText: RESULT_796,
    otherExtra: {},
    ownTurn: "claw-pending-3935",
    when: "before_send",
  });
  assertClosedByItsOwnReply(r, "#796");
});

it("a tasks own notice never closes the receipt of a message", async () => {
  const r = await otherTurnMeanwhile({
    queued: true,
    otherKind: "work_item.needs_you",
    otherText: "#796 needs your attention.",
    otherExtra: { fallback: true },
    ownTurn: "claw-pending-3935",
  });
  assertClosedByItsOwnReply(r, "#796");
});

it("a reply that names no turn still closes the receipt", async () => {
  const r = await otherTurnMeanwhile({
    queued: true,
    otherKind: "assistant.say",
    otherText: STARTED_797,
    otherExtra: {},
    ownTurn: "claw-pending-3935",
  });
  assert.equal(r.openAfterOther, false);
  const closedWith = finals(r.outbox).map(textOf);
  assert.ok(closedWith.length === 1 && closedWith[0]?.includes("#797"), JSON.stringify(closedWith));
});

// --- the turn is followed from just before the message is sent (internal #505) ---------------------------------------------

/**
 * A 1:1 message to the assistant, logging in which order it reads the turn in front of it, starts following its turn and is sent
 * (with how many streams of the session Claw had been asked for by then); `understood`: a person the assistant understands
 * (`AssistantChat.understand`), else one it takes over (`AssistantChat.route`); `send` replaces the send, `afterSend` runs
 * once Claw took it. Returns the order, the outbox and the streams still open at the end (Python `hand_over`).
 */
async function handOver(o: {
  queued: boolean;
  understood: boolean;
  send?: () => Promise<string | null>;
  afterSend?: (l: Awaited<ReturnType<typeof liveWorld>>, messageId: string | null) => Promise<void>;
  /** Runs once the message was handed over (what the turn says next). */
  after?: (l: Awaited<ReturnType<typeof liveWorld>>) => Promise<void>;
}) {
  const l = await liveWorld(o.understood ? { understanding: [ALICE] } : {});
  l.w.claw.queue = o.queued;
  const order: string[] = [];
  const asked = () => l.w.feed.opened;
  l.w.claw.onTurn = async () => {
    // (the read of the turn in front is a round trip: a stream asked for meanwhile was asked before it was read)
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    if (l.w.feed.afters.length > 0) order.push("following");
    order.push("turn in front read");
  };
  const send = l.w.claw.assistant.send;
  (l.w.claw.assistant as { send: typeof send }).send = async (...args) => {
    if (l.w.feed.afters.length > 0 && !order.includes("following")) order.push("following");
    order.push(`sent, ${String(asked())} stream asked for`);
    const out = o.send === undefined ? await send(...args) : await o.send();
    await o.afterSend?.(l, out);
    return out;
  };
  const text = "现在有多少节点在忙？";
  try {
    if (o.understood) {
      await l.w.chat.understand({
        userId: ALICE,
        credential: "ak-alice",
        modelKey: "",
        prompt: text,
        context: { channel_message_id: "m-1" },
        lang: "zh",
        conversation: l.w.conversation(),
        files: [],
      });
    } else {
      await l.w.say(text);
    }
  } catch {
    // (a send that fails in a way no handler names comes back as it is)
  }
  await o.after?.(l);
  await flushMicrotasks();
  return { order, outbox: l.w.surface.outbox, stillOpen: l.w.feed.open, opened: l.w.feed.opened };
}

for (const understood of [false, true]) {
  for (const queued of [false, true]) {
    it(`the turn is followed from before the message is sent and after the turn in front is read (${understood ? "understand" : "route"}, ${queued ? "queued" : "taken"})`, async () => {
      // (L1 self-check) the turn in front is read, then the turn is followed, and the message is sent only once Claw has
      // answered the stream's request: three requests to Claw in one order, every time.
      const { order } = await handOver({ queued, understood });
      assert.deepEqual(order, ["turn in front read", "following", "sent, 1 stream asked for"]);
    });
  }
}

for (const understood of [false, true]) {
  it(`a turn that says its first step at once shows it (${understood ? "understand" : "route"})`, async () => {
    // A turn whose first step comes the moment Claw takes the message: the stream was open before the message was sent.
    const { outbox } = await handOver({
      queued: false,
      understood,
      // (the turn's script: its first step the moment Claw takes the message, then its say 0.05 s later)
      afterSend: async (l, messageId) => {
        await l.live("toolUsed", { tool: "mcp__safe__node_list", actionId: "t1", status: "start" }, messageId ?? "");
      },
      after: (l) => l.live("toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" }),
    });
    const informative = streamed(outbox, "inform");
    assert.ok(
      informative.some((line) => line.includes("查询 SaFE 节点")),
      JSON.stringify(informative),
    );
  });
}

it("a send that fails in a way no handler names still closes the stream", async () => {
  const { stillOpen } = await handOver({
    queued: false,
    understood: true,
    send: () => Promise.reject(new Error("a failure no handler names")),
  });
  assert.equal(stillOpen, 0, "the stream is closed");
});

for (const understood of [false, true]) {
  it(`a message cancelled while its stream opens leaves no stream open (${understood ? "understand" : "route"})`, async () => {
    // (internal #505, codex r2) The message stopped while it waited for its turn's stream to open: the follower it started is
    // settled all the same and its stream closed. A promise cannot be cancelled: here the wait ends in an error instead.
    const wait = Object.getOwnPropertyDescriptor(TurnFollower.prototype, "waitOpen");
    assert.ok(wait !== undefined);
    Object.defineProperty(TurnFollower.prototype, "waitOpen", {
      ...wait,
      // (the stream opens at Claw while the message waits for it; then the message stops)
      value: async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        throw new Error("the message was cancelled");
      },
    });
    try {
      const { stillOpen, opened } = await handOver({ queued: false, understood });
      assert.equal(opened, 1, "the stream was asked for");
      assert.equal(stillOpen, 0, "the stream is closed");
    } finally {
      Object.defineProperty(TurnFollower.prototype, "waitOpen", wait);
    }
  });
}
