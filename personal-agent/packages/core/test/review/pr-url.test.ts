// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The pull request address a review's progress and result show (`shownPrUrl`): Claw's `pr_url` only when the whole string is a
 * github.com pull request address, else the address of the pull request the request named. The cases are the ones the Python
 * worker's tests read, result for result.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { requesterResultText, shownPrUrl } from "../../src/review/progress.js";
import { reviewTurn } from "../../src/review/review-turn.js";

interface Case {
  readonly pr_url: string;
  readonly shown: boolean;
  readonly result: string;
}

const shared = JSON.parse(readFileSync(new URL("./data/pr-url-cases.json", import.meta.url), "utf8")) as {
  readonly named: string;
  readonly cases: readonly Case[];
};
const PULL = { owner: "AMD-AGI", repo: "Hyperloom", number: 12 };

test("claw's address is shown only when it is exactly a pull request's, as the python worker shows it", () => {
  assert.ok(shared.cases.length > 0);
  for (const c of shared.cases) {
    assert.equal(shownPrUrl(c.pr_url, PULL), c.result, JSON.stringify(c.pr_url));
    assert.equal(c.result === c.pr_url, c.shown, JSON.stringify(c.pr_url));
  }
});

test("an address with a second link in it never reaches the asker's line", () => {
  const review = reviewTurn({
    pull: PULL,
    requesterId: "aad-a",
    requesterName: "Alice",
    actorId: "aad-b",
    actorUserId: "u-bob",
    actorName: "Bob",
    actorChannelId: "29:b",
  });
  const said = requesterResultText(review, {
    itemId: "item-1",
    status: "done",
    prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12\nhttps://evil.example/phish",
    verdict: "approve",
    merged: true,
    waitingFor: "",
    findings: null,
    note: "",
    prSummary: "",
  });
  assert.ok(!said.includes("evil.example"), said);
  assert.ok(said.split("\n").includes(shared.named), said);
});
