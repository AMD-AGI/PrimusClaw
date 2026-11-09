// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Markdown answers as the HTML subset Teams renders (textFormat "xml"): exact strings, so a change in what renders
 * shows up here; the heading rule, the status colours' contrast and a realistic answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_COLORS, toTeamsHtml } from "../../src/richtext/index.js";

const BR = "<br>";
const LEAD = '<b><span style="font-size:16px">';
const LABEL = '<b><span style="font-size:15px">';
const END = "</span></b>";
const NBSP = "&nbsp;";

function paint(color: string, inner: string): string {
  return `<span style="color:${color}">${inner}</span>`;
}

function color(emoji: string): string {
  const value = STATUS_COLORS[emoji];
  assert.ok(value !== undefined, emoji);
  return value;
}

const [GREEN, AMBER, RED, BLUE] = [color("✅"), color("⚠"), color("❌"), color("⏳")];

/** [name, markdown, expected html] */
const EXACT: readonly (readonly [string, string, string])[] = [
  ["plain text is only escaped", `Hello, world`, `Hello, world`],
  ["bold italic strike underline", `**a** *b* ~~c~~ ++d++`, `<b>a</b> <i>b</i> <s>c</s> <u>d</u>`],
  ["underscore forms", `__a__ and _b_`, `<b>a</b> and <i>b</i>`],
  ["bold italic together", `x ***both***`, `x <b><i>both</i></b>`],
  ["nesting", `x **bold *and italic* end**`, `x <b>bold <i>and italic</i> end</b>`],
  ["intraword underscores stay", `use snake_case_name here`, `use snake_case_name here`],
  ["spaced stars stay", `2 * 3 * 4`, `2 * 3 * 4`],
  ["plus plus in prose stays", `C++ and C++ again`, `C++ and C++ again`],
  ["unbalanced bold stays literal", `**x and more`, `**x and more`],
  ["backslash escapes", `\\*not bold\\* and \\_x\\_`, `*not bold* and _x_`],
  [
    "inline code is escaped and not parsed",
    `run \`a <b> & **c**\` now`,
    `run <code>a &lt;b&gt; &amp; **c**</code> now`,
  ],
  ["double backtick code", `\`\`a\`b\`\``, `<code>a\`b</code>`],
  ["lone backtick stays", `it\`s fine`, `it\`s fine`],
  ["code span across a line break", `\`line one\n**literal**\``, `<code>line one **literal**</code>`],
  ["code span across lines inside a bullet", `- run \`a\n  b\` now\n- next`, `• run <code>a b</code> now${BR}• next`],
  ["code span across three lines of a paragraph", `x \`a\nb\nc\` y`, `x <code>a b c</code> y`],
  ["a lone backtick does not swallow the next line", `it\`s\nfine`, `it\`s${BR}fine`],
  ["a code span does not run over a blank line", `\`a\n\nb\``, `\`a${BR}${BR}b\``],
  ["a code span does not run into a bullet", `\`a\n- b\``, `\`a${BR}• b\``],
  ["an unclosed code span stays literal", `\`a\nb\nc`, `\`a${BR}b${BR}c`],
  [
    "link",
    `[Open the run](https://example.com/a?b=1&c=2)`,
    `<a href="https://example.com/a?b=1&amp;c=2">Open the run</a>`,
  ],
  ["link with a title", `[x](https://example.com "title")`, `<a href="https://example.com">x</a>`],
  [
    "link with balanced parens in the url",
    `[w](https://en.wikipedia.org/wiki/Foo_(bar))`,
    `<a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a>`,
  ],
  [
    "bold inside a link label",
    `[**big** news](https://example.com)`,
    `<a href="https://example.com"><b>big</b> news</a>`,
  ],
  ["uppercase scheme", `[x](HTTPS://EXAMPLE.COM/A)`, `<a href="HTTPS://EXAMPLE.COM/A">x</a>`],
  [
    "bare url, trailing full stop",
    `see https://example.com/x.`,
    `see <a href="https://example.com/x">https://example.com/x</a>.`,
  ],
  ["bare url in parentheses", `(https://example.com/x)`, `(<a href="https://example.com/x">https://example.com/x</a>)`],
  ["autolink", `<https://example.com/y>`, `<a href="https://example.com/y">https://example.com/y</a>`],
  ["image becomes a link", `![chart](https://example.com/c.png)`, `<a href="https://example.com/c.png">chart</a>`],
  ["script tag", `<script>alert(1)</script>`, `&lt;script&gt;alert(1)&lt;/script&gt;`],
  ["img onerror", `<img src=x onerror=alert(1)>`, `&lt;img src=x onerror=alert(1)&gt;`],
  ["raw anchor", `<a href="javascript:alert(1)">x</a>`, `&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;`],
  ["raw span style", `<span style="color:red">x</span>`, `&lt;span style="color:red"&gt;x&lt;/span&gt;`],
  ["entities are not decoded", `&lt;b&gt; &amp; &#60;`, `&amp;lt;b&amp;gt; &amp;amp; &amp;#60;`],
  ["javascript link", `[click](javascript:alert(1))`, `[click](javascript:alert(1))`],
  ["javascript link, mixed case", `[click](JaVaScRiPt:alert(1))`, `[click](JaVaScRiPt:alert(1))`],
  ["javascript link, entity-looking", `[click](&#106;avascript:alert(1))`, `[click](&amp;#106;avascript:alert(1))`],
  ["data link", `[x](data:text/html;base64,PHNjcmlwdD4=)`, `[x](data:text/html;base64,PHNjcmlwdD4=)`],
  ["file link", `[x](file:///etc/passwd)`, `[x](file:///etc/passwd)`],
  ["scheme-relative link", `[x](//evil.example/a)`, `[x](//evil.example/a)`],
  ["relative link", `[x](/claw/s1)`, `[x](/claw/s1)`],
  [
    "link with a space in the url",
    `[x](https://a.example/a b)`,
    `[x](<a href="https://a.example/a">https://a.example/a</a> b)`,
  ],
  ["link without a host", `[x](https:///a)`, `[x](https:///a)`],
  ["javascript image", `![x](javascript:alert(1))`, `![x](javascript:alert(1))`],
  ["javascript autolink", `<javascript:alert(1)>`, `&lt;javascript:alert(1)&gt;`],
  [
    "tag inside a link label",
    `[<img onerror=x>](https://example.com)`,
    `<a href="https://example.com">&lt;img onerror=x&gt;</a>`,
  ],
  [
    "quote in a url cannot leave the attribute",
    `[x](https://a.example/"onmouseover="alert(1))`,
    `<a href="https://a.example/&quot;onmouseover=&quot;alert(1)">x</a>`,
  ],
  ["tag inside bold", `x **<script>**`, `x <b>&lt;script&gt;</b>`],
  ["control and bidi characters are dropped", `a\x00b\x1bc\u202ed`, `abcd`],
  ["bullets use a bullet character", `- one\n* two\n+ three`, `• one${BR}• two${BR}• three`],
  ["numbered list keeps its numbers", `1. one\n2) two`, `1. one${BR}2) two`],
  [
    "nested list is indented",
    `- a\n  - b\n    - c\n- d`,
    `• a${BR}${NBSP.repeat(4)}◦ b${BR}${NBSP.repeat(8)}◦ c${BR}• d`,
  ],
  ["blank line is one empty line", `a\n\n\n\nb`, `a${BR}${BR}b`],
  ["leading and trailing blanks go", `\n\n a \n\n`, `a`],
  ["windows newlines", `a\r\nb`, `a${BR}b`],
  ["fenced code", `\`\`\`python\nprint('<x>')\n  indented\n\`\`\``, `<pre>print('&lt;x&gt;')${BR}  indented</pre>`],
  [
    "code keeps markdown literal",
    `\`\`\`\n**not bold** [x](https://a.example)\n\`\`\``,
    `<pre>**not bold** [x](https://a.example)</pre>`,
  ],
  ["unclosed fence runs to the end", `text\n\`\`\`\ncode\nmore`, `text${BR}<pre>code${BR}more</pre>`],
  ["tilde fence", `~~~\nx\n~~~`, `<pre>x</pre>`],
  ["fence info string is never output", `\`\`\`<script>alert(1)</script>\ncode\n\`\`\``, `<pre>code</pre>`],
  ["closing fence must be as long", `\`\`\`\`\na\n\`\`\`\nb\n\`\`\`\``, `<pre>a${BR}\`\`\`${BR}b</pre>`],
  [
    "code block breaks out of nothing",
    `\`\`\`\n</pre><script>x</script>\n\`\`\``,
    `<pre>&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</pre>`,
  ],
  ["empty fence is dropped", `a\n\`\`\`\n\`\`\`\nb`, `a${BR}b`],
  ["a code block has its own spacing", `a\n\n\`\`\`\nx\n\`\`\`\n\nb`, `a${BR}<pre>x</pre>${BR}b`],
  ["quote", `> quoted *text*`, `│ <i>quoted <i>text</i></i>`],
  ["rule", `a\n\n---\n\nb`, `a${BR}${BR}────────────${BR}${BR}b`],
  ["table", `| a | b |\n|---|:-:|\n| 1 | **2** |`, `<b>a | b</b>${BR}1 | <b>2</b>`],
  ["table cells are escaped", `| <x> | y |\n|---|---|\n| & | z |`, `<b>&lt;x&gt; | y</b>${BR}&amp; | z`],
  [
    "first bold line is the heading",
    `**All good**\n\n**Progress**\n- one`,
    `${LEAD}All good${END}${BR}${BR}${LABEL}Progress${END}${BR}• one`,
  ],
  ["a bold line after text is a label", `intro\n**Label**`, `intro${BR}${LABEL}Label${END}`],
  ["bold label keeps a trailing colon", `**Next:**`, `${LEAD}Next:${END}`],
  ["underscore bold line", `__Verdict__`, `${LEAD}Verdict${END}`],
  ["hash heading is a label", `# Title\ntext`, `${LEAD}Title${END}${BR}text`],
  ["hash heading later", `text\n## Part two ##`, `text${BR}${LABEL}Part two${END}`],
  ["bold in the middle is not a heading", `**a** and **b**`, `<b>a</b> and <b>b</b>`],
  ["bold then more text is not a heading", `**Label:** value`, `<b>Label:</b> value`],
  ["verdict line is coloured", `**✅ Deploy finished**`, `${LEAD}${paint(GREEN, "✅ Deploy finished")}${END}`],
  ["verdict line, amber", `**⚠️ Needs a look**`, `${LEAD}${paint(AMBER, "⚠️ Needs a look")}${END}`],
  ["verdict line, red", `**❌ Failed**`, `${LEAD}${paint(RED, "❌ Failed")}${END}`],
  ["verdict line, blue", `**⏳ Running**`, `${LEAD}${paint(BLUE, "⏳ Running")}${END}`],
  ["no emoji, no colour", `**Plain verdict**`, `${LEAD}Plain verdict${END}`],
  ["label line is coloured too", `a\n**❌ Problems**`, `a${BR}${LABEL}${paint(RED, "❌ Problems")}${END}`],
  [
    "bold after the emoji is the label",
    `- ✅ **Tests pass** 120 of 120`,
    `• ✅ ${paint(GREEN, "<b>Tests pass</b>")} 120 of 120`,
  ],
  ["text up to a colon is the label", `⚠️ Slow: 12s per run`, `⚠️ ${paint(AMBER, "Slow")}: 12s per run`],
  ["text up to a dash is the label", `❌ Build failed - missing foo`, `❌ ${paint(RED, "Build failed")} - missing foo`],
  ["text up to a comma is the label", `✅ Tests pass, 120 of 120`, `✅ ${paint(GREEN, "Tests pass")}, 120 of 120`],
  ["fullwidth colon", `⏳ 进行中：等待评审`, `⏳ ${paint(BLUE, "进行中")}：等待评审`],
  ["short line without a separator is all label", `⏳ Running now`, `⏳ ${paint(BLUE, "Running now")}`],
  ["no variation selector", `⚠ Slow: x`, `⚠ ${paint(AMBER, "Slow")}: x`],
  ["a long line is not coloured", "✅ " + "word ".repeat(12) + "end", "✅ " + "word ".repeat(12) + "end"],
  [
    "a long label before the separator is not coloured",
    "✅ " + "w".repeat(45) + ": rest",
    "✅ " + "w".repeat(45) + ": rest",
  ],
  ["pin has no colour", `📌 Next: merge`, `📌 Next: merge`],
  ["emoji not at the start", `done ✅ ok`, `done ✅ ok`],
  [
    "code in the label stays code",
    `❌ \`build\` broke: see log`,
    `❌ ${paint(RED, "<code>build</code> broke")}: see log`,
  ],
  [
    "link in the label",
    `⏳ Waiting on [#132](https://a.example/132): review`,
    `⏳ ${paint(BLUE, 'Waiting on <a href="https://a.example/132">#132</a>')}: review`,
  ],
  ["status in a numbered item", `1. ✅ Done: yes`, `1. ✅ ${paint(GREEN, "Done")}: yes`],
  ["status inside code is just text", `\`\`\`\n✅ Done: yes\n\`\`\``, `<pre>✅ Done: yes</pre>`],
  ["status in a heading line keeps the size", `# ❌ Broken`, `${LEAD}${paint(RED, "❌ Broken")}${END}`],
];

for (const [name, markdown, expected] of EXACT) {
  test(`markdown becomes exactly this html: ${name}`, () => {
    assert.equal(toTeamsHtml(markdown), expected);
  });
}

test("only the first bold line is the heading and only when it leads", () => {
  const answer = "**Verdict**\n\n**Part**\nx";
  const count = (html: string): number => html.split("font-size:16px").length - 1;
  assert.equal(count(toTeamsHtml(answer)), 1);
  assert.equal(count(toTeamsHtml(answer, { lead: false })), 0); // a later part of a long answer
  assert.equal(count(toTeamsHtml("text first\n\n**Part**")), 0);
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = [r ?? 0, g ?? 0, b ?? 0].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test("status colours are readable on light and dark themes", () => {
  assert.deepEqual(new Set(Object.keys(STATUS_COLORS)), new Set(["✅", "⚠", "❌", "⏳"]));
  for (const [emoji, color] of Object.entries(STATUS_COLORS)) {
    // white and light grey message backgrounds, the two dark Teams message backgrounds
    for (const background of ["#ffffff", "#f5f5f5", "#292929", "#1f1f1f"]) {
      assert.ok(contrast(color, background) >= 3.3, `${emoji} ${color} ${background}`);
    }
  }
  assert.equal(new Set(Object.values(STATUS_COLORS)).size, 4);
});

test("a realistic answer", () => {
  const markdown =
    "**⏳ One line: code is ready, one approval left**\n\n" +
    "**Main line**\n" +
    "- ✅ **#133** confirmed by both sides\n" +
    "- ⏳ Waiting on [#132](https://board.example/board/132): review fixes pushed, merge on ACK\n" +
    "- 📌 Then run **3 sessions** on `mb8`\n\n" +
    "📌 Next: confirm #132.";
  assert.equal(
    toTeamsHtml(markdown),
    `${LEAD}${paint(BLUE, "⏳ One line: code is ready, one approval left")}${END}${BR}${BR}` +
      `${LABEL}Main line${END}${BR}` +
      `• ✅ ${paint(GREEN, "<b>#133</b>")} confirmed by both sides${BR}` +
      `• ⏳ ${paint(BLUE, 'Waiting on <a href="https://board.example/board/132">#132</a>')}: review fixes pushed, merge on ACK${BR}` +
      `• 📌 Then run <b>3 sessions</b> on <code>mb8</code>${BR}${BR}` +
      "📌 Next: confirm #132.",
  );
});
