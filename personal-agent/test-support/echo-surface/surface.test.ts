// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The echo surface masks credential shapes in every word a group reads: text, buttons and a pick list's options. */
import assert from "node:assert/strict";
import { it } from "node:test";

import type { OutMessage } from "@primusclaw/personal-agent";

import { refOf } from "./adapter.js";
import { EchoSurface } from "./surface.js";

const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

function choiceCard(option: string): OutMessage {
  const model = {
    text: `pick ${TOKEN}`,
    cardId: "c1",
    options: [option, "staging"],
    multiple: false,
    note: "",
    lang: null,
  };
  return { body: { type: "view", view: { name: "choiceCard", model }, fallbackText: "" } };
}

it("in a group every word of a card is masked; in a 1:1 chat it is shown as it is", async () => {
  const surface = new EchoSurface();
  await surface.conversation(refOf({ id: "g", kind: "group" })).send(choiceCard(`use ${TOKEN}`));
  await surface.conversation(refOf({ id: "d", kind: "personal" })).send(choiceCard(`use ${TOKEN}`));
  const [group, personal] = surface.records;
  assert.ok(group?.op === "post" && personal?.op === "post");
  assert.equal(JSON.stringify(group.message).includes(TOKEN), false, JSON.stringify(group.message));
  assert.deepEqual(group.message.choices?.options.map((o) => o.title)[1], "staging");
  assert.equal(personal.message.choices?.options[0]?.title, `use ${TOKEN}`);
});
