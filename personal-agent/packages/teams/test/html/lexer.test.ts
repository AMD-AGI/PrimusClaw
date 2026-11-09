// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { unescape } from "../../src/html/entities.js";
import { attrValue, tokenize } from "../../src/html/lexer.js";

type Event = ["start" | "startend", string, [string, string | null][]] | ["end", string] | ["data", string];

/** The tokens as the events a Python `HTMLParser` subclass is handed (adjacent text joined). */
function events(markup: string): Event[] {
  return tokenize(markup).map((token): Event => {
    if (token.kind === "data") return ["data", token.text];
    if (token.kind === "end") return ["end", token.tag];
    return [token.selfClosing ? "startend" : "start", token.tag, token.attrs.map(([k, v]) => [k, v])];
  });
}

// Each expectation below is what CPython's HTMLParser(convert_charrefs=True) reported for the same markup.
const MEASURED: readonly [string, Event[]][] = [
  ["<p>a &amp; b</p>", [["start", "p", []], ["data", "a & b"], ["end", "p"]]],
  [
    `<A HREF="x" Title='y>z' bare=v checked>t</A>`,
    [
      [
        "start",
        "a",
        [
          ["href", "x"],
          ["title", "y>z"],
          ["bare", "v"],
          ["checked", null],
        ],
      ],
      ["data", "t"],
      ["end", "a"],
    ],
  ],
  [
    "<br/><img src=x />",
    [
      ["startend", "br", []],
      ["startend", "img", [["src", "x"]]],
    ],
  ],
  ["a < b <3 c", [["data", "a < b <3 c"]]],
  ["<!-- c -->x<!-- y -->z", [["data", "xz"]]],
  ["<!DOCTYPE html><?php x ?>t", [["data", "t"]]],
  [
    "<script>a<b>&amp;</script>&amp;",
    [["start", "script", []], ["data", "a<b>&amp;"], ["end", "script"], ["data", "&"]],
  ],
  ["<style>p{}</StYlE >x", [["start", "style", []], ["data", "p{}"], ["end", "style"], ["data", "x"]]],
  ["</>x</ y>z", [["data", "xz"]]],
  [
    "&amp &ampx &notit; &notin; &#65;&#x41;&#0;&#128;&#xD800;&#1114112;&#1; &copy &COPY; &unknown; &#9999999999;",
    [["data", "& &x ¬it; ∉ AA�€�� © © &unknown; �"]],
  ],
  [
    `<a href="https://e.test/?a=1&amp;b=2&lt">w</a>`,
    [["start", "a", [["href", "https://e.test/?a=1&b=2<"]]], ["data", "w"], ["end", "a"]],
  ],
  [
    `<p\nclass="c"\tid=d>x</p\n>`,
    [
      [
        "start",
        "p",
        [
          ["class", "c"],
          ["id", "d"],
        ],
      ],
      ["data", "x"],
      ["end", "p"],
    ],
  ],
  ["<b>x</b", [["start", "b", []], ["data", "x"]]],
  [`<a href="x`, []],
  ["x&", [["data", "x&"]]],
  [
    "<a a=1 a=2>",
    [
      [
        "start",
        "a",
        [
          ["a", "1"],
          ["a", "2"],
        ],
      ],
    ],
  ],
  [`<a b = "1">`, [["start", "a", [["b", "1"]]]]],
];

test("the tokens are the events python's parser reports", () => {
  for (const [markup, expected] of MEASURED) assert.deepEqual(events(markup), expected, markup);
});

test("an attribute given twice reads as its last value, as python's dict of the attributes does", () => {
  const [token] = tokenize("<a href=1 HREF=2 flag>");
  assert.ok(token?.kind === "start");
  assert.equal(attrValue(token.attrs, "href"), "2");
  assert.equal(attrValue(token.attrs, "flag"), null);
  assert.equal(attrValue(token.attrs, "none"), undefined);
});

test("markup that ends inside a tag, a comment or a raw text element", () => {
  assert.deepEqual(events("a<p class"), [["data", "a"]]);
  assert.deepEqual(events("a<p class='x"), [["data", "a"]]);
  assert.deepEqual(events("a<p class=x"), [["data", "a"]]);
  assert.deepEqual(events("a</p"), [["data", "a"]]);
  assert.deepEqual(events("a<!-- never closed"), [["data", "a"]]);
  assert.deepEqual(events("a<!never closed"), [["data", "a"]]);
  assert.deepEqual(events("<script>x</scriptx>y"), [
    ["start", "script", []],
    ["data", "x</scriptx>y"],
  ]);
  assert.deepEqual(events("<script></script>"), [
    ["start", "script", []],
    ["end", "script"],
  ]);
  assert.deepEqual(events("a<"), [["data", "a<"]]);
  assert.deepEqual(events("a</"), [["data", "a</"]]);
  assert.deepEqual(events("a<p/"), [["data", "a"]]);
});

test("a self closing raw text element has no raw text", () => {
  assert.deepEqual(events("<style/>&amp;"), [
    ["startend", "style", []],
    ["data", "&"],
  ]);
});

test("a slash inside a tag separates attributes", () => {
  assert.deepEqual(events("<a/b=1 / c>"), [
    [
      "start",
      "a",
      [
        ["b", "1"],
        ["c", null],
      ],
    ],
  ]);
});

test("a reference is decoded on its own side of a tag or a comment", () => {
  assert.deepEqual(events("&am<b>p;"), [["data", "&am"], ["start", "b", []], ["data", "p;"]]);
  assert.deepEqual(events("&amp<!-- -->;"), [["data", "&;"]]);
});

test("numeric references follow python's html unescape", () => {
  assert.equal(unescape("&#x1F600;&#13;&#11;&#x7f;&#xFDD0;&#xFFFE;&#x10FFFF;&#159;"), "\u{1F600}\rŸ");
  assert.equal(unescape("&#0000065;&#x0041&#X61;&#;&#x;"), "AAa&#;&#x;");
  assert.equal(unescape("&#99999999;"), "�");
});

test("named references follow python's html unescape for the names this lexer knows", () => {
  assert.equal(unescape("&nbsp;&nbsp&apos;&hellip;&notinva;&gtrsim;&AElig&yuml;"), "  '…∉≳Æÿ");
  assert.equal(unescape("&notindot;"), "⋵̸");
  assert.equal(unescape("&a;&ab;&;&\t;& amp;"), "&a;&ab;&;&\t;& amp;");
  assert.equal(unescape("plain text"), "plain text");
});
