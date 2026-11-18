// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { workItem } from "../../../../test-support/assistant/work-items.js";
import { Board } from "../../src/assistant/board.js";
import { ClawError } from "../../src/claw/errors.js";
import { silentLogger } from "../../src/ports/logger.js";
import { ALICE, clicksWorld } from "./clicks-world.js";

it("the board shows the items and a card for each that waits", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "a" }));
  w.claw.add(workItem({ itemId: "b", canAccept: false, pendingQuestion: "Which branch?" }));
  w.claw.add(workItem({ itemId: "c", boardState: "in_progress", canAccept: false }));
  await w.board.show(ALICE, "ak", w.conversation);
  assert.deepEqual(w.sent(), ["view:board", "view:workCard", "view:workCard"]);
});

it("an empty board, an unavailable one and a refused key are said", async () => {
  const w = clicksWorld();
  await w.board.show(ALICE, "ak", w.conversation);
  w.claw.fail.set("list", new ClawError(404));
  await w.board.show(ALICE, "ak", w.conversation);
  w.claw.fail.set("list", new ClawError(401));
  await w.board.show(ALICE, "ak", w.conversation);
  w.claw.fail.set("list", new ClawError(500));
  await w.board.show(ALICE, "ak", w.conversation);
  assert.deepEqual(w.sent(), [
    "You have no tasks yet. Tell me what you need done and I will start one.",
    "The task board is not available yet.",
    "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
    "I could not read your tasks just now. Please try again in a moment.",
  ]);
});

it("more than five waiting items are counted and the reviews asked of others are best effort", async () => {
  const w = clicksWorld();
  for (let i = 0; i < 7; i += 1) w.claw.add(workItem({ itemId: `i${String(i)}` }));
  w.claw.fail.set("asked", new ClawError(500));
  await w.board.show(ALICE, "ak", w.conversation);
  const out = w.sent();
  assert.equal(out.filter((l) => l === "view:workCard").length, 5);
  assert.equal(out.at(-1), "2 more tasks wait for you; answer or accept the ones above and send /board again.");
});

it("a development environment item that waits shows its own approval card", async () => {
  const w = clicksWorld();
  w.claw.add(
    workItem({
      itemId: "r1",
      kind: "remote",
      canAccept: false,
      params: { session_id: "rs-1", waiting: ["a1"], machine: "robin-dev" },
    }),
  );
  w.store.remotePermissions.saveRemotePermission({
    userId: ALICE,
    sessionId: "rs-1",
    actionId: "a1",
    tool: "Bash",
    options: [],
    expiresAt: w.store.now() + 600,
  });
  await w.board.show(ALICE, "ak", w.conversation);
  assert.deepEqual(w.sent(), ["view:board", "ask rs-1 a1"]);
});

it("a development environment item's approval card is drawn again on the board in the language it was shown in", async () => {
  // (the card was shown in Chinese; the item's title is English and the person never chose a language, so a language read again
  // from the title would redraw it in English)
  const w = clicksWorld();
  const drawn: string[] = [];
  const board = new Board({
    store: w.store,
    claw: w.claw,
    logger: silentLogger,
    on: () => true,
    remoteAsk: (r) => {
      drawn.push(`${String(r.ask["action_id"])} ${r.lang}`);
      return { body: { type: "text", text: "" } };
    },
  });
  for (const [itemId, actionId, lang] of [
    ["r1", "a1", "zh"],
    ["r2", "a2", undefined], // (a card shown before its language was kept: as before, from the title)
  ] as const) {
    w.claw.add(
      workItem({
        itemId,
        kind: "remote",
        title: "Fix the flaky upload test",
        canAccept: false,
        params: { session_id: `rs-${itemId}`, waiting: [actionId], machine: "robin-dev" },
      }),
    );
    w.store.remotePermissions.saveRemotePermission({
      userId: ALICE,
      sessionId: `rs-${itemId}`,
      actionId,
      tool: "Bash",
      options: [],
      expiresAt: w.store.now() + 600,
      ...(lang ? { lang } : {}),
    });
  }
  await board.show(ALICE, "ak", w.conversation);
  assert.deepEqual(drawn.sort(), ["a1 zh", "a2 en"]);
});

it("the board is not shown where the assistant is off", async () => {
  const w = clicksWorld();
  const off = new (w.board.constructor as typeof import("../../src/assistant/board.js").Board)({
    store: w.store,
    claw: w.claw,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: function () {
        return this;
      },
    },
    on: () => false,
    remoteAsk: () => ({ body: { type: "text", text: "" } }),
  });
  await off.show(ALICE, "ak", w.conversation);
  assert.deepEqual(w.sent(), ["The task board is not available yet."]);
  assert.equal(await off.now(ALICE, "ak"), undefined);
});
