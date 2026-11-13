// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review cards as the reviewer and the asker see them (`test_github_review`'s and `test_review_pr_summary`'s card tests): the
 * confirmation card is clipped and its buttons carry only the confirmation and the choice; a held review's card names its event
 * and its inline comments; an ended review card says what the pull request does right under how it ended.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubConfirmView, ReviewModeView } from "@primusclaw/personal-agent";
import { endedItemCard, githubConfirmCard, reviewItemCard, reviewModeCard } from "../../src/views/review/index.js";

/** Every text a card shows and every fact's value, wherever they sit. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  if (record.type === "TextBlock" && typeof record.text === "string") return [record.text];
  if (record.type === "FactSet" && Array.isArray(record.facts))
    return (record.facts as { value: string }[]).map((f) => f.value);
  return Object.values(record).flatMap(texts);
}

function facts(node: unknown): Record<string, string> {
  if (Array.isArray(node)) return Object.assign({}, ...node.map(facts)) as Record<string, string>;
  if (typeof node !== "object" || node === null) return {};
  const record = node as Record<string, unknown>;
  if (record.type === "FactSet" && Array.isArray(record.facts))
    return Object.fromEntries(
      (record.facts as { title: string; value: string }[]).map((f) => [f.title.replaceAll("⁠", ""), f.value]),
    );
  return Object.assign({}, ...Object.values(record).map(facts)) as Record<string, string>;
}

function actions(card: unknown): { title: string; data: Record<string, unknown> }[] {
  const out: { title: string; data: Record<string, unknown> }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === "object" && node !== null) {
      const r = node as Record<string, unknown>;
      if (r.type === "Action.Execute")
        out.push({ title: String(r.title), data: (r.data ?? {}) as Record<string, unknown> });
      Object.values(r).forEach(walk);
    }
  };
  walk(card);
  return out;
}

const view = (fields: Partial<GithubConfirmView> = {}): GithubConfirmView => ({
  confirmationId: "cf-1",
  repo: "o/r",
  number: 7,
  title: "t",
  author: "a",
  headSha: "b".repeat(12),
  reasons: ["why"],
  checks: "",
  requester: "Alice",
  room: "",
  review: undefined,
  model: "",
  hint: false,
  installUrl: "",
  bot: "PrimusClaw Assistant",
  base: "main",
  login: "",
  lang: "zh",
  summary: "",
  ...fields,
});

test("the confirmation card is clipped and carries only the id and the choice", () => {
  const card = githubConfirmCard(
    view({
      title: "t".repeat(500),
      author: "a".repeat(500),
      reasons: Array.from({ length: 9 }, () => "r".repeat(500)),
      checks: "g".repeat(500),
      requester: "q".repeat(500),
    }),
  );
  assert.ok(
    texts(card).every((t) => Array.from(t).length <= 400),
    texts(card)
      .map((t) => t.length)
      .join(","),
  );
  const acts = actions(card);
  assert.deepEqual(
    acts.map((a) => a.title),
    ["确认合入", "不合入"],
  );
  assert.ok(
    acts.every(
      (a) => JSON.stringify(Object.keys(a.data).sort()) === JSON.stringify(["confirmation", "decision", "primusclaw"]),
    ),
  );
});

test("the card of a held review names its event and clips its text", () => {
  const body = `fine, token [hidden] was in the log ${"w ".repeat(400)}`; // (masked before it reaches the card: core's confirm.ts)
  const card = githubConfirmCard(view({ review: { event: "APPROVE", body, comments: 0 }, room: "G" }));
  const f = facts(card);
  assert.equal(f["结论"], "APPROVE");
  assert.ok(!texts(card).some((t) => t.includes("行内评论")));
  const preview = f["内容"] ?? "";
  assert.ok(Array.from(preview).length <= 200 && preview.endsWith("…"), preview);
  assert.deepEqual(
    actions(card).map((a) => a.title),
    ["确认发布", "不发布"],
  );
  assert.equal(
    facts(githubConfirmCard(view({ review: { event: "APPROVE", body, comments: 1 } })))["结论"],
    "APPROVE，1 条行内评论",
  );
  const en = githubConfirmCard(view({ review: { event: "APPROVE", body, comments: 1 }, lang: "en" }));
  assert.ok(
    texts(en).some((t) => t.includes("APPROVE, 1 inline comment")) &&
      !texts(en).some((t) => t.includes("1 inline comments")),
  );
  assert.deepEqual(
    actions(en).map((a) => a.title),
    ["Post review", "Do not post"],
  );
});

const ZH = "给代审结论卡加一句话，概述这个 PR 做了什么";
const EN = "Adds a one-sentence summary of what the pull request does to the review conclusion card.";
const ITEM = {
  seq: 3,
  pull: "AMD-AGI/Hyperloom#12",
  who: "Bob",
  reviewOnly: false,
  model: "m",
  cardId: "c1",
  lang: "zh" as const,
  queued: false,
};

test("an ended review card says what it does right under how it ended", () => {
  const shown = texts(reviewItemCard(ITEM, "已结束：结论：批准，已合入", ZH));
  assert.equal(shown.indexOf(`PR 概述：${ZH}`), shown.indexOf("已结束：结论：批准，已合入") + 1);
  assert.ok(
    texts(reviewItemCard({ ...ITEM, lang: "en" }, "Ended: approved, merged", EN)).includes(`What it does: ${EN}`),
  );
  assert.ok(!texts(reviewItemCard(ITEM, "已结束")).some((t) => t.includes("概述")));
  assert.ok(!texts(reviewItemCard(ITEM, "", ZH)).some((t) => t.includes("概述")), "only once it ended");
  const render = {
    kind: "review",
    seq: 3,
    pull: ITEM.pull,
    who: "Bob",
    review_only: false,
    model: "m",
    lang: "zh",
    pr_summary: ZH,
  };
  assert.ok(
    texts(endedItemCard({ render, ended: "已结束：结论：批准，已合入", cardId: "c1" })).includes(`PR 概述：${ZH}`),
  );
});

test("the confirmation card says what the pull request does", () => {
  for (const review of [undefined, { event: "REQUEST_CHANGES", body: "x", comments: 2 }]) {
    assert.ok(texts(githubConfirmCard(view({ review, summary: ZH }))).some((t) => t === ZH || t.endsWith(ZH)));
    assert.ok(!texts(githubConfirmCard(view({ review }))).some((t) => t.includes(ZH)));
    assert.ok(texts(githubConfirmCard(view({ review, summary: EN, lang: "en" }))).some((t) => t.includes(EN)));
  }
});

for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(`a setting named like an object property is no setting on the mode card (${word})`, () => {
    // (Python's review_mode_card: `suggested in REVIEW_MODES`, `current in REVIEW_MODES`)
    const model = { current: word, suggested: word, lead: "", hint: "", installUrl: "" } as unknown as ReviewModeView;
    const card = reviewModeCard(model);
    const shown = texts(card);
    assert.ok(
      JSON.stringify(card).includes("还没有设置，默认是第一项"),
      "a word that is not a setting is not the one in force",
    );
    assert.ok(!JSON.stringify(card).includes("native code"));
    assert.ok(!shown.some((t) => t.includes("（当前）")));
    assert.deepEqual(
      actions(card).map((a) => a.data.mode),
      ["high_risk_confirm", "fully_auto"],
    );
  });
}
