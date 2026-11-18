// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What /whoami says of the person's GitHub binding (`GithubReview.connectionState`, the router's `GithubChat.connectionState`;
 * Python `Agent._github_connections` then `connections_text`): their binding as the identity service holds it, none when it has
 * none (invalid_grant), and "could not be read just now" when it cannot answer, never "not connected". The lines are the Python
 * worker's, word for word.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubConnection } from "../../src/index.js";
import { connectionsText } from "../../src/review/connect/connections.js";
import type { GithubChat } from "../../src/routing/features.js";
import { ALICE, reviewWorld, type ReviewWorld } from "../../../../test-support/review-world.js";

const CONNECTION: GithubConnection = { readsWith: "", login: "", missing: "none", bindingReads: true };

async function githubLine(world: ReviewWorld, zh: boolean): Promise<string> {
  const text = connectionsText({
    safe: { name: "A" },
    githubState: await world.service.connectionState(ALICE.id),
    connection: CONNECTION,
    connectionKnown: true,
    githubPart: true,
    memory: [true, true],
    memoryPage: "p",
    zh,
    extraLines: [],
  });
  return text.split("\n").find((l) => l.includes("GitHub")) ?? "";
}

for (const [name, setUp, en, zh] of [
  [
    "bound",
    (w: ReviewWorld) => {
      w.identity.know("aad-a", "u-alice", "alice-gh");
    },
    "- GitHub: connected `alice-gh`, but PrimusClaw cannot read GitHub with it just now",
    "- GitHub：已连接 `alice-gh`，但 PrimusClaw 暂时用不了它读 GitHub",
  ],
  [
    "expired",
    (w: ReviewWorld) => {
      w.identity.know("aad-a", "u-alice", "alice-gh", false, true);
    },
    "- GitHub: the authorization has expired; send `/github bind` to connect it again",
    "- GitHub：授权已过期，发 `/github bind` 重新连接",
  ],
  [
    "no binding at the identity service",
    (w: ReviewWorld) => {
      w.identity.users.delete("aad-a");
    },
    "- GitHub: not connected; send `/github bind` to connect it",
    "- GitHub：未连接，发 `/github bind` 连接",
  ],
  [
    "the identity service down",
    (w: ReviewWorld) => {
      w.identity.down = true;
    },
    "- GitHub: could not be read just now",
    "- GitHub：暂时读不到",
  ],
] as const) {
  test(`whoami says the github binding as python does: ${name}`, async () => {
    const world = reviewWorld();
    setUp(world);
    assert.equal(await githubLine(world, false), en);
    assert.equal(await githubLine(world, true), zh);
  });
}

test("a failure on the way to the identity service is not known, not not connected", async () => {
  const world = reviewWorld();
  (world.deps.credentials as { status: unknown }).status = () => Promise.reject(new TypeError("fetch failed"));
  assert.equal(await githubLine(world, false), "- GitHub: could not be read just now");
});

test("the review service is the router's github chat, connect card included", async () => {
  const world = reviewWorld();
  const chat: GithubChat = world.service;
  assert.equal(await chat.connectionState("aad-c"), null);
  const conversation = world.surface.conversation({
    id: "personal:aad-a",
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: "personal:aad-a" } },
  });
  world.identity.know("aad-a", "u-alice"); // (no GitHub yet)
  world.claw.connection = { readsWith: "", login: "", missing: "none", bindingReads: true };
  await chat.offerConnect({
    sender: ALICE,
    credential: "ak-alice-linked",
    text: "我开着几个 PR？",
    lang: "zh",
    conversation,
    again: () => Promise.resolve(),
  });
  // (the same card GithubConnect.offer sends: the router reaches it through the port)
  assert.equal(
    world.surface.of("personal:aad-a").filter((r) => r.op === "send" && r.message.body.type === "view").length,
    1,
  );
});
