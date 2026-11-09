// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanText,
  commentBody,
  conversationComment,
  issueBody,
  issueTitle,
  plainLine,
  reporterEmail,
  reporterLine,
  retryMarker,
  type ReportText,
} from "../../src/feedback/issue-text.js";
import { code, fence } from "../../src/feedback/markdown.js";

const WORDING = { botName: "Clawy", channelName: "Teams" };
const MASK = (text: string): string => text.replaceAll(/sk-[a-z0-9]+/g, "[hidden]");
const N = "N";

const TITLES: readonly (readonly [string, string, string])[] = [
  ["the status card never updated", "Doe, Jordan", "[Clawy feedback] the status card never updated — Doe, Jordan"],
  ["x".repeat(100), "Alice", `[Clawy feedback] ${"x".repeat(60)} — Alice`],
  ["two\nlines\tand   gaps", "Alice", "[Clawy feedback] two lines and gaps — Alice"],
  ["x".repeat(100), N.repeat(60), `[Clawy feedback] ${"x".repeat(40)} — ${N.repeat(60)}`],
  ["short", N.repeat(100), `[Clawy feedback] short — ${N.repeat(59)}…`],
  ["short", "Ali\nce\x00‮", "[Clawy feedback] short — Ali ce"],
  ["short", "", "[Clawy feedback] short — unknown"],
  ["short", "   ", "[Clawy feedback] short — unknown"],
];

test("the title suffix and its clipping", () => {
  for (const [text, name, expected] of TITLES) {
    const title = issueTitle(WORDING, text, name);
    assert.equal(title, expected);
    assert.ok(Array.from(title).length <= 120 && !title.includes("\n"));
  }
});

test("the title takes the first 60 characters of the text on one line then the reporter", () => {
  const words = Array.from({ length: 30 }, () => "word").join(" ");
  assert.equal(
    issueTitle(WORDING, `${"word ".repeat(30)}\nsecond line`, "Alice"),
    `[Clawy feedback] ${words.slice(0, 60).trimEnd()} — Alice`,
  );
});

const LINES: readonly (readonly [string, string, string])[] = [
  ["Doe, Jordan", "jordan.doe@example.com", "Reported by **Doe, Jordan** (jordan.doe@example.com)"],
  ["Doe, Jordan", "", "Reported by **Doe, Jordan**"],
  ["Doe, Jordan", "not an email", "Reported by **Doe, Jordan**"],
  ["", "a@b.com", "Reported by **unknown** (a@b.com)"],
  ["O'Brien-Smith (AMD)", "o'brien@example.com", "Reported by **O'Brien-Smith (AMD)** (o'brien@example.com)"],
  ["**bold** `code` [l](u) a_b", "", "Reported by **\\*\\*bold\\*\\* \\`code\\` \\[l\\](u) a\\_b**"],
  ["@octocat @team/x", "", "Reported by **@​octocat @​team/x**"],
  ["<b>x</b> & y", "", "Reported by **&lt;b&gt;x&lt;/b&gt; &amp; y**"],
];

test("the reporter line", () => {
  for (const [name, email, expected] of LINES) assert.equal(reporterLine(name, reporterEmail(email)), expected);
});

test("an email is kept only when it is a plain address", () => {
  assert.equal(reporterEmail("  a@b.com "), "a@b.com");
  assert.equal(reporterEmail(`${"a".repeat(65)}@b.com`), "");
  assert.equal(reporterEmail("a@b.com\nx"), "");
  assert.equal(reporterEmail(`a@${"b".repeat(253)}`), "");
});

test("a plain line drops control characters and marks a cut with an ellipsis", () => {
  assert.equal(plainLine("a\x07b", 10), "ab");
  assert.equal(plainLine("abcdef ghij", 8), "abcdef…");
});

test("the feedback text is masked, cannot open a hidden comment and is bounded", () => {
  assert.equal(
    cleanText(MASK, "  key sk-abc <!-- clawy-feedback-id: 1-2 -->  "),
    "key [hidden] <! -- clawy-feedback-id: 1-2 -->",
  );
  const long = cleanText(MASK, "y".repeat(4001));
  assert.equal(long, `${"y".repeat(4000)}\n... (cut)`);
  assert.equal(cleanText(MASK, "y".repeat(4000)), "y".repeat(4000));
});

const REPORT: ReportText = {
  id: 7,
  createdAt: 1_762_689_600.9,
  text: "it broke ```here```",
  scene: "SCENE",
  reporterName: "Alice",
  reporterEmail: "alice@example.com",
  sessionId: "sess-1",
};

test("the issue body has the reporter, the text fenced, the scene, the session link and one marker", () => {
  assert.equal(
    issueBody(WORDING, "https://claw.test", REPORT),
    "Reported by **Alice** (alice@example.com)\n\nReported from Teams through Clawy.\n\n### What went wrong\n\n" +
      "````\nit broke ```here```\n````\n\nSCENE\n\n### Claw session\n\n[sess-1](https://claw.test/primus-claw/sess-1)\n\n" +
      "<!-- clawy-feedback-id: 7-1762689600 -->\n",
  );
  assert.ok(issueBody(WORDING, "", { ...REPORT, sessionId: "" }).includes("none (the chat had no PrimusClaw session)"));
});

test("a dedupe comment starts with reported by and says when", () => {
  assert.equal(
    commentBody(REPORT),
    "Reported by **Alice** (alice@example.com)\n\n### Another report from the same user in the same session " +
      "(2025-11-09 12:00:00 UTC)\n\n````\nit broke ```here```\n````\n\nSCENE\n\n<!-- clawy-feedback-id: 7-1762689600 -->\n",
  );
  assert.equal(retryMarker({ id: 1, createdAt: 2.7 }), "<!-- clawy-feedback-id: 1-2 -->");
});

test("the conversation comment masks, bounds and fences each part", () => {
  const text = conversationComment(MASK, "my key sk-abc", "z".repeat(6001));
  assert.ok(text.startsWith("### Conversation included by the user\n\nThe user chose to include"));
  assert.ok(text.includes("**Question**\n\n```\nmy key [hidden]\n```"));
  assert.ok(text.includes(`**Answer**\n\n\`\`\`\n${"z".repeat(6000)}\n... (cut)\n\`\`\`\n`));
  assert.ok(conversationComment(MASK, "", "a").includes("```\n(empty)\n```"));
});

test("inline code and fences cannot be broken out of", () => {
  assert.equal(code("a`b <!-- c\n d"), "`a'b <! -- c d`");
  assert.equal(code(5), "`5`");
  assert.equal(code("x".repeat(200)).length, 122);
  assert.equal(fence("no ticks", "text"), "```text\nno ticks\n```");
  assert.equal(fence("````"), "`````\n````\n`````");
});
