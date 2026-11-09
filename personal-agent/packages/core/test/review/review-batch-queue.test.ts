// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fifteen pull requests handed to a reviewer in one message (`test_review_batch_queue`): Claw takes the whole request, the first
 * ten start and the rest wait for a slot and start by themselves; the one answer says how many started and how many wait, by
 * name, and the asker hears when a waiting one has started.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutMessage } from "../../src/index.js";
import { VIEW_SETTLE_MS } from "../../src/review/service/follow.js";
import type { ReviewItemView } from "../../src/review/views.js";
import {
  ALICE_DM,
  handBack,
  handoffEvent,
  handoffWorld,
  type HandoffWorld,
} from "../../../../test-support/review-world.js";

const PRS = Array.from({ length: 15 }, (_, i) => `AMD-AGI/Hyperloom#${String(101 + i)}`);
const RUNNING = { status: "in_progress", prUrl: "" };
const QUEUED = { status: "queued", prUrl: "" };

function queuedWorld(count: number): HandoffWorld {
  const world = handoffWorld({ seqFrom: 1, queueAfter: 10, queueReason: "too_many_in_request" });
  // (each read of the views is past the settle time of the one before)
  (world.service as unknown as { follows: { viewMs: number } }).follows.viewMs = VIEW_SETTLE_MS;
  for (let n = 1; n <= count; n += 1) {
    const done = {
      status: "done",
      prUrl: `https://github.com/AMD-AGI/Hyperloom/pull/${String(100 + n)}`,
      verdict: "approve",
      merged: true,
    };
    world.claw.views.set(
      `item-${String(n)}`,
      n <= 10 ? [RUNNING, RUNNING, RUNNING, done] : [QUEUED, RUNNING, RUNNING, RUNNING, done],
    );
  }
  return world;
}

const textOf = (message: OutMessage) => (message.body.type === "text" ? message.body.text : "");

function texts(world: HandoffWorld, mine: boolean): string[] {
  return world.surface.outbox
    .filter((r) => (r.conversation === ALICE_DM) === mine)
    .flatMap((r) => (r.op === "send" ? [textOf(r.message)] : []));
}

test("fifteen handed over start ten queue five and the asker hears when they start", async () => {
  const world = queuedWorld(15);
  assert.deepEqual(await handBack(world, handoffEvent({ prs: PRS })), ["delivered"]);
  // One request with all fifteen: none refused.
  const requests = world.claw.calls.filter((c) => c[0] === "startReviews");
  assert.equal(requests.length, 1);
  const body = requests[0]?.[2] as { prs: { pull: { number: number } }[] };
  assert.deepEqual(
    body.prs.map((p) => p.pull.number),
    PRS.map((_, i) => 101 + i),
  );
  const text = texts(world, true).join(" ");
  assert.ok(!text.includes("一次最多") && !text.includes("分批"));
  assert.ok(text.includes("收到，以 Bob 的身份 review 合入这 15 个 PR"), text);
  const started = PRS.slice(0, 10).join("、");
  const queued = PRS.slice(10).join("、");
  assert.ok(
    text.includes(
      `已开始 10 个（${started}），排队 5 个（${queued}；同一次请求最多同时进行 10 个，前面的结束一个就按顺序开始下一个），` +
        "排队的会自动开始，不用再发。",
    ),
    text,
  );
  // Bob hears which of his started and which wait.
  const bob = texts(world, false).join(" ");
  assert.equal(bob.split("已作为你看板上的事项开始").length - 1, 10);
  assert.equal(bob.split("已作为你看板上的事项排队").length - 1, 5);
  // The asker hears when the waiting ones start, each by name, before their ends.
  const summaries = texts(world, true).filter((t) => t.includes("代审进度"));
  const notes = summaries.filter((s) => s.includes("排队结束，已开始 review"));
  assert.equal(notes.length, 1, summaries.join("\n---\n"));
  const [note = ""] = notes;
  for (const pr of PRS.slice(10)) assert.ok(note.includes(`- ${pr}：排队结束，已开始 review`), note);
  assert.ok(PRS.slice(0, 10).every((pr) => !note.includes(`- ${pr}：排队结束`)));
  assert.ok(summaries.indexOf(note) < summaries.length - 1); // (and the ends come after)
  assert.equal(
    summaries.reduce((n, s) => n + s.split("：结论：批准，已合入").length - 1, 0),
    15,
  );
});

function cardOps(world: HandoffWorld) {
  return world.surface.of(ALICE_DM).flatMap((r) => {
    if ((r.op !== "post" && r.op !== "update") || r.message.body.type !== "view") return [];
    const view = r.message.body.view;
    return [{ op: r.op, id: r.id, name: view.name, model: view.model }];
  });
}

test("a queued reviews card says it is queued until it starts", async () => {
  const world = queuedWorld(12);
  assert.deepEqual(await handBack(world, handoffEvent({ prs: PRS.slice(0, 12) })), ["delivered"]);
  const ops = cardOps(world);
  const posted = new Map(
    ops.flatMap((o) => (o.op === "post" && o.name === "reviewItem" ? [[(o.model as ReviewItemView).pull, o]] : [])),
  );
  for (const pr of PRS.slice(0, 10)) assert.equal((posted.get(pr)?.model as ReviewItemView).queued, false, pr);
  for (const pr of PRS.slice(10, 12)) assert.equal((posted.get(pr)?.model as ReviewItemView).queued, true, pr);
  // Once each starts, its card is edited (in place, its Stop kept) into the running one, once; then into its end.
  for (const pr of PRS.slice(0, 12)) {
    const id = posted.get(pr)?.id;
    const edits = ops.filter((o) => o.op === "update" && o.id === id).map((o) => [o.name, o.model] as const);
    const queuedOne = PRS.indexOf(pr) >= 10;
    assert.deepEqual(
      edits.map(([name, model]) =>
        name === "reviewItem" ? `running:${String((model as ReviewItemView).queued)}` : name,
      ),
      queuedOne ? ["running:false", "endedItem"] : ["endedItem"],
      pr,
    );
  }
});
