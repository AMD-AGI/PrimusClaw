// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A question about one's own GitHub while Claw has no token of theirs (test_github_connect.py): the connect card goes first and
 * the question goes on at once; once the person connects, the question is asked again as a message of its own (an id of its
 * own), on the assistant path as on a session, with the credential it was asked with when none can be read then. The router
 * (W4) reads the message, W7's review service offers the card and runs the device flow.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "@primusclaw/personal-agent";

import type { GithubChat } from "../../packages/core/src/routing/features.js";
import { message } from "../routing/world.js";
import { ALICE_KEY, pressesWorld, type PressesWorld } from "./review-presses.js";

const QUESTION = "我开着几个 PR？";
const DM = "dm-aad-a";

/** Alice has no GitHub yet and Claw reads none of hers; the review service is the router's GitHub (Python `world`). */
function connectWorld(): PressesWorld {
  const w = pressesWorld();
  w.identity.know("aad-a", "u-alice"); // (no GitHub yet)
  w.claw.connection = { readsWith: "", login: "", missing: "none", bindingReads: true };
  w.github.script = ["ok"]; // (the device flow ends with GitHub connected)
  const github: GithubChat = {
    remember: (m) => {
      w.service.remember(m);
    },
    helpValues: (userId, lang) => w.service.helpValues(userId, lang),
    offerConnect: async (request) => {
      await w.service.connect.offer(request);
    },
    pendingConfirmations: (userId) => w.service.pendingConfirmations(userId),
    connectionState: () => Promise.resolve(undefined), // (what /whoami reads: not asked here)
  };
  (w.router.deps as { github: GithubChat | undefined }).github = github;
  return w;
}

async function settleFlow(w: PressesWorld): Promise<void> {
  for (let i = 0; i < 20 && w.clock.pending > 0; i += 1) await w.clock.advance(10_000);
  await w.service.idle();
  await w.router.router.settled();
}

/** The connect cards in Alice's chat (Python `connect_cards`). */
function connectCards(w: PressesWorld) {
  return w.surface
    .of(DM)
    .filter((r) => r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "githubConnect");
}

it("the question asked again is a message of its own on the assistant path", async () => {
  const w = connectWorld();
  const heard: [string, string, string][] = [];
  const deps = w.router.deps as unknown as {
    assistant: Record<string, unknown>;
    channelContext: (request: { channelMessageId: string }) => {
      context: JsonObject;
      actions: never[];
      people: never[];
    };
  };
  deps.channelContext = (request) => ({
    context: { channel_message_id: request.channelMessageId },
    actions: [],
    people: [],
  });
  deps.assistant = {
    ...deps.assistant,
    on: () => true,
    understands: () => true,
    reachable: () => false,
    understand: (request: { credential: string; prompt: string; context: JsonObject }) => {
      const id = request.context["channel_message_id"];
      heard.push([request.credential, request.prompt, typeof id === "string" ? id : ""]);
      return Promise.resolve(true);
    },
  };
  await w.router.router.handle(message(QUESTION, { id: "q1" }));
  await settleFlow(w);
  assert.equal(connectCards(w).length, 1);
  assert.deepEqual(heard, [
    [ALICE_KEY, QUESTION, "q1"],
    [ALICE_KEY, QUESTION, "q1-github"],
  ]);
});

it("the question asked again uses the credential it was asked with when none can be read then", async () => {
  const w = connectWorld();
  await w.router.router.handle(message(QUESTION, { id: "q1" }));
  await w.router.router.settled();
  w.store.links.unlink("aad-a"); // (from here on nothing can be read, e.g. the exchange is down)
  await settleFlow(w);
  const asked = w.router.turns.calls.filter((c) => c[0] === "create" || c[0] === "send");
  assert.deepEqual(
    asked.map((c) => c.at(-1)),
    [QUESTION, QUESTION],
  );
  assert.deepEqual(
    asked.map((c) => c[1]),
    [ALICE_KEY, ALICE_KEY],
  );
});
