// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { connectionsText } from "../../src/review/connect/connections.js";
import { asksAboutOwnGithub, repositoriesNamed } from "../../src/review/connect/questions.js";
import { consentText, readsLine } from "../../src/review/consent.js";
import { ALICE, groupMessage, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

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
    ["amd-agi", "SECRET"], // (links first, as Python reads them)
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

test("the consent says the assistant reads github with it only where claw does", () => {
  const code = {
    deviceCode: "d",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  };
  assert.ok(consentText(code, true, "PrimusClaw Assistant").includes("To let me read your GitHub for you"));
  assert.ok(!consentText(code, false, "PrimusClaw Assistant").includes("To let me read your GitHub for you"));
  assert.ok(consentText(code, false, "PrimusClaw Assistant").includes("（15 分钟内有效）"));
  // (what is posted names the bot by the deployment's name)
  const named = consentText(code, false, "Robin");
  assert.ok(named.includes("注明是 Robin 代你所发") && named.includes("made by Robin on your behalf"));
  assert.ok(!named.includes("{bot}"));
});

test("github status says whether the assistant reads github with the binding", () => {
  assert.ok(
    readsLine({ readsWith: "binding", login: "", missing: "", bindingReads: true }, true).startsWith(
      "我用这个令牌读你的 GitHub",
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
  assert.ok(text.split("\n").some((line) => line === "- 记忆：关，在这里打开：https://m"));
});

const connectionReads = (world: ReviewWorld) => world.claw.calls.filter((c) => c[0] === "githubConnection").length;

test("once github is read the next questions do not ask claw again", async () => {
  const world = connectWorld();
  world.claw.connection = { readsWith: "binding", login: "alice-gh", missing: "", bindingReads: true };
  assert.equal(await offer(world, () => Promise.resolve()), false);
  assert.equal(await offer(world, () => Promise.resolve(), "我的 CI 挂了吗"), false);
  assert.equal(connectionReads(world), 1);
});

test("a person already bound whose binding claw cannot read gets no card", async () => {
  const world = connectWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  assert.equal(await offer(world, () => Promise.resolve()), false);
  assert.deepEqual(world.github.starts, []);
  assert.deepEqual(
    world.surface.of(DM).filter((r) => "message" in r && r.message.body.type === "view"),
    [],
  );
});

test("a github command forgets what was remembered of the connection", async () => {
  const world = connectWorld();
  world.claw.connection = { readsWith: "binding", login: "alice-gh", missing: "", bindingReads: true };
  await offer(world, () => Promise.resolve());
  const conversation = world.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: DM } },
  });
  const github = world.service.routeHandlers().commands.find((c) => c.name === "github");
  const message = groupMessage("/github unbind", ALICE, [], "u1", "personal");
  await github?.run(
    { message, text: message.text, sender: ALICE, conversation, scope: "", lang: () => "zh" } as never,
    "unbind",
  );
  await offer(world, () => Promise.resolve(), "我的 CI 挂了吗");
  assert.equal(connectionReads(world), 2); // asked again after the unbind
});

test("repositories are read from links and names next to a github word", () => {
  assert.deepEqual(repositoriesNamed("看下 https://github.com/example-org/example-repo/pull/288"), [
    ["example-org", "example-repo"],
  ]);
  assert.deepEqual(repositoriesNamed("clone https://github.com/AMD-AGI/PrimusClaw.git"), [["AMD-AGI", "PrimusClaw"]]); // (a clone URL)
  assert.deepEqual(repositoriesNamed("AMD-AGI/Primus#12 的 CI 挂了吗"), [["AMD-AGI", "Primus"]]);
  assert.deepEqual(repositoriesNamed("a/b 是什么"), []); // (no GitHub word: "and/or" is no repository)
  assert.deepEqual(repositoriesNamed("CI/CD 的 PR 怎么写"), []); // (words, not a repository)
});

test("a long line of review words is read in linear time", () => {
  // (each "review" looked ahead for owner/repo#N, which used to be tried again from every character of the run: cubic, ~0.4 s
  // for one 2000-character message; Python's `_REVIEW` takes ~0.15 s on it)
  const text = `我的 github PR 状态 ${"review-".repeat(282)}`;
  const started = performance.now();
  assert.equal(asksAboutOwnGithub(text), true);
  assert.ok(performance.now() - started < 100, `took ${String(performance.now() - started)} ms`);
  // (and the same reading as Python's: owner/repo#N within 40 characters of the word, from the start of its name)
  assert.equal(asksAboutOwnGithub(`我的 github PR 状态 review ${" ".repeat(39)}o/r#1`), false);
  assert.equal(asksAboutOwnGithub(`我的 github PR 状态 review ${" ".repeat(40)}o/r#1`), true);
  assert.equal(asksAboutOwnGithub(`我的 github PR 状态 review x-${"a".repeat(60)}/r#1`), false);
});

test("the dots after a repository name are dropped as python's rstrip drops them", () => {
  assert.deepEqual(repositoriesNamed("看下 https://github.com/o/repo.../pull/1"), [["o", "repo"]]);
  assert.deepEqual(repositoriesNamed("看下 https://github.com/o/.../pull/1"), []);
  assert.deepEqual(repositoriesNamed("看下 https://github.com/o/a.b./pull/1"), [["o", "a.b"]]);
});
