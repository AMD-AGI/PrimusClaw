// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { clip, hasCjk, zh } from "../src/cards/cjk.js";
import type { CardElement } from "../src/cards/json.js";
import { pyLstrip, pyRstrip, pyStr } from "../src/text/py-extra.js";
import {
  buttons,
  card,
  CardKitError,
  execute,
  header,
  facts,
  emojiIn,
  emojiBudget,
  message,
  row,
  band,
  badges,
  fold,
  headerItems,
  icon,
  note,
  openUrl,
  section,
  text,
} from "../src/cards/kit.js";

test("full width punctuation next to chinese only", () => {
  assert.equal(zh("模型: claude, 分支(当前)"), "模型：claude，分支（当前）");
  assert.equal(zh("Hello, world: ok"), "Hello, world: ok");
  assert.equal(zh("运行 `a:b, c` 并打开 https://x.y/a:b 看"), "运行 `a:b, c` 并打开 https://x.y/a:b 看");
});

test("the kit refuses a fourth button and an unknown tone", () => {
  const button = execute("x", "primusclaw.x", {});
  assert.throws(() => buttons([button, button, button, button]), CardKitError);
  // (a tone outside the kit's list is refused even when the type system is bypassed, as a value read from data could be)
  assert.throws(() => header("x", { tone: "red" as unknown as "good" }), CardKitError);
});

test("only the first button is primary", () => {
  const a = execute("a", "v", {});
  const b = { ...execute("b", "v", {}), style: "destructive" };
  assert.deepEqual(
    buttons([a, b]).map((x) => x["style"]),
    ["positive", undefined],
  );
  assert.deepEqual(
    buttons([a, b], "").map((x) => x["style"]),
    [undefined, undefined],
  );
});

for (const [name, sample] of [
  ["brackets", "中" + "[".repeat(50000)],
  ["empty links", "中" + "[](".repeat(30000)],
  ["blanks", "中" + " ".repeat(50000) + ",中"],
  ["parens", "中(" + "a(".repeat(30000)],
  ["comma run", "中," + "a".repeat(50000)],
  ["backticks", "中" + "`".repeat(50000)],
] as const) {
  test(`full width punctuation takes linear time on any text: ${name}`, () => {
    const started = performance.now();
    zh(sample);
    assert.ok(performance.now() - started < 1000);
  });
}

test("clip counts characters, not UTF-16 units, and marks a cut", () => {
  assert.equal(clip("  a   b \n c ", 10), "a b c");
  assert.equal(clip("😀😀😀😀", 4), "😀😀😀😀");
  assert.equal(clip("😀😀😀😀😀", 4), "😀😀😀…");
  assert.equal(clip("abc def", 5), "abc…");
});

test("facts leave out empty values and keep Chinese names on one line", () => {
  assert.deepEqual(
    facts([
      ["a", ""],
      ["b", "  "],
      ["c", null],
    ]),
    [],
  );
  assert.deepEqual(facts([["作者", "张三: 李四"]]), [
    { type: "FactSet", facts: [{ title: "作⁠者", value: "张三：李四" }] },
  ]);
});

test("the emoji budget counts rows, bands and badges", () => {
  const card = message([
    header("x", { emoji: "board" }),
    badges([{ meaning: "good", label: "done", count: 2, tone: "good" }]),
    band("needs you", "attention", "needs_you"),
    row("1", "working", "item"),
    ...fold("more", [row("2", "good", "item")]),
  ]).attachments[0]?.content;
  assert.ok(card && typeof card === "object" && !Array.isArray(card));
  assert.equal(emojiBudget(card), 3 + 4);
  assert.deepEqual(emojiIn("⚠️ a ✅ b"), ["⚠️", "✅"]);
});

test("a header has a bar in its tone, a plain one has none, and its items take one more line", () => {
  const plain = header("标题: 一", { subtitle: "sub", titleId: "t1", emoji: "review" });
  assert.deepEqual(plain, {
    type: "Container",
    items: [
      { type: "TextBlock", text: "🔍 标题：一", wrap: true, size: "Medium", weight: "Bolder", id: "t1" },
      { type: "TextBlock", text: "sub", wrap: true, isSubtle: true, size: "Small", spacing: "None" },
    ],
  });
  assert.equal(headerItems(plain).length, 2);
  const toned = header("x", { tone: "good" });
  assert.equal(toned.type, "ColumnSet");
  const columns = toned["columns"] as CardElement[];
  assert.deepEqual(columns[0], {
    type: "Column",
    width: "auto",
    spacing: "None",
    items: [{ type: "TextBlock", text: "┃", color: "Good", size: "Large", weight: "Bolder" }],
  });
  assert.equal(headerItems(toned), columns[1]?.["items"]);
  assert.throws(() => headerItems({ type: "ColumnSet", columns: [] }), CardKitError);
});

test("a section is a bold line, barred in a tone with a medium bar", () => {
  assert.deepEqual(section("A"), {
    type: "Container",
    spacing: "Medium",
    items: [{ type: "TextBlock", text: "A", wrap: true, weight: "Bolder" }],
  });
  const toned = section("A", "attention");
  assert.equal(toned["spacing"], "Medium");
  const bar = (toned["columns"] as CardElement[])[0];
  assert.equal((bar?.["items"] as CardElement[])[0]?.["size"], "Medium");
  assert.throws(() => section("A", "red" as unknown as "good"), CardKitError);
  assert.throws(() => band("A", "red" as unknown as "good"), CardKitError);
  assert.equal(band("A")["id"], "band-plain");
  assert.equal(band("A")["style"], "emphasis");
  assert.equal(band("A", "warning", "needs_you")["style"], "warning");
});

test("text options and notes", () => {
  assert.deepEqual(
    text("a", { subtle: true, size: "Small", weight: "Bolder", maxLines: 2, spacing: "None", mono: true }),
    {
      type: "TextBlock",
      text: "a",
      wrap: true,
      isSubtle: true,
      size: "Small",
      weight: "Bolder",
      maxLines: 2,
      spacing: "None",
      fontType: "Monospace",
    },
  );
  assert.deepEqual(note("n", { id: "x" }), {
    type: "TextBlock",
    text: "n",
    wrap: true,
    isSubtle: true,
    size: "Small",
    id: "x",
  });
  assert.deepEqual(note("n"), { type: "TextBlock", text: "n", wrap: true, isSubtle: true, size: "Small" });
  assert.equal(icon("", "w"), "w");
  assert.equal(fold("f", []).length, 0);
});

test("buttons, links and the card around them", () => {
  const go = openUrl("打开: 控制台", "https://example.com");
  assert.deepEqual(go, { type: "Action.OpenUrl", title: "打开：控制台", url: "https://example.com" });
  assert.deepEqual(buttons([null, go, undefined], "destructive"), [{ ...go, style: "destructive" }]);
  const built = card([text("a")], [], 3, { msteams: { width: "Full" } });
  assert.deepEqual(built, {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [{ type: "TextBlock", text: "a", wrap: true }],
    msteams: { width: "Full" },
  });
  assert.throws(() => card([], [go, go], 1), CardKitError);
  assert.deepEqual(message([text("a")], [go])["attachments"][0]?.content, {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [{ type: "TextBlock", text: "a", wrap: true }],
    actions: [go],
  });
  assert.equal(hasCjk("中"), true);
  assert.equal(hasCjk(null), false);
});

test("python string semantics the core does not have yet: lstrip and str()", () => {
  assert.equal(pyLstrip("\u0085 x \u2028"), "x \u2028");
  assert.equal(pyLstrip("   "), "");
  assert.equal(pyRstrip("  x "), "  x");
  assert.deepEqual(
    [
      pyStr("s"),
      pyStr(0),
      pyStr(2),
      pyStr(Number.NaN),
      pyStr(0n),
      pyStr(3n),
      pyStr(true),
      pyStr(false),
      pyStr(null),
      pyStr({}),
    ],
    ["s", "", "2", "", "", "3", "True", "", "", ""],
  );
});
