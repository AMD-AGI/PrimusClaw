// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The note card (render.py's note_card): a short note under an optional headline, and its buttons. */

import assert from "node:assert/strict";
import { it } from "node:test";

import { action, noteCard } from "../src/views/turn/note.js";

function content(card: ReturnType<typeof noteCard>): Record<string, unknown> {
  return card.attachments[0]?.content as Record<string, unknown>;
}

it("a note alone is one text block and no actions", () => {
  const card = content(noteCard({ text: "This button is no longer active." }));
  assert.deepEqual(card["body"], [{ type: "TextBlock", text: "This button is no longer active.", wrap: true }]);
  assert.equal(card["actions"], undefined);
});

it("a headline leads with the emoji of its tone, a notice's when the tone has none", () => {
  const titles = (["good", "attention", "warning", "accent", "default"] as const).map((tone) => {
    const body = content(noteCard({ text: "x", title: "Done", tone }))["body"] as Array<Record<string, unknown>>;
    return JSON.stringify(body[0]);
  });
  assert.ok(titles[0]?.includes('"✅ Done"'));
  assert.ok(titles[1]?.includes('"❌ Done"'));
  assert.ok(titles[2]?.includes('"⚠️ Done"'));
  assert.ok(titles[3]?.includes('"🔔 Done"'));
  assert.ok(titles[4]?.includes('"🔔 Done"'));
});

it("a button sends its verb and its own copy of the data, or opens its address, styled only when it says so", () => {
  const data = { primusclaw: "show", session_id: "s1" };
  const execute = action({ title: "Show here", verb: "primusclaw.show", data });
  assert.deepEqual(execute, { type: "Action.Execute", title: "Show here", verb: "primusclaw.show", data });
  assert.notEqual(execute["data"], data);
  assert.deepEqual(action({ title: "Open", url: "https://x.test/a", style: "positive" }), {
    type: "Action.OpenUrl",
    title: "Open",
    url: "https://x.test/a",
    style: "positive",
  });
  const card = content(noteCard({ text: "x", buttons: [{ title: "Go", verb: "v", data: {} }] }));
  assert.equal((card["actions"] as unknown[]).length, 1);
});
