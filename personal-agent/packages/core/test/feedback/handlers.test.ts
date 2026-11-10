// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { DailyBrief, Observer, w8RouteHandlers } from "@primusclaw/personal-agent";

import { inboundVote } from "../../../../test-support/inbound.js";
import { world as routingWorld } from "../../../../test-support/routing/world.js";

import { observeWorld } from "../observe/world.js";
import { linkedWorld, USER_A } from "./world.js";

function briefOf(world: ReturnType<typeof linkedWorld>): DailyBrief {
  return new DailyBrief({
    enabled: false,
    links: world.store.links,
    prefs: world.store.prefs,
    triggers: {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      delete: () => Promise.resolve(),
    },
    assistant: { brief: () => Promise.resolve({}) },
    assistantOn: () => false,
    briefMarkdown: () => "",
    log: world.log,
  });
}

test("the router gets feedback first in a 1:1 chat and observe before feedback in a group", () => {
  const world = linkedWorld();
  const observer: Observer = observeWorld().observer;
  const brief = new DailyBrief({
    enabled: false,
    links: world.store.links,
    prefs: world.store.prefs,
    triggers: {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      delete: () => Promise.resolve(),
    },
    assistant: { brief: () => Promise.resolve({}) },
    assistantOn: () => false,
    briefMarkdown: () => "",
    log: world.log,
  });
  const handlers = w8RouteHandlers({ flow: world.flow, thumbs: world.thumbs, observer, brief });
  assert.deepEqual(
    handlers.personalInterceptors.map((i) => i.name),
    ["feedback"],
  );
  assert.deepEqual(
    handlers.groupInterceptors.map((i) => i.name),
    ["observe", "feedback"],
  );
  assert.deepEqual(
    handlers.commands.map((c) => c.name),
    ["brief"],
  );
  assert.deepEqual(
    handlers.clicks.map((c) => c.verbs),
    [["report", "feedback"], ["thumb", "thumb_note"], ["observe"]],
  );
});

test("the channel's own thumbs reach the thumbs through the real router: a vote in Claw, a thumbs-down also filed", async () => {
  // Python agent.py: an invoke thumb_of reads is counted, voted on in Claw and, when down, filed like /feedback
  for (const [reaction, way, filed] of [
    ["like", "up", 0],
    ["dislike", "down", 1],
  ] as const) {
    const world = linkedWorld();
    const handlers = w8RouteHandlers({
      flow: world.flow,
      thumbs: world.thumbs,
      observer: observeWorld().observer,
      brief: briefOf(world),
    });
    const router = routingWorld({ handlers }).router;
    await router.handle(
      inboundVote({
        id: "v1",
        sender: USER_A,
        conversation: { id: "dm-aad-a", kind: "personal", tenantId: "t1", wire: {} },
        messageId: "1730880000123",
        reaction,
        comment: "it ignored my question",
      }),
    );
    await world.thumbs.settled();
    assert.deepEqual(world.claw.votes, [["ak-alice", "sess-1", "teams:1730880000123", way, "it ignored my question"]]);
    assert.equal(world.issues.issues.length, filed, reaction);
  }
});
