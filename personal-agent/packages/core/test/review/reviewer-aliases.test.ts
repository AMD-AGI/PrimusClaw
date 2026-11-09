// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whom a message to the assistant names (`test_reviewer_aliases`, read at `peopleOf`): a known person's name is read as the group
 * path reads a member's, so every way of writing it, and their address, names them; two people one name fits are both listed;
 * a name nobody has lists nobody; a review request that names nobody known offers the closest linked people (`near`), never one
 * something of whom the message writes. Each expectation was checked against the Python worker with the same (fictional) names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { peopleOf } from "../../src/understanding/people.js";
import type { PersonRecord } from "../../src/understanding/record.js";
import { openTestStore } from "../../../../test-support/store.js";

const LIN: PersonRecord = { id: "29:w", objectId: "aad-w", name: "Lin, Mei", email: "mlin@example.com" };
const CAROL: PersonRecord = { id: "29:c", objectId: "aad-c", name: "Carol Chen" };
const IDS: Readonly<Record<string, string>> = { "aad-w": "u-lin", "aad-w2": "u-lin2", "aad-c": "u-carol" };
const userIdOf = (aad: string) => IDS[aad];

/** The store's members, as the people records a message is read against. */
const records = (members: readonly object[]): PersonRecord[] => members.map((m) => ({ ...m }));

const names = (text: string, known: readonly PersonRecord[]) =>
  peopleOf([], text, known, userIdOf).map((p) => [p.name, p.user_id ?? ""]);

for (const text of [
  "请linmei帮我review并合入 PrimusClaw PR #304、Primus-SaFE PR #837",
  "请Lin, Mei帮我review并合入 PrimusClaw PR #304、Primus-SaFE PR #837",
  "请 Lin Mei 帮我 review AMD-AGI/PrimusClaw#304",
  "请 Mei Lin 帮我 review AMD-AGI/PrimusClaw#304",
  "请mei.lin帮我review AMD-AGI/PrimusClaw#304",
  "请meilin帮我review AMD-AGI/PrimusClaw#304",
  "请 LinMei 帮我 review AMD-AGI/PrimusClaw#304",
  "请 mlin@example.com 帮我 review AMD-AGI/PrimusClaw#304",
  "请 mlin 帮我 review AMD-AGI/PrimusClaw#304",
]) {
  test(`each way of writing the name lists them: ${text}`, () => {
    assert.deepEqual(names(text, [CAROL, LIN]), [["Lin, Mei", "u-lin"]]);
  });
}

test("the address goes to claw beside the name", () => {
  assert.deepEqual(peopleOf([], "请linmei帮我review AMD-AGI/PrimusClaw#304", [LIN], userIdOf), [
    { name: "Lin, Mei", user_id: "u-lin", email: "mlin@example.com", source: "known" },
  ]);
});

test("two people one name fits are both listed for claw to ask which", () => {
  const twin: PersonRecord = { id: "29:w2", objectId: "aad-w2", name: "Lin, Mei", email: "linm2@example.com" };
  const people = peopleOf([], "请linmei帮我review AMD-AGI/PrimusClaw#304", [LIN, twin], userIdOf);
  assert.deepEqual(
    people.map((p) => [p.user_id, p.email]),
    [
      ["u-lin", "mlin@example.com"],
      ["u-lin2", "linm2@example.com"],
    ],
  );
  // ... and the address tells them apart
  assert.deepEqual(names("请 linm2 帮我 review AMD-AGI/PrimusClaw#304", [LIN, twin]), [["Lin, Mei", "u-lin2"]]);
});

for (const text of [
  "请 Zed 帮我 review AMD-AGI/PrimusClaw#304", // nobody's name, and like nobody's
  "请 Lin 帮我 review AMD-AGI/PrimusClaw#304", // one word of a two-word name is not that name, nor offered as a guess
  "请 linmeiwang 帮我 review AMD-AGI/PrimusClaw#304",
  "请 linme 看一下天气", // like a name, in a message that asks for no review
]) {
  test(`a name nobody has lists nobody: ${text}`, () => {
    assert.deepEqual(names(text, [CAROL, LIN]), []);
  });
}

for (const text of [
  "请linme帮我review并合入 PrimusClaw PR #304",
  "请 linmie 帮我 review AMD-AGI/PrimusClaw#304",
  "请 meiln 帮我 review 合入 https://github.com/AMD-AGI/PrimusClaw/pull/304",
]) {
  test(`a review request that names nobody offers the closest people: ${text}`, () => {
    assert.deepEqual(
      peopleOf([], text, [CAROL, LIN], userIdOf).map((p) => [p.name, p.user_id, p.source]),
      [["Lin, Mei", "u-lin", "near"]],
    );
  });
}

test("the closest people are at most three and closest first and linked", () => {
  const known = ["Linmex", "Linmen", "Linmeo", "Linmea"].map((n) => ({ id: `29:${n}`, objectId: `aad-${n}`, name: n }));
  const ids: Readonly<Record<string, string>> = { "aad-Linmex": "u1", "aad-Linmen": "u2", "aad-Linmeo": "u3" }; // (Linmea is not linked)
  const of = (aad: string) => ids[aad];
  // (a name written is that person; no guesses beside it)
  assert.deepEqual(
    peopleOf([], "请 linmen 帮我 review AMD-AGI/PrimusClaw#304", known, of).map((p) => p.source),
    ["known"],
  );
  const near = peopleOf([], "请 linme 帮我 review AMD-AGI/PrimusClaw#304", known, of);
  assert.deepEqual(
    near.map((p) => p.user_id),
    ["u1", "u2", "u3"],
  );
  assert.deepEqual(new Set(near.map((p) => p.source)), new Set(["near"]));
});

test("an address only the member list gave names them", () => {
  const { store } = openTestStore();
  store.members.rememberMember("29:w", "aad-w", "Lin, Mei");
  store.members.rememberMember("29:x", "aad-x", "Ng, Yu");
  const ask = "请 mlin 帮我 review AMD-AGI/PrimusClaw#304";
  // (only a guess while the address is unknown)
  assert.deepEqual(
    peopleOf([], ask, records(store.members.knownMembers()), userIdOf).map((p) => p.source),
    ["near"],
  );
  store.members.rememberMemberEmails([
    { id: "29:w", name: "Lin, Mei", userPrincipalName: "mlin@example.com" },
    { id: "29:new", name: "Someone New", email: "new@example.com" },
  ] as never);
  const known = store.members.knownMembers();
  // (nobody new is added)
  assert.deepEqual(Object.fromEntries(known.map((k) => [k.id, k.email ?? ""])), {
    "29:w": "mlin@example.com",
    "29:x": "",
  });
  assert.deepEqual(
    peopleOf([], ask, records(known), userIdOf).map((p) => [p.user_id, p.source]),
    [["u-lin", "known"]],
  );
});

test("a message without an address keeps the one known", () => {
  const { store } = openTestStore();
  store.members.rememberMember("29:w", "aad-w", "Lin, Mei", "mlin@example.com");
  store.members.rememberMember("29:w", "aad-w", "Lin, Mei (AMD)");
  assert.deepEqual(store.members.knownMembers(), [
    { id: "29:w", objectId: "aad-w", name: "Lin, Mei (AMD)", email: "mlin@example.com" },
  ]);
  store.members.rememberMember("29:w", "aad-w", "Lin, Mei", "mei.lin@example.com");
  assert.equal(store.members.knownMembers()[0]?.email, "mei.lin@example.com");
});

test("a person something of whom is written is never offered as a guess", () => {
  const zhang: PersonRecord = { id: "29:z", objectId: "aad-c", name: "Linmen Zhang", email: "linmen@example.com" };
  assert.deepEqual(peopleOf([], "请 linme zhang 帮我 review AMD-AGI/PrimusClaw#304", [zhang], userIdOf), []);
  assert.equal(peopleOf([], "请 linme 帮我 review AMD-AGI/PrimusClaw#304", [zhang], userIdOf)[0]?.source, "near");
});

for (const text of [
  "Review https://github.com/mlin/project/pull/42 please", // (the owner of a link is no one named)
  "请帮我 review 合入 mlin/project#42",
  "请帮我 review 合入 linmei/project#42",
  "请帮我 review AMD-AGI/PrimusClaw#304，model: linmei-7b",
]) {
  test(`a pull request or model that carries a name names nobody: ${text}`, () => {
    assert.deepEqual(
      peopleOf([], text, [CAROL, LIN], userIdOf).filter((p) => p.source === "known"),
      [],
    );
  });
}
