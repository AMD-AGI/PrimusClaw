// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What was typed at the shared terminal, as the chat gets it: the cases shared with the Python worker's fix
 * (test-support/data/typed-line-cases.json, every one byte for byte), and the rich message it is sent as, which makes no link of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { remoteView } from "@primusclaw/personal-agent";

import { richTextActivity } from "../../src/richtext/index.js";

interface Case {
  readonly input: string;
  readonly lang: "en" | "zh";
  readonly expected: string;
}

const CASES = (
  JSON.parse(readFileSync(new URL("../../../../test-support/data/typed-line-cases.json", import.meta.url), "utf8")) as {
    cases: Case[];
  }
).cases;

test("a typed line is what the shared cases say, every one", () => {
  assert.ok(CASES.length >= 16);
  for (const c of CASES) assert.equal(remoteView.typedLine(c.input, c.lang), c.expected, `${c.lang}: ${c.input}`);
});

test("the rich message of a typed line links nothing", () => {
  const typed = [
    "https://attacker.example",
    "go to HTTP://attacker.example/x now",
    "[Open](https://attacker.example)",
    "[ref]: https://attacker.example",
    "[Open](https://attacker\n.example)",
    "<https://attacker.example>",
    "see ‹http://attacker.example›",
    "see http://a.example and <https://b.example>",
    "[1]: https://ref.example/x\n[words][1]",
    "[Open](\nhttps://split.example)",
    "&lt;a href=&quot;https://e.example&quot;&gt;x&lt;/a&gt;",
    "_https://attacker.example/path", // (a word boundary is no boundary after `_`)
    "a@https://attacker.example x/https://b.example",
  ];
  for (const text of typed) {
    for (const lang of ["en", "zh"] as const) {
      const sent = richTextActivity(remoteView.typedLine(text, lang))["text"];
      assert.ok(typeof sent === "string");
      assert.ok(!/<a[\s>]/i.test(sent), `${text}: ${sent}`);
      assert.ok(sent.includes(".example"), sent); // (shown, only inert)
    }
  }
});

test("a long typed prompt still goes as rich text with no link", () => {
  // past what the rich text converts a message goes as plain markdown, where `[a][1]` with `[1]: https&#58;//...` could be a link
  const typed = "[a][1]\n[1]: https&#58;//attacker.example\n" + "x".repeat(30_000);
  const line = remoteView.typedLine(typed, "en");
  const activity = richTextActivity(line);
  assert.equal(activity["textFormat"], "xml");
  const sent = activity["text"];
  assert.ok(typeof sent === "string" && !/<a[\s>]/.test(sent));
  assert.ok(Array.from(line).length < remoteView.TYPED_CHARS_MAX + 200);
});
