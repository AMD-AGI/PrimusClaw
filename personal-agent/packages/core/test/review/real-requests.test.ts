// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Real ways people asked for a review (`test_github_review_intent`'s table, `test-support/review-requests.ts`): each does what it
 * asks when the model reads it well — the reviews it names start as the person it names, a chat stays a chat, and a question is
 * asked back — and nobody but the asker is ever @mentioned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader, UserRef } from "../../src/index.js";
import { pullsIn } from "../../src/review-text/pull-ref.js";
import { MEMBERS, MENTIONS, REQUESTS, type ReviewReading } from "../../../../test-support/review-requests.js";
import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

function setup(reading: ReviewReading): ReviewWorld {
  const intent: IntentReader = {
    read: () => Promise.resolve({ ...reading }),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: MEMBERS }, intent });
  world.store.members.rememberMember("29:w", "aad-w", "Lin, Mei");
  world.identity.know("aad-w", "u-lin", "lin-gh", true);
  world.link("aad-w", "Lin, Mei", "ak-lin");
  world.bound.add("aad-w");
  world.github.repos.set("amd-agi/primus", "AMD-AGI/Primus");
  return world;
}

/** The message as Teams gives it: `{Name}` an @mention; a quoted message as Teams carries a reply. */
function messageOf(text: string, quoted: string) {
  const people: UserRef[] = Object.keys(MENTIONS)
    .filter((name) => text.includes(`{${name}}`))
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ id: "", channelUserId: MENTIONS[name] ?? "", name, email: "" }));
  const message = groupMessage(text, ALICE, people);
  const quote = {
    messageId: "q1",
    author: "Dan",
    text: quoted,
    fromBot: false,
    sentAt: "",
    deleted: false,
    source: "entity" as const,
  };
  return quoted ? { ...message, quotes: [quote] } : message;
}

const key = (owner: string, repo: string, number: number) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}#${String(number)}`;

for (const c of REQUESTS.filter((r) => !r.html)) {
  test(`each real request does what it asks when the model reads it well (${c.id})`, async () => {
    const world = setup(c.reading);
    const message = messageOf(c.text, c.quoted);
    const handled = await world.service.request({
      message,
      text: message.text,
      sender: ALICE,
      conversation: world.surface.conversation(message.conversation),
      scope: CONV,
      lang: () => "zh",
    });
    const said = [saidIn(world.surface, CONV), ...world.started.map((s) => s.turn.lead)].join(" ");
    const [kind] = c.outcome;
    if (c.outcome[0] === "start") {
      const [, actor, prs, model] = c.outcome;
      assert.deepEqual(
        world.started.map((s) => key(s.turn.reviewTarget.owner, s.turn.reviewTarget.repo, s.turn.reviewTarget.number)),
        prs.flatMap((pr) => pullsIn(pr).map((p) => key(p.owner, p.repo, p.number))),
        said,
      );
      assert.deepEqual(new Set(world.started.map((s) => s.turn.actingAs)), new Set([actor]));
      assert.deepEqual(new Set(world.started.map((s) => s.turn.reviewModel)), new Set([model ?? ""]));
    } else if (kind === "chat") {
      assert.equal(handled, false, said);
      assert.equal(world.started.length, 0);
    } else {
      assert.equal(world.started.length, 0);
      assert.ok(said.includes(c.outcome[1]), said);
    }
    // Nobody but the asker is @mentioned by Clawy: a reviewer named in a reply is plain text.
    const mentioned = world.surface.of(CONV).flatMap((r) => ("message" in r ? (r.message.mentions ?? []) : []));
    assert.ok(mentioned.every((m) => m.channelUserId === "29:a"));
  });
}

test("the table has at least thirty real requests and the ten-line message as it was sent", () => {
  assert.ok(REQUESTS.length >= 30);
  assert.ok(REQUESTS.some((r) => r.text.includes("\r\n")));
});
