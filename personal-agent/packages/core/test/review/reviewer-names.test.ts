// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a group request names (`github_review.py`'s `_reviewer_of`, `_member_named`): a mention is used as Teams gives it, its
 * Entra id from the group's member list when the worker has not seen it; a typed name is one member of the list, the closest
 * offered when none is; the list is read once in a while, and a list that cannot be read is said as such.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RosterMember, UserRef } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const member = (channelUserId: string, userId: string, name: string): RosterMember => ({
  channelUserId,
  userId,
  name,
  givenName: "",
  surname: "",
  email: "",
  userPrincipalName: "",
});

const ROSTER = [member("29:a", "aad-a", "Alice"), member("29:b", "aad-b", "Bob"), member("29:e", "aad-e", "Erin Chen")];

async function ask(world: ReviewWorld, text: string, people: readonly UserRef[] = [], id = "g1"): Promise<void> {
  const message = groupMessage(text, ALICE, people, id);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);

test("a typed name nobody in the group has is a question with the closest members", async () => {
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: ROSTER } });
  await ask(world, `请 Erin 帮我 review 合入 ${PR}`);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("我在这个群里没有找到「Erin」（相近的有：Erin Chen）"), groupText(world));
});

test("a mention the worker has not seen is found in the group's member list", async () => {
  const dave: UserRef = { id: "", channelUserId: "29:d", name: "Dave", email: "" };
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: [...ROSTER, member("29:d", "aad-d", "Dave")] } });
  world.identity.know("aad-d", "u-dave", "dave-gh", true);
  world.link("aad-d", "Dave", "ak-dave");
  world.bound.add("aad-d");
  await ask(world, `请 {Dave} 帮我 review 合入 ${PR}`, [dave]);
  assert.deepEqual(
    world.started.map((s) => s.turn.actingAs),
    ["u-dave"],
    groupText(world),
  );
});

test("a member list that cannot be read is said as such, and is read again later", async () => {
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: ROSTER } });
  const surface = world.surface;
  const members = surface.members.bind(surface);
  let reads = 0;
  let broken = true;
  surface.members = (conversation) => {
    reads += 1;
    return broken ? Promise.reject(new Error("Teams said 502")) : members(conversation);
  };
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("读不到这个群的成员名单"), groupText(world));
  broken = false;
  const before = reads;
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, [], "g2");
  assert.deepEqual(
    world.started.map((s) => s.turn.actingAs),
    ["u-bob"],
  );
  const afterRead = reads;
  assert.ok(afterRead > before);
  await ask(world, `请 Erin Chen 帮我 review 合入 ${PR}`, [], "g3"); // (read once in a while: not again at once)
  assert.equal(reads, afterRead);
});

test("a member the list names without an entra id is found by the id the worker has seen it write with", async () => {
  const world = reviewWorld(["AMD-AGI"], {
    rosters: { [CONV]: [member("29:b", "", "Bob"), member("29:a", "aad-a", "Alice")] },
  });
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`);
  assert.deepEqual(
    world.started.map((s) => s.turn.actingAs),
    ["u-bob"],
    groupText(world),
  );
});

test("a member nobody can tell who is, is a question", async () => {
  const world = reviewWorld(["AMD-AGI"], {
    rosters: { [CONV]: [member("29:z", "", "Zoe"), member("29:a", "aad-a", "Alice")] },
  });
  await ask(world, `请 Zoe 帮我 review 合入 ${PR}`);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("我认不出「Zoe」，请写出 TA 在群里的全名。"), groupText(world));
});
