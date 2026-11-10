// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A press on a review card, end to end through the Teams inbound reading: the button the card carries comes back as Teams sends
 * it (an Action.Execute invoke), `toInboundEvent` reads it into an InboundAction, and the review service's click handler is the
 * one whose verbs name that action's `verb` (the card data's `primusclaw` kind, as Python dispatches on `_card_data`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, InboundAction, JsonObject } from "@primusclaw/personal-agent";
import { toInboundEvent } from "../../src/activity/inbound/index.js";
import { githubConfirmCard, githubConnectCard, reviewModeCard } from "../../src/views/review/index.js";
import { ALICE, reviewWorld } from "../../../../test-support/review-world.js";
import { dm } from "../activity/fixtures.js";

/** The Action.Execute buttons of a card: their channel verb and data. */
function buttons(node: unknown): { verb: string; data: JsonObject }[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (typeof node !== "object" || node === null) return [];
  const r = node as Record<string, unknown>;
  const own =
    r.type === "Action.Execute" && typeof r.verb === "string" ? [{ verb: r.verb, data: r.data as JsonObject }] : [];
  return [...own, ...Object.values(r).flatMap(buttons)];
}

/** The press as Teams delivers it, read by the adapter. */
function pressed(button: { verb: string; data: JsonObject }): InboundAction {
  const event = toInboundEvent({
    ...dm(""),
    type: "invoke",
    name: "adaptiveCard/action",
    value: { action: { type: "Action.Execute", verb: button.verb, data: button.data } },
  });
  assert.ok(event.ok && event.value?.type === "action");
  return event.value;
}

function handlerFor(world: ReturnType<typeof reviewWorld>, action: InboundAction) {
  return world.service.routeHandlers().clicks.find((h) => h.verbs.includes(action.verb));
}

test("a press on the confirmation setting card reaches the review service and changes the setting", async () => {
  const world = reviewWorld();
  const card = reviewModeCard({
    current: "",
    suggested: "fully_auto",
    lead: "",
    hint: "",
    installUrl: "",
  });
  const button = buttons(card).find((b) => b.data.mode === "fully_auto");
  assert.ok(button !== undefined);
  const action = pressed(button);
  assert.equal(action.verb, "github_mode");
  const handler = handlerFor(world, action);
  assert.ok(handler?.beforeCredential !== undefined, "no click handler takes the verb the adapter reads");
  const settled: string[] = [];
  const conversation = world.surface.conversation({
    id: "personal:aad-a",
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: "personal:aad-a" } },
  });
  const route = {
    action,
    sender: ALICE,
    conversation,
    scope: "",
    lang: () => "zh",
    settle: (said: unknown) => {
      settled.push(typeof said === "string" ? said : JSON.stringify(said));
      return Promise.resolve(true);
    },
  } as unknown as ClickRoute;
  assert.equal(await handler.beforeCredential(route), true);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "setReviewMode"),
    [["setReviewMode", "tok-aad-a", "fully_auto"]],
  );
});

test("a press on a held write card and on the connect card reach the review service", () => {
  const world = reviewWorld();
  const confirm = githubConfirmCard({
    confirmationId: "cf-1",
    repo: "o/r",
    number: 7,
    title: "t",
    author: "a",
    headSha: "b".repeat(12),
    reasons: ["why"],
    checks: "",
    requester: "Alice",
    room: "",
    review: undefined,
    model: "",
    hint: false,
    installUrl: "",
    base: "main",
    login: "",
    lang: "zh",
    summary: "",
  });
  const connect = githubConnectCard({
    code: "ABCD-1234",
    uri: "https://github.com/login/device",
    minutes: 15,
    question: "q",
    lang: "zh",
    cardId: "card-1",
  });
  const actions = [...buttons(confirm), ...buttons(connect)].map(pressed);
  assert.deepEqual([...new Set(actions.map((a) => a.verb))].sort(), ["github_confirm", "github_connect"]);
  for (const action of actions) assert.ok(handlerFor(world, action), `no click handler takes ${action.verb}`);
});
