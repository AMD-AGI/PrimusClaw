// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/github` when things do not go the usual way (`github_review.py`'s `_bind`, `_wait_and_bind`, `_status`, `_auto_merge`): a code
 * GitHub would not give, one that was denied or never answered, a binding the identity service refused for a reason it named,
 * a second bind while one waits, auto-merge asked about or set before GitHub is connected, and a status Claw cannot complete.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { err } from "../../src/index.js";
import { ALICE, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

async function command(world: ReviewWorld, args: string): Promise<void> {
  const conversation = world.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: DM } },
  });
  await world.service.account.command(ALICE, args, conversation);
}

async function waitForBinding(world: ReviewWorld): Promise<void> {
  for (let i = 0; i < 30 && world.clock.pending > 0; i += 1) await world.clock.advance(10_000);
  await world.service.idle();
}

const said = (world: ReviewWorld) => saidIn(world.surface, DM);
const binds = (world: ReviewWorld) => world.identity.requests.filter((r) => r.action === "bind");

test("github would not give a code: nothing is started", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.github.startStatus = 503;
  await command(world, "bind");
  assert.ok(
    said(world).includes("GitHub did not give me a code just now. Please try `/github bind` again in a minute."),
  );
  assert.equal(world.clock.pending, 0);
});

for (const [step, expected] of [
  ["access_denied", "GitHub says the request was denied, so nothing was connected."],
  [
    "incorrect_device_code",
    "GitHub did not answer while I waited for your approval. Send `/github bind` to try again.",
  ],
] as const) {
  test(`a code that was not approved says why and stores nothing (${step})`, async () => {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice");
    world.github.script = [step];
    await command(world, "bind");
    await waitForBinding(world);
    assert.ok(said(world).includes(expected), said(world));
    assert.deepEqual(binds(world), []);
  });
}

test("a second bind while a code waits says so and starts no second flow", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.github.script = []; // (Alice has not approved the code yet)
  await command(world, "bind");
  await command(world, "bind");
  assert.ok(said(world).includes("I am already waiting for you to approve a code."), said(world));
  assert.equal(world.github.starts.length, 1);
  await command(world, "unbind"); // (and unbind ends the wait)
  await waitForBinding(world);
  assert.deepEqual(binds(world), []);
});

for (const [error, expected] of [
  ["invalid_scope", "GitHub gave a token with more permissions than the one I asked for, so I did not keep it."],
  [
    "provider_unavailable",
    "The identity service could not check the token with GitHub just now, so nothing was stored.",
  ],
  ["something_new", "The identity service did not accept the connection. Send `/github bind` to try again."],
] as const) {
  test(`a binding the identity service refuses says what it named (${error})`, async () => {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice");
    world.identity.bindError = [400, error];
    await command(world, "bind");
    await waitForBinding(world);
    assert.ok(said(world).includes(expected), said(world));
  });
}

test("auto-merge asked about says how it is, and set before github is connected says to connect first", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  await command(world, "auto-merge");
  assert.ok(said(world).includes("Auto-merge is on. Send `/github auto-merge on` or `off` to change it."), said(world));
  world.identity.know("aad-a", "u-alice", null);
  await command(world, "auto-merge on");
  assert.ok(said(world).includes("Connect GitHub first: send `/github bind`."), said(world));
});

test("a status whose confirmation setting claw cannot read says it is not known", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  world.claw.modeError = 503;
  await command(world, "status");
  assert.ok(
    said(world).includes(
      "Confirmation (for every review and merge with your account): not known just now (PrimusClaw did not answer)",
    ),
    said(world),
  );
});

test("unbind with nothing connected says so", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", null);
  await command(world, "unbind");
  assert.ok(said(world).includes("No GitHub account was connected."), said(world));
});

test("a status read while the identity service cannot exchange a token says what could not be asked", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  exchange.tokenFor = () => Promise.resolve(err({ kind: "exchange_failed" as const, reason: "down" }));
  await command(world, "status");
  const text = said(world);
  assert.ok(text.includes("not known just now (PrimusClaw did not answer)"), text);
  assert.ok(text.includes("Whether I read your GitHub with it: PrimusClaw could not be asked just now"), text);
});

test("a choice that cannot be written for want of a token is said as not saved", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.github.script = [];
  await command(world, "bind");
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  exchange.tokenFor = () => Promise.resolve(err({ kind: "exchange_unavailable" as const }));
  world.github.script = ["ok"];
  await waitForBinding(world);
  assert.ok(said(world).includes("could not save your choice"), said(world));
});

test("a bind whose end cannot be said either stores nothing and leaves nothing waiting", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.github.script = ["access_denied"];
  const surface = world.surface;
  const open = surface.conversation.bind(surface);
  surface.conversation = (ref) => {
    const conversation = open(ref);
    const send = conversation.send.bind(conversation);
    conversation.send = (message) =>
      message.body.type === "text" && message.body.text.includes("denied")
        ? Promise.reject(new Error("Teams refused it"))
        : send(message);
    return conversation;
  };
  await command(world, "bind");
  await waitForBinding(world);
  assert.deepEqual(binds(world), []);
  assert.ok(!said(world).includes("denied")); // (it could not be said)
  world.github.script = ["authorization_pending"];
  const starts = world.github.starts.length;
  await command(world, "bind"); // (nothing waits any more: a new code is given)
  assert.equal(world.github.starts.length, starts + 1);
});
