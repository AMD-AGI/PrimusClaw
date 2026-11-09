// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_LIMITS,
  Guardrails,
  SENSITIVE_OPERATIONS,
  correlationId,
  parseLimits,
  type AuditFields,
  type SecurityEventName,
} from "../../src/index.js";
import { sha256Hex } from "../../src/guardrails/sha256.js";
import { FakeClock } from "../../../../test-support/index.js";

const ALICE_AAD = "6f1c2a4e-1b2d-4c3e-9f80-1a2b3c4d5e6f";

function recorded(): {
  records: Array<{ event: SecurityEventName; fields: AuditFields }>;
  audit: (e: SecurityEventName, f: AuditFields) => void;
} {
  const records: Array<{ event: SecurityEventName; fields: AuditFields }> = [];
  return { records, audit: (event, fields) => records.push({ event, fields }) };
}

test("a limit refuses past its count and frees up as the window slides", async () => {
  const clock = new FakeClock(1_000_000);
  const { records, audit } = recorded();
  const guard = new Guardrails(clock, audit, new Map([["pr_merge", { count: 2, windowSeconds: 600 }]]));
  assert.equal(guard.take(ALICE_AAD, "pr_merge"), null);
  await clock.advance(100_000);
  assert.equal(guard.take(ALICE_AAD, "pr_merge"), null);
  const refused = guard.take(ALICE_AAD, "pr_merge");
  assert.ok(refused !== null);
  assert.equal(refused.retryAfterSeconds, 500); // the first one leaves the window at 1600
  assert.equal(guard.take("another-user", "pr_merge"), null); // per user
  assert.equal(guard.take(ALICE_AAD, "approval"), null); // per operation
  await clock.advance(500_000);
  assert.equal(guard.take(ALICE_AAD, "pr_merge"), null); // the oldest left the window
  assert.notEqual(guard.take(ALICE_AAD, "pr_merge"), null);
  const limited = records.filter((r) => r.event === "rate_limited");
  assert.equal(limited.length, 2);
  assert.deepEqual(limited[0]?.fields, {
    aad_object_id: ALICE_AAD,
    count: 2,
    limit: 2,
    operation: "pr_merge",
    reason: "user_limit",
    retry_after_seconds: 500,
    scope: "user",
    window_seconds: 600,
  });
  assert.ok(refused.text().includes("10 minutes") && refused.text().includes("Try again in 9 minutes"));
  assert.ok(refused.text("zh").includes("10 分钟内已经有 2 次合入确认"));
});

test("a refusal says the whole sentence, in both languages", () => {
  const clock = new FakeClock(0);
  const guard = new Guardrails(clock, () => undefined, new Map([["pr_review", { count: 1, windowSeconds: 3600 }]]));
  guard.take(ALICE_AAD, "pr_review");
  const refused = guard.take(ALICE_AAD, "pr_review", undefined, { repo: "o/r", pr_number: 7 });
  assert.ok(refused);
  assert.equal(
    refused.text(),
    "You have reached the limit of 1 reviews started per hour for one person, so this was not done. Try again in 60 " +
      "minutes; if you really need more, ask the operator to raise the limit.",
  );
  assert.equal(
    refused.text("zh"),
    "你在1 小时内已经有 1 次 review，达到了每人的上限，所以这次没有执行。请 60 分钟后再试；如果确实需要更多，请联系管理员调整上限。",
  );
  const other = new Guardrails(clock, () => undefined, new Map([["approval", { count: 1, windowSeconds: 90 }]]));
  other.take("p", "approval");
  const short = other.take("p", "approval");
  assert.ok(short);
  assert.ok(short.text().includes("per 90 seconds") && short.text().includes("Try again in 2 minutes;"));
  assert.ok(short.text("zh").startsWith("你在90 秒内"));
  const hours = new Guardrails(clock, () => undefined, new Map([["remote_agent", { count: 1, windowSeconds: 7200 }]]));
  hours.take("p", "remote_agent");
  assert.ok(hours.take("p", "remote_agent")?.text().includes("switches to a mode that does not ask per 2 hours"));
  const minute = new Guardrails(clock, () => undefined, new Map([["approval", { count: 1, windowSeconds: 60 }]]));
  minute.take("p", "approval");
  const once = minute.take("p", "approval");
  assert.ok(once);
  assert.ok(once.text().includes("per minute") && once.text().includes("Try again in 1 minute;"));
});

test("a limit of zero is off and the defaults are on", () => {
  const guard = new Guardrails(
    new FakeClock(0),
    () => undefined,
    new Map([["approval", { count: 0, windowSeconds: 60 }]]),
  );
  assert.ok(Array.from({ length: 1000 }, () => guard.take(ALICE_AAD, "approval")).every((r) => r === null));
  const defaults = new Guardrails(new FakeClock(0), () => undefined);
  assert.ok([...defaults.limits.values()].every((limit) => limit.count > 0));
  assert.deepEqual([...defaults.limits.keys()].sort(), Object.keys(SENSITIVE_OPERATIONS).sort());
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), Object.keys(SENSITIVE_OPERATIONS).sort());
  assert.throws(
    () => new Guardrails(new FakeClock(0), () => undefined, new Map([["merge_all", { count: 1, windowSeconds: 1 }]])),
    /no such sensitive operation: merge_all/,
  );
});

test("the limits are read from the environment and a typo stops the worker", () => {
  const env: Record<string, string> = { TEAMS_LIMIT_PR_MERGE: "5/600", TEAMS_LIMIT_APPROVAL: "0" };
  const limits = parseLimits((name) => env[name] ?? "");
  assert.deepEqual(limits.get("pr_merge"), { count: 5, windowSeconds: 600 });
  assert.equal(limits.get("approval")?.count, 0);
  assert.deepEqual(limits.get("pr_review"), DEFAULT_LIMITS.pr_review);
  assert.deepEqual(limits.get("remote_agent"), DEFAULT_LIMITS.remote_agent);
  for (const bad of ["5", "five/600", "5/0", "-1/600", "5/600/1"]) {
    assert.throws(() => parseLimits((name) => (name === "TEAMS_LIMIT_PR_REVIEW" ? bad : "")), /TEAMS_LIMIT_PR_REVIEW/);
  }
  assert.deepEqual(parseLimits((name) => (name === "TEAMS_LIMIT_REMOTE_AGENT" ? " 3 / 60 " : "")).get("remote_agent"), {
    count: 3,
    windowSeconds: 60,
  });
});

test("give back returns one count and never more than were taken", () => {
  const guard = new Guardrails(
    new FakeClock(0),
    () => undefined,
    new Map([
      ["pr_merge", { count: 1, windowSeconds: 3600 }],
      ["approval", { count: 0, windowSeconds: 60 }],
    ]),
  );
  const first = {};
  const second = {};
  assert.equal(guard.take(ALICE_AAD, "pr_merge", first), null);
  guard.giveBack(ALICE_AAD, "pr_merge", first);
  assert.equal(guard.take(ALICE_AAD, "pr_merge", second), null); // the count came back
  guard.giveBack(ALICE_AAD, "pr_merge", first); // given back already: nothing more comes back
  assert.notEqual(guard.take(ALICE_AAD, "pr_merge"), null);
  guard.giveBack("nobody", "pr_merge", {}); // nothing taken: nothing to give back, and no error
  guard.giveBack(ALICE_AAD, "approval", {}); // an operation with no limit
  guard.giveBack(ALICE_AAD, "pr_merge", undefined); // a take without a ticket is never given back
  assert.notEqual(guard.take(ALICE_AAD, "pr_merge"), null);
});

test("give back undoes its own count and never a later one that was done", async () => {
  const clock = new FakeClock(0);
  const guard = new Guardrails(clock, () => undefined, new Map([["approval", { count: 2, windowSeconds: 60 }]]));
  const failing = {};
  const done = {};
  assert.equal(guard.take(ALICE_AAD, "approval", failing), null); // at 0: slow, and fails
  await clock.advance(10_000);
  assert.equal(guard.take(ALICE_AAD, "approval", done), null); // at 10: another card, done
  await clock.advance(10_000);
  guard.giveBack(ALICE_AAD, "approval", failing); // at 20: the slow one failed
  await clock.advance(10_000);
  assert.equal(guard.take(ALICE_AAD, "approval", {}), null); // at 30: the place it gave back
  await clock.advance(31_000);
  assert.notEqual(guard.take(ALICE_AAD, "approval", {}), null); // the ones at 10 and 30 are still in the window
});

test("people idle for a whole window are forgotten past ten thousand", async () => {
  const clock = new FakeClock(0);
  const guard = new Guardrails(clock, () => undefined, new Map([["approval", { count: 5, windowSeconds: 10 }]]));
  guard.take("old", "approval");
  await clock.advance(11_000);
  for (let i = 0; i < 10_000; i++) guard.take(`p${String(i)}`, "approval");
  assert.equal(guard.remembered, 10_000);
});

test("the correlation id is the Python worker's: the first 32 hex of the sha256 of the parts", () => {
  assert.equal(correlationId("s1", "a1"), "318f2345c3bd5e8443e4160a3bb76a90");
  assert.equal(correlationId("sess", "o/r", 7), "7b4db34d07c7896d90323c827eb8695a");
  assert.equal(correlationId(null, true, "中文"), "796235c98d2157ef1fb92682163b7940");
  assert.equal(correlationId(undefined, false), correlationId("None", "False"));
  assert.equal(correlationId(), "e3b0c44298fc1c149afbf4c8996fb924");
  for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(1000), "é😀\u001f"]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
  }
});
