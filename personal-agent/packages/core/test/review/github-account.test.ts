// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, TOKEN, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

async function command(world: ReviewWorld, args: string): Promise<void> {
  const conversation = world.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "tenant-1",
    wire: { conversation: { id: DM } },
  });
  await world.service.account.command(ALICE, args, conversation);
}

/** Lets the device flow's sleeps pass, as GitHub's interval asks. */
async function waitForBinding(world: ReviewWorld): Promise<void> {
  for (let i = 0; i < 20 && world.clock.pending > 0; i += 1) await world.clock.advance(10_000);
  await world.service.idle();
}

test("bind runs the device flow and gives the token only to the identity service", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice"); // Alice has not connected GitHub yet
  world.github.script = ["authorization_pending", "slow_down", "authorization_pending", "ok"];
  await command(world, "bind");
  const consent = saidIn(world.surface, DM);
  for (const expected of [
    "GitHub CLI",
    "`repo`",
    "ABCD-1234",
    "https://github.com/login/device",
    "Revoke",
    "gh",
    "加密",
    "encrypted",
    "auto-merge",
  ]) {
    assert.ok(consent.includes(expected), expected);
  }
  await waitForBinding(world);
  const binds = world.identity.requests.filter((r) => r.action === "bind");
  assert.deepEqual(
    binds.map((b) => b.body),
    [{ user: "external:teams.microsoft.com|aad-a", provider: "github", token: TOKEN }],
  );
  assert.equal(world.github.polls.length, 4);
  const said = saidIn(world.surface, DM);
  assert.ok(said.includes("connected as `octo-u-alice`") && said.includes("Auto-merge is off"), said);
  assert.ok(!JSON.stringify(world.surface.outbox).includes(TOKEN));
});

test("bind that ends without a token says why and stores nothing", async () => {
  for (const [step, expected] of [
    ["expired_token", "ran out"],
    ["access_denied", "denied"],
  ] as const) {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice");
    world.github.script = [step];
    await command(world, "bind");
    await waitForBinding(world);
    assert.ok(saidIn(world.surface, DM).includes(expected), step);
    assert.equal(world.identity.requests.filter((r) => r.action === "bind").length, 0);
  }
});

test("bind for someone the identity service does not know asks to connect first", async () => {
  const world = reviewWorld();
  world.identity.users.delete("aad-a");
  await command(world, "bind");
  assert.deepEqual(world.github.polls, []);
  assert.equal(world.said.connect.length, 1);
});

test("bind when already connected does not start again and an expired one does", async () => {
  const world = reviewWorld();
  await command(world, "bind");
  assert.ok(saidIn(world.surface, DM).includes("already connected"));
  world.identity.know("aad-a", "u-alice", "alice-gh", false, true);
  await command(world, "bind");
  assert.ok(saidIn(world.surface, DM).includes("ABCD-1234"));
});

test("bind refused by the identity service says what to do and never echoes the token", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.identity.bindError = [400, "invalid_scope"];
  await command(world, "bind");
  await waitForBinding(world);
  const said = saidIn(world.surface, DM);
  assert.ok(said.includes("more permissions than the one I asked for"), said);
  assert.ok(!said.includes(TOKEN));
});

test("status unbind and auto merge talk to the identity service for the sender only", async () => {
  const world = reviewWorld();
  await command(world, "status");
  await command(world, "auto-merge on");
  await command(world, "auto-merge");
  await command(world, "unbind");
  assert.ok(world.identity.askedAbout().every((u) => u === "external:teams.microsoft.com|aad-a"));
  const said = saidIn(world.surface, DM);
  assert.ok(said.includes("GitHub: `alice-gh`") && said.includes("Auto-merge is on") && said.includes("deleted"), said);
});

test("the identity service being down is said not swallowed", async () => {
  const world = reviewWorld();
  world.identity.down = true;
  await command(world, "status");
  assert.ok(saidIn(world.surface, DM).includes("could not reach the Primus identity service"));
});

test("an unknown subcommand is answered with the usage", async () => {
  const world = reviewWorld();
  await command(world, "frobnicate now");
  assert.ok(saidIn(world.surface, DM).includes("`/github bind` connects your GitHub account"));
});
