// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  displayName,
  memberMatches,
  memberNames,
  namedIn,
  namedWithin,
  oneLine,
  personOf,
  plainText,
  samePerson,
  tokens,
  writtenIn,
} from "../../src/review-text/names.js";
import type { RosterMember } from "../../src/ports/surface.js";
import { MEMBERS } from "../../../../test-support/review-requests.js";

const member = (name: string, more: Partial<RosterMember> = {}): RosterMember => ({
  channelUserId: "29:x",
  userId: "aad-x",
  name,
  givenName: "",
  surname: "",
  email: "",
  userPrincipalName: "",
  ...more,
});

const TYPED: readonly [string, string[]][] = [
  ["Lin, Mei", ["Lin, Mei"]],
  ["Mei Lin", ["Lin, Mei"]],
  ["linmei", ["Lin, Mei"]],
  ["linmei0120", ["Lin, Mei"]],
  ["LIN MEI", ["Lin, Mei"]],
  ["bob.smith", ["Bob"]],
  ["Bob", ["Bob"]],
  ["Carol", ["Carol", "Carol (SaFE)"]],
  ["Lin", []],
  ["Zed", []],
  ["Al", []],
];

test("a typed name is a member only when it is one way of writing their name", () => {
  for (const [typed, hits] of TYPED) {
    const { hits: found, near } = memberMatches(typed, MEMBERS);
    assert.deepEqual(
      found.map((m) => m.name),
      hits,
      typed,
    );
    // (offered back as a candidate, never acted on)
    if (typed === "Lin")
      assert.deepEqual(
        near.map((m) => m.name),
        ["Lin, Mei"],
      );
  }
});

test("the words of a name may come in any order without a given name or surname to go by", () => {
  const cases: readonly [string, string][] = [
    ["Mei Lin", "Lin, Mei"],
    ["Zhang Lin Mei", "Lin Mei Zhang"],
    ["mei zhang lin", "Lin Mei Zhang"],
  ];
  for (const [typed, name] of cases) {
    assert.deepEqual(
      memberMatches(typed, [member(name)]).hits.map((m) => m.name),
      [name],
    );
  }
});

test("written in: whole words in any order, run together, or a Chinese name inside Chinese", () => {
  assert.equal(writtenIn("Mei Lin", "请 Lin, Mei review 合入"), true);
  assert.equal(writtenIn("linmei", "请 linmei 帮我"), true);
  assert.equal(writtenIn("Bob", "请 Bobby 帮我"), false);
  assert.equal(writtenIn("林梅", "请林梅帮我"), true);
  assert.equal(writtenIn("", "anything"), false);
});

test("tokens split where Chinese meets a letter or a digit", () => {
  assert.deepEqual(tokens("帮我请linmei review并合入PR249"), ["帮我请", "linmei", "review", "并合入", "pr249"]);
  assert.deepEqual(tokens("a_b-c"), ["a", "b", "c"]);
});

test("where a member's name is written, in letters", () => {
  const words = tokens("请 李伟强 和 Lin Mei 帮我");
  assert.deepEqual([...namedIn(words, member("李伟"))].sort(), ["1:0", "1:1"]);
  assert.deepEqual([...namedIn(words, member("Lin, Mei"))].sort(), ["3:0", "3:1", "3:2", "4:0", "4:1", "4:2"]);
  assert.equal(namedIn(words, member("Al")).size, 0);
  assert.equal(namedIn(tokens("ask linmei0120"), member("x", { email: "linmei0120@example.com" })).size, 10);
});

test("the same person named several ways", () => {
  const mentions = [{ channelUserId: "29:w", userId: "", name: "Lin, Mei" }];
  assert.equal(samePerson("⟦0⟧", "Mei Lin", mentions), true);
  assert.equal(samePerson("⟦0⟧", "linmei", mentions), true);
  assert.equal(samePerson("Bob", "Carol", mentions), false);
  assert.equal(namedWithin("Bob", "让 Bob", mentions), true);
  assert.equal(namedWithin("⟦0⟧", "⟦0⟧ 帮忙", mentions), true);
  assert.equal(namedWithin("Carol", "让 Bob", mentions), false);
  assert.equal(personOf("Lin, Mei", mentions), "id:29:w");
  assert.equal(personOf("29:w", mentions), "id:29:w");
  assert.equal(personOf(" Zed  X ", mentions), "name:zedx");
});

test("names and outside text are shown as one plain line", () => {
  assert.equal(displayName("a `b`\n<c>*d*_e_[f](g)#h|i\\j"), "a b c d e f g h i j");
  assert.equal(displayName("x".repeat(70)).length, 60);
  assert.equal(oneLine("ref\n**main**", 100), "ref main");
  assert.equal(oneLine(undefined, 10), "");
  assert.equal(plainText(12), "12");
  assert.equal(plainText({}), "");
  assert.equal(memberNames([member(""), member("Bob")]), "?、Bob");
});
