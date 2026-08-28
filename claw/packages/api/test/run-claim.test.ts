// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claim hydrates a secret-free row: open the blob, mint a lease, inject live user-env.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { encryptUserEnvValue, initUserEnvCrypto } from "../src/crypto/user-env.js";
import { db } from "../src/infra/db.js";
import { claimNextRun, claimRunById, failHeldClaim, heldClaimReasonFrom, releaseClaim, runClaimPorts } from "../src/tasks/run-claim.js";
import { sealRunCredentials } from "../src/tasks/run-secrets.js";

const originalQuery = db.query;
// These tests reply to queries positionally, so the claim's history rebuild --
// several reads of its own -- would eat the replies meant for the user-env
// lookup. It is stubbed here on purpose: the real rebuild is covered against a
// real Postgres in doorbell-scenario.test.ts, where positions do not matter.
const originalBuildHistory = runClaimPorts.buildHistory;
runClaimPorts.buildHistory = (async (sessionId: string, prompt: string) => [
  { role: "user" as const, content: `rebuilt:${sessionId}:${prompt}` },
]) as typeof runClaimPorts.buildHistory;
after(() => {
  db.query = originalQuery;
  runClaimPorts.buildHistory = originalBuildHistory;
});

function withCrypto(): string {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  return sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
}

function stubQueries(
  replies: Array<() => unknown>,
): Array<{ sql: string; params: unknown[] }> {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    const reply = replies[i++];
    if (!reply) return { rows: [], rowCount: 0 };
    return reply();
  }) as typeof db.query;
  return seen;
}

function row(blob: string) {
  return {
    task_id: "ktsk_1",
    session_id: "s-1",
    status: "preparing",
    prompt: "hello",
    deadline_at: "2099-01-01T00:00:00.000Z",
    input: {
      prompt: "hello",
      session_id: "s-1",
      user_id: "u-1",
      session_env: { REGION: "us" },
      credentials: blob,
    },
  };
}

test("claim-by-id hydrates keys from the blob and issues a lease", async () => {
  const blob = withCrypto();
  stubQueries([
    () => ({ rows: [row(blob)], rowCount: 1 }),
    () => ({
      rows: [{ key_name: "OPENAI_API_KEY", key_value_enc: encryptUserEnvValue("sk-user") }],
      rowCount: 1,
    }),
  ]);

  const claimed = await claimRunById("ktsk_1", "brain-7");
  if (typeof claimed === "string") throw new Error(`expected a claim, got ${claimed}`);
  assert.equal(claimed.request.llm_api_key, "sk-live");
  assert.equal(claimed.request.platform_key, "pk-live");
  assert.equal(claimed.request.user_env?.OPENAI_API_KEY, "sk-user");
  assert.equal(claimed.request.session_env?.REGION, "us");
  assert.deepEqual(
    claimed.request.history,
    [{ role: "user", content: "rebuilt:s-1:hello" }],
    "the claim rebuilds the turn's context around the row's own prompt",
  );
  assert.ok(claimed.lease.token);
  assert.equal("credentials" in claimed.request, false);
});

test("a row whose prompt column is empty still rebuilds around the spec's prompt", async () => {
  const blob = withCrypto();
  stubQueries([() => ({ rows: [{ ...row(blob), prompt: null }], rowCount: 1 })]);

  const claimed = await claimRunById("ktsk_1", "brain-7");
  if (typeof claimed === "string") throw new Error(`expected a claim, got ${claimed}`);
  assert.deepEqual(
    claimed.request.history,
    [{ role: "user", content: "rebuilt:s-1:hello" }],
    "not an empty turn",
  );
});

test("claim-by-id only takes a chat doorbell row", async () => {
  const blob = withCrypto();
  const seen = stubQueries([
    () => ({ rows: [row(blob)], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);
  await claimRunById("ktsk_1", "brain-7");
  assert.match(seen[0].sql, /origin = 'chat'/);
  assert.match(seen[0].sql, /metadata->>'dispatch' = 'doorbell'/);
});

test("claim stamps the execution deadline, so queue wait is not spent from the budget", async () => {
  const blob = withCrypto();
  const seen = stubQueries([
    () => ({ rows: [row(blob)], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);
  await claimRunById("ktsk_1", "brain-7");
  assert.match(seen[0].sql, /deadline_at = COALESCE/);
});

test("a missing blob fails the row rather than handing a worker an empty key", async () => {
  withCrypto();
  const events: Array<Record<string, unknown>> = [];
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = (async (_sessionId, event) => {
    events.push(event);
  }) as typeof runClaimPorts.publishSessionEvent;
  try {
    const seen = stubQueries([
      () => ({
        rows: [{ ...row("x"), input: { prompt: "hello", session_id: "s-1" } }],
        rowCount: 1,
      }),
      () => ({ rows: [{ ...row("x"), input: { prompt: "hello", session_id: "s-1" }, metadata: { message_id: "m-1" } }], rowCount: 1 }),
    ]);
    assert.equal(await claimRunById("ktsk_1", "brain-7"), "unclaimable");
    assert.ok(seen.some((q) => /failure_reason = 'unclaimable'/.test(q.sql)));
    assert.ok(events.some((e) => e.type === "exec_complete" && e.failure_reason === "unclaimable"));
  } finally {
    runClaimPorts.publishSessionEvent = originalPublish;
  }
});

test("a held lease is busy, not stolen", async () => {
  stubQueries([
    () => ({ rows: [], rowCount: 0 }),
    () => ({ rows: [{ status: "preparing", lease_expires_at: "2099-01-01" }], rowCount: 1 }),
  ]);
  assert.equal(await claimRunById("ktsk_1", "brain-7"), "busy");
});

test("claim-next only looks at queued chat rows", async () => {
  const blob = withCrypto();
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
    () => ({ rows: [row(blob)], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);
  const claimed = await claimNextRun("brain-7");
  assert.ok(claimed);
  assert.match(seen[0].sql, /status = 'queued'/);
  assert.match(seen[0].sql, /origin = 'chat'/);
  assert.match(seen[0].sql, /metadata->>'dispatch' = 'doorbell'/);
  assert.equal(claimed!.request.llm_api_key, "sk-live");
});

test("unclaim returns the row to queued for the holder only", async () => {
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await releaseClaim("ktsk_1", "brain-7"), true);
  assert.match(seen[0].sql, /SET status = 'queued'/);
  assert.equal(seen[0].params[1], "brain-7");
});

test("a row that is not there is missing, not busy", async () => {
  stubQueries([
    () => ({ rows: [], rowCount: 0 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);
  assert.equal(await claimRunById("ktsk_gone", "brain-7"), "missing");
});

test("unclaim by a different brain does not move the row", async () => {
  stubQueries([() => ({ rows: [], rowCount: 0 })]);
  assert.equal(await releaseClaim("ktsk_1", "brain-other"), false);
});

test("failing a held claim ends the row instead of returning it to the queue", async () => {
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await failHeldClaim("ktsk_1", "brain-7"), true);
  assert.match(seen[0].sql, /SET status = 'failed'/);
  assert.equal(seen[0].params[2], "session_deleted");
  assert.match(seen[0].sql, /origin = 'chat'/);
  assert.equal(seen[0].params[1], "brain-7");
  assert.ok(!seen.some((q) => /SET status = 'queued'/.test(q.sql)));
});

test("a doorbell term fails the held claim as claim_abandoned, not session_deleted", async () => {
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await failHeldClaim("ktsk_1", "brain-7", "claim_abandoned"), true);
  assert.equal(seen[0].params[2], "claim_abandoned");
  assert.match(String(seen[0].params[3]), /without completing it/);
});

test("an unbound claimed run fails the row as workspace_unbound", async () => {
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await failHeldClaim("ktsk_1", "brain-7", "workspace_unbound"), true);
  assert.equal(seen[0].params[2], "workspace_unbound");
  assert.match(String(seen[0].params[3]), /not bound to a workspace/);
});

test("failing a held claim is a no-op for a brain that does not hold it", async () => {
  stubQueries([() => ({ rows: [], rowCount: 0 })]);
  assert.equal(await failHeldClaim("ktsk_1", "brain-other"), false);
});

test("fail-claim body reasons other than the held-claim set stay session_deleted", () => {
  assert.equal(heldClaimReasonFrom({ brain_id: "b", reason: "claim_abandoned" }), "claim_abandoned");
  assert.equal(heldClaimReasonFrom({ reason: "workspace_unbound" }), "workspace_unbound");
  assert.equal(heldClaimReasonFrom({ brain_id: "b" }), "session_deleted");
  assert.equal(heldClaimReasonFrom({ reason: "agent_error" }), "session_deleted");
});

test("claim-next skips an unclaimable row and takes the next chat run", async () => {
  const blob = withCrypto();
  const seen = stubQueries([
    () => ({ rows: [{ task_id: "ktsk_bad" }], rowCount: 1 }),
    () => ({
      rows: [{ ...row(""), input: { prompt: "hello", session_id: "s-1" } }],
      rowCount: 1,
    }),
    () => ({ rows: [{ ...row(""), task_id: "ktsk_bad", metadata: {} }], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
    () => ({ rows: [{ task_id: "ktsk_good" }], rowCount: 1 }),
    () => ({ rows: [{ ...row(blob), task_id: "ktsk_good" }], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);

  const claimed = await claimNextRun("brain-7");
  assert.ok(claimed);
  assert.equal(claimed.request.task_id, "ktsk_good");
  assert.equal(claimed.request.llm_api_key, "sk-live");
  assert.ok(seen.some((q) => /failure_reason = 'unclaimable'/.test(q.sql)));
  const peekAfterSkip = seen.find((q, i) => i > 2 && /NOT \(task_id = ANY/.test(q.sql));
  assert.ok(peekAfterSkip);
  assert.deepEqual(peekAfterSkip!.params[0], ["ktsk_bad"]);
});

test("too many claims fail the row as max_retries_exceeded", async () => {
  const blob = withCrypto();
  const events: Array<Record<string, unknown>> = [];
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = (async (_sessionId, event) => {
    events.push(event);
  }) as typeof runClaimPorts.publishSessionEvent;
  try {
    const seen = stubQueries([
      () => ({ rows: [{ ...row(blob), claim_count: 100 }], rowCount: 1 }),
      () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
    ]);
    const taken = await claimRunById("ktsk_1", "brain-7");
    assert.ok(seen.some((q) => /claim_count = COALESCE\(claim_count, 0\) \+ 1/.test(q.sql)));
    // The reason is a bind parameter now: the poison guard reports
    // lock_contention_exhausted when the last holder said it was waiting on a
    // lock, and max_retries_exceeded otherwise.
    const closing = seen.find((q) => /status = 'failed'/.test(q.sql) && /completed_at = NOW\(\)/.test(q.sql));
    assert.ok(closing, "the row is closed");
    assert.equal(closing?.params[1], "max_retries_exceeded");
    assert.deepEqual(taken, { kind: "exhausted", reason: "max_retries_exceeded" },
      "the caller is told the same cause the row records");
    assert.ok(events.some((e) => e.type === "exec_complete" && e.failure_reason === "max_retries_exceeded"));
  } finally {
    runClaimPorts.publishSessionEvent = originalPublish;
  }
});

test("exhausted claims put the row back when it was not actually failed", async () => {
  const blob = withCrypto();
  const events: Array<Record<string, unknown>> = [];
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = (async (_sessionId, event) => {
    events.push(event);
  }) as typeof runClaimPorts.publishSessionEvent;
  try {
    const seen = stubQueries([
      () => ({ rows: [{ ...row(blob), claim_count: 100 }], rowCount: 1 }),
      () => ({ rows: [], rowCount: 0 }),
      () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
    ]);
    assert.equal(await claimRunById("ktsk_1", "brain-7"), "busy");
    assert.equal(events.length, 0);
    assert.ok(seen.some((q) => /SET status = 'queued'/.test(q.sql)));
  } finally {
    runClaimPorts.publishSessionEvent = originalPublish;
  }
});

test("exhausted claims put the row back when marking the row throws", async () => {
  const blob = withCrypto();
  const events: Array<Record<string, unknown>> = [];
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = (async (_sessionId, event) => {
    events.push(event);
  }) as typeof runClaimPorts.publishSessionEvent;
  try {
    const seen = stubQueries([
      () => ({ rows: [{ ...row(blob), claim_count: 100 }], rowCount: 1 }),
      () => { throw new Error("db down"); },
      () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
    ]);
    assert.equal(await claimRunById("ktsk_1", "brain-7"), "busy");
    assert.equal(events.length, 0);
    assert.ok(seen.some((q) => /SET status = 'queued'/.test(q.sql)));
  } finally {
    runClaimPorts.publishSessionEvent = originalPublish;
  }
});

test("a blob that will not open fails the row instead of being retried", async () => {
  // Truncated ciphertext, which decryptUserEnvValue reports as "blob too
  // short". No retry can fix it, and releasing the claim sent it straight back
  // through claim-next to throw again -- a 500 per cycle until claim_count ran
  // out. The substring list that was meant to catch this never matched the
  // messages the decrypt helper actually raises, which is why it is a typed
  // fault now.
  withCrypto();
  const seen = stubQueries([
    () => ({
      rows: [{ ...row("x"), input: { prompt: "hello", session_id: "s-1", credentials: "not-a-blob" } }],
      rowCount: 1,
    }),
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await claimRunById("ktsk_1", "brain-7"), "unclaimable");
  assert.ok(seen.some((q) => /failure_reason = 'unclaimable'/.test(q.sql)), "the row is closed");
});

test("an unknown version byte is terminal too, not just a bad tag", async () => {
  // The cross-version case: byte 0 is reserved for key rotation, so a blob
  // sealed by a replica writing a version this build does not know must not
  // loop either.
  withCrypto();
  const badVersion = Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(40)]).toString("base64");
  const seen = stubQueries([
    () => ({
      rows: [{ ...row("x"), input: { prompt: "hi", session_id: "s-1", credentials: badVersion } }],
      rowCount: 1,
    }),
    () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
  ]);
  assert.equal(await claimRunById("ktsk_1", "brain-7"), "unclaimable");
  assert.ok(seen.some((q) => /failure_reason = 'unclaimable'/.test(q.sql)));
});

test("the claim reports the row's own claim count, not a placeholder", () => {
  // Producer-side coverage for the generation guard. Every brain-side test
  // stubs the claim response, so nothing pinned the API line that puts the
  // real count into it: replace `claimCountOf(row)` with a constant and the
  // whole suite stayed green, while in production every later unclaim would
  // carry a generation that matches no row and be refused as stale.
  withCrypto();
  return (async () => {
    const blob = withCrypto();
    stubQueries([
      () => ({ rows: [{ ...row(blob), claim_count: 6 }], rowCount: 1 }),
      () => ({ rows: [], rowCount: 0 }),
    ]);
    const taken = await claimRunById("ktsk_1", "brain-7");
    assert.ok(typeof taken !== "string" && !("kind" in taken), "a claim, not a refusal");
    assert.equal((taken as { claimCount: number }).claimCount, 6);
  })();
});

test("a budget spent waiting on a lock is reported as that, not as generic retries", () => {
  // Producer-side coverage for the reason the poison guard picks. The test
  // above pins the max_retries_exceeded branch, which is also what a neutered
  // `exhaustionReasonOf` returns -- so only this one can tell the two apart.
  const blob = withCrypto();
  const events: Array<Record<string, unknown>> = [];
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = (async (_s, e) => { events.push(e); }) as typeof runClaimPorts.publishSessionEvent;
  return (async () => {
    try {
      const seen = stubQueries([
        () => ({
          rows: [{
            ...row(blob),
            claim_count: 100,
            metadata: { message_id: "m-1", last_release: "lock_contention" },
          }],
          rowCount: 1,
        }),
        () => ({ rows: [{ task_id: "ktsk_1" }], rowCount: 1 }),
      ]);
      const taken = await claimRunById("ktsk_1", "brain-7");
      assert.deepEqual(taken, { kind: "exhausted", reason: "lock_contention_exhausted" });
      const closing = seen.find((q) => /status = 'failed'/.test(q.sql) && /completed_at = NOW\(\)/.test(q.sql));
      assert.equal(closing?.params[1], "lock_contention_exhausted", "and the row records it too");
      assert.ok(events.some((e) => e.failure_reason === "lock_contention_exhausted"),
        "and the reader is told the same");
    } finally {
      runClaimPorts.publishSessionEvent = originalPublish;
    }
  })();
});
