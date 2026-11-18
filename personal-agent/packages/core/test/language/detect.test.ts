// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which language a person is answered in, against the Python worker's approval_view (has_cjk, written_lang, pick_lang,
 * answer_lang) on 4,000 seeded texts: English sentences and requests, Chinese, names and links that are not prose, and
 * Python's white space (the ideographic space, the information separators, NEL).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { answerLang, asText, hasCjk, pickLang, writtenLang } from "../../src/language/detect.js";

interface Row {
  readonly t: string;
  readonly wl: "zh" | "en" | null;
  readonly cjk: boolean;
  readonly pl: "zh" | "en";
  readonly al: Array<"zh" | "en">;
}

const rows = readFileSync(new URL("written-lang-parity.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as Row);

describe("the language a person writes and is answered in", () => {
  it("reads every text as the Python worker does", () => {
    assert.equal(rows.length, 4000);
    assert.ok(rows.filter((r) => r.wl === "en").length > 500 && rows.filter((r) => r.wl === null).length > 500);
    const differences = rows
      .filter((r) => {
        const got = {
          wl: writtenLang(r.t) ?? null,
          cjk: hasCjk(r.t),
          pl: pickLang("", r.t, "x"),
          al: ["", "zh", "en", "fr"].map((said) => answerLang(said, "", r.t)),
        };
        return JSON.stringify(got) !== JSON.stringify({ wl: r.wl, cjk: r.cjk, pl: r.pl, al: r.al });
      })
      .slice(0, 5)
      .map((r) => r.t);
    assert.deepEqual(differences, []);
  });

  it("reads a second, independent corpus of 4,000 random texts as the Python worker does", () => {
    const second = readFileSync(new URL("written-lang-parity-2.jsonl", import.meta.url), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: string; wl: "zh" | "en" | null });
    assert.equal(second.length, 4000);
    assert.deepEqual(second.filter((r) => (writtenLang(r.t) ?? null) !== r.wl).slice(0, 5), []);
  });

  it("the client's locale decides while the conversation has said nothing", () => {
    assert.equal(answerLang("", "zh-CN", "hello"), "zh");
    assert.equal(answerLang("", "en-US", "你好"), "en");
    assert.equal(answerLang("en", "zh-CN", "你好"), "en");
  });

  it("the text of a value is Python's str(x or '')", () => {
    assert.deepEqual([null, undefined, false, 0, "", "a", 3, true, { a: 1 }].map(asText), [
      "",
      "",
      "",
      "",
      "",
      "a",
      "3",
      "True",
      '{"a":1}',
    ]);
    assert.equal(pickLang(null, "  ", "中文"), "zh");
    assert.equal(pickLang(), "en");
  });
});
