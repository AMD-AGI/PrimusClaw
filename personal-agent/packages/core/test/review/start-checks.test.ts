// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a request in a group is checked for before a review starts (`test_github_review`'s request tests): the named reviewer's
 * own GitHub account, never the asker's as a stand-in; who a mention or a typed name is; and the asker's own exchanged token,
 * never a linked key as the credential.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { err, type UserRef } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const DAVE: UserRef = { id: "", channelUserId: "29:d", name: "Dave", email: "" };

async function ask(
  world: ReviewWorld,
  text = `请 {Bob} 帮我 review 合入 ${PR}`,
  options: { id?: string; people?: readonly UserRef[]; mentionId?: string } = {},
): Promise<void> {
  const message = groupMessage(text, ALICE, options.people, options.id ?? "g1");
  const mentions =
    options.mentionId === undefined
      ? message.mentions
      : message.mentions.map((m) => ({ ...m, userId: options.mentionId ?? "" }));
  const shown = { ...message, mentions };
  await world.service.request({
    message: shown,
    text: shown.text,
    sender: ALICE,
    conversation: world.surface.conversation(shown.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
/** How many turns were started (read again each time: no narrowing from an earlier assertion). */
const started = (world: ReviewWorld): number => world.started.length;
const turnsFor = (world: ReviewWorld) => world.started.map((s) => s.turn.actingAs);

test("the requesters own account is never the stand in", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", null);
  await ask(world);
  assert.deepEqual(world.started, []);
  // (Alice's own account is not asked about, and is not used)
  assert.deepEqual(world.identity.askedAbout(), ["external:teams.microsoft.com|aad-b"]);
  assert.ok(groupText(world).includes("还没有绑定 GitHub"), groupText(world));
  world.identity.users.delete("aad-b"); // not even a Primus account any more
  await ask(world, undefined, { id: "g2" });
  assert.deepEqual(world.started, []);
});

test("the steps go to the reviewer alone", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", null);
  await ask(world);
  assert.deepEqual(world.surface.of("personal:aad-a"), []);
  for (const r of world.surface.of(CONV)) {
    const text = "message" in r && r.message.body.type === "text" ? r.message.body.text : "";
    assert.ok(!text.includes("bind") || text.includes("我已私信"), text);
  }
  assert.notDeepEqual(world.surface.of("personal:aad-b"), []);
});

test("a reviewer the identity service does not know gets the connect card in their chat", async () => {
  const world = reviewWorld();
  world.identity.users.delete("aad-b");
  await ask(world);
  assert.deepEqual(
    world.said.connect.map((c) => c.split(":")[0]),
    ["aad-b"],
  );
  assert.deepEqual(world.started, []);
});

test("a mention of someone the worker has never seen asks them to bind first", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Dave} 帮我 review 合入 ${PR}`, { people: [DAVE] });
  assert.ok(groupText(world).includes("/github bind") && groupText(world).includes("Dave"), groupText(world));
  assert.deepEqual(world.identity.requests, []);
  assert.deepEqual(world.started, []);
});

test("a mention that carries the entra id is used as it is", async () => {
  const world = reviewWorld();
  world.identity.know("aad-d", "u-dave", "dave-gh", true);
  world.link("aad-d", "Dave", "ak-dave"); // (a review asked of Dave runs on his own key and token)
  world.bound.add("aad-d");
  await ask(world, `请 {Dave} 帮我 review 合入 ${PR}`, { people: [DAVE], mentionId: "aad-d" });
  assert.deepEqual(turnsFor(world), ["u-dave"], groupText(world));
});

const MEMBERS = [
  {
    channelUserId: "29:b",
    userId: "aad-b",
    name: "Bob",
    givenName: "Bob",
    surname: "",
    email: "",
    userPrincipalName: "",
  },
  {
    channelUserId: "29:a",
    userId: "aad-a",
    name: "Alice",
    givenName: "Alice",
    surname: "",
    email: "",
    userPrincipalName: "",
  },
  {
    channelUserId: "29:c",
    userId: "aad-c",
    name: "Bob (SaFE)",
    givenName: "Bob",
    surname: "",
    email: "",
    userPrincipalName: "",
  },
];

test("a typed name needs exactly one member with it", async () => {
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: MEMBERS } });
  world.identity.know("aad-a", "u-alice", "alice-gh");
  world.github.authors.set(PR.toLowerCase(), "carol-gh"); // (a pull request Alice did not write)
  await ask(world, `请 Alice 帮我 review 合入 ${PR}`, { people: [] }); // exactly one Alice
  assert.deepEqual(turnsFor(world), ["u-alice"], groupText(world));
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, { people: [], id: "g2" }); // "Bob" and "Bob (SaFE)" are two people
  assert.equal(world.started.length, 1);
  assert.ok(groupText(world).includes("不止一位"), groupText(world));
  await ask(world, `请 Zed 帮我 review 合入 ${PR}`, { people: [], id: "g3" });
  assert.ok(groupText(world).includes("没有找到"), groupText(world));
  assert.equal(started(world), 1);
  assert.ok(!world.identity.askedAbout().includes("external:teams.microsoft.com|aad-c")); // nobody was guessed
});

test("a typed name cannot be read without the member list", async () => {
  const world = reviewWorld();
  await ask(world, `请 Alice 帮我 review 合入 ${PR}`, { people: [] });
  assert.ok(groupText(world).includes("@"), groupText(world));
  assert.deepEqual(world.started, []);
  assert.deepEqual(world.identity.requests, []);
});

test("an asker with only a linked key starts nothing and the key is never sent", async () => {
  const world = reviewWorld();
  world.bound.delete("aad-a"); // no binding: the exchange says not bound, but the linked key is still there
  await ask(world);
  assert.equal(world.started.length, 0);
  assert.deepEqual(world.identity.requests, []); // nobody's GitHub account was even asked about
  const said = groupText(world);
  assert.ok(said.includes("身份服务") && said.includes("API key"), said);
  assert.ok(!JSON.stringify(world.surface.outbox).includes("ak-alice-linked"));
  world.bound.add("aad-a"); // connected through the identity service: the same request now goes through, as a token
  await ask(world, undefined, { id: "g2" });
  assert.deepEqual(
    world.started.map((s) => s.token),
    ["tok-aad-a"],
  );
});

test("when the askers token cannot be exchanged nothing is started and the group is told", async () => {
  const world = reviewWorld();
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  exchange.tokenFor = () => Promise.resolve(err({ kind: "exchange_failed" as const, reason: "identity service down" }));
  await ask(world);
  assert.deepEqual(world.started, []);
  const said = groupText(world);
  assert.ok(said.includes("Primus 平台") && said.includes("没有开始 review"), said);
  assert.deepEqual(world.identity.requests, []);
  assert.ok(!JSON.stringify(world.surface.outbox).includes("ak-alice-linked"));
});
