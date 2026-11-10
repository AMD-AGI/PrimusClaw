// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A name that ends in "key" joined to the word before it (AccountKey, SharedAccessKey, my_key, primaryKey): its value
 * is masked, as in the Python worker, while monkey, turkey and words that go on past the key (monkeypatch, hotkeys) are no names. The
 * cases are the Python worker's own (67, 46 of them credentials), with its outputs. Their values are stored by shape
 * and filled in here, so that nothing shaped like a real storage key sits in the repository.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { redactText } from "../../src/index.js";

interface Case {
  readonly text: string;
  readonly output: string;
  readonly masked: boolean;
  readonly maskedBefore: boolean;
  readonly credential: boolean;
  readonly shapes: readonly string[];
}

const { cases } = JSON.parse(readFileSync(new URL("data/redact-compound-key.json", import.meta.url), "utf8")) as {
  cases: readonly Case[];
};

/** A fixed sequence of numbers in [0, 1) (mulberry32, seed 622). */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = sequence(622);
const pick = (alphabet: string): string => alphabet[Math.floor(next() * alphabet.length)] ?? "";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
/** A value of the given shape: A an upper-case letter, a a lower-case one, 9 a digit, any other character itself. */
const fill = (shape: string): string =>
  Array.from(shape, (ch) =>
    ch === "A" ? pick(UPPER) : ch === "a" ? pick(LOWER) : ch === "9" ? pick(DIGITS) : ch,
  ).join("");
const placed = (template: string, values: readonly string[]): string =>
  template.replace(/\{(\d+)\}/g, (_all, n: string) => values[Number(n)] ?? "");

describe("a compound key name (Python redact_text, AccountKey=)", () => {
  it("has the Python worker's 67 cases, 46 of them credentials none of which was masked before", () => {
    assert.equal(cases.length, 67);
    assert.equal(cases.filter((c) => c.credential).length, 46);
    assert.ok(cases.filter((c) => c.credential).every((c) => c.masked && !c.maskedBefore));
  });

  for (const c of cases) {
    it(`gives what the Python worker gives: ${c.text}`, () => {
      const values = c.shapes.map(fill);
      const text = placed(c.text, values);
      const got = redactText(text);
      assert.deepEqual(got, { text: placed(c.output, values), masked: c.masked });
      if (c.credential) assert.ok(!got.text.includes(values[0] ?? "\u0000"), "the key is left in the text");
    });
  }

  // Many names that fail, so that the scan asks for the next name many times: each pattern must read the text once,
  // not once per name. Measured on this code: 20-110 ms each; on a scan that searched every pattern again from every
  // name: 1-8 s each.
  for (const [label, hostile] of [
    ["token ", "token ".repeat(80_000)],
    ["xKey= ", "xKey= ".repeat(20_000)],
    ["my_key: ", "my_key: ".repeat(40_000)],
    ["accountkey is ", "accountkey is ".repeat(40_000)],
  ] as const) {
    it(`reads many failing names in linear time: ${JSON.stringify(label)} repeated`, () => {
      const started = performance.now();
      const got = redactText(hostile);
      const took = performance.now() - started;
      assert.deepEqual(got, { text: hostile, masked: false });
      assert.ok(took < 500, `${took.toFixed(0)} ms`);
    });
  }

  it("reads hostile texts in linear time", () => {
    const value = "a1".repeat(20);
    for (const hostile of [
      "xkey" + " ".repeat(60_000) + "!",
      "a_key ".repeat(20_000) + "!",
      "aKey".repeat(25_000) + "=" + "!",
      "_account".repeat(20_000) + "key" + " ".repeat(20_000) + "!",
      ("Akey" + "　".repeat(30)).repeat(2_000) + "is" + value,
    ]) {
      const started = performance.now();
      redactText(hostile);
      const took = performance.now() - started;
      assert.ok(took < 400, `${hostile.slice(0, 12)}...: ${took.toFixed(0)} ms`);
    }
  });
});
