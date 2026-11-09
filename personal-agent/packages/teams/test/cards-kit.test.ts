import assert from "node:assert/strict";
import { test } from "node:test";

import { clip, zh } from "../src/cards/cjk.js";
import { buttons, CardKitError, execute, header, facts, emojiIn, emojiBudget, message, row, band, badges, fold } from "../src/cards/kit.js";

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
  assert.deepEqual(facts([["a", ""], ["b", "  "], ["c", null]]), []);
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
