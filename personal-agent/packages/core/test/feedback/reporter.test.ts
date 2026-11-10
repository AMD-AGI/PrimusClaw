// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of tests/test_feedback_reporter.py: who reported it, on the issue's first line and in its title. */
import assert from "node:assert/strict";
import test from "node:test";

import type { KeyOwner, UserRef } from "@primusclaw/personal-agent";

import { USER_A, advance, linkedWorld, makeWorld, say } from "./world.js";

const SAFE: KeyOwner = { id: "u-1", name: "Alice Safe", email: "alice@example.com", accountType: "sso" };
const ALICE_TEAMS: UserRef = { ...USER_A, email: "alice.teams@example.com" };

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0] ?? "";
}

test("the email comes from the teams profile then safe then nowhere", async () => {
  const cases: readonly (readonly [UserRef, KeyOwner | "fail" | undefined, string, boolean])[] = [
    [ALICE_TEAMS, SAFE, "Reported by **Alice** (alice.teams@example.com)", false],
    [USER_A, SAFE, "Reported by **Alice** (alice@example.com)", true],
    [USER_A, undefined, "Reported by **Alice**", true],
    [USER_A, { ...SAFE, email: "" }, "Reported by **Alice**", true],
    [USER_A, "fail", "Reported by **Alice**", true],
    [USER_A, { ...SAFE, email: "alice@example.com) [click](http://x" }, "Reported by **Alice**", true],
    [USER_A, { ...SAFE, email: "two words@example.com" }, "Reported by **Alice**", true],
    [{ ...USER_A, name: "" }, SAFE, "Reported by **Alice Safe** (alice@example.com)", true],
  ];
  for (const [user, lookup, expected, asks] of cases) {
    const world = linkedWorld({ lookup });
    await say(world, "/feedback it broke", user);
    const body = world.issues.issues[0]?.body ?? "";
    assert.equal(firstLine(body), expected);
    assert.equal(world.lookups.length > 0, asks, expected);
    assert.ok(!(body.split("### Context")[0] ?? "").includes("()"));
  }
});

test("an unlinked user has no key to ask safe with so the line has no parentheses", async () => {
  const world = makeWorld({ lookup: SAFE });
  await say(world, "/feedback I cannot link");
  assert.equal(firstLine(world.issues.issues[0]?.body), "Reported by **Alice**");
  assert.deepEqual(world.lookups, []);
  assert.ok(world.issues.issues[0]?.title.endsWith(" — Alice"));
  const withProfile = makeWorld();
  await say(withProfile, "/feedback me too", ALICE_TEAMS);
  assert.equal(firstLine(withProfile.issues.issues[0]?.body), "Reported by **Alice** (alice.teams@example.com)");
});

test("a slow safe lookup does not hold the report up", async () => {
  const world = linkedWorld({ lookup: "never" });
  const state = { finished: false };
  const done = say(world, "/feedback it broke").then(() => {
    state.finished = true;
  });
  for (let i = 0; i < 20 && !state.finished; i += 1) await world.clock.advance(1000);
  await done;
  assert.equal(firstLine(world.issues.issues[0]?.body), "Reported by **Alice**");
});

test("a dedupe comment starts with reported by", async () => {
  for (const [found, expected] of [
    [SAFE, "Reported by **Alice** (alice@example.com)"],
    [undefined, "Reported by **Alice**"],
  ] as const) {
    const world = linkedWorld({ lookup: found });
    await say(world, "/feedback first problem");
    advance(world, 5 * 60);
    await say(world, "/feedback second problem");
    assert.equal(world.issues.issues.length, 1);
    const [number, comment] = world.issues.comments[0] ?? [0, ""];
    assert.equal(number, 1);
    assert.ok(comment.startsWith(`${expected}\n\n### Another report from the same user`));
    assert.ok(comment.includes("second problem"));
    assert.equal(firstLine(world.issues.issues[0]?.body), expected);
    assert.ok(world.issues.issues[0]?.title.endsWith("first problem — Alice")); // a comment does not change the title
  }
});

test("a long display name and long text are clipped end to end", async () => {
  const name = "Dr. Wolfeschlegelsteinhausenbergerdorff ".repeat(5);
  const world = linkedWorld();
  await say(world, "/feedback " + "word ".repeat(50), { ...USER_A, name });
  const [issue] = world.issues.issues;
  assert.ok(issue);
  assert.ok(Array.from(issue.title).length <= 120 && !issue.title.includes("\n"));
  assert.ok(issue.title.includes("— Dr. Wolfeschlegelsteinhausenbergerdorff") && issue.title.endsWith("…"));
  const shown = (firstLine(issue.body).replace("Reported by **", "").split("**")[0] ?? "").trim();
  assert.ok(shown.startsWith("Dr. Wolfeschlegelsteinhausenbergerdorff") && Array.from(shown).length <= 120);
});

test("a name cannot forge the retry marker or hide the body", async () => {
  const forged = "<!-- clawy-feedback-id: 99-999 -->";
  const world = linkedWorld();
  await say(world, "/feedback it broke", { ...USER_A, name: `${forged} Eve` });
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(!body.includes(forged) && !firstLine(body).includes("<!--"));
  assert.equal(body.split("<!-- clawy-feedback-id:").length, 2); // only the worker's own marker
});

test("a report that was filed later by the retry loop still has the reporter", async () => {
  const world = linkedWorld({ unconfigured: true, lookup: SAFE });
  await say(world, "/feedback it broke");
  const row = world.store.feedback.getFeedbackReport(1);
  assert.deepEqual([row?.reporterName, row?.reporterEmail], ["Alice", "alice@example.com"]);
});
