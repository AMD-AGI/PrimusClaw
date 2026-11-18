// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's text is untrusted: what the user's client receives must never contain a tag, attribute or link the
 * converter did not write itself. Hostile inputs in every block, `safeUrl`, the allow-list validator on its own, and
 * the converter failing closed when its escaping is broken.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SeededRandom } from "../../../../test-support/random.js";
import { escaping, PY_SPACE } from "../../src/richtext/escape.js";
import { checkHtml, RichTextError, safeUrl, toTeamsHtml } from "../../src/richtext/index.js";

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:x">x</a>',
  "<svg/onload=x>",
  '<span style="color:red;position:fixed">x</span>',
  "<b onclick=x>b</b>",
  "<iframe src=//evil></iframe>",
  "[x](javascript:alert(1))",
  "[x](  javascript:alert(1))",
  "[x](<javascript:alert(1)>)",
  "[a](https://a.example)(javascript:x)",
  "**<script>**",
  "`<script>`",
  "```\n<script>\n```",
  "> <script>",
  "- <script>",
  "# <script>",
  "| <script> |\n|-|\n| <img> |",
  "⏳ <script>: x",
  "**✅ <script>**",
  "<https://a.example/><script>",
  "\\<script>",
  "&lt;script&gt;",
  "<<script>>",
  "[<script>](https://a.example)",
  "![<script>](https://a.example/x.png)",
  "https://a.example/<script>",
  'https://a.example/"><script>',
  "<a href=https://a.example onclick=x>x</a>",
  "</pre><script>",
];

const ALLOWED = new Set([
  "<b>",
  "</b>",
  "<i>",
  "</i>",
  "<s>",
  "</s>",
  "<u>",
  "</u>",
  "<br>",
  "<pre>",
  "</pre>",
  "<code>",
  "</code>",
  "</span>",
  "</a>",
]);
const SPAN_TAG = /^<span style="(font-size:1[56]px|color:#[0-9a-f]{6})">$/;
const A_TAG = new RegExp(`^<a href="https?://[^"<>${PY_SPACE}]*">$`, "u");
const HREF = new RegExp(`^href="https?://[^"<>${PY_SPACE}]*"$`, "iu");

function tagsIn(markup: string): string[] {
  return markup.match(/<[^>]*>/g) ?? [];
}

for (const hostile of HOSTILE) {
  test(`hostile text never produces a tag of its own: ${JSON.stringify(hostile)}`, () => {
    for (const wrapper of ["{}", "**{}**", "- {}", "x {} y", "```\n{}\n```", "> {}", "# {}", "⏳ {}"]) {
      const markup = toTeamsHtml(wrapper.replace("{}", () => hostile));
      for (const tag of tagsIn(markup)) {
        assert.ok(ALLOWED.has(tag) || SPAN_TAG.test(tag) || A_TAG.test(tag), `${hostile} ${wrapper} ${tag}`);
      }
      assert.ok(!markup.includes("<script"));
      assert.ok(!markup.replace(/&lt;.*?&gt;/g, "").includes("onerror"));
    }
  });
}

test("a link url cannot close its attribute", () => {
  const markup = toTeamsHtml('[x](https://a.example/"onmouseover="alert(1))');
  assert.equal(tagsIn(markup)[0], '<a href="https://a.example/&quot;onmouseover=&quot;alert(1)">');
  assert.equal(markup.split('"').length - 1, 2); // only the attribute's own quotes
});

const URLS: readonly (readonly [string, boolean])[] = [
  ["https://example.com/a?b=1", true],
  ["http://example.com", true],
  ["HTTP://EXAMPLE.COM", true],
  ["https://user@example.com:8443/x", true],
  ["https://[::1]/x", true],
  ["javascript:alert(1)", false],
  ["data:text/html,x", false],
  ["ftp://example.com", false],
  ["//example.com", false],
  ["/relative", false],
  ["https:///x", false],
  ["https://", false],
  ["https://a b", false],
  ["https://a\tb", false],
  ["https://a\nb", false],
  ["https://a\x7fb", false],
  ["https://example.com:99999999/x", false],
  ["", false],
  ["https://" + "a".repeat(3000), false],
  ["https://[::1/x", false],
];

for (const [url, ok] of URLS) {
  test(`safe url: ${JSON.stringify(url.slice(0, 40))}`, () => {
    assert.equal(safeUrl(url) !== null, ok);
  });
}

const OFF_THE_LIST = [
  "<script>x</script>",
  "<img src=x>",
  '<a href="javascript:x">x</a>',
  '<a href="https://a.example" onclick="x">x</a>',
  '<a href="https://a.example">unclosed',
  '<span style="color:red">x</span>',
  '<span style="font-size:99px">x</span>',
  "<b onclick=x>x</b>",
  "<b>x</i>",
  "</b>",
  "<b>",
  "<br/>",
  "<br class=x>",
  "a < b",
  "a > b",
  "a & b",
  "&copy;",
  "&#60;",
  "<h2>x</h2>",
  "<font color=red>x</font>",
  '<b><span style="color:#d9484c">x</b></span>',
  "<p>x</p>",
  "<div>x</div>",
  '<a href="https://a.example/"x">x</a>',
  '<a href="https://a.example/<b>">x</a>',
  "<!-- x -->",
  "<![CDATA[x]]>",
];

for (const markup of OFF_THE_LIST) {
  test(`the validator refuses anything off the allow list: ${markup}`, () => {
    assert.throws(() => {
      checkHtml(markup);
    }, RichTextError);
  });
}

test("the validator accepts what the converter writes", () => {
  checkHtml(toTeamsHtml("**✅ ok**\n- [a](https://a.example/?x=1&y=2) `c` ~~s~~ ++u++ *i*\n```\nx < y\n```"));
});

test("a converter that escaped nothing fails closed", () => {
  // Reverse proof of the second layer: with escaping broken, the validator throws instead of letting markup out.
  const original = escaping.esc;
  escaping.esc = (text) => text;
  try {
    assert.throws(() => toTeamsHtml("<script>alert(1)</script>"), RichTextError);
  } finally {
    escaping.esc = original;
  }
});

const PIECES = [
  "*",
  "**",
  "_",
  "__",
  "~~",
  "++",
  "`",
  "```",
  "[",
  "]",
  "(",
  ")",
  "![",
  "](",
  "<",
  ">",
  "&",
  "\\",
  "\n",
  "\n\n",
  "- ",
  "1. ",
  "> ",
  "# ",
  "|",
  "---",
  " ",
  "a",
  "b c",
  "https://a.example/x",
  "javascript:",
  "http://",
  "✅",
  "⏳",
  "⚠️",
  "❌",
  "<script>",
  "</b>",
  '"',
  "'",
  "：",
  ": ",
  ", ",
  "&amp;",
  "‮",
  "\x00",
];

test("random markup never escapes the allow list", () => {
  const rng = new SeededRandom(47);
  for (let n = 0; n < 3000; n++) {
    const length = 1 + rng.int(40);
    const markdown = Array.from({ length }, () => PIECES[rng.int(PIECES.length)] ?? "").join("");
    const markup = toTeamsHtml(markdown, { lead: rng.fraction() < 0.5 }); // throws if the validator objects
    for (const href of markup.match(/href="[^"]*"/g) ?? []) assert.match(href, HREF);
    assert.doesNotMatch(markup, /<(?!\/?(?:b|i|u|s|br|a|code|pre|span)\b)/);
  }
});
