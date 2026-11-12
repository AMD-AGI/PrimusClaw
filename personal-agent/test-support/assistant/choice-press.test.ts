// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A choice card as a person in Teams answers it, end to end: the say is planned (`SayPlanner`) and drawn by the Teams renderer, the
 * person ticks options on that very card and presses its Send, Teams sends the press (an `adaptiveCard/action` invoke on desktop and
 * mobile, whose data carries the card's inputs beside the button's; an Action.Submit message from an older client), the Teams
 * adapter reads it (`toInboundEvent`), and the real router dispatches it to the real handler, whose message reaches the real
 * assistant chat as the person's own.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "../../packages/teams/src/cards/json.js";
import { toInboundEvent } from "../../packages/teams/src/activity/inbound/to-event.js";
import { assistantRenderers } from "../../packages/teams/src/views/assistant/index.js";
import { AssistantChoiceClicks } from "../../packages/core/src/assistant/choice-clicks.js";
import { SayPlanner } from "../../packages/core/src/assistant/say.js";
import { AssistantWorld, ALICE } from "./assistant-world.js";
import { world } from "../routing/world.js";

async function teamsWorld() {
  const aw = await AssistantWorld.start();
  const late: { w?: ReturnType<typeof world> } = {};
  const w = world({
    testStore: { store: aw.store, clock: aw.clock, encryptionKeys: [] },
    assistantChat: aw.chat,
    ...(aw.subs ? { subscriptions: aw.subs } : {}),
    handlers: {
      clicks: [
        new AssistantChoiceClicks({
          store: aw.store,
          deliver: (message) => (late.w ? late.w.router.handle(message) : Promise.reject(new Error("no router"))),
        }),
      ],
    },
  });
  late.w = w;
  const planner = new SayPlanner({
    store: aw.store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  return { aw, w, planner };
}

/** The Teams card a say with `choices` is drawn as. */
function drawn(planner: SayPlanner, text: string, choices: unknown): JsonObject {
  const [message] = planner.messages(ALICE, { type: "assistant.say", text, choices });
  const body = message?.body;
  assert.ok(body?.type === "view" && body.view.name === "choiceCard");
  const activity = assistantRenderers.choiceCard(body.view.model);
  const attachment = (activity["attachments"] as JsonObject[])[0];
  return attachment?.["content"] as JsonObject;
}

/** The values of the options titled `titles` on the card's choice set, joined as Teams joins a multiple choice's. */
function ticked(card: JsonObject, titles: readonly string[]): { id: string; value: string; multiple: boolean } {
  const set = (card["body"] as JsonObject[]).find((e) => e["type"] === "Input.ChoiceSet");
  assert.ok(set);
  const choices = set["choices"] as { title: string; value: string }[];
  const value = titles.map((t) => choices.find((c) => c.title === t)?.value ?? "missing").join(",");
  const id = set["id"];
  assert.ok(typeof id === "string");
  return { id, value, multiple: set["isMultiSelect"] === true };
}

let presses = 0;

/** What Teams sends for Send with `inputs` filled in: an Action.Execute invoke (desktop, web, mobile), or an Action.Submit message. */
function press(card: JsonObject, inputs: JsonObject, submit = false): JsonObject {
  const [send] = card["actions"] as JsonObject[];
  assert.ok(send && send["type"] === "Action.Execute");
  const data = { ...(send["data"] as JsonObject), ...inputs };
  const base = {
    id: `inv-${String((presses += 1))}`,
    replyToId: "card-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:a", aadObjectId: ALICE, name: "Alice" },
    recipient: { id: "28:bot" },
    conversation: { id: "dm-aad-a", conversationType: "personal" },
  };
  return submit
    ? { ...base, type: "message", text: "", value: data }
    : {
        ...base,
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: { type: "Action.Execute", verb: send["verb"] as string, data } },
      };
}

async function handled(w: Awaited<ReturnType<typeof teamsWorld>>["w"], activity: JsonObject) {
  const read = toInboundEvent(activity);
  assert.ok(read.ok && read.value?.type === "action");
  await w.router.handle(read.value);
  await w.router.settled();
}

it("a single choice ticked on the Teams card and sent: the assistant hears the option as the person's message", async () => {
  const { aw, w, planner } = await teamsWorld();
  const card = drawn(planner, "部署到哪个集群？", { options: ["prod（生产）", "staging（测试）"] });
  const input = ticked(card, ["staging（测试）"]);
  assert.equal(input.multiple, false, "radio buttons");
  await handled(w, press(card, { [input.id]: input.value }));
  assert.deepEqual(
    aw.claw.heard.map((h) => [h.key, h.text]),
    [["ak-alice", "staging（测试）"]],
  );
  await handled(w, press(card, { [input.id]: ticked(card, ["prod（生产）"]).value }));
  assert.equal(aw.claw.heard.length, 1, "a second press (a double tap) sends nothing again");
});

it("a multiple choice ticked on the Teams card and sent, from a client that submits: one message with every option ticked", async () => {
  const { aw, w, planner } = await teamsWorld();
  const card = drawn(planner, "Which repositories?", {
    options: ["PrimusClaw", "Primus-SaFE", "Primus-Turbo"],
    multiple: true,
  });
  const input = ticked(card, ["Primus-Turbo", "PrimusClaw"]);
  assert.equal(input.multiple, true, "check boxes");
  await handled(w, press(card, { [input.id]: input.value }, true));
  assert.deepEqual(
    aw.claw.heard.map((h) => h.text),
    ["PrimusClaw, Primus-Turbo"],
  );
});
