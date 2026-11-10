// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `redactText` against the Python worker's `redact_text` on 6,000 credential-shaped texts (random, seeded, with
 * Unicode around and inside them: the Kelvin sign and long s that fold to k and s, CJK and full-width neighbours,
 * non-breaking spaces), and further corpora of the same kind. redact-parity-4.json is built around compound key names
 * (AccountKey=, my_key:, monkey=). The answers are those of Python's rule with the compound key names. The texts and Python's
 * answers are stored base64-encoded so that no credential-shaped string sits in the repository as such.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { redactLogLine, redactText } from "../../src/index.js";

interface Row {
  readonly t: string;
  readonly o: string;
  readonly m: boolean;
}

/** A corpus file: each text and Python's answer as base64 of UTF-16LE (lone surrogates included, as Python wrote them). */
function corpus(name: string): Row[] {
  return (JSON.parse(readFileSync(new URL(`data/${name}`, import.meta.url), "utf8")) as { rows: Row[] }).rows;
}
const decode = (text: string): string => {
  const bytes = Buffer.from(text, "base64");
  return String.fromCharCode(...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
};

describe("redaction parity with the Python worker", () => {
  for (const [name, masked] of [
    ["redact-parity.json", 1000],
    ["redact-parity-2.json", 400],
    ["redact-parity-3.json", 500],
    ["redact-parity-4.json", 500],
  ] as const) {
    it(`masks exactly what the Python worker masks, byte for byte: ${name}`, () => {
      const rows = corpus(name);
      const differences = rows.filter((row) => {
        const got = redactText(decode(row.t));
        return got.text !== decode(row.o) || got.masked !== row.m;
      });
      assert.ok(rows.length >= 6000);
      assert.ok(rows.filter((r) => r.m).length > masked, "the corpus masks something");
      assert.deepEqual(
        differences.slice(0, 5).map((r) => [decode(r.t), decode(r.o)]),
        [],
      );
    });
  }
});

describe("Python's re.I, as Unicode", () => {
  it("folds the Kelvin sign, the long s and the dotted and dotless i as Python does", () => {
    const value = "x".repeat(33);
    assert.equal(redactText(`Bearer K${value}`).text, "[hidden]");
    assert.equal(redactText(`BEARER ı${value}`).text, "[hidden]");
    assert.equal(redactText(`pİssword=${"a1".repeat(17)}`).text, `pİssword=${"a1".repeat(17)}`);
    assert.equal(redactText(`api_key İs ${"a1".repeat(17)}`).text, "api_key İs [hidden]");
    assert.equal(redactText(`token=${"a".repeat(31)}１`).text, `token=${"a".repeat(31)}１`);
    assert.equal(redactText(`token=${"a".repeat(32)}１`).text, "token=[hidden]１");
  });

  it("a credential-named URL parameter with a dotless i", () => {
    assert.equal(redactLogLine("GET /x?sıg=abc&a=1"), "GET /x?sıg=[hidden]&a=1");
  });
});

describe("a hostile text is masked in linear time", () => {
  // Each took seconds as a regular expression (and in Python's re): a long run of what one rule's start looks like.
  const hostile: Record<string, string> = {
    "many JWT starts in one run": "eyJ0--J-".repeat(12_500) + "\x00",
    "many names before one value": "ke" + "password".repeat(6_250) + "y=" + "a_".repeat(25_000) + "\x00",
    "many 'is' after one name": "token" + "-is".repeat(20_000) + "!",
  };
  for (const [what, text] of Object.entries(hostile)) {
    it(`within a bound: ${what}`, () => {
      const started = performance.now();
      redactText(text);
      redactLogLine(text);
      const ms = performance.now() - started;
      assert.ok(ms < 400, `${what}: ${ms.toFixed(0)} ms`);
    });
  }
});
