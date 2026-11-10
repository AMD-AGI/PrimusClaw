// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A work item stopped from its card: the review turn the router follows for it ends as stopped, not as a failure (the
// Python worker's Agent._item_stopped, which WorkClicks' Stop reaches; W5's
// test_a_stopped_item_ends_its_followed_turn_as_stopped_not_as_a_failure).
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function reviewFollowing(itemId: string) {
  const w = world();
  link(w, ALICE.id, "ak");
  const running = gate();
  w.turns.hold = running.promise;
  const chat = w.router.chat(ALICE, w.surface.conversation(message("x").conversation));
  await w.router.startTurn({
    chat,
    credential: "tok",
    text: "review",
    messageId: "r1",
    clientPlatform: "",
    review: {
      itemId,
      itemSessionId: "s-review",
      pull: "o/r#1",
      model: "",
      lang: "en",
      fields: {
        kind: "review",
        turn: {
          actingAs: "u-reviewer",
          reviewTarget: { owner: "o", repo: "r", number: 1 },
          modelKey: "ak",
          reviewModel: "",
          reviewOnly: false,
          attach: true,
          attachMessageId: "",
          lead: "",
          mention: undefined,
          shapeAnswer: (answer) => answer,
          onGithubResult: () => undefined,
        },
      },
      onSession: () => undefined,
      after: () => Promise.resolve(),
    },
  });
  return { w, release: running.open };
}

test("a stopped item ends the review turn the router follows for it as stopped, not as a failure", async () => {
  const { w, release } = await reviewFollowing("it-1");
  w.router.itemStopped("it-1");
  release();
  await w.router.settled();
  assert.ok(said(w).includes("Stopped."), said(w).join(" | "));
  assert.ok(!said(w).includes("ok"));
});

test("another item's stop leaves the turn running to its answer", async () => {
  const { w, release } = await reviewFollowing("it-1");
  w.router.itemStopped("it-2");
  w.router.itemStopped("");
  release();
  await w.router.settled();
  assert.ok(said(w).includes("ok"), said(w).join(" | "));
  assert.ok(!said(w).includes("Stopped."));
});
