// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The committer is not the author (`test_github_review`'s author tests): a request of someone for a pull request they wrote starts
 * nothing and messages nobody; the author is read, with no credential, from the pull request asked about; an author that cannot be
 * read does not stop the request (Claw still refuses an approval by its author).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  BOB,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import type { UserRef } from "../../src/index.js";

async function ask(
  world: ReviewWorld,
  text = `请 {Bob} 帮我 review 合入 ${PR}`,
  id = "g1",
  people: readonly UserRef[] = [BOB],
) {
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
const pullReads = (world: ReviewWorld) => world.github.reads.filter((p) => p.includes("/pulls/"));

test("nobody is messaged when the reviewer is the asker", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.github.defaultAuthor = "carol-gh";
  await ask(world, `请 {Alice} 帮我 review 合入 ${PR}`, "g1", [ALICE]);
  assert.equal(world.started.length, 1);
  assert.deepEqual(world.surface.of("personal:aad-a"), []);
});

test("a committer cannot review and merge their own pull request and nothing is started", async () => {
  const world = reviewWorld();
  world.github.authors.set(PR.toLowerCase(), "Bob-GH"); // (GitHub logins compare without case)
  await ask(world);
  assert.equal(world.started.length, 0);
  const text = groupText(world);
  assert.ok(
    text.includes("Bob 自己提交的") && text.includes("另外指定一位 committer") && !text.includes("已私信"),
    text,
  );
  assert.deepEqual(world.surface.of("personal:aad-b"), []); // nobody is messaged about it
  assert.deepEqual(world.surface.of("personal:aad-a"), []);
  world.github.authors.set(PR.toLowerCase(), "alice-gh"); // the same request about a pull request somebody else wrote goes through
  await ask(world, undefined, "g2");
  assert.equal(world.started.length, 1);
});

test("naming oneself for a pull request one wrote is refused too", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.github.authors.set(PR.toLowerCase(), "alice-gh");
  await ask(world, `请 {Alice} 帮我 review 合入 ${PR}`, "g1", [ALICE]);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("Alice 自己提交的"), groupText(world));
});

test("the author is read from the pull request asked about without any credential", async () => {
  const world = reviewWorld();
  world.github.authors.set("amd-agi/hyperloom#12", "alice-gh");
  world.github.authors.set("amd-agi/hyperloom#13", "bob-gh");
  await ask(world, "请 {Bob} 帮我 review 合入 AMD-AGI/Hyperloom#13");
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("Bob 自己提交的"), groupText(world)); // (not the author of #12)
  assert.deepEqual(pullReads(world), ["/repos/AMD-AGI/Hyperloom/pulls/13"]);
});

for (const [name, reply] of [
  ["rate limit", { status: 403, body: { message: "API rate limit exceeded" } }],
  ["not found", { status: 404, body: { message: "Not Found" } }],
  ["bad gateway", { status: 502, body: "bad gateway" }],
  ["not an object", { status: 200, body: [] }],
  ["no user", { status: 200, body: { user: null } }],
  ["empty login", { status: 200, body: { user: { login: "" } } }],
  ["login not text", { status: 200, body: { user: { login: 7 } } }],
  ["refusal that names a user", { status: 403, body: { user: { login: "bob-gh" } } }],
] as const) {
  test(`an author that could not be read does not stop the request (${name})`, async () => {
    const world = reviewWorld();
    world.github.reply = reply;
    await ask(world);
    assert.equal(world.started.length, 1, groupText(world));
    assert.ok(!groupText(world).includes("自己提交的"));
    assert.equal(pullReads(world).length, 1);
  });
}
