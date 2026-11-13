// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/github bind` reaches private and internal repositories and says what it is used for as Claw uses it; `/github status` says
 * what a binding can read and what the bot reads GitHub with; the confirmation setting chosen while binding goes with the binding
 * (`test_github_repo_scope`, `test_github_connect`'s bind and status tests, `test_github_review_mode`'s bind tests).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, GithubConnection, InboundAction } from "../../src/index.js";
import { ALICE, reviewWorld, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

function dm(world: ReviewWorld) {
  return world.surface.conversation({ id: DM, kind: "personal", tenantId: "t", wire: { conversation: { id: DM } } });
}

const texts = (world: ReviewWorld) =>
  world.surface.of(DM).flatMap((r) => ("message" in r && r.message.body.type === "text" ? [r.message.body.text] : []));
const said = (world: ReviewWorld) => texts(world).join(" ");
const last = (world: ReviewWorld) => texts(world).at(-1) ?? "";

async function command(world: ReviewWorld, args: string): Promise<void> {
  await world.service.account.command(ALICE, args, dm(world));
}

async function waitForBinding(world: ReviewWorld): Promise<void> {
  for (let i = 0; i < 20 && world.clock.pending > 0; i += 1) await world.clock.advance(10_000);
  await world.service.idle();
}

async function click(world: ReviewWorld, mode: string): Promise<void> {
  const route = {
    action: {
      type: "action",
      verb: "github_mode",
      data: { primusclaw: "github_mode", mode },
    } as unknown as InboundAction,
    sender: ALICE,
    conversation: dm(world),
    scope: "",
    lang: () => "en" as const,
    settle: () => Promise.resolve(true),
  } as unknown as ClickRoute;
  await world.service.routeHandlers().clicks[0]?.beforeCredential?.(route);
}

const binds = (world: ReviewWorld) => world.identity.requests.filter((r) => r.action === "bind");

test("bind asks github for repo", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice"); // (not connected)
  await command(world, "bind");
  assert.deepEqual(world.github.starts[0], { client_id: "cli-id", scope: "repo" });
  const consent = said(world);
  assert.ok(
    consent.includes("`repo`") && consent.includes("private and internal") && consent.includes("私有和内部仓库"),
  );
  assert.ok(consent.includes("waits for your approval each time") && consent.includes("每次都先问你"));
});

test("a person bound with public repo only is connected again", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", false, false, ["public_repo"]);
  await command(world, "bind");
  await waitForBinding(world);
  const text = said(world);
  assert.ok(
    !text.includes("already connected") && text.includes("用 `public_repo` 权限连接的") && text.includes("ABCD-1234"),
  );
  assert.equal(binds(world).length, 1); // (approved: the narrow binding is replaced by one with `repo`)
  assert.deepEqual(world.identity.users.get("aad-a")?.scopes, ["repo"]);
});

test("a person bound with repo is already connected", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", false, false, ["repo"]);
  await command(world, "bind");
  assert.ok(last(world).includes("already connected"), last(world));
  assert.deepEqual(world.github.starts, []);
});

test("status says what a public repo binding cannot read", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", false, false, ["public_repo"]);
  await command(world, "status");
  assert.ok(
    last(world).includes("Permission: public_repo (public repositories only: send `/github bind`"),
    last(world),
  );
  world.identity.know("aad-a", "u-alice", "alice-gh", false, false, ["repo"]);
  await command(world, "status");
  assert.ok(`${last(world)}\n`.includes("Permission: repo\n") && !last(world).includes("public repositories only"));
});

test("bind tells the wider use when claw reads with the binding and when it cannot say", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.claw.connection = {
    readsWith: "",
    login: "",
    missing: "none",
    bindingReads: true,
  } satisfies GithubConnection;
  await command(world, "bind");
  assert.ok(said(world).includes("Claw reads it as you"), said(world));
});

test("bind keeps the review only consent where claw does not read with it", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  world.claw.connection = null; // an older Claw
  await command(world, "bind");
  const consent = said(world);
  assert.ok(
    consent.includes("Only Claw's restricted GitHub review tools use it") && !consent.includes("Claw reads it as you"),
  );
});

test("github status shows the line", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  world.claw.connection = { readsWith: "binding", login: "alice-gh", missing: "", bindingReads: true };
  await command(world, "status");
  assert.ok(last(world).includes("我用这个令牌读你的 GitHub"), last(world));
});

for (const [name, connection, saysToken] of [
  ["gh-token", { readsWith: "env", login: "", missing: "", bindingReads: true }, true],
  ["nothing", { readsWith: "", login: "", missing: "none", bindingReads: true }, false],
  ["older-claw", null, false],
] as const) {
  test(`github status without a binding still says when the assistant reads with a gh token (${name})`, async () => {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice"); // (no binding)
    world.claw.connection = connection;
    await command(world, "status");
    const text = last(world);
    assert.ok(text.includes("not connected with `/github bind`"), text);
    assert.equal(text.includes("GH_TOKEN in your PrimusClaw settings"), saysToken, text);
  });
}

const CONFIRMATION = { fully_auto: "Fully automatic", high_risk_confirm: "A person confirms" } as const;

for (const [chosen, boundWith] of [
  [undefined, "high_risk_confirm"],
  ["high_risk_confirm", "high_risk_confirm"],
  ["fully_auto", "fully_auto"],
] as const) {
  test(`bind offers the two settings and the choice goes with the binding (${chosen ?? "none chosen"})`, async () => {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice");
    world.github.script = []; // Alice has not approved the code yet
    await command(world, "bind");
    const cards = world.surface
      .of(DM)
      .flatMap((r) =>
        "message" in r && r.message.body.type === "view" && r.message.body.view.name === "reviewMode"
          ? [r.message.body.view.model]
          : [],
      );
    assert.equal(cards.length, 1);
    // (nothing suggested: the card puts a person's confirmation first, the default)
    assert.ok(cards[0]?.suggested === "" || cards[0]?.suggested === "high_risk_confirm");
    if (chosen !== undefined) await click(world, chosen);
    world.github.script = ["ok"];
    await waitForBinding(world);
    assert.equal(binds(world).length, 1);
    assert.deepEqual(
      world.claw.calls.filter((c) => c[0] === "setReviewMode"),
      [["setReviewMode", "tok-aad-a", boundWith]],
    ); // once the binding is made, as Alice
    assert.ok(last(world).includes(`Confirmation: ${CONFIRMATION[boundWith]}`), last(world));
  });
}

for (const chosen of [undefined, "high_risk_confirm", "fully_auto"] as const) {
  test(`a choice claw does not take at bind is said and nothing is claimed about the setting (${chosen ?? "none chosen"})`, async () => {
    const world = reviewWorld();
    world.identity.know("aad-a", "u-alice");
    world.github.script = [];
    world.claw.modeError = 503;
    await command(world, "bind");
    if (chosen !== undefined) await click(world, chosen);
    world.github.script = ["ok"];
    await waitForBinding(world);
    const text = last(world);
    assert.ok(text.includes("could not save your choice") && text.includes("fully automatic included"), text);
    assert.ok(!text.includes("Confirmation: A person confirms") && !text.includes("Confirmation: Fully automatic"));
  });
}
