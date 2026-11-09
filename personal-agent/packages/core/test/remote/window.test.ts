// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The session card as the window: when it is posted again, and the output it holds (`remote/window/`).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FULL_PARTS_MAX,
  FULL_PART_CHARS,
  chatBoxLine,
  fullParts,
  modeSetLine,
  sentLabel,
  tailLines,
} from "../../src/remote/window/output.js";
import {
  REPOST_EDITS,
  REPOST_EDITS_STREAMING,
  REPOST_GROWTH,
  WindowView,
  markEdited,
  markPosted,
  quotesWindow,
  shouldRepost,
  takesInput,
} from "../../src/remote/window/view.js";

test("the repost rule", () => {
  const view = new WindowView();
  view.reset("rs-1");
  markPosted(view, []);
  assert.ok(!shouldRepost(view, [])); // nothing changed: an edit
  view.setText("x".repeat(50));
  assert.ok(!shouldRepost(view, []) && shouldRepost(view, [], true)); // a little more: an edit, unless the turn ended
  view.setText("x".repeat(REPOST_GROWTH + 1));
  assert.ok(shouldRepost(view, [])); // a lot more: again at the bottom
  markPosted(view, []);
  assert.ok(shouldRepost(view, ["a1"]) && shouldRepost(view, ["a1"], false, true)); // a new approval, always
  markPosted(view, ["a1"]);
  for (let i = 0; i < REPOST_EDITS; i += 1) markEdited(view);
  assert.ok(shouldRepost(view, ["a1"]) && !shouldRepost(view, ["a1"], false, true)); // many edits; a streaming turn waits longer
  for (let i = 0; i < REPOST_EDITS_STREAMING; i += 1) markEdited(view);
  assert.ok(shouldRepost(view, ["a1"], false, true));
  markPosted(view, ["a1"]);
  view.setText("a new turn"); // another turn's output: measured from nothing
  assert.ok(view.postedLen === 0 && !shouldRepost(view, ["a1"]) && shouldRepost(view, ["a1"], true));
  markPosted(view, ["a1"]);
  assert.ok(shouldRepost(view, ["a1"], true)); // a turn's end, even with no new output (the card said "running")
});

test("full output parts are bounded and masked", () => {
  const text =
    Array.from({ length: 2000 }, (_, i) => `${String(i)} ${"y".repeat(100)}`).join("\n") + "\nghp_" + "a".repeat(36);
  const parts = fullParts(text);
  assert.equal(parts.length, FULL_PARTS_MAX);
  assert.ok(parts.every((p) => p.length <= FULL_PART_CHARS));
  assert.ok(!(parts.at(-1) ?? "").includes("ghp_" + "a".repeat(36)));
});

/** What a view holds, read through a function (the checks below change it between reads). */
function shown(view: WindowView): { text: string; note: string; draft: string; postedLen: number; seen: number } {
  return {
    text: view.text,
    note: view.note,
    draft: view.draft,
    postedLen: view.postedLen,
    seen: view.approvalsSeen.size,
  };
}

test("a view of another session starts empty and only a continuation keeps its measure", () => {
  const view = new WindowView();
  view.reset("s1");
  view.setText("hello");
  view.note = "Stopped.";
  view.draft = "half typed";
  markPosted(view, ["a1"]);
  view.reset("s1"); // (the same session: nothing is forgotten)
  assert.deepEqual(shown(view), { text: "hello", note: "Stopped.", draft: "half typed", postedLen: 5, seen: 1 });
  view.setText("hello world");
  assert.equal(view.postedLen, 5);
  view.reset("s2");
  assert.deepEqual(shown(view), { text: "", note: "", draft: "", postedLen: 0, seen: 0 });
  view.setText("y".repeat(70_000));
  assert.equal(shown(view).text.length, 60_000);
});

test("the tail of the output fits the card and says what was left out", () => {
  assert.deepEqual(tailLines("", 900, 14), { lines: [], cut: false });
  assert.deepEqual(tailLines("one\ntwo\n", 900, 14), { lines: ["one", "two"], cut: false });
  const many = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join("\n");
  const tail = tailLines(many, 900, 14);
  assert.ok(tail.cut && tail.lines.length === 14 && tail.lines[0] === "line 6");
  assert.deepEqual(tailLines("z".repeat(10), 4, 14), { lines: ["zzzz"], cut: true });
});

test("where typed text goes is said in the chat's language", () => {
  assert.ok(takesInput("idle") && !takesInput("working"));
  assert.ok(quotesWindow(["c2"], ["c1", "c2"]) && !quotesWindow(["c3"], ["c1", ""]) && !quotesWindow(["x"], [""]));
  assert.equal(sentLabel("quote", "en"), "You replied quoting the card: ");
  assert.equal(sentLabel("", "zh"), "你从卡片发的：");
  assert.ok(chatBoxLine("card", "en", "Clawy").startsWith("What you type in the chat box goes to Clawy;"));
  assert.ok(chatBoxLine("chat", "zh", "Clawy").startsWith("聊天框里打的字都发给这个会话"));
  assert.equal(
    modeSetLine("chat", "en", true, "Clawy"),
    "Done: while a chat is attached, what you type goes to the session (this chat too, from now on). Messages that start with @Clawy still come to me.",
  );
  assert.equal(
    modeSetLine("card", "zh", false, "Clawy"),
    "好的：接入会话后，聊天框留给 Clawy，发给会话用会话卡片上的输入框。",
  );
});
