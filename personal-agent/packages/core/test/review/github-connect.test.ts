// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { connectionsText } from "../../src/review/connect/connections.js";
import { asksAboutOwnGithub, repositoriesNamed } from "../../src/review/connect/questions.js";
import { consentText, readsLine } from "../../src/review/consent.js";
import { ALICE, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const QUESTION = "我开着几个 PR？";
const DM = `personal:${ALICE.id}`;

test("a question about ones own github is recognised", () => {
  for (const text of [
    QUESTION,
    "我开着的 PR 有几个？",
    "最近一次 CI 为什么挂了",
    "帮我看看我的 issue 有哪些",
    "Which PRs are waiting on my review?",
    "how many pull requests do I have open",
    "my latest CI run failed, why?",
    "我们仓库最近合入了什么",
    "我上周的 PR 合了没有",
    "Which of my PRs are open, and what is each one waiting on: review, CI or me?",
    "Why did my last CI run fail?",
  ]) {
    assert.ok(asksAboutOwnGithub(text), text);
  }
});

test("anything else is not", () => {
  for (const text of [
    "CI 是什么意思",
    "what is a pull request?",
    "帮我写个周报",
    "今天天气怎么样",
    "",
    "PRESS release",
    `我的 ${"x".repeat(3000)} PR`,
    "Can I use GitHub Actions to deploy a static site?",
    "Can you tell me which GitHub Actions I should use?",
    "Which CI tools are best?",
    "我想了解 GitHub 怎么用",
    "请 Bob 帮我 review 合入 AMD-AGI/Hyperloom#12",
    "帮我 review 一下 AMD-AGI/Hyperloom#12 现在的状态",
    "请 @Lin Mei 帮我 review 合入 AMD-AGI/Primus#12",
    "Is CI failing in https://github.com/AMD-AGI/PrimusClaw?",
    "https://github.com/AMD-AGI/PrimusClaw/pull/317 改了什么",
  ]) {
    assert.ok(!asksAboutOwnGithub(text), text);
  }
});

test("the repositories a question names, each once", () => {
  assert.deepEqual(repositoriesNamed("my PRs in AMD-AGI/secret and https://github.com/amd-agi/SECRET.git and CI/CD"), [
    ["AMD-AGI", "secret"],
  ]);
  assert.deepEqual(repositoriesNamed("and/or"), []);
});

function connectWorld(): ReviewWorld {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice"); // (no GitHub yet)
  world.claw.connection = { readsWith: "", login: "", missing: "none", bindingReads: true };
  return world;
}

async function offer(world: ReviewWorld, again: () => Promise<void>, text = QUESTION): Promise<boolean> {
  const conversation = world.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: DM } },
  });
  return world.service.connect.offer({
    sender: ALICE,
    credential: "ak-alice-linked",
    text,
    lang: "zh",
    conversation,
    again,
  });
}

async function settleFlow(world: ReviewWorld): Promise<void> {
  for (let i = 0; i < 20 && world.clock.pending > 0; i += 1) await world.clock.advance(10_000);
  await world.service.idle();
}

test("the card comes before the question goes on and the question is asked again once github is connected", async () => {
  const world = connectWorld();
  let asked = 0;
  assert.equal(
    await offer(world, () => {
      asked += 1;
      return Promise.resolve();
    }),
    true,
  );
  assert.ok(world.surface.of(DM).some((r) => r.op === "send" && r.message.body.type === "view"));
  await settleFlow(world);
  assert.equal(asked, 1);
  assert.ok(saidIn(world.surface, DM).includes("现在用你的 GitHub 再回答一次你刚才的问题。"));
});

test("a flow that ends without github asks nothing again", async () => {
  for (const step of ["expired_token", "access_denied"]) {
    const world = connectWorld();
    world.github.script = [step];
    let asked = 0;
    await offer(world, () => {
      asked += 1;
      return Promise.resolve();
    });
    await settleFlow(world);
    assert.equal(asked, 0, step);
  }
});

test("one card at most in a while whatever became of it", async () => {
  const world = connectWorld();
  world.github.script = ["authorization_pending"];
  assert.equal(await offer(world, () => Promise.resolve()), true);
  assert.equal(await offer(world, () => Promise.resolve()), false);
});

test("no card while claw cannot use a binding or already reads github", async () => {
  for (const connection of [
    null,
    { readsWith: "", login: "", missing: "none", bindingReads: false },
    { readsWith: "binding", login: "alice-gh", missing: "", bindingReads: true },
    { readsWith: "env", login: "", missing: "", bindingReads: true },
  ]) {
    const world = connectWorld();
    world.claw.connection = connection;
    assert.equal(await offer(world, () => Promise.resolve()), false);
  }
});

test("a flow that cannot start offers no card and the question goes on", async () => {
  const down = connectWorld();
  down.identity.down = true;
  assert.equal(await offer(down, () => Promise.resolve()), false);
  const unknown = connectWorld();
  unknown.identity.users.delete("aad-a");
  assert.equal(await offer(unknown, () => Promise.resolve()), false);
  const noCode = connectWorld();
  noCode.github.startStatus = 500;
  assert.equal(await offer(noCode, () => Promise.resolve()), false);
});

test("a question not about ones own github is not even checked", async () => {
  const world = connectWorld();
  assert.equal(await offer(world, () => Promise.resolve(), "今天天气怎么样"), false);
  assert.deepEqual(world.identity.requests, []);
});

test("not now closes the card asks nothing again and offers none that day", async () => {
  const world = connectWorld();
  world.github.script = ["authorization_pending"];
  let asked = 0;
  await offer(world, () => {
    asked += 1;
    return Promise.resolve();
  });
  const card = world.surface.of(DM).find((r) => r.op === "send" && r.message.body.type === "view");
  const cardId =
    card && "message" in card && card.message.body.type === "view"
      ? (card.message.body.view.model as { cardId: string }).cardId
      : "";
  const settled: string[] = [];
  await world.service.connect.dismiss(ALICE, { card: cardId }, "zh", (t) => Promise.resolve(settled.push(t)));
  assert.ok(settled[0]?.includes("先不连 GitHub"));
  await world.service.connect.dismiss(ALICE, { card: cardId }, "en", (t) => Promise.resolve(settled.push(t)));
  assert.ok(settled[1]?.includes("already been dealt with"));
  world.github.script = ["ok"];
  await settleFlow(world);
  assert.equal(asked, 0);
});

test("the consent says clawy reads github with it only where claw does", () => {
  const code = {
    deviceCode: "d",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  };
  assert.ok(consentText(code, true).includes("To let me read your GitHub for you"));
  assert.ok(!consentText(code, false).includes("To let me read your GitHub for you"));
  assert.ok(consentText(code, false).includes("（15 分钟内有效）"));
});

test("github status says whether clawy reads github with the binding", () => {
  assert.ok(
    readsLine({ readsWith: "binding", login: "", missing: "", bindingReads: true }, true).startsWith(
      "Clawy 用这个令牌读你的 GitHub",
    ),
  );
  assert.ok(readsLine({ readsWith: "env", login: "", missing: "", bindingReads: true }, true).includes("GH_TOKEN"));
  assert.ok(readsLine(null, false).includes("暂时问不到"));
});

test("whoami in chinese", () => {
  const text = connectionsText({
    safe: { name: "爱丽丝" },
    githubState: {
      userId: "u",
      bound: true,
      login: "alice-gh",
      scopes: ["repo"],
      expiresAt: "",
      expired: false,
      delegation: false,
      lastUsedAt: "",
    },
    connection: { readsWith: "", login: "", missing: "none", bindingReads: false },
    connectionKnown: true,
    githubPart: true,
    memory: [false, true],
    memoryPage: "https://m",
    zh: true,
    extraLines: [],
  });
  assert.ok(text.startsWith("连接状态：\n- SaFE：已连接（爱丽丝）"));
  assert.ok(text.includes("- GitHub：已连接 `alice-gh`（只用于代审"));
  assert.ok(text.includes("- 记忆：关，在这里打开：https://m"));
});
