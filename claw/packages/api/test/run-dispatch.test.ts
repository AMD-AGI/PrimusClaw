// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Persist, admit, ring a doorbell — or sit in the queue, or refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { RUN_DOORBELL_KIND } from "@claw/protocol";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { openRunCredentials } from "../src/tasks/run-secrets.js";
import { handOffAssembledRun, persistableSpec } from "../src/tasks/run-dispatch.js";

function withCrypto(): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
}

const TASK = {
  prompt: "hello",
  session_id: "s-1",
  llm_api_key: "sk-live",
  platform_key: "pk-live",
  user_env: { OPENAI_API_KEY: "sk-user" },
  session_env: { REGION: "us" },
};

test("an admitted run opens queued, rings a doorbell, and keeps keys off the payload", async () => {
  withCrypto();
  const published: Array<{ subject: string; payload: string }> = [];
  const opened: Array<Record<string, unknown>> = [];
  const result = await handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    publish: async (subject, payload) => { published.push({ subject, payload }); },
    openRun: (async (input: Record<string, unknown>) => {
      opened.push(input);
      return { taskId: "ktsk_1" };
    }) as never,
    admit: async () => ({ kind: "admit" as const }),
  });

  assert.deepEqual(result, { kind: "dispatched", taskId: "ktsk_1", messageId: "claw-1" });
  assert.equal(opened[0].status, "queued");
  assert.equal(opened[0].issueLease, false);
  const spec = opened[0].spec as Record<string, unknown>;
  assert.equal("llm_api_key" in spec, false);
  assert.equal("platform_key" in spec, false);
  assert.equal("user_env" in spec, false);
  assert.equal(typeof spec.credentials, "string");
  assert.equal((spec.credentials as string).includes("sk-live"), false);
  // session_env is the caller's environment and mcp_servers carry their own
  // auth headers, so both are sealed into the envelope rather than written to
  // the row. The claim puts them back on the request.
  assert.equal("session_env" in spec, false);
  // No substring check on the ciphertext: "us" is two characters over a
  // 64-symbol alphabet in ~144 of them, so it turns up by chance about one run
  // in twenty-nine, and the failure reads as a credential leak. The round trip
  // below is the assertion that means something anyway.
  const opened_creds = openRunCredentials(spec.credentials as string);
  assert.deepEqual(opened_creds.session_env, { REGION: "us" });

  const doorbell = JSON.parse(published[0].payload) as Record<string, unknown>;
  assert.equal(doorbell.kind, RUN_DOORBELL_KIND);
  assert.equal(doorbell.task_id, "ktsk_1");
  assert.equal("llm_api_key" in doorbell, false);
  assert.match(doorbell.claim_url as string, /\/v1\/internal\/tasks\/ktsk_1\/claim$/);
});

test("a soft-limit run is persisted queued and does not ring a doorbell", async () => {
  withCrypto();
  let published = 0;
  const result = await handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    publish: async () => { published += 1; },
    openRun: (async () => ({ taskId: "ktsk_1" })) as never,
    admit: async () => ({ kind: "queue" as const, position: 3 }),
  });
  assert.deepEqual(result, {
    kind: "queued", taskId: "ktsk_1", messageId: "claw-1", queuePosition: 3,
  });
  assert.equal(published, 0);
});

test("a hard-limit run is refused before a row is opened", async () => {
  let opened = 0;
  const result = await handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    publish: async () => {},
    openRun: (async () => { opened += 1; return { taskId: "ktsk_1" }; }) as never,
    admit: async () => ({ kind: "reject" as const, reason: "runs_hard_limit" }),
  });
  assert.deepEqual(result, { kind: "rejected", reason: "runs_hard_limit" });
  assert.equal(opened, 0);
});

test("an existing credentials blob is not sealed a second time", () => {
  withCrypto();
  const blob = persistableSpec({ ...TASK }).credentials as string;
  const again = persistableSpec({ prompt: "hello", credentials: blob });
  assert.equal(again.credentials, blob);
});

test("a publish failure closes the row that was already opened", async () => {
  withCrypto();
  const failed: Array<{ taskId: string; reason: string }> = [];
  await assert.rejects(
    () => handOffAssembledRun({
      task: { ...TASK },
      sessionId: "s-1",
      userId: "u-1",
      messageId: "claw-1",
      prompt: "hello",
      publish: async () => { throw new Error("nats down"); },
      openRun: (async () => ({ taskId: "ktsk_1" })) as never,
      // true = the row really was closed, which is what these two assert on.
      // Returning nothing would now read as "a worker holds it".
      failRun: (async (taskId: string, reason: string) => {
        failed.push({ taskId, reason });
        return "closed";
      }) as never,
      admit: async () => ({ kind: "admit" as const }),
    }),
    /nats down/,
  );
  assert.deepEqual(failed, [{ taskId: "ktsk_1", reason: "nats down" }]);
});

test("a post-insert hard exceed fails the row rather than ringing a doorbell", async () => {
  withCrypto();
  let published = 0;
  const failed: Array<{ taskId: string; reason: string }> = [];
  const result = await handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    publish: async () => { published += 1; },
    openRun: (async () => ({ taskId: "ktsk_1" })) as never,
    failRun: (async (taskId: string, reason: string) => {
      failed.push({ taskId, reason });
      return "closed";
    }) as never,
    admit: async () => ({ kind: "admit" as const }),
    hardAfterInsert: async () => "runs_hard_limit",
  });
  assert.deepEqual(result, { kind: "rejected", reason: "runs_hard_limit" });
  assert.equal(published, 0);
  assert.deepEqual(failed, [{ taskId: "ktsk_1", reason: "runs_hard_limit" }]);
});

test("an open that returns nothing is reported as open_failed, not dispatched", async () => {
  withCrypto();
  const result = await handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    publish: async () => { throw new Error("must not publish"); },
    openRun: (async () => null) as never,
    admit: async () => ({ kind: "admit" as const }),
  });
  assert.deepEqual(result, { kind: "open_failed" });
});

test("a hard limit does not refuse a turn a worker is already running", async () => {
  // The compensation declines the row because claim-next took it between the
  // insert and this recheck. Reporting `rejected` here is a rollback: the
  // caller deletes the UserMessage and answers 429, and the run then publishes
  // an AssistantMessage against a message that no longer exists.
  const result = await handOffAssembledRun({
    task: { prompt: "hi" },
    sessionId: "s1",
    userId: "u1",
    messageId: "m1",
    prompt: "hi",
    publish: async () => {},
    openRun: (async () => ({ taskId: "t1" })) as never,
    admit: (async () => ({ kind: "dispatch" })) as never,
    hardAfterInsert: (async () => "fleet at the hard ceiling") as never,
    failRun: (async () => "held") as never,
  });
  assert.deepEqual(result, { kind: "dispatched", taskId: "t1", messageId: "m1" });
});

test("a hard limit still refuses a turn nothing has started", async () => {
  const result = await handOffAssembledRun({
    task: { prompt: "hi" },
    sessionId: "s1",
    userId: "u1",
    messageId: "m1",
    prompt: "hi",
    publish: async () => {},
    openRun: (async () => ({ taskId: "t1" })) as never,
    admit: (async () => ({ kind: "dispatch" })) as never,
    hardAfterInsert: (async () => "fleet at the hard ceiling") as never,
    failRun: (async () => "closed") as never,
  });
  assert.deepEqual(result, { kind: "rejected", reason: "fleet at the hard ceiling" });
});

test("a failed doorbell publish does not unwind a run claim-next already took", async () => {
  const result = await handOffAssembledRun({
    task: { prompt: "hi" },
    sessionId: "s1",
    userId: "u1",
    messageId: "m1",
    prompt: "hi",
    publish: async () => { throw new Error("stream unavailable"); },
    openRun: (async () => ({ taskId: "t1" })) as never,
    admit: (async () => ({ kind: "dispatch" })) as never,
    hardAfterInsert: (async () => null) as never,
    failRun: (async () => "held") as never,
  });
  assert.deepEqual(result, { kind: "dispatched", taskId: "t1", messageId: "m1" });
});

test("a recheck that throws does not unwind a run claim-next already took", async () => {
  const result = await handOffAssembledRun({
    task: { prompt: "hi" },
    sessionId: "s1",
    userId: "u1",
    messageId: "m1",
    prompt: "hi",
    publish: async () => {},
    openRun: (async () => ({ taskId: "t1" })) as never,
    admit: (async () => ({ kind: "dispatch" })) as never,
    hardAfterInsert: (async () => { throw new Error("ordinal query failed"); }) as never,
    failRun: (async () => "held") as never,
  });
  assert.deepEqual(result, { kind: "dispatched", taskId: "t1", messageId: "m1" });
});

test("a compensation that could not run still refuses the turn", async () => {
  const result = await handOffAssembledRun({
    task: { prompt: "hi" },
    sessionId: "s1",
    userId: "u1",
    messageId: "m1",
    prompt: "hi",
    publish: async () => {},
    openRun: (async () => ({ taskId: "t1" })) as never,
    admit: (async () => ({ kind: "dispatch" })) as never,
    hardAfterInsert: (async () => "fleet at the hard ceiling") as never,
    failRun: (async () => "unknown") as never,
  });
  // Not `dispatched`: nothing said a worker has it, and claiming otherwise
  // would report a turn as running on the strength of a failed statement.
  assert.deepEqual(result, { kind: "rejected", reason: "fleet at the hard ceiling" });
});
