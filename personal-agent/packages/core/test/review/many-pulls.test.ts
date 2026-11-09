// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Several pull requests in one request (`test_github_review_many`): reviewed at the same time, each in a session of its own, one
 * acknowledgement for all; on a Claw without a queue ten start and the rest are named; one refused early is named in that one
 * acknowledgement and the others go on; one under review is not started twice and is free again when its review ends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR1 = "AMD-AGI/Hyperloom#1";
const PR2 = "AMD-AGI/Hyperloom#2";
const PR3 = "AMD-AGI/Primus#3";
const URL2 = "https://github.com/AMD-AGI/Hyperloom/pull/2";

function world(): ReviewWorld {
  const w = reviewWorld();
  w.github.repos.set("amd-agi/primus", "AMD-AGI/Primus");
  return w;
}

async function ask(w: ReviewWorld, text: string, id = "g1"): Promise<void> {
  const message = groupMessage(text, ALICE, undefined, id);
  await w.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: w.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const targets = (w: ReviewWorld) =>
  w.started.map(
    (s) => `${s.turn.reviewTarget.owner}/${s.turn.reviewTarget.repo}#${String(s.turn.reviewTarget.number)}`,
  );
const groupTexts = (w: ReviewWorld) =>
  w.surface.of(CONV).flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []));
const acks = (w: ReviewWorld) =>
  [...groupTexts(w), ...w.started.map((s) => s.turn.lead)].filter((t) => t.startsWith("收到"));

test("several pull requests are reviewed at the same time each in a session of its own", async () => {
  const w = world();
  await ask(w, `请 {Bob} 帮我 review 合入 ${PR1}, ${URL2}、${PR3}`);
  assert.deepEqual(targets(w), [PR1, PR2, PR3]);
  assert.deepEqual(new Set(w.started.map((s) => s.turn.actingAs)), new Set(["u-bob"]));
  assert.deepEqual(new Set(w.started.map((s) => s.modelKey)), new Set(["ak-alice-linked"]));
  const [ack = "", ...more] = acks(w);
  assert.equal(more.length, 0);
  assert.ok([PR1, PR2, PR3].every((p) => ack.includes(p)) && ack.includes("同时"), ack);
});

for (const [count, started] of [
  [10, 10],
  [15, 10],
  [31, 0],
] as const) {
  test(`a claw without a queue starts ten and names the rest and past thirty starts none (${String(count)})`, async () => {
    const w = world();
    const prs = Array.from({ length: count }, (_, i) => `AMD-AGI/Hyperloom#${String(i + 1)}`).join(" ");
    await ask(w, `请 {Bob} 帮我 review 合入 ${prs}`);
    assert.equal(w.started.length, started);
    const said = saidIn(w.surface, CONV) + acks(w).join(" ");
    if (!started) {
      assert.ok(said.includes("一次最多交给我 30 个 PR"), said);
      assert.deepEqual(w.identity.requests, []);
      assert.deepEqual(w.github.reads, []);
    } else if (count > started) {
      assert.ok(said.includes("AMD-AGI/Hyperloom#11（PrimusClaw 这一版一次只接受 10 个"), said);
    }
  });
}

for (const [name, refused, why] of [
  ["owner", "someone-else/repo#5", "只处理 AMD-AGI 的公开仓库"],
  ["own pull request", PR2, "Bob 自己提交的"],
] as const) {
  test(`a pull request refused early is named in the one acknowledgement and the others go on (${name})`, async () => {
    const w = world();
    if (name === "own pull request") w.github.authors.set(PR2.toLowerCase(), "bob-gh");
    await ask(w, `请 {Bob} 帮我 review 合入 ${PR1} ${refused} ${PR3}`);
    assert.deepEqual(targets(w), [PR1, PR3]);
    const [ack = ""] = acks(w);
    const [head = "", tail = ""] = ack.split("没有开始：");
    assert.ok(head.includes(PR1) && head.includes(PR3) && !head.includes(refused), ack);
    assert.ok(tail.includes(refused) && tail.includes(why), ack);
  });
}

test("a pull request refused early because it is under review is named and the others go on (in flight)", async () => {
  const w = world();
  await ask(w, `请 {Bob} 帮我 review 合入 ${PR2}`, "g0"); // (still running)
  await ask(w, `请 {Bob} 帮我 review 合入 ${PR1} ${PR2} ${PR3}`);
  assert.deepEqual(targets(w).slice(-2), [PR1, PR3]);
  const ack = acks(w).at(-1) ?? "";
  const [, tail = ""] = ack.split("没有开始：");
  assert.ok(tail.includes(PR2) && tail.includes("已经在 review 中"), ack);
});

test("when every pull request is refused early nothing starts and the group hears why", async () => {
  const w = world();
  await ask(w, "请 {Bob} 帮我 review 合入 someone-else/repo#5 other/x#6");
  assert.equal(w.started.length, 0);
  assert.deepEqual(w.identity.requests, []);
  const said = saidIn(w.surface, CONV);
  assert.ok(
    said.includes("没有开始任何 review") && said.includes("someone-else/repo#5") && said.includes("other/x#6"),
    said,
  );
});

test("a pull request under review is not started twice and is free again when its review ends", async () => {
  const w = world();
  await ask(w, `请 {Bob} 帮我 review 合入 ${PR2}`, "g1");
  await ask(w, `请 {Bob} 帮我 review 合入 ${URL2}`, "g2");
  assert.equal(w.started.length, 1);
  assert.ok(saidIn(w.surface, CONV).includes(`${PR2} 已经在 review 中`));
  w.started[0]?.ended();
  await Promise.resolve();
  await ask(w, `请 {Bob} 帮我 review 合入 ${PR2}`, "g3");
  assert.equal(w.started.length, 2);
});
