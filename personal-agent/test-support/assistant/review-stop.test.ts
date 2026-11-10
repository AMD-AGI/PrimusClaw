// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Stop card of a review Claw makes as an item (test_review_items.py): the asker's Stop goes to Claw as her (her linked key,
 * else her exchanged token), what Claw answers is said from the asker's view, nobody else can press it, the card is ended in
 * place when the review ends, and a late press on an ended card says so and never asks Claw. W7's review service asks and
 * follows; the press is Teams' own, routed by the router to this line's WorkCardClicks.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import {
  channelContext,
  type InboundAction,
  type JsonObject,
  type OutMessage,
  type UserRef,
  type WorkItem,
} from "@primusclaw/personal-agent";

import { peopleOf } from "../../packages/core/src/understanding/people.js";
import { reviewStop } from "../../packages/core/src/understanding/review-stop.js";
import { message } from "../routing/world.js";

import { ClawHttp } from "../../packages/runtime/src/claw/http.js";
import { HttpWorkItems } from "../../packages/runtime/src/claw/work-items.js";
import { RENDERERS, renderView } from "../../packages/teams/src/views/index.js";
import { inboundAction } from "../inbound.js";
import { ALICE, ALICE_DM, BOB, CONV, PR, groupMessage, saidIn, settleFollows } from "../review-world.js";
import { world as proactiveWorld } from "./proactive-world.js";
import { ALICE_KEY, itemsWorld, stoppedItem, type ItemsWorld } from "./review-presses.js";

type Json = Record<string, unknown>;
const LINK = "https://github.com/AMD-AGI/Hyperloom/pull/12";

/** Alice asks in the group (or in her 1:1 chat), and the review is followed as far as it goes (Python `asking`). */
async function asking(w: ItemsWorld, text: string, kind: "group" | "personal" = "group"): Promise<void> {
  const message = groupMessage(text, ALICE, [BOB], "g1", kind);
  await w.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: w.surface.conversation(message.conversation),
    scope: kind === "group" ? CONV : "",
    lang: () => "zh",
  });
  await settleFollows(w, 4);
}

/** Bob's item has not ended when Alice presses its Stop (Python `still_running`). */
function stillRunning(w: ItemsWorld): void {
  w.claw.views.set("item-1", [{ status: "in_progress", prUrl: "" }]);
}

function rendered(message: OutMessage): Json {
  const body = message.body;
  if (body.type !== "view") return {};
  const out = renderView(RENDERERS, body.view) as { attachments?: { content: Json }[] };
  return out.attachments?.[0]?.content ?? {};
}

/** The cards with a Stop in Alice's 1:1 chat (Python `item_cards`): the posted message's id and the card. */
function itemCards(w: ItemsWorld, conversation = ALICE_DM): { id: string; card: Json }[] {
  return w.surface.of(conversation).flatMap((r) => {
    if (r.op !== "post") return [];
    const card = rendered(r.message);
    const actions = (card["actions"] ?? []) as { data?: Json }[];
    return actions.some((a) => a.data?.["primusclaw"] === "work") ? [{ id: r.id, card }] : [];
  });
}

/** Teams' press on a card's Stop (Python `stop_click`), in the presser's own chat. */
function stopClick(found: { id: string; card: Json }, user: UserRef = ALICE, id = "k1"): InboundAction {
  const [stop] = (found.card["actions"] ?? []) as { verb: string; data: Json }[];
  assert.ok(stop !== undefined);
  const conversation = user.id === "aad-a" ? ALICE_DM : `personal:${user.id}`;
  return inboundAction({
    id,
    sender: user,
    conversation: {
      id: conversation,
      kind: "personal",
      tenantId: "tenant-1",
      wire: { conversation: { id: conversation } },
    },
    verb: String(stop.data["primusclaw"]),
    clickVerb: stop.verb,
    data: stop.data,
    cardMessageId: found.id,
  });
}

async function press(w: ItemsWorld, action: InboundAction): Promise<void> {
  await w.router.router.handle(action);
  await w.router.router.settled();
  await settleFollows(w, 6);
}

/** Every text said in Alice's 1:1 chat, and the cards' words there. */
function saidToAlice(w: ItemsWorld): string {
  const cards = w.surface.of(ALICE_DM).flatMap((r) => ("message" in r ? [JSON.stringify(rendered(r.message))] : []));
  return `${saidIn(w.surface, ALICE_DM)} ${cards.join(" ")}`;
}

/** The edits of cards in Alice's 1:1 chat (Python `card_edits`): the message edited and the card it now shows. */
function cardEdits(w: ItemsWorld): { id: string; card: Json }[] {
  return w.surface.of(ALICE_DM).flatMap((r) => (r.op === "update" ? [{ id: r.id, card: rendered(r.message) }] : []));
}

const stops = (w: ItemsWorld) => w.stops.calls.filter((c) => c[0] === "stop_item");

it("an asker without a key of her own can stop what she asked of bob", async () => {
  const w = itemsWorld();
  w.store.links.unlink("aad-a"); // (her Stop goes as her exchanged token: chats do not use the exchange)
  w.store.references.saveReference("aad-a", { conversation: { id: ALICE_DM } }); // (unlinking forgot her chat)
  stillRunning(w);
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.decision = { ok: true, item: stoppedItem(), error: "" };
  await press(w, stopClick(card));
  assert.deepEqual(stops(w), [["stop_item", "tok-aad-a", "item-1"]]);
  assert.ok(saidToAlice(w).includes("已停止 #1"), saidToAlice(w));
});

it("stop on the card stops that item as the asker and says so", async () => {
  const w = itemsWorld();
  stillRunning(w);
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.decision = { ok: true, item: stoppedItem(), error: "" };
  await press(w, stopClick(card));
  assert.deepEqual(stops(w), [["stop_item", ALICE_KEY, "item-1"]]);
  assert.ok(saidToAlice(w).includes("已停止 #1"));
});

for (const [error, said] of [
  ["already_merged", "已经合入了，停不了"],
  ["merge_in_progress", "正在合入，已经停不下来了"],
] as const) {
  it(`a stop claw refuses because github has the merge is said as it is (${error})`, async () => {
    const w = itemsWorld();
    stillRunning(w);
    await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
    const [card] = itemCards(w);
    assert.ok(card !== undefined);
    w.stops.decision = { ok: false, item: stoppedItem({ boardState: "done", outcome: "accepted" }), error };
    await press(w, stopClick(card));
    assert.ok(saidToAlice(w).includes(said), saidToAlice(w));
    assert.ok(!saidToAlice(w).includes("已停止"));
  });
}

it("the askers stop answered with her view alone is said and not said again", async () => {
  const w = itemsWorld();
  // (running while it is asked and followed, stopped once the press stopped it)
  w.claw.views.set("item-1", [...Array.from({ length: 6 }, () => ({ status: "in_progress" })), { status: "stopped" }]);
  w.stops.answer = [
    200,
    { ok: true, data: { params: { requester_view: { status: "stopped", pr_url: LINK, verdict: "", merged: false } } } },
  ];
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  await press(w, stopClick(card));
  assert.deepEqual(stops(w), [["stop_item", ALICE_KEY, "item-1"]]);
  assert.ok(saidToAlice(w).includes("已停止") && saidToAlice(w).includes(LINK), saidToAlice(w));
  // (the stop was said on the card; its view is not said again in the group)
  assert.ok(!saidIn(w.surface, CONV).includes("代审）："), saidIn(w.surface, CONV));
});

it("a stop refused as already merged is said from the askers view", async () => {
  const w = itemsWorld();
  stillRunning(w);
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.answer = [
    409,
    {
      ok: false,
      error: "already_merged",
      data: { requester_view: { status: "done", pr_url: LINK, verdict: "approve", merged: true } },
    },
  ];
  await press(w, stopClick(card));
  assert.ok(saidToAlice(w).includes("已经合入了，停不了"), saidToAlice(w));
});

it("nobody but the asker can press stop", async () => {
  const w = itemsWorld();
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.decision = { ok: true, item: stoppedItem(), error: "" };
  await press(w, stopClick(card, BOB));
  assert.deepEqual(stops(w), []);
});

it("when bobs review ends alices card shows how and has no stop", async () => {
  const w = itemsWorld();
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(w.surface, CONV).includes("（Bob 代审）：结论：批准，已合入"), saidIn(w.surface, CONV));
  const [sent] = itemCards(w);
  const edits = cardEdits(w);
  assert.equal(edits.length, 1, JSON.stringify(edits));
  const [edit] = edits as [{ id: string; card: Json }];
  assert.equal(edit.id, sent?.id);
  const words = JSON.stringify(edit.card);
  assert.ok(!("actions" in edit.card) && words.includes("已结束：结论：批准，已合入") && words.includes(PR), words);
  assert.ok(!words.includes("点「停止」"));
  const cardId = ((sent?.card["actions"] as { data: Json }[])[0]?.data["card"] ?? "") as string;
  assert.equal(w.store.assistantCards.getAssistantCard(cardId)?.state, "ended");
});

for (const [view, words] of [
  [{ status: "stopped", merged: false }, "已停止，没有合入"],
  [{ status: "failed", merged: false }, "已结束：没有完成，没有合入"],
  [{ status: "done", verdict: "request_changes", merged: false }, "已结束：结论：要求修改，没有合入"],
] as const) {
  it(`the ended card says how it ended (${words})`, async () => {
    const w = itemsWorld();
    w.claw.views.set("item-1", [
      { status: "in_progress", prUrl: "" },
      { prUrl: "", ...view },
    ]);
    await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
    const edits = cardEdits(w);
    assert.equal(edits.length, 1, JSON.stringify(edits));
    const [edit] = edits as [{ id: string; card: Json }];
    assert.ok(JSON.stringify(edit.card).includes(words) && !("actions" in edit.card), JSON.stringify(edit.card));
  });
}

it("a late press on the stop of an ended review says so and never asks claw", async () => {
  const w = itemsWorld();
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.decision = { ok: true, item: stoppedItem(), error: "" };
  await press(w, stopClick(card));
  assert.deepEqual(stops(w), []);
  const said = saidToAlice(w);
  assert.ok(said.includes("这个 review 已经结束了（已结束：结论：批准，已合入），不用再停"), said);
  assert.ok(!said.includes("已停止 #1"));
});

it("a press claw answers as closed says the review ended and offers no new stop", async () => {
  const w = itemsWorld();
  stillRunning(w);
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  w.stops.answer = [
    409,
    {
      ok: false,
      error: "item_closed",
      data: { requester_view: { status: "done", pr_url: LINK, verdict: "approve", merged: true } },
    },
  ];
  await press(w, stopClick(card));
  assert.deepEqual(stops(w), [["stop_item", ALICE_KEY, "item-1"]]);
  assert.ok(saidToAlice(w).includes("这个 review 已经结束了，不用再停"), saidToAlice(w));
  assert.equal(itemCards(w).length, 1); // (no new card with Stop)
});

it("in a one to one chat the card there is closed too", async () => {
  const w = itemsWorld();
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`, "personal");
  const [sent] = itemCards(w);
  const edits = cardEdits(w);
  assert.equal(edits.length, 1, JSON.stringify(edits));
  const [edit] = edits as [{ id: string; card: Json }];
  assert.equal(edit.id, sent?.id);
  assert.ok(JSON.stringify(edit.card).includes("已结束：结论：批准，已合入") && !("actions" in edit.card));
});

it("a card already pressed is left as the press made it", async () => {
  const w = itemsWorld();
  // (running while it is asked and followed, stopped once the press stopped it)
  w.claw.views.set("item-1", [...Array.from({ length: 6 }, () => ({ status: "in_progress" })), { status: "stopped" }]);
  w.stops.answer = [
    200,
    { ok: true, data: { params: { requester_view: { status: "stopped", pr_url: LINK, verdict: "", merged: false } } } },
  ];
  await asking(w, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  await press(w, stopClick(card));
  // (only the press's own edit of the card it was pressed on)
  assert.deepEqual(
    cardEdits(w).map((e) => e.id),
    [card.id],
  );
});

it("the owners whole item is never read as a view", async () => {
  // Bob's own stop (from his board) answers with his whole item, whose params carry the asker's view: Bob sees his item.
  const whole = {
    item_id: "item-1",
    seq: 1,
    title: `Review ${PR}`,
    board_state: "done",
    kind: "review",
    outcome: "stopped",
    params: { requester_view: { status: "stopped", pr_url: "u" } },
  };
  const client = new HttpWorkItems(
    new ClawHttp("https://claw.test", () =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, data: whole }), { status: 200 })),
    ),
  );
  const decision = await client.stop("ak-bob", "item-1");
  assert.deepEqual([decision.item.title, decision.item.seq], [`Review ${PR}`, 1]);
});

/** Alice asks a review of herself (her own account, her own key): followed in its session on the router (Python `asking_self`). */
async function askingSelf(w: ItemsWorld): Promise<void> {
  w.store.members.rememberMember("29:a", "aad-a", "Alice");
  w.identity.know("aad-a", "u-alice", "alice-gh", true);
  w.github.defaultAuthor = "carol-gh"; // (a pull request Alice did not write)
  const message = groupMessage(`请 {Alice} 帮我 review 合入 ${PR}`, ALICE, [ALICE]);
  await w.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: w.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

it("a stopped item ends its followed turn as stopped not as a failure", async () => {
  const w = itemsWorld();
  stillRunning(w);
  let open: () => void = () => undefined;
  w.router.turns.hold = new Promise<void>((resolve) => {
    open = resolve;
  });
  // (the turn the router follows the item with answers "Stopped." only when the stop reached it, as a /stop does)
  w.stops.decision = { ok: true, item: stoppedItem(), error: "" };
  await askingSelf(w);
  const [card] = itemCards(w);
  assert.ok(card !== undefined);
  await w.router.router.handle(stopClick(card));
  open();
  await w.router.router.settled();
  await settleFollows(w, 4);
  const said = saidIn(w.surface, CONV);
  assert.ok(said.includes("Stopped.") && !said.includes("ran into an error"), said);
});

it("a review item ends as one message and keeps its stop card", async () => {
  const w = itemsWorld();
  w.router.turns.answers = ["有两处必须修改：src/a.py:3、src/b.py:9。"];
  await askingSelf(w);
  await w.router.router.settled();
  await settleFollows(w, 4);
  assert.equal(itemCards(w).length, 1); // (the Stop card, in Alice's own chat)
  const group = w.surface.of(CONV).filter((r) => r.op === "send" || r.op === "post");
  assert.equal(group.length, 1, JSON.stringify(group)); // (the review ends as one message)
  assert.ok(saidIn(w.surface, CONV).includes("src/a.py:3"));
  // However late Claw closes the run, it is no "Run completed" card: the chat had its answer.
  const before = w.surface.outbox.length;
  const proactive = proactiveWorld({ on: { store: w.store, clock: w.clock } });
  await w.clock.advance(600_000);
  const late = {
    type: "run.completed",
    event_id: "ev-late",
    session_id: "s-1",
    message_id: "claw-1", // (Claw's id of the turn the router followed the item with)
    occurred_at: new Date(w.store.now() * 1000).toISOString(),
    title: "Run completed",
  };
  assert.equal(await proactive.proactive.handle("aad-a", proactive.reference, late), "dropped");
  assert.deepEqual(proactive.surface.outbox, []);
  assert.equal(w.surface.outbox.length, before);
});

/** Alice's assistant understands her: what it hears, with the people the chat's context names (Python `UnderstandingClaw`). */
function understandingAlice(w: ItemsWorld): [string, string, JsonObject][] {
  const heard: [string, string, JsonObject][] = [];
  const deps = w.router.deps as unknown as Record<string, unknown> & { assistant: Record<string, unknown> };
  deps.assistant = {
    ...deps.assistant,
    on: (userId: string) => userId === "aad-a",
    understands: (userId: string) => userId === "aad-a",
    reachable: () => true, // (the subscription with the assistant's events is not what is tested)
    understand: (request: { credential: string; prompt: string; context: JsonObject }) => {
      heard.push([request.credential, request.prompt, request.context]);
      return Promise.resolve(true);
    },
  };
  deps.channelContext = (request: { channelMessageId: string; message: { text: string } }) => {
    const known = w.store.members
      .knownMembers()
      .map((m) => ({ name: m.name, objectId: m.objectId, email: m.email ?? "" }));
    const people = peopleOf([], request.message.text, known, (aad) => w.store.links.clawUserIdOf(aad));
    return {
      context: channelContext({ channelMessageId: request.channelMessageId, people, pending: [], actions: [] }),
      actions: [],
      people: people.flatMap((p) => (p.user_id ? [p.user_id] : [])),
    };
  };
  return heard;
}

/** The group's "停 N" (the router's review stop, as the assembly registers it): what Claw lists running, and what it stopped. */
function groupStops(w: ItemsWorld, running: WorkItem[]): string[] {
  const stopped: string[] = [];
  const deps = w.router.deps as unknown as Record<string, unknown> & { handlers: { groupInterceptors: unknown[] } };
  deps.reviewStop = reviewStop;
  deps.handlers.groupInterceptors = [w.router.router.group.reviewStopInterceptor()];
  deps.claw = {
    ...(deps.claw as object),
    workItems: {
      list: () => Promise.resolve(running),
      stop: (_key: string, itemId: string) => {
        stopped.push(itemId);
        return Promise.resolve({ ok: true, item: stoppedItem({ itemId }), error: "" });
      },
    },
  };
  return stopped;
}

it("a review through the assistant and one through the old path both start and both stop", async () => {
  // Alice is listed for understanding: her 1:1 request goes to the assistant with Bob as a person carrying his Claw user id,
  // and the worker starts nothing; her group request (of herself) still starts a review item with a Stop card and a
  // followed turn. A group stop then stops either item in Claw at once, and the followed turn ends as stopped.
  const w = itemsWorld();
  const PR2 = "AMD-AGI/Hyperloom#13";
  w.store.links.setClawUserId("aad-b", "u-bob"); // (Bob is linked, as Claw user u-bob)
  const heard = understandingAlice(w);
  const pull = (n: number) => ({ owner: "AMD-AGI", repo: "Hyperloom", number: n });
  const stopped = groupStops(w, [
    stoppedItem({
      itemId: "item-a",
      seq: 7,
      title: `Review ${PR2}`,
      boardState: "in_progress",
      outcome: null,
      pull: pull(13),
    }),
    stoppedItem({ itemId: "item-1", seq: 1, boardState: "in_progress", outcome: null, pull: pull(12) }),
  ]);
  // 1:1: the assistant has it; the worker neither asks the review route nor makes a session
  await w.router.router.handle(message(`请 Bob 帮我 review 合入 ${PR2}`, { id: "d1" }));
  await w.router.router.settled();
  assert.deepEqual(
    heard.map(([, text]) => text),
    [`请 Bob 帮我 review 合入 ${PR2}`],
  );
  const people = (heard[0]?.[2]["people"] ?? []) as JsonObject[];
  assert.ok(
    people.some((p) => p["name"] === "Bob" && p["user_id"] === "u-bob"),
    JSON.stringify(people),
  );
  assert.deepEqual(
    w.claw.calls.filter((c) => c[0] === "startReviews"),
    [],
  );
  assert.deepEqual(w.router.turns.calls, []);
  // group: a review Alice asks of herself starts a Claw review item, with its Stop card in her 1:1 chat and its session followed
  let open: () => void = () => undefined;
  w.router.turns.hold = new Promise<void>((resolve) => {
    open = resolve;
  });
  stillRunning(w);
  await askingSelf(w);
  const sent = w.claw.calls
    .filter((c) => c[0] === "startReviews")
    .map((c) => c[2] as { prs: { pull: { number: number } }[] });
  assert.deepEqual(
    sent.map((body) => body.prs.map((p) => p.pull.number)),
    [[12]],
  );
  assert.equal(itemCards(w, "dm-aad-a").length, 1); // (her 1:1 chat, as her message there recorded it)
  assert.deepEqual(
    w.router.turns.runs.map((r) => r.sessionId),
    ["s-1"],
  );
  // a group stop for each: Claw is asked at once, as Alice
  const inGroup = (text: string, id: string) => message(text, { id, kind: "group", conversation: CONV });
  await w.router.router.handle(inGroup("停 13", "g2"));
  await w.router.router.handle(inGroup("停 12", "g3"));
  open();
  await w.router.router.settled();
  assert.deepEqual(stopped, ["item-a", "item-1"]);
  const said = saidIn(w.surface, CONV);
  assert.ok(
    said.includes("AMD-AGI/Hyperloom#13：代审已停下。") && said.includes("AMD-AGI/Hyperloom#12：代审已停下。"),
    said,
  );
  assert.ok(said.includes("Stopped.") && !said.includes("ran into an error"), said);
});
