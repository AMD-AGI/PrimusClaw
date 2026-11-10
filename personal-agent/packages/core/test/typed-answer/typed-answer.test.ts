// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ANSWER_PROMPT,
  decisionWords,
  namesReviewAndMerge,
  pickRow,
  readTypedAnswer,
  typedAnswerText,
  typedMode,
  type HeldRow,
  type Pending,
} from "../../src/index.js";
import { own } from "../../src/own.js";

const CLAW = "AMD-AGI/PrimusClaw";
const SAFE = "AMD-AGI/Primus-SaFE";
const PULLS: Pending[] = [
  [CLAW, 243],
  [CLAW, 234],
  [SAFE, 823],
];

type Expected = ReadonlyArray<readonly [Pending, "allow" | "deny"]> | "ask" | null;

// (what is typed, what it decides with no model reading): decisions, "ask" for a question back, null: chat.
const RULES: Array<readonly [string, Expected]> = [
  ["确认 #243", [[[CLAW, 243], "allow"]]],
  ["拒绝 #243", [[[CLAW, 243], "deny"]]],
  ["不合入 #243", [[[CLAW, 243], "deny"]]],
  [
    "#243 #234 都确认",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "allow"],
    ],
  ],
  [
    "确认 #243，拒绝 #234",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "deny"],
    ],
  ],
  [
    "243 可以合，234 先别合",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "deny"],
    ],
  ],
  [
    "全部确认",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "allow"],
      [[SAFE, 823], "allow"],
    ],
  ],
  [
    "都合吧",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "allow"],
      [[SAFE, 823], "allow"],
    ],
  ],
  ["don't merge 234", [[[CLAW, 234], "deny"]]],
  ["确认 Primus-SaFE#823", [[[SAFE, 823], "allow"]]],
  ["确认 PR #243", [[[CLAW, 243], "allow"]]], // "PR" is no repository
  [
    "PR#243 PR#234 都合入",
    [
      [[CLAW, 243], "allow"],
      [[CLAW, 234], "allow"],
    ],
  ],
  ["确认 https://github.com/AMD-AGI/PrimusClaw/pull/243", [[[CLAW, 243], "allow"]]],
  ["确认", "ask"], // three wait: which?
  ["确认 #243 拒绝 #243", "ask"], // both for one
  ["好的", null], // a weak word alone answers nothing
  ["都可以", null],
  ["#243 为什么是高风险？", null], // a question
  ["确认 #243 吗？", null],
  ["我看过了 #243 那个代码没问题，合吧", null], // with no reading, only a message that is nothing but an answer counts
  ["确认一下这个函数是否正确", null],
  ["请帮忙确认 #243 的状态", null], // a request to check, not an answer
  ["确认一下 #243", null],
  ["帮我确认 #243", null],
  ["请确认 #243 吧", [[[CLAW, 243], "allow"]]],
  ["帮我 review 合入 #250", null], // a new request (#250 does not wait)
  ["确认 #250", null], // with no reading, a number that does not wait may be anything
  ["合入前高风险的都先人工确认一下", null], // about the settings, not an answer to a merge
  ["改成全自动合入", null],
];

test("what the rules read from a typed answer", async (t) => {
  for (const [text, expected] of RULES) {
    await t.test(text, () => {
      const got = readTypedAnswer(text, PULLS, true);
      if (expected === null) {
        assert.equal(got, null);
      } else if (expected === "ask") {
        assert.ok(got?.question);
        assert.deepEqual(got.decisions, []);
      } else {
        assert.equal(got?.question, "");
        assert.deepEqual(got.decisions, expected);
      }
    });
  }
});

test("with a reading that it is an answer what the rules cannot place is asked back", () => {
  assert.equal(readTypedAnswer("确认 #243 吗？", PULLS, false), null); // a question is never an answer
  assert.deepEqual(readTypedAnswer("我看过了 #243 那个代码没问题，合吧", PULLS, false)?.decisions, [
    [[CLAW, 243], "allow"],
  ]);
  assert.ok(readTypedAnswer("确认 #250 吧，之前那个", PULLS, false)?.question.includes("#250 没有在等你确认"));
  assert.equal(readTypedAnswer("确认 #250 吧，之前那个", PULLS, true), null); // (no reading: too many other words)
  const same: Pending[] = [
    ["AMD-AGI/PrimusClaw", 12],
    ["AMD-AGI/Hyperloom", 12],
  ];
  assert.ok(readTypedAnswer("确认 #12", same, true)?.question.includes("请写上仓库名"));
  assert.deepEqual(readTypedAnswer("确认 Hyperloom#12", same, true)?.decisions, [[["AMD-AGI/Hyperloom", 12], "allow"]]);
  assert.equal(readTypedAnswer("确认 #243", [], true)?.question, typedAnswerText.nothingWaits);
});

test("a typed choice of the setting needs a word that picks one", async (t) => {
  const cases: Array<readonly [string, string | null]> = [
    ["确认全自动", "fully_auto"],
    ["选全自动合入", "fully_auto"],
    ["确认高风险再问我", "high_risk_confirm"],
    ["改成全自动", null],
    ["全自动驾驶是什么原理", null],
    ["确认全自动吗？", null],
    ["确认全自动还是高风险", null],
  ];
  for (const [text, mode] of cases) {
    await t.test(text, () => {
      assert.equal(typedMode(text)?.mode ?? null, mode);
    });
  }
});

const REVIEW_AND_MERGE = [
  "请linmei帮我review合入AMD-AGI/Hyperloom#12",
  "请 linmei 帮我 review 合入 AMD-AGI/Hyperloom#12",
  "请linmei帮我review合并AMD-AGI/Hyperloom#12",
  "请 linmei 帮我 review 合并 AMD-AGI/Hyperloom#12",
  "请linmei帮我评审并合并AMD-AGI/Hyperloom#12",
  "Bob，麻烦 review 后合并 AMD-AGI/Hyperloom#12",
  "Please review and merge AMD-AGI/Hyperloom#12",
  "please review & merge AMD-AGI/Hyperloom#12",
  "Bob, review, merge AMD-AGI/Hyperloom#12",
  "Bob please review+merge AMD-AGI/Hyperloom#12",
  "merge AMD-AGI/Hyperloom#12 after Bob reviews it, ok",
  "Bob 帮我 review 一下 AMD-AGI/Hyperloom#12，没问题就合了吧",
];

const CONFIRMATIONS = [
  "确认",
  "合入",
  "合并",
  "同意 #12",
  "确认 #12",
  "确认 #12 合入",
  "合并 Hyperloom#12",
  "merge Hyperloom#12",
  "approve Hyperloom#12",
  "我看过了，#12 那个没问题，合吧",
  "#12 可以合",
];

test("every request to review and merge names a review and a merge, and a confirmation names no review", () => {
  assert.deepEqual(
    REVIEW_AND_MERGE.filter((text) => !namesReviewAndMerge(text)),
    [],
  );
  assert.deepEqual(
    CONFIRMATIONS.filter((text) => namesReviewAndMerge(text)),
    [],
  );
});

test("whether it can merge is a question, never a choice of the merge", () => {
  for (const text of ["确认 #12 能不能合", "确认 #12 可不可以合入", "确认 #12 能否合并"]) {
    assert.equal(readTypedAnswer(text, [["AMD-AGI/Hyperloom", 12]], false), null);
  }
});

interface Parity {
  pending: Record<string, Pending[]>;
  answers: Array<{
    text: string;
    pending: string;
    strict: boolean;
    answer: { decisions: Array<[Pending, string]>; question: string } | null;
  }>;
  modes: Array<{
    text: string;
    mode: { mode: string; bare: boolean } | null;
    decision_words: boolean;
    review_and_merge: boolean;
  }>;
}

const PARITY = JSON.parse(readFileSync(new URL("python-parity.json", import.meta.url), "utf8")) as Parity;

test("the rules read every message of the Python worker's corpus as it did", () => {
  const differ = PARITY.answers.filter((row) => {
    const got = readTypedAnswer(row.text, own(PARITY.pending, row.pending) ?? [], row.strict);
    return (
      JSON.stringify(got === null ? null : { decisions: got.decisions, question: got.question }) !==
      JSON.stringify(row.answer)
    );
  });
  assert.deepEqual(
    differ.map((row) => `${row.text} | ${row.pending} | ${String(row.strict)}`),
    [],
  );
  assert.ok(PARITY.answers.length >= 300);
});

test("the setting, the words of an answer and a review-and-merge request are read as the Python worker read them", () => {
  for (const row of PARITY.modes) {
    assert.deepEqual(typedMode(row.text), row.mode, row.text);
    assert.equal(decisionWords(row.text), row.decision_words, row.text);
    assert.equal(namesReviewAndMerge(row.text), row.review_and_merge, row.text);
  }
});

function row(over: Partial<HeldRow>): HeldRow {
  return {
    kind: "merge",
    event: "",
    repo: "AMD-AGI/Hyperloom",
    pr: 12,
    created_at: 1,
    confirmation_id: "cf-1",
    ...over,
  };
}

test("a pull request held for a merge and a review is asked which, and one held twice is answered for the newest", () => {
  const merge = row({});
  const review = row({ kind: "review", event: "REQUEST_CHANGES", confirmation_id: "cf-r", created_at: 2 });
  assert.equal(
    pickRow([merge, review], "确认 #12"),
    "AMD-AGI/Hyperloom#12 有两项在等你确认：合入、发布 REQUEST_CHANGES review。请回复「确认 #12 合入」或「确认 #12 review」（拒绝同理）。 / " +
      "AMD-AGI/Hyperloom#12 holds both a merge and a review: reply 确认 #12 合入 or 确认 #12 review.",
  );
  assert.equal(pickRow([merge, review], "确认 #12 合入"), merge);
  assert.equal(pickRow([merge, review], "确认 #12 review"), review);
  assert.equal(pickRow([merge, review], "确认 #12 发布"), review);
  const older = row({ confirmation_id: "cf-0", created_at: 0 });
  const tie = row({ confirmation_id: "cf-2" });
  assert.equal(pickRow([older, merge, tie], "确认"), tie);
  assert.equal(pickRow([merge], "确认"), merge);
});

test("the model is asked only whether it is an answer", () => {
  assert.ok(ANSWER_PROMPT.startsWith("You read one message a person sent to Clawy"));
  assert.ok(ANSWER_PROMPT.endsWith("only classify it."));
});

test("a number past 2^53 is read and said back as Python's int writes it, never thrown on", () => {
  const pending = [["AMD-AGI/x", 1] as const];
  const big = "99999999999999999999";
  const notWaiting = (name: string): string =>
    `${name} 没有在等你确认。在等你确认的是：AMD-AGI/x#1。 / ${name} is not waiting for your confirmation; these are: AMD-AGI/x#1.`;
  // (each expected value is what the Python worker's read_typed_answer returned)
  for (const text of [
    `合入 #${big}`,
    `确认 PR ${big}`,
    `approve AMD-AGI/x#${big}`,
    `https://github.com/o/r/pull/${big} 合入`,
  ]) {
    assert.equal(readTypedAnswer(text, pending, true), null, text);
  }
  assert.deepEqual(readTypedAnswer(`合入 #${big}`, pending, false), { decisions: [], question: notWaiting(`#${big}`) });
  assert.deepEqual(readTypedAnswer(`确认 PR ${big}`, pending, false), {
    decisions: [[["AMD-AGI/x", 1], "allow"]],
    question: "",
  });
  assert.deepEqual(readTypedAnswer(`approve AMD-AGI/x#${big}`, pending, false), {
    decisions: [],
    question: notWaiting(`AMD-AGI/x#${big}`),
  });
  assert.deepEqual(readTypedAnswer(`https://github.com/o/r/pull/${big} 合入`, pending, false), {
    decisions: [],
    question: notWaiting(`o/r#${big}`),
  });
});
