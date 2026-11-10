// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's cards and their words: a work item's card, the board, a command or a write put to the person, the files of
 * an assistant message (teams/tests/test_assistant_cards.py's card tests), and the pure helpers core keeps for them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cpLength,
  WORK_TEXT_MAX,
  ago,
  askedLine,
  askedRow,
  boardLine,
  cardParagraphs,
  fitsWorkCard,
  retryable,
  workEventText,
  type ReviewAskedOfOther,
} from "@primusclaw/personal-agent";
import { Ajv } from "ajv";

import type { JsonObject } from "../src/cards/json.js";
import { assistantRenderers, noteCard } from "../src/views/assistant/index.js";
import { askerView, wi } from "../../../test-support/card-catalog/assistant.js";

/** A JSON value as the text it shows ("" when absent). */
function s(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

const schema = JSON.parse(
  readFileSync(new URL("../../../test-support/data/adaptive-card-1.5.schema.json", import.meta.url), "utf8"),
) as JsonObject;
const rules = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "id"));
const validate = new Ajv({ strict: false, allErrors: true }).compile({ ...rules, $id: s(schema["id"]) });
const BAR = "┃";

function valid(card: JsonObject): void {
  assert.ok(validate(card), JSON.stringify(validate.errors));
}

function cardOf(activity: JsonObject): JsonObject {
  const [attachment] = activity["attachments"] as [JsonObject];
  return attachment["content"] as JsonObject;
}

/** The words of a card element, in order, wherever they sit (containers, columns, facts); not the header's bar. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node !== "object" || node === null) return [];
  const n = node as JsonObject;
  if (n["type"] === "TextBlock") return n["text"] === BAR ? [] : [s(n["text"])];
  return [...texts(n["items"] ?? []), ...texts(n["columns"] ?? [])];
}

const body = (card: JsonObject) => card["body"] as JsonObject[];
const actions = (card: JsonObject) => (card["actions"] ?? []) as JsonObject[];

// --- the work cards and the board -----------------------------------------------------------------------------------------------

const item = wi({
  itemId: "wi-1",
  seq: 3,
  title: "Fix __init__.py",
  resultVersion: 2,
  canAccept: true,
  lastReportKind: "ready",
  summary: "A summary",
});

function work(fields: Partial<Parameters<typeof assistantRenderers.workCard>[0]> = {}) {
  return cardOf(
    assistantRenderers.workCard({
      item,
      text: "",
      cardId: "c1",
      note: "",
      watch: false,
      watching: false,
      lang: null,
      ...fields,
    }),
  );
}

test("the cards validate and are one column with at most three actions", () => {
  const cards = [
    work({ text: "Done.\nSee the PR." }),
    work({ note: "note" }),
    cardOf(assistantRenderers.workDone({ verb: "Accepted", item })),
    cardOf(assistantRenderers.workDone({ verb: "Stopped", item })),
    cardOf(assistantRenderers.board({ items: [item], asked: [], now: 0, accept: [], retry: [], lang: null })),
  ];
  for (const card of cards) {
    valid(card);
    assert.ok(actions(card).length <= 3 && body(card).length <= 7);
    for (const b of body(card)) {
      assert.ok(["TextBlock", "Container", "ColumnSet"].includes(s(b["type"])));
      if (b["type"] !== "ColumnSet") continue;
      // a ColumnSet is a heading with its bar, the board's count badges, or one of its rows (emoji + words)
      const columns = b["columns"] as JsonObject[];
      const first = columns[0] as JsonObject;
      const firstText = (first["items"] as JsonObject[])[0]?.["text"];
      assert.ok(
        (columns.length === 2 && firstText === BAR) ||
          s(first["id"]).startsWith("badge-") ||
          (s(b["id"]).startsWith("row-") && columns.length === 2 && first["width"] === "auto"),
      );
    }
  }
});

test("an asked line never fails on a link it cannot read", () => {
  const cases: Array<readonly [string, string]> = [
    ["https://github.com/AMD-AGI/PrimusClaw/pull/7", "AMD-AGI/PrimusClaw#7"],
    ["https://github.com]/o/r/pull/1", "https://github.com]/o/r/pull/1"],
    ["https://github.com/o/r/pull/x", "https://github.com/o/r/pull/x"],
    ["", "kwi_9"],
  ];
  for (const [url, shown] of cases) {
    const line = askedLine({
      itemId: "kwi_9",
      reviewer: "Lin Mei",
      view: askerView({ itemId: "kwi_9", status: "in_progress", prUrl: url }),
    });
    assert.ok(line.startsWith(`${shown} (Lin Mei)`), line);
  }
});

test("a work card offers auto-reply on a task, or turning it off once on, and only Stop when nothing waits", () => {
  const watch = work({ watch: true });
  assert.deepEqual(
    actions(watch).map((a) => [a["title"], a["verb"], a["style"]]),
    [
      ["Accept v2", "primusclaw.work_accept", "positive"],
      ["Stop", "primusclaw.work_stop", undefined],
      ["Auto-reply to PR comments", "primusclaw.work_watch", undefined],
    ],
  );
  assert.ok(texts(body(watch)).at(-1)?.startsWith("Auto-reply: once on"));
  const watching = work({ watch: true, watching: true, lang: "zh" });
  assert.deepEqual(
    actions(watching).map((a) => a["title"]),
    ["接受 v2", "停止", "关闭自动处理"],
  );
  assert.ok(texts(body(watching)).at(-1)?.startsWith("PR 评论自动回复已开启"));
  const review = work({ item: { ...item, kind: "review" }, watch: true });
  assert.equal(actions(review).length, 2, "a review has no auto-reply of its own");
  const waiting = work({ item: { ...item, canAccept: false }, text: "要哪个频道？" });
  assert.deepEqual(texts(body(waiting)), ["⚠️ #3 Fix \\_\\_init\\_\\_.py", "等你回复", "要哪个频道？"]);
  assert.deepEqual(
    actions(waiting).map((a) => [a["title"], a["style"]]),
    [["停止", "destructive"]],
  );
  assert.deepEqual(actions(waiting)[0]?.["data"], { primusclaw: "work", op: "stop", card: "c1" });
});

test("a work card lays every line out as a paragraph and clips what does not fit", () => {
  const card = work({ text: `${"x".repeat(700)}\n\ny` });
  const shown = texts(body(card))[2] ?? "";
  assert.equal(cpLength(shown), WORK_TEXT_MAX);
  assert.ok(shown.endsWith("…"));
  assert.equal(cardParagraphs(" a \r\nb c\x1c\n\n d "), "a\n\nb\n\nc\n\nd");
  const many = Array.from({ length: 250 }, () => "x").join("\n");
  assert.ok(many.length <= WORK_TEXT_MAX && !fitsWorkCard(many), "laid out, 250 short lines no longer fit");
  assert.ok(fitsWorkCard("short"));
});

test("a work card put back after a press has its note and its buttons", () => {
  const card = cardOf(
    assistantRenderers.workNote({ text: "Claw did not answer.", cardId: "c1", version: 3, canAccept: true }),
  );
  valid(card);
  assert.deepEqual(texts(body(card)), ["Claw did not answer."]);
  assert.deepEqual(
    actions(card).map((a) => a["title"]),
    ["Accept v3", "Stop"],
  );
  const titled = cardOf(noteCard("x", [], "Not done", "attention"));
  assert.deepEqual(texts(body(titled)), ["❌ Not done", "x"]);
  assert.deepEqual(texts(body(cardOf(noteCard("x", [], "Done", "good")))), ["✅ Done", "x"]);
  assert.deepEqual(texts(body(cardOf(noteCard("x", [], "Wait", "warning")))), ["⚠️ Wait", "x"]);
});

test("the board's buttons accept every result that waits and retry tasks within three buttons", () => {
  const retry = [5, 6, 7].map((seq) => ({ cardId: `r${String(seq)}`, item: wi({ seq }) }));
  const card = cardOf(
    assistantRenderers.board({ items: [item], asked: [], now: 0, accept: ["a1", "a2"], retry, lang: "zh" }),
  );
  assert.deepEqual(
    actions(card).map((a) => [a["title"], a["style"]]),
    [
      ["全部接受（2）", "positive"],
      ["重试 #5", undefined],
      ["重试 #6", undefined],
    ],
  );
  assert.deepEqual(actions(card)[0]?.["data"], { primusclaw: "work", op: "accept_all", cards: ["a1", "a2"] });
  assert.deepEqual(actions(card)[1]?.["data"], { primusclaw: "work", op: "retry", card: "r5" });
  const retryOnly = cardOf(
    assistantRenderers.board({ items: [item], asked: [], now: 0, accept: [], retry, lang: "en" }),
  );
  assert.deepEqual(
    actions(retryOnly).map((a) => [a["title"], a["style"]]),
    [
      ["Retry #5", "positive"],
      ["Retry #6", undefined],
      ["Retry #7", undefined],
    ],
  );
});

test("a long board section shows the newest, folds the rest of eight and counts the older ones", () => {
  const items = Array.from({ length: 11 }, (_, i) =>
    wi({ itemId: `i${String(i)}`, seq: i, title: `Task ${String(i)}`, canAccept: false }),
  );
  const card = cardOf(assistantRenderers.board({ items, asked: [], now: 0, accept: [], retry: [], lang: null }));
  valid(card);
  const ids = body(card).map((b) => s(b["id"] ?? b["type"]));
  assert.deepEqual(ids.slice(2), [
    "band-needs_you",
    "row-i0",
    "row-i1",
    "row-i2",
    "row-i3",
    "more-needs_you-toggle",
    "more-needs_you",
    "TextBlock",
  ]);
  assert.deepEqual(texts(body(card)[0]), ["📋 Your tasks", "11 waiting for you"]);
  assert.deepEqual(texts(body(card).at(-1)), ["and 3 older"]);
  assert.deepEqual(texts(body(card)[7]), ["4 more ▾"]);
});

function asked(n: number, fields: Partial<ReviewAskedOfOther["view"]> & { status: string }, reviewer = "Lin Mei") {
  const itemId = `kwi_${String(n)}`;
  return {
    itemId,
    reviewer,
    view: askerView({ itemId, prUrl: `https://github.com/o/r/pull/${String(n)}`, ...fields }),
  };
}

test("the reviews asked of others stand beside the person's own, in their language", () => {
  const list = [
    asked(1, { status: "waiting_for_reviewer", verdict: "approve", waitingFor: "confirm_merge" }),
    asked(2, { status: "waiting_for_reviewer", waitingFor: "failed" }),
    asked(3, { status: "in_progress" }),
    asked(4, { status: "done", verdict: "request_changes" }),
    asked(5, { status: "stopped" }, ""),
    asked(6, { status: "waiting", waitingFor: "reviewer" }),
    asked(7, { status: "needs_you", verdict: "comment", waitingFor: "confirm_review" }),
    asked(8, { status: "done", verdict: "approve" }),
    asked(9, { status: "queued", verdict: "constructor" }),
  ];
  const card = cardOf(assistantRenderers.board({ items: [], asked: list, now: 0, accept: [], retry: [], lang: "zh" }));
  valid(card);
  const at = body(card).findIndex((b) => b["id"] === "band-handoff");
  assert.deepEqual(texts(body(card)[at]), ["🤝 请别人做的代审 · 9"]);
  const rows = body(card)
    .slice(at + 1)
    .map(texts);
  assert.deepEqual(rows, [
    ["🤝", "o/r#1 (Lin Mei) · 已批准，合入等 Lin Mei 确认"],
    ["❌", "o/r#2 (Lin Mei) · 失败，重新请求即可重试"],
    ["🔍", "o/r#3 (Lin Mei) · 审阅中"],
    ["还有 5 条 ▾"],
    [
      ...["⏹️", "o/r#4 (Lin Mei) · 要求修改，未合入"],
      ...["⏹️", "o/r#5 (the reviewer) · 已停止，未合入"],
      ...["🤝", "o/r#6 (Lin Mei) · 等 Lin Mei"],
      ...["🤝", "o/r#7 (Lin Mei) · 已评论，批准等 Lin Mei 确认"],
      ...["✅", "o/r#8 (Lin Mei) · 已批准，未合入"],
    ],
    ["以及更早的 1 条"],
  ]);
  assert.deepEqual(texts(body(card)[1]), ["⚠️ **0** 待处理", "⏳ **0** 进行中", "✅ **0** 已完成"]);
  assert.equal(
    askedLine(asked(9, { status: "queued", verdict: "constructor" })),
    "o/r#9 (Lin Mei) - being reviewed",
    "a verdict Claw does not name is no verdict",
  );
  assert.equal(
    askedLine(asked(10, { status: "waiting", waitingFor: "something new" })),
    "o/r#10 (Lin Mei) - waits for Lin Mei",
  );
  assert.equal(askedLine(asked(11, { status: "done", merged: true })), "o/r#11 (Lin Mei) - done, merged");
});

test("a board line says what matters about an item in its column", () => {
  const cases: Array<readonly [Parameters<typeof wi>[0], string, string]> = [
    [{ boardState: "done", outcome: "accepted" }, "#12 t — accepted", "#12 t — 已接受"],
    [{ boardState: "done", outcome: null }, "#12 t — closed", "#12 t — 已关闭"],
    [{ boardState: "done", outcome: "answered" }, "#12 t — answered", "#12 t — answered"],
    [{}, "#12 t — result v2 is ready", "#12 t — 结果 v2 待接受"],
    [{ canAccept: false, pendingQuestion: "which?" }, "#12 t — asks: which?", "#12 t — 在问：which?"],
    [{ canAccept: false, lastReportKind: "blocked" }, "#12 t — blocked", "#12 t — 卡住了"],
    [{ canAccept: false }, "#12 t — needs you", "#12 t — 等你处理"],
    [{ boardState: "in_progress", summary: "" }, "#12 t", "#12 t"],
    [{ boardState: "in_progress", summary: "half" }, "#12 t — half", "#12 t — half"],
  ];
  for (const [fields, en, zh] of cases) {
    const it = wi({ title: "t", ...fields });
    assert.equal(boardLine(it), en);
    assert.equal(boardLine(it, "zh"), zh);
  }
});

test("a word Claw sends that names a property every object has is any other word to the card (the Python worker's dict.get)", () => {
  // Expected values computed by the Python worker (render.board_line, asked_line, asked_section) for each word.
  for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const done = wi({ title: "t", boardState: "done", outcome: word });
    assert.equal(boardLine(done), `#12 t — ${word}`);
    assert.equal(boardLine(done, "zh"), `#12 t — ${word}`);
    const report = wi({ title: "t", canAccept: false, lastReportKind: word });
    assert.equal(boardLine(report), "#12 t — needs you");
    assert.equal(boardLine(report, "zh"), "#12 t — 等你处理");
    assert.equal(askedLine(asked(9, { status: "waiting", waitingFor: word })), "o/r#9 (Lin Mei) - waits for Lin Mei");
    assert.deepEqual(askedRow(asked(9, { status: "waiting", waitingFor: "reviewer" }, `Lin Mei, ${word}`), "zh"), [
      `o/r#9 (Lin Mei, ${word})`,
      `等 Lin Mei，${word}`,
    ]);
  }
});

test("a board row's emoji says the item's state at a glance", () => {
  const card = cardOf(
    assistantRenderers.board({
      items: [
        wi({ itemId: "q", canAccept: false, pendingQuestion: "?" }),
        wi({ itemId: "f", canAccept: false, lastReportKind: "failed" }),
        wi({ itemId: "n", canAccept: false }),
        wi({ itemId: "w", boardState: "in_progress", canAccept: false }),
      ],
      asked: [],
      now: 0,
      accept: [],
      retry: [],
      lang: "en",
    }),
  );
  const marks = body(card)
    .filter((b) => s(b["id"]).startsWith("row-"))
    .map((b) => texts(b)[0]);
  assert.deepEqual(marks, ["❓", "❌", "⚠️", "⏳"]);
});

test("only a task that failed or was stopped is retried", () => {
  const now = 1_761_800_000;
  const updatedAt = new Date((now - 60) * 1000).toISOString();
  assert.ok(retryable(wi({ canAccept: false, lastReportKind: "failed" }), now));
  assert.ok(retryable(wi({ boardState: "done", outcome: "stopped", updatedAt }), now));
  assert.ok(!retryable(wi({ boardState: "done", outcome: "stopped", kind: "review", updatedAt }), now));
  assert.ok(!retryable(wi({ boardState: "done", outcome: "accepted", updatedAt }), now));
  assert.ok(!retryable(wi({ lastReportKind: "blocked" }), now));
});

test("how long ago an item changed is short, and nothing when it is not known", () => {
  const now = 1_000_000;
  const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1000).toISOString();
  assert.equal(ago(iso(30), now, "en"), "just now");
  assert.equal(ago(iso(-600), now, "zh"), "刚刚", "a clock ahead of ours is now");
  assert.equal(ago(iso(5 * 60), now, "zh"), "5 分钟前");
  assert.equal(ago(iso(3 * 3600), now, "en"), "3 h ago");
  assert.equal(ago(iso(47 * 3600), now, "zh"), "47 小时前");
  assert.equal(ago(iso(3 * 86400), now, "en"), "3 d ago");
  assert.equal(ago("", now, "en"), "");
  assert.equal(ago("yesterday", now, "en"), "");
});

test("what an assistant event says is its own text, or that the item needs the person", () => {
  assert.equal(workEventText(item, "  Done.  "), "Done.");
  assert.equal(workEventText(item, null), "#3 Fix __init__.py needs you.");
  assert.equal(workEventText(null, ""), "");
});

test("a command and a write put to the person carry only the card's id, in the person's language", () => {
  const action = cardOf(
    assistantRenderers.actionCard({ text: "Run the `tests`?", cardId: "c4", command: "make `test`", lang: null }),
  );
  valid(action);
  assert.deepEqual(texts(body(action)), ["⚠️ Run this command?", "Run the `tests`?", "`make test`"]);
  assert.deepEqual(
    actions(action).map((a) => [a["title"], a["data"]]),
    [
      ["Run", { primusclaw: "assistant_action", op: "run", card: "c4" }],
      ["Cancel", { primusclaw: "assistant_action", op: "cancel", card: "c4" }],
    ],
  );
  const zh = cardOf(assistantRenderers.actionCard({ text: "Run it?", cardId: "c4", command: "ls", lang: "zh" }));
  assert.deepEqual(
    actions(zh).map((a) => a["title"]),
    ["执行", "取消"],
  );
  const write = cardOf(
    assistantRenderers.confirmWrite({ text: "Every day at 9.", cardId: "c5", allowLabel: "", lang: "en" }),
  );
  valid(write);
  assert.deepEqual(texts(body(write)), ["⚠️ Please confirm", "Every day at 9."]);
  assert.deepEqual(
    actions(write).map((a) => [a["title"], a["verb"]]),
    [
      ["Confirm", "primusclaw.assistant_confirm_allow"],
      ["Don't", "primusclaw.assistant_confirm_deny"],
    ],
  );
});
