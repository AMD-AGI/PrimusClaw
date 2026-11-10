// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `pySplitlines(text, keepends)` against Python's `str.splitlines()` and `str.splitlines(True)`: every string of up to
 * three characters over the ten line breaks, a plain and an astral character, and 2,000 seeded random strings
 * (data/splitlines-keepends.json, written by python3). The public-error classifier reads paragraphs with the breaks kept.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pySplitlines } from "../../src/text/py-text.js";

interface Case {
  readonly t: string;
  readonly lines: readonly string[];
  readonly kept: readonly string[];
}

const { cases } = JSON.parse(readFileSync(new URL("data/splitlines-keepends.json", import.meta.url), "utf8")) as {
  cases: readonly Case[];
};
const BREAKS = ["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "];

describe("py splitlines with and without the breaks (Python str.splitlines)", () => {
  it("covers every break, alone, doubled and as \\r\\n", () => {
    assert.ok(cases.length > 3_800);
    for (const b of [...BREAKS, "\r\n"])
      assert.ok(
        cases.some((c) => c.t === `${b}a`),
        JSON.stringify(b),
      );
  });

  it("keeps each line's own break as Python does", () => {
    const differ = cases.filter((c) => JSON.stringify(pySplitlines(c.t, true)) !== JSON.stringify(c.kept));
    assert.deepEqual(differ.slice(0, 3), []);
  });

  it("drops the breaks as Python does, the default", () => {
    const differ = cases.filter(
      (c) =>
        JSON.stringify(pySplitlines(c.t)) !== JSON.stringify(c.lines) ||
        JSON.stringify(pySplitlines(c.t, false)) !== JSON.stringify(c.lines),
    );
    assert.deepEqual(differ.slice(0, 3), []);
  });

  it("gives back the whole text when the breaks are kept", () => {
    for (const c of cases) assert.equal(pySplitlines(c.t, true).join(""), c.t);
  });
});
