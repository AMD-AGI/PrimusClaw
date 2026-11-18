// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Every button on the routing's and the turn's cards reaches its handler the way a press does in production: the card as
// Teams is sent it, the button's Action.Execute as Teams sends it back (an adaptiveCard/action invoke), read by
// toInboundEvent, routed by the router by the kind the card data carries. A button whose press no handler answers is
// replaced by the click safety net with "That button is not active any more." (test_every_button_replaces_card.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFIRM_BUTTON,
  createPrButton,
  noteFactory,
  repoButton,
  showButton,
  type OutMessage,
} from "@primusclaw/personal-agent";

import { toInboundEvent } from "../../src/activity/inbound/index.js";
import { RENDERERS } from "../../src/views/index.js";
import { renderView } from "../../src/views/registry.js";
import { COMMAND_CARDS } from "../../../../test-support/card-catalog/commands.js";
import { SID } from "../../../../test-support/card-catalog/catalog.js";
import { TURN } from "../../../../test-support/card-catalog/turn.js";
import { link, said, world, type World } from "../../../../test-support/routing/world.js";
import { dm, grp } from "../activity/fixtures.js";

type Json = Record<string, unknown>;
const INACTIVE = "That button is not active any more.";

/** Every Action.Execute in a card message, anywhere in it. */
function executes(node: unknown): Json[] {
  if (Array.isArray(node)) return node.flatMap(executes);
  if (typeof node !== "object" || node === null) return [];
  const json = node as Json;
  const own = json["type"] === "Action.Execute" ? [json] : [];
  return [...own, ...Object.values(json).flatMap(executes)];
}

/** The invoke Teams sends for a press on `button` of the card message `cardId`, in a 1:1 chat or the group. */
function press(button: Json, cardId: string, group: boolean): unknown {
  return {
    ...(group ? grp("") : dm("")),
    type: "invoke",
    name: "adaptiveCard/action",
    id: `press-${cardId}`,
    replyToId: cardId,
    value: { action: { type: "Action.Execute", verb: button["verb"], data: button["data"] } },
  };
}

/** A world where each kind's main path can run: Alice linked, the card's session her current one, its answer readable. */
function ready(): World {
  const w = world({ config: { exchangeForChat: true } });
  link(w, "aad-a", "ak");
  w.store.sessions.setSession("aad-a", { sessionId: SID, model: "", pluginId: "" });
  w.turns.lastAnswers.set(SID, "The sweep found 3 stale jobs.");
  return w;
}

const CARDS = [...COMMAND_CARDS, ...TURN];

test("every card of the routing and the turn has a button to check", () => {
  const kinds = new Set(CARDS.flatMap((c) => executes(c.build())).map((b) => (b["data"] as Json)["primusclaw"]));
  assert.deepEqual([...kinds].sort(), ["bind", "create_pr", "onboard", "repo", "show", "turn_stop"]);
});

for (const card of CARDS) {
  for (const [i, button] of executes(card.build()).entries()) {
    const kind = String((button["data"] as Json)["primusclaw"]);
    test(`a press on ${card.id}'s ${String(button["title"])} (${kind}) reaches its handler`, async () => {
      const w = ready();
      const parsed = toInboundEvent(press(button, `card-${String(i)}`, kind === "onboard"));
      assert.ok(parsed.ok && parsed.value?.type === "action", JSON.stringify(parsed));
      assert.equal(parsed.value.verb, kind);
      await w.router.handle(parsed.value);
      await w.router.settled();
      assert.ok(!said(w).includes(INACTIVE), `${card.id}: ${said(w).join(" | ")}`);
    });
  }
}

test("a press on Show here posts the session's answer and makes it the chat's session", async () => {
  const w = ready();
  w.store.sessions.clearSession("aad-a");
  const show = executes(CARDS.find((c) => c.id === "show_here_note")?.build()).at(0) ?? {};
  const parsed = toInboundEvent(press(show, "card-s", false));
  assert.ok(parsed.ok && parsed.value !== undefined);
  await w.router.handle(parsed.value);
  assert.deepEqual(w.turns.lastAnswerReads, [["ak", SID]]); // (read with the presser's own key)
  assert.ok(
    said(w).some((t) => t.startsWith("Here is the answer. Your next message continues this session.\n\nThe sweep")),
  );
  assert.equal(w.store.sessions.getSession("aad-a"), SID);
});

// --- the router's note buttons, as core's noteFactory makes them ---------------------------------------------------------

/** The Python worker's buttons for the same inputs (render.py confirm_button, repo_button, show_button, create_pr_button). */
const PYTHON_BUTTONS = [
  {
    type: "Action.Execute",
    title: "Confirm",
    verb: "primusclaw.bind",
    data: { primusclaw: "bind", action: "confirm" },
    style: "positive",
  },
  {
    type: "Action.Execute",
    title: "Use this repo",
    verb: "primusclaw.repo",
    data: { primusclaw: "repo", repo: "AMD-AGI/PrimusClaw", branch: "dev" },
  },
  {
    type: "Action.Execute",
    title: "用这个仓库",
    verb: "primusclaw.repo",
    data: { primusclaw: "repo", repo: "AMD-AGI/PrimusClaw", branch: "" },
  },
  {
    type: "Action.Execute",
    title: "Show here",
    verb: "primusclaw.show",
    data: { primusclaw: "show", session_id: "s-1" },
  },
  {
    type: "Action.Execute",
    title: "Create PR",
    verb: "primusclaw.create_pr",
    data: { primusclaw: "create_pr", session_id: "s-1" },
  },
];

const NOTE_BUTTONS = [
  CONFIRM_BUTTON,
  repoButton("AMD-AGI/PrimusClaw", "dev"),
  repoButton("AMD-AGI/PrimusClaw", "", "zh"),
  showButton("s-1"),
  createPrButton("s-1"),
];

function rendered(message: OutMessage): unknown {
  const { body } = message;
  if (body.type !== "view") throw new Error(`not a view: ${body.type}`);
  return renderView(RENDERERS, body.view);
}

test("a note's buttons are the Python worker's, field for field and in order", () => {
  const each = NOTE_BUTTONS.map((button) => executes(rendered(noteFactory("Again?", { buttons: [button] }))));
  assert.equal(JSON.stringify(each.flat()), JSON.stringify(PYTHON_BUTTONS));
  const two = executes(rendered(noteFactory("Pick one.", { buttons: NOTE_BUTTONS.slice(3) })));
  assert.equal(JSON.stringify(two), JSON.stringify(PYTHON_BUTTONS.slice(3)));
});

for (const button of NOTE_BUTTONS) {
  test(`a press on a note's ${button.title} (${button.verb}) reaches its handler`, async () => {
    const w = ready();
    const [execute] = executes(rendered(noteFactory("Again?", { buttons: [button] })));
    const parsed = toInboundEvent(press(execute ?? {}, "card-n", false));
    assert.ok(parsed.ok && parsed.value?.type === "action");
    assert.equal(parsed.value.verb, button.verb);
    await w.router.handle(parsed.value);
    await w.router.settled();
    assert.ok(!said(w).includes(INACTIVE), said(w).join(" | "));
  });
}
