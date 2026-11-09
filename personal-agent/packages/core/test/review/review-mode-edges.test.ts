// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The confirmation setting when things are not as usual (`github_review.py`'s `_choose_mode`, `_mode_click`, `_mode`): a card
 * whose choice is no longer one, a choice by someone not connected to Primus or to GitHub, a Claw that cannot save it or does not
 * have it yet, and `/github mode` before GitHub is connected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, InboundAction } from "../../src/index.js";
import { ALICE, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

function dm(world: ReviewWorld) {
  return world.surface.conversation({ id: DM, kind: "personal", tenantId: "t", wire: { conversation: { id: DM } } });
}

async function click(world: ReviewWorld, mode: unknown): Promise<string> {
  const settled: string[] = [];
  const route = {
    action: {
      type: "action",
      verb: "primusclaw.github_mode",
      data: { primusclaw: "github_mode", mode },
    } as unknown as InboundAction,
    sender: ALICE,
    conversation: dm(world),
    scope: "",
    lang: () => "en" as const,
    settle: (card: unknown) =>
      Promise.resolve(settled.push(typeof card === "string" ? card : JSON.stringify(card)) > 0),
  } as unknown as ClickRoute;
  await world.service.routeHandlers().clicks[0]?.beforeCredential?.(route);
  return settled.join(" ");
}

const writes = (world: ReviewWorld) => world.claw.calls.filter((c) => c[0] === "setReviewMode");

test("a choice that is no longer one is said so and nothing is written", async () => {
  const world = reviewWorld();
  assert.equal(await click(world, "something_else"), "That choice is no longer active.");
  assert.deepEqual(writes(world), []);
});

test("a choice by someone the identity service does not know asks to connect first", async () => {
  const world = reviewWorld();
  world.identity.users.delete("aad-a");
  const said = await click(world, "fully_auto");
  assert.ok(said.includes("Connect your Primus account first, then choose again."), said);
  assert.deepEqual(writes(world), []);
  assert.ok(world.said.connect.some((c) => c.startsWith("aad-a:")));
});

test("a choice before github is connected says to connect it first", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", null);
  const said = await click(world, "fully_auto");
  assert.ok(said.includes("Connect GitHub first: send `/github bind`."), said);
  assert.deepEqual(writes(world), []);
});

test("a choice the identity service cannot be asked about is not saved", async () => {
  const world = reviewWorld();
  world.identity.down = true;
  const said = await click(world, "fully_auto");
  assert.ok(said.includes("I could not save it just now; nothing changed."), said);
});

test("a choice on a claw without the setting changes nothing and says so", async () => {
  const world = reviewWorld();
  world.claw.modeError = 404;
  const said = await click(world, "fully_auto");
  assert.ok(
    said.startsWith("Nothing changed: this setting is not available yet (PrimusClaw does not have it yet)"),
    said,
  );
});

test("a choice made while github is being connected goes with the binding", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.github.script = [];
  await world.service.account.command(ALICE, "bind", dm(world));
  const said = await click(world, "fully_auto");
  assert.ok(said.includes("It applies as soon as GitHub is connected."), said);
  assert.deepEqual(writes(world), []);
});

test("/github mode before github is connected says how to connect it", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", null);
  await world.service.account.command(ALICE, "mode", dm(world));
  assert.ok(
    saidIn(world.surface, DM).includes(
      "GitHub is not connected. Send `/github bind` to connect it; you choose this there.",
    ),
  );
});

test("/github mode on a claw without the setting says the default applies", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  world.claw.modeError = 404;
  await world.service.account.command(ALICE, "mode", dm(world));
  assert.ok(
    saidIn(world.surface, DM).includes("This setting is not available yet (PrimusClaw does not have it yet)"),
    saidIn(world.surface, DM),
  );
});
