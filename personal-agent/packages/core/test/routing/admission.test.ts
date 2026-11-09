// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClawPort, Logger, LogValue, MetricsPort, WorkItem } from "@primusclaw/personal-agent";

import { FakeClock } from "../../../../test-support/clock.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { TaskAdmission } from "../../src/routing/admission.js";
import { Chat } from "../../src/routing/chat.js";
import type { RouterDeps, RouterLimits } from "../../src/routing/deps.js";
import type { AssistantChat, RemoteChat } from "../../src/routing/features.js";
import { KeyedLock } from "../../src/routing/lock.js";
import { ActiveTurn, chatTurnKey, reviewTurnKey, TurnRegistry } from "../../src/routing/turn-registry.js";
import { ALICE, personal } from "./fixtures.js";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

function limits(max: number): RouterLimits {
  return {
    maxConcurrentTasks: max,
    assistantPendingSeconds: 90,
    checkMessage: () => ({ allowed: true }),
    rateNotice: () => "slow down",
    concurrencyNotice: (lang, running, what) => `${lang}:${String(running)}${what}`,
  };
}

function setup(max = 2) {
  const clock = new FakeClock();
  const turns = new TurnRegistry();
  const board: { items: string[] | Error } = { items: [] };
  const events: Record<string, LogValue>[] = [];
  const limited: string[] = [];
  const state = { on: true, remoteRunning: false };
  const claw = {
    workItems: {
      list: () =>
        board.items instanceof Error
          ? Promise.reject(board.items)
          : Promise.resolve(board.items.map((itemId) => ({ itemId }) as WorkItem)),
    },
  } as unknown as ClawPort;
  const metrics = { limited: (reason: string) => limited.push(reason) } as unknown as MetricsPort;
  const assistant = { on: () => state.on, understands: () => false } as unknown as AssistantChat;
  const remote = { running: () => state.remoteRunning } as unknown as RemoteChat;
  const deps = {
    limits: limits(max),
    claw,
    clock,
    logger: silent,
    metrics,
    securityEvent: (name: string, fields: Readonly<Record<string, LogValue>>) =>
      events.push({ event: name, ...fields }),
    assistant,
    remote,
  } as unknown as RouterDeps;
  const admission = new TaskAdmission(deps, turns);
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const chat = (locale = "") => new Chat(store, ALICE, surface.conversation(personal()), "", locale);
  return { clock, turns, board, events, limited, state, admission, chat, surface };
}

function said(surface: FakeSurface): string[] {
  return surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : [],
  );
}

test("tasks are the chat turns, the attached agent's turn, prompts being sent and reviews admitted", async () => {
  const w = setup(5);
  w.turns.claim(chatTurnKey(ALICE.id), new ActiveTurn());
  w.state.remoteRunning = true;
  assert.equal(w.admission.running(ALICE.id), 2);
  const inside = await w.admission.reserve(ALICE.id, () => Promise.resolve(w.admission.running(ALICE.id)));
  assert.equal(inside, 3);
  assert.equal(w.admission.running(ALICE.id), 2);
  const slots = await w.admission.admitReviews(w.chat(), "a1", 2, "");
  assert.equal(slots.granted, 2);
  assert.equal(w.admission.running(ALICE.id), 4);
  slots.followed();
  assert.equal(w.admission.running(ALICE.id), 3);
  slots.followed("it-1");
  assert.equal(w.admission.running(ALICE.id), 2);
  slots.release();
});

test("over the limit a task is refused, said in the person's language and recorded", async () => {
  const w = setup(1);
  w.turns.claim(chatTurnKey(ALICE.id), new ActiveTurn());
  assert.equal(await w.admission.overLimit(w.chat("zh-CN"), "act-1", "claw_turn", "o/r#1"), true);
  assert.equal(await w.admission.overLimit(w.chat(), "", "claw_turn"), true);
  assert.deepEqual(said(w.surface), ["zh:1（o/r#1）", "en:1"]);
  assert.deepEqual(w.limited, ["concurrency_limit", "concurrency_limit"]);
  assert.deepEqual(w.events[0], {
    event: "rate_limited",
    aad_object_id: ALICE.id,
    activity_id: "act-1",
    operation: "claw_turn",
    reason: "concurrency_limit",
    scope: "user",
    count: 1,
    limit: 1,
  });
  assert.equal(w.events[1]?.["activity_id"], null);
  const slots = await w.admission.admitReviews(w.chat(), "a2", 3, "");
  assert.equal(slots.granted, 0);
  assert.equal(w.events.at(-1)?.["operation"], "pr_review");
});

test("the assistant's work items in progress count, and a new one lets go the slot of the message that started it", async () => {
  const w = setup(2);
  w.board.items = ["i1"];
  assert.equal(await w.admission.count(ALICE.id, "key"), 1);
  assert.equal(await w.admission.assistantOverLimit(w.chat(), "m1", "key"), false); // (holds a slot: 1 + 1)
  assert.equal(w.admission.handoffsPending(ALICE.id), 1);
  assert.equal(await w.admission.assistantOverLimit(w.chat(), "m2", "key"), true); // (at the limit)
  w.board.items = ["i1", "i2"];
  assert.equal(await w.admission.count(ALICE.id, "key"), 2); // (i2 took m1's slot)
  assert.equal(w.admission.handoffsPending(ALICE.id), 0);
  w.board.items = ["i2"];
  assert.equal(await w.admission.count(ALICE.id, "key"), 1);
  w.board.items = new Error("down");
  assert.equal(await w.admission.count(ALICE.id, "key"), 0); // (an unreadable board refuses nothing)
  assert.equal(await w.admission.count(ALICE.id, ""), 0);
  w.state.on = false;
  w.board.items = ["i9"];
  assert.equal(await w.admission.count(ALICE.id, "key"), 0); // (no assistant: no board)
});

test("a review item followed here is not counted twice from the board; a message's slot runs out", async () => {
  const w = setup(5);
  w.board.items = ["it-7", "i1"];
  w.turns.claim(reviewTurnKey(ALICE.id, "", "it-7", "o/r#7"), new ActiveTurn(true, "it-7"));
  assert.equal(await w.admission.count(ALICE.id, "key"), 2);
  assert.equal(await w.admission.assistantOverLimit(w.chat(), "m1", "key"), false);
  w.admission.dropLastHandoff(ALICE.id);
  w.admission.dropLastHandoff(ALICE.id);
  assert.equal(await w.admission.assistantOverLimit(w.chat(), "m2", "key"), false);
  await w.clock.advance(91_000);
  assert.equal(w.admission.handoffsPending(ALICE.id), 0);
  const slots = await w.admission.admitReviews(w.chat(), "a", 1, "key");
  slots.itemIds.add("i1");
  assert.equal(await w.admission.count(ALICE.id, "key"), 2); // (the turn and the slot: the board's it-7 and i1 are theirs)
});

test("a keyed lock runs one at a time per key, in order", async () => {
  const lock = new KeyedLock();
  const order: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lock.run("k", async () => {
    await gate;
    order.push("first");
  });
  const second = lock.run("k", () => {
    order.push("second");
    return Promise.resolve();
  });
  const other = lock.run("j", () => {
    order.push("other");
    return Promise.resolve();
  });
  await other;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["other", "first", "second"]);
  await assert.rejects(lock.run("k", () => Promise.reject(new Error("x"))));
  assert.equal(await lock.run("k", () => Promise.resolve(1)), 1);
});
