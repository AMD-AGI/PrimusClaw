// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  attachedContext,
  channelContext,
  exactCommand,
  memberKeys,
  nearPeople,
  peopleOf,
  pendingOf,
  pullsIn,
  reviewStop,
  withoutRefs,
  type CommandBook,
  type Mention,
  type PersonRecord,
} from "../../src/index.js";
import { similarity } from "../../src/text/sequence-matcher.js";

/** The commands of the 1:1 chat that these cases use (the command module's own table is W4's). */
const COMMANDS: CommandBook = {
  menuCommand: (text) => (({ help: "/help" }) as Record<string, string>)[text.trim().toLowerCase()] ?? text,
  isKnownCommand: (name) => ["help", "new", "stop", "brief", "quiet", "memory"].includes(name),
};

test("exact command", async (t) => {
  const cases: Array<readonly [string, boolean]> = [
    ["/brief on 10:00", true],
    ["help", true],
    ["/github status", true],
    ["/board", true],
    ["/brief10:0", false],
    ["/foo", false],
    ["停一下", false],
    ["看看我的任务", false],
    ["", false],
  ];
  for (const [text, command] of cases)
    await t.test(text || "(empty)", () => {
      assert.equal(exactCommand(text, COMMANDS), command);
    });
});

test("review stop", async (t) => {
  const cases: Array<readonly [string, Array<readonly [string, number]>]> = [
    ["停 825", [["", 825]]],
    ["把 825 的 review 停一下", [["", 825]]],
    ["stop AMD-AGI/Primus#825", [["amd-agi/primus", 825]]],
    [
      "825 先别合，826 也停",
      [
        ["", 825],
        ["", 826],
      ],
    ],
    ["停一下", []],
    ["825 为什么停在 CI", []],
    ["帮我 review 825", []],
    ["825 为什么被取消了？", []],
    ["不要停 825", []],
    ["do not stop 825", []],
    ["825 别停，继续审", []],
    ["don't cancel #825", []],
    ["我不想停 #825", []],
    ["我不想取消 #825", []],
    ["I don't want to stop 825", []],
    ["不必撤回 825", []],
    ["停不了 825", []],
    ["825 别审了", [["", 825]]],
    ["stop AMD-AGI/Primus#825 please", [["amd-agi/primus", 825]]],
    ["停 https://github.com/AMD-AGI/Primus/pull/825", [["amd-agi/primus", 825]]],
    [
      "停 AMD-AGI/Primus#825\t826",
      [
        ["amd-agi/primus", 825],
        ["", 826],
      ],
    ],
  ];
  for (const [text, pulls] of cases)
    await t.test(text, () => {
      assert.deepEqual(reviewStop(text), pulls);
    });
});

test("review stop is linear in a long word", () => {
  const text = `停 AMD-AGI/Primus#825 ${"x".repeat(28_000)} Primus`;
  const started = performance.now();
  assert.deepEqual(reviewStop(text), []); // the long word is none of the words around a stop: no stop
  assert.ok(performance.now() - started < 1000);
});

interface Parity {
  known: PersonRecord[];
  linked: Record<string, string>;
  mentions: Mention[][];
  people: Array<{
    text: string;
    mentions: number;
    people: unknown[];
    near: string[];
    without_refs: string;
    pulls: Array<[string, string, number]>;
  }>;
  keys: Array<{ person: PersonRecord; keys: string[] }>;
  stops: Array<{ text: string; pulls: Array<[string, number]> }>;
}

const PARITY = JSON.parse(readFileSync(new URL("python-parity.json", import.meta.url), "utf8")) as Parity;
const userIdOf = (aad: string): string | undefined => PARITY.linked[aad];
const aadOf = (teamsId: string): string | undefined => (teamsId === "29:m2" ? "aad-m2" : undefined);

test("the people a message names are read as the Python worker read them", () => {
  assert.ok(PARITY.people.length >= 80 && PARITY.people.some((row) => row.near.length > 0));
  for (const row of PARITY.people) {
    const label = `${row.text} (mentions ${String(row.mentions)})`;
    assert.deepEqual(
      peopleOf(PARITY.mentions[row.mentions] ?? [], row.text, PARITY.known, userIdOf, aadOf),
      row.people,
      label,
    );
    assert.deepEqual(
      nearPeople(row.text, PARITY.known, userIdOf).map((p) => p["objectId"]),
      row.near,
      label,
    );
    assert.equal(withoutRefs(row.text), row.without_refs, label);
    assert.deepEqual(
      pullsIn(row.text).map((p) => [p.owner, p.repo, p.number]),
      row.pulls,
      label,
    );
  }
  for (const { person, keys } of PARITY.keys) assert.deepEqual([...memberKeys(person)].sort(), keys);
});

test("a stop is read as the Python worker read it", () => {
  for (const row of PARITY.stops) assert.deepEqual(reviewStop(row.text), row.pulls, row.text);
});

test("names are compared as difflib compares them", () => {
  const cases: Array<readonly [string, string, number]> = [
    ["huiru", "huirui", 0.9090909090909091],
    ["linme", "linmei", 0.9090909090909091],
    ["abc", "abc", 1.0],
    ["", "x", 0.0],
    ["", "", 1.0],
    ["review", "reviewer", 0.8571428571428571],
    ["abcd", "dcba", 0.25],
    ["aaaa", "aa", 0.6666666666666666],
    ["xyzzy", "zyxxy", 0.4],
    ["mmmlinmeimm", "linmeimmm", 0.8],
    ["中文名字", "中文名", 0.8571428571428571],
    ["😀ab", "ab😀", 0.6666666666666666],
  ];
  for (const [a, b, ratio] of cases) assert.equal(similarity(a, b), ratio, `${a} ~ ${b}`);
  // b of 200 or more: its popular characters are left out of the search, then matched around
  assert.equal(similarity(`${"ab".repeat(3)}xyz`, `${"ab".repeat(99)}xyzq`), 0.08530805687203792);
});

test("what waits, the attached session and the whole context are said as the contract writes them", () => {
  assert.deepEqual(
    pendingOf([{ confirmation_id: "cf-1", repo: "o/r", pr: 7, kind: "merge", expires_at: 1_767_225_600 }]),
    [{ kind: "confirmation", id: "cf-1", pr: "o/r#7", what: "merge", expires_at: "2026-01-01T00:00:00+00:00" }],
  );
  assert.equal(
    pendingOf([{ confirmation_id: "x".repeat(300), repo: "o/r", pr: 7, kind: "review", expires_at: 1.5 }])[0]
      ?.expires_at,
    "1970-01-01T00:00:01.500000+00:00",
  );
  assert.equal(
    pendingOf(
      Array.from({ length: 60 }, () => ({ confirmation_id: "c", repo: "o/r", pr: 1, kind: "merge", expires_at: 0 })),
    ).length,
    50,
  );
  assert.deepEqual(attachedContext(undefined), {});
  assert.deepEqual(attachedContext(null), { attached: null });
  assert.deepEqual(attachedContext({ session: "s".repeat(250), live: true, n: 3 }), {
    attached: { session: "s".repeat(200), live: true },
  });
  const people = [{ name: "Lin Mei", user_id: "u-lm", source: "known" as const }];
  assert.deepEqual(channelContext({ channelMessageId: "m1", people, pending: [], actions: [{ name: "brief" }] }), {
    channel: "teams",
    channel_message_id: "m1",
    people,
    actions: [{ name: "brief" }],
    pending: [],
  });
  assert.deepEqual(
    channelContext({
      channelMessageId: "m2",
      people: [],
      pending: [],
      actions: [],
      handoffs: ["review_for_other"],
      attached: null,
      via: "on_behalf",
    }),
    {
      channel: "teams",
      channel_message_id: "m2",
      people: [],
      actions: [],
      pending: [],
      handoffs: ["review_for_other"],
      via: "on_behalf",
      attached: null,
    },
  );
});
