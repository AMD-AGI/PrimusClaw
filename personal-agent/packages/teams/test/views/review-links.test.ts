// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A link on a card ends its line too (`test_link_on_its_own_line`): the connect card's page, and the GitHub connect card's. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { textAfterLinks } from "../../../../test-support/link-check.js";
import { linkCard } from "../../src/views/commands/index.js";
import { githubConnectCard } from "../../src/views/review/index.js";

/** Every text a card shows, wherever it sits. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.text === "string" ? [record.text] : [];
  return [...own, ...Object.values(record).flatMap(texts)];
}

/** Every address a card opens. */
function urls(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(urls);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.url === "string" ? [record.url] : [];
  return [...own, ...Object.values(record).flatMap(urls)];
}

test("the link card puts the link on a line of its own", () => {
  const page = "https://claw.example.test/primus-claw/teams-link";
  const shown = texts(linkCard({ bot: "PrimusClaw Assistant", who: "Alice", page, notice: "AI notice" }));
  assert.ok(shown.some((t) => t.includes("teams-link")));
  assert.ok(
    shown.every((t) => textAfterLinks(t).length === 0),
    shown.join("\n"),
  );
});

test("the github connect card glues no text to a link in both languages", () => {
  for (const lang of ["zh", "en"] as const) {
    const uri = "https://github.com/login/device";
    const card = githubConnectCard({ code: "ABCD-1234", uri, minutes: 15, question: "我的 PR", lang, cardId: "c1" });
    const shown = texts(card);
    assert.deepEqual(urls(card), [uri], lang); // (on the button that opens it: nothing is glued to it)
    assert.ok(
      shown.every((t) => textAfterLinks(t).length === 0),
      shown.join("\n"),
    );
  }
});
