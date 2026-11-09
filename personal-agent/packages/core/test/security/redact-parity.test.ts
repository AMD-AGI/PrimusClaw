// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `redactText` against the Python worker's `redact_text` on 6,000 credential-shaped texts (random, seeded, with
 * Unicode around and inside them: the Kelvin sign and long s that fold to k and s, CJK and full-width neighbours,
 * non-breaking spaces). The texts and Python's answers are stored base64-encoded so that no credential-shaped string
 * sits in the repository as such.
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

const corpus = JSON.parse(readFileSync(new URL("data/redact-parity.json", import.meta.url), "utf8")) as { rows: Row[] };
const decode = (text: string): string => Buffer.from(text, "base64").toString("utf8");

describe("redaction parity with the Python worker", () => {
  it("masks exactly what the Python worker masks, byte for byte", () => {
    const differences = corpus.rows.filter((row) => {
      const got = redactText(decode(row.t));
      return got.text !== decode(row.o) || got.masked !== row.m;
    });
    assert.equal(corpus.rows.length, 6000);
    assert.ok(corpus.rows.filter((r) => r.m).length > 1000, "the corpus masks something");
    assert.deepEqual(
      differences.slice(0, 5).map((r) => [decode(r.t), decode(r.o)]),
      [],
    );
  });
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
