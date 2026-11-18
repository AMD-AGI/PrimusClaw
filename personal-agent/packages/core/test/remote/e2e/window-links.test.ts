// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// An agent's output in the session card and in its full output, through the worker: every address broken where it stands, so
// none can be followed, and a plain sentence as it is.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import { fullBlockText } from "../../../src/remote/clicks.js";
import { USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { answering, lastWindow, sendFromCard, statusCardId, windowed } from "./window-helpers.js";

const LINES = [
  "L1 请看 example.com/path 这一页。",
  "docs.example.museum/x",
  "a@b.example",
  "L4 write `a@b.example now",
  "| docs.example.museum/p\\| | x |",
  "main.py:42",
  "a@b.com.1",
  "L7 今天下午三点开会，请准时参加。",
];
/** Each line as the card's TextBlock holds it (its markdown escaped) and as the client reads it. */
const SHOWN = [
  "L1 请看 example\u200b.com/path 这一页。",
  "docs.example\u200b.museum/x",
  "a@\u200bb.example",
  "L4 write \\`a@\u200bb.example now",
  "\\| docs.example\u200b.museum/p\\\\\\| \\| x \\|",
  "main\u200b.py:42",
  "a@\u200bb.com.1",
  "L7 今天下午三点开会，请准时参加。",
];

test("the agents output in the card and in the full output has no address that can be followed", () =>
  remoteWorld(
    async (w) => {
      const sid = await windowed(w, answering(LINES.join("\n")));
      await sendFromCard(w, sid, "show me");
      await w.idle();
      await sleep(100);
      const tail = ((lastWindow(w)["body"] ?? []) as Record<string, unknown>[]).find((b) => b["id"] === "window_tail");
      const items = (tail?.["items"] ?? []) as Record<string, unknown>[];
      assert.deepEqual(
        items.map((i) => i["text"]),
        SHOWN,
      );
      const before = w.operations().length;
      await w.click({ primusclaw: "remote", op: "full", session_id: sid }, USER_A, statusCardId(w));
      const full = w
        .operations()
        .slice(before)
        .filter((o) => o.op === "send")
        .map((o) => o.text)
        .join("\n");
      for (const part of [
        "example\u200b.com/path",
        "docs.example\u200b.museum/x",
        "a@\u200bb.example",
        "main\u200b.py:42",
      ]) {
        assert.ok(full.includes(part), `${part}: ${full}`);
      }
      assert.ok(full.includes("L7 今天下午三点开会，请准时参加。"), full);
      assert.ok(!full.includes("example.com/path") && !full.includes("a@b.example"), full);
    },
    { windowDefault: "card" },
  ));

test("a character the rich text drops cannot close the full output's block or join an address in it", () => {
  // (the rich text drops controls and bidi overrides before it reads: a fence split by one closes the block once read, and
  // `https:\x01//` is `https://`)
  const shown = fullBlockText("`\u{202e}``\nhttps:\x01//127.0.0.1/x and www\u{2066}.w.example");
  assert.equal(shown, "ʼʼʼ\nhttps:​//127.0.0.1/x and www​.w.example");
});
