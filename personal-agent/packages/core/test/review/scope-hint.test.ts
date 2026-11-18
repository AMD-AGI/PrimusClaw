// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A person bound with `public_repo` only whose question names a repository GitHub does not show publicly gets one line beside the
 * answer saying so and how to connect again (`test_github_repo_scope`): never where it would not help, never holding the question
 * up, and once in a while.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubConnection } from "../../src/index.js";
import { ALICE, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;
const PRIVATE_Q = "example-org/example-repo 的 PR #288 现在什么状态";
const BOUND: GithubConnection = { readsWith: "binding", login: "alice-gh", missing: "", bindingReads: true };

function world(scopes = ["public_repo"], connection: GithubConnection = BOUND): ReviewWorld {
  const w = reviewWorld();
  w.identity.know("aad-a", "u-alice", "alice-gh", false, false, scopes);
  w.claw.connection = { ...connection };
  return w;
}

async function ask(w: ReviewWorld, text: string): Promise<boolean> {
  const conversation = w.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: DM } },
  });
  return w.service.connect.offer({
    sender: ALICE,
    credential: "ak-alice-linked",
    text,
    lang: "zh",
    conversation,
    again: () => Promise.resolve(),
  });
}

const hintLines = (w: ReviewWorld) =>
  saidIn(w.surface, DM)
    .split("提示：")
    .slice(1)
    .filter((t) => t.includes("不是公开仓库"));

test("a question about a private repository gets the reconnect line", async () => {
  const w = world();
  assert.equal(await ask(w, PRIVATE_Q), false); // (the question goes on)
  await w.service.idle();
  const [line = "", ...more] = hintLines(w);
  assert.equal(more.length, 0);
  assert.ok(
    line.includes("example-org/example-repo 不是公开仓库") &&
      line.includes("`/github bind`") &&
      line.includes("`repo`"),
    line,
  );
  assert.ok(w.github.reads.includes("/repos/example-org/example-repo")); // (read with no credential)
  await ask(w, "example-org/example-repo 的 PR #289 呢");
  await w.service.idle();
  assert.equal(hintLines(w).length, 1); // once in six hours
});

for (const [name, scopes, connection, text] of [
  ["public repository", ["public_repo"], BOUND, "AMD-AGI/PrimusClaw 的 PR #317 现在什么状态"],
  ["wide binding", ["repo"], BOUND, PRIVATE_Q],
  [
    "claw reads a gh token",
    ["public_repo"],
    { readsWith: "env", login: "", missing: "", bindingReads: true },
    PRIVATE_Q,
  ],
  ["no repository named", ["public_repo"], BOUND, "CI/CD 流水线是什么"],
] as const) {
  test(`no reconnect line where it would not help (${name})`, async () => {
    const w = world([...scopes], connection);
    await ask(w, text);
    await w.service.idle();
    assert.deepEqual(hintLines(w), []);
  });
}

test("two messages in a row get the reconnect line once", async () => {
  const w = world();
  await ask(w, PRIVATE_Q);
  await ask(w, "example-org/example-repo 的 PR #289 呢");
  await w.service.idle();
  assert.equal(hintLines(w).length, 1);
});

test("the reconnect line never holds the question up", async () => {
  const w = world();
  const settings = w.deps.claw.settings as { githubConnection: (key: string) => Promise<GithubConnection | null> };
  const real = settings.githubConnection.bind(settings);
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let looking = false;
  settings.githubConnection = async (key) => {
    looking = true;
    await opened; // (a line looked up in the foreground would wait here for ever)
    return real(key);
  };
  assert.equal(await ask(w, PRIVATE_Q), false); // (the question goes on at once)
  assert.equal(looking, true, "the look is under way in the background");
  assert.deepEqual(hintLines(w), []);
  open();
  await w.service.idle();
  assert.equal(hintLines(w).length, 1); // (the line comes after, from the background)
});
