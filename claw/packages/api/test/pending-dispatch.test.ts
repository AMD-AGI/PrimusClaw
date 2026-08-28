// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Replaying a turn that had to wait.
 *
 * The immediate dispatch path has had tests since it got a row (see
 * chat-run-rows.test.ts); the replay path had none, because it lived inside an
 * event handler that wants a NATS connection, a marketplace, an LLM and a
 * skill store before it reaches the interesting part. What went untested was
 * not the payload -- it is the same payload -- but the ordering: which of the
 * row, the binding, the publish and the queue delete happens when, and what is
 * left behind when the step after the next one throws.
 *
 * Coverage:
 *   P1 the row exists before the message does
 *   P2 the lease travels with the turn
 *   P3 the turn names the files it writes, and says it was required to
 *   P3b a replayed turn is published under the same id, so the stream sees one
 *   P4 an unbindable turn is refused before anything is opened for it
 *   P5 a refusal that does not clear is abandoned, visibly, and stops retrying
 *   P5b a queue row that has already gone is not replayed and not retried
 *   P5c the abandoned turn is one the user can see end, and the queue moves on
 *   P5d one attempt below the bound is still a retry
 *   P5e a counter that cannot be read retries rather than abandons
 *   P5f a refusal with no run row keeps the message queued
 *   P5g a counter that never answers still stops eventually
 *   P5h a refusal whose run row never opens stops at the second ceiling
 *   P6 the queue row survives a failed publish
 *   P6b a publish that only timed out keeps its row, because it may have landed
 *   P7 a published turn clears the queue row, then marks the session running
 *   P8 a row that could not be opened does not publish
 *   P9 a turn that cannot be serialised is a publish that certainly failed
 *   P10 a doorbell replay publishes a wakeup, not the execute request
 *   P11 a queued doorbell replay does not publish, and still clears the pending row
 *   P12 a hard admission refusal abandons the pending row
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  dispatchPendingMessage,
  pendingDispatchPorts,
} from "../src/tasks/pending-dispatch.js";
import { RUN_DOORBELL_KIND } from "@claw/protocol";
import { randomBytes } from "node:crypto";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";

const originalQuery = db.query;
const originalPorts = { ...pendingDispatchPorts };

afterEach(() => {
  db.query = originalQuery;
  Object.assign(pendingDispatchPorts, originalPorts);
});

interface Recorder {
  calls: string[];
  sql: Array<{ text: string; params: unknown[] }>;
  published: Array<{ subject: string; task: Record<string, unknown>; msgId: string }>;
  failed: Array<{ runId: string | null; reason: string; failureReason?: string }>;
  opened: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

/**
 * Wire up every collaborator to record instead of act.
 *
 * `calls` is a single ordered list across all of them, because the ordering
 * between the row, the publish and the delete is the whole subject here and
 * per-collaborator counters cannot express it.
 */
function harness(opts: {
  run?: { taskId: string; workspaceId?: string; lease: { url: string; token: string } } | null;
  publishThrows?: Error;
  /** What the workspace lookup answers; absent means it could not be bound. */
  bound?: string;
  /** What the attempt counter on the queue row has reached, once counted. */
  bindAttempts?: number;
  /** What the counting statement itself does, when it does not answer. */
  countThrows?: Error;
  /** What the queue row's delete does, when the database refuses it. */
  deleteThrows?: Error;
} = {}): Recorder {
  const rec: Recorder = {
    calls: [], sql: [], published: [], failed: [], opened: [], events: [],
  };
  const run = opts.run === undefined
    ? { taskId: "ktsk_1", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t0ken" } }
    : opts.run;

  pendingDispatchPorts.openChatRun = (async (args: Record<string, unknown>) => {
    rec.calls.push("open");
    rec.opened.push(args);
    return run;
  }) as unknown as typeof pendingDispatchPorts.openChatRun;

  pendingDispatchPorts.publishSessionEvent = (async (
    _sessionId: string, event: Record<string, unknown>,
  ) => {
    rec.calls.push("event");
    rec.events.push(event);
  }) as unknown as typeof pendingDispatchPorts.publishSessionEvent;

  pendingDispatchPorts.bindWorkspace = (async () => {
    rec.calls.push("lookup");
    return "bound" in opts ? opts.bound : "kws_1";
  }) as typeof pendingDispatchPorts.bindWorkspace;

  pendingDispatchPorts.requireWorkspaceBinding = ((workspaceId?: string) => {
    rec.calls.push("bind");
    if (!workspaceId) throw new Error("workspace_binding_required");
    return workspaceId;
  }) as typeof pendingDispatchPorts.requireWorkspaceBinding;

  pendingDispatchPorts.publish = (async (subject: string, payload: string, msgId: string) => {
    rec.calls.push("publish");
    if (opts.publishThrows) throw opts.publishThrows;
    rec.published.push({ subject, task: JSON.parse(payload), msgId });
  }) as typeof pendingDispatchPorts.publish;

  pendingDispatchPorts.failChatRunDispatch = (async (
    runId: string | null, reason: string, failureReason?: string,
  ) => {
    rec.calls.push("fail");
    rec.failed.push({ runId, reason, ...(failureReason ? { failureReason } : {}) });
  }) as typeof pendingDispatchPorts.failChatRunDispatch;

  db.query = (async (text: string, params: unknown[] = []) => {
    if (/bind_attempts = bind_attempts \+ 1/.test(text)) {
      rec.calls.push("count-attempt");
      rec.sql.push({ text, params });
      if (opts.countThrows) throw opts.countThrows;
      return opts.bindAttempts === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ bind_attempts: opts.bindAttempts }], rowCount: 1 };
    }
    const isDelete = /DELETE/.test(text);
    rec.calls.push(isDelete ? "delete-pending" : "mark-running");
    rec.sql.push({ text, params });
    if (isDelete && opts.deleteThrows) throw opts.deleteThrows;
    return { rows: [], rowCount: 1 };
  }) as typeof db.query;

  return rec;
}

/** A publish error the server sent back, as opposed to one that timed out. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: "503" });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s-1",
    pendingId: 42,
    userId: "u-1",
    messageId: "claw-1700000000000",
    prompt: "carry on",
    workspaceId: "kws_1",
    task: { session_id: "s-1", prompt: "carry on" } as Record<string, unknown>,
    ...overrides,
  };
}

test("P1 the row exists before the message does", async () => {
  const rec = harness();
  await dispatchPendingMessage(input());
  assert.ok(
    rec.calls.indexOf("open") < rec.calls.indexOf("publish"),
    "a publish that beats the row leaves a run nothing can reclaim",
  );
  assert.ok(
    rec.calls.indexOf("bind") < rec.calls.indexOf("open"),
    "and a row that beats the binding is a row per retry of a refusal that may never clear",
  );
});

test("P2 the lease travels with the turn", async () => {
  const rec = harness();
  await dispatchPendingMessage(input());
  assert.deepEqual(rec.published[0].task.run_lease, { url: "http://api/lease", token: "t0ken" });
});

test("P3 the turn names the files it writes, and says it was required to", async () => {
  const rec = harness();
  await dispatchPendingMessage(input());
  const sent = rec.published[0].task;
  assert.equal(sent.files_workspace_id, "kws_1");
  assert.equal(
    sent.files_workspace_required, true,
    "without the flag a Brain that cannot bind treats this like an old-API message and runs it anyway",
  );
});

test("P3b the turn is published under the queue row's id, so a replay is one turn", async () => {
  // The drain is not atomic: publishing is followed by the queue delete, and a
  // failure after the publish brings the whole handler back with the queue row
  // still there. Published anonymously, the second attempt is a second task --
  // the transcript's uniqueness recognises it afterwards, which is after the
  // model has run twice and its tools have done whatever they do, twice.
  const rec = harness();
  const messageId = "claw-pending-42";
  await dispatchPendingMessage(input({ messageId }));
  await dispatchPendingMessage(input({ messageId }));

  assert.deepEqual(
    rec.published.map((p) => p.msgId), [messageId, messageId],
    "both attempts have to claim the same identity for the stream to see one",
  );
});

test("P4 an unbindable turn is refused before anything is opened for it", async () => {
  // A run whose files are not named falls back to the session gate key, where two
  // runs over one directory delete each other's work -- so the refusal is right.
  // What it must not do is leave the run half-begun: the refusal goes back to a
  // consumer that naks and comes again, and anything written on the way to it is
  // written once per attempt.
  const rec = harness({ bound: undefined, bindAttempts: 1 });

  await assert.rejects(
    () => dispatchPendingMessage(input()),
    /workspace_binding_required/,
  );

  assert.deepEqual(rec.calls, ["lookup", "bind", "count-attempt"]);
  assert.equal(rec.published.length, 0, "an unbound run must not reach the queue");
  assert.deepEqual(rec.failed, [], "there is no row yet, so there is nothing to fail");
  assert.ok(!rec.calls.includes("delete-pending"), "and the message is still queued for the retry");
});

test("P5 a refusal that does not clear is abandoned, visibly, and stops retrying", async () => {
  // Retrying for ever is not patience here: the failure comes back through a
  // consumer with no delivery ceiling, and each pass re-runs the completion
  // handler's memory insert and profile call as well. Past the bound the message
  // is dropped -- so it has to leave a record of having been dropped, filed under
  // the reason the DAG path uses for the same refusal.
  const rec = harness({ bound: undefined, bindAttempts: 6, run: { taskId: "ktsk_9", lease: { url: "u", token: "t" } } });

  const result = await dispatchPendingMessage(input());

  assert.deepEqual(result, { runId: null }, "the caller must not be asked to retry this");
  assert.deepEqual(rec.failed, [{
    runId: "ktsk_9",
    reason: "workspace_binding_required",
    failureReason: "workspace_bind_failed",
  }]);
  assert.ok(
    rec.calls.includes("delete-pending"),
    "left queued, the next completion event on this session picks it up again ahead of newer messages",
  );
  assert.deepEqual(
    rec.sql[0].params, [42],
    "the row counted has to be the row being replayed, or the bound is counted against someone else",
  );
  assert.equal(
    rec.opened[0].recordWorkspaceUse, false,
    "the binding was just refused, so asking the same database for it again buys nothing",
  );
});

test("P5c the abandoned turn is one the user can see end", async () => {
  // The queued message's own turn is only written when that turn completes, so
  // without a completion the message the user sent leaves no trace anywhere
  // they can read -- no reply, no error, nothing. The completion is also what
  // drives the drain: the queue behind this message moves on the next
  // exec_complete for the session and on nothing else.
  const rec = harness({ bound: undefined, bindAttempts: 6 });

  await dispatchPendingMessage(input());

  const types = rec.events.map((e) => e.type);
  assert.deepEqual(types, ["AssistantMessage", "ResultMessage", "exec_complete"]);
  const complete = rec.events[2];
  assert.equal(complete.failed, true);
  assert.equal(complete.failure_reason, "workspace_bind_failed");
  assert.equal(
    complete.prompt, "carry on",
    "the completion writes the user's turn, so it has to carry what they said",
  );
  assert.ok(
    rec.calls.indexOf("event") < rec.calls.indexOf("delete-pending"),
    "publishing can throw, and the other order deletes the queue row and closes the run "
    + "with no completion behind them: the turn is never written, so the message the user "
    + "sent is gone from everywhere they can read and from the queue that would retry it",
  );
});

test("P5d one attempt below the bound is still a retry", async () => {
  // The boundary is the whole value of the counter: one off in either
  // direction is either a message dropped on the first database hiccup or the
  // unbounded loop it was added to stop.
  const rec = harness({ bound: undefined, bindAttempts: 5 });

  await assert.rejects(() => dispatchPendingMessage(input()), /workspace_binding_required/);

  assert.deepEqual(rec.failed, [], "nothing is given up on yet");
  assert.ok(!rec.calls.includes("delete-pending"), "and the message is still queued");
  assert.deepEqual(rec.events, [], "a turn that will be retried has not ended");
});

test("P5e a counter that cannot be read retries rather than abandons", async () => {
  // The column arrives by a migration that is allowed to fail, so a deployment
  // can reach this line without it. Raising here would escape into a consumer
  // that naks every ten seconds for ever -- the exact loop the counter exists
  // to stop, and unconditional for every refused binding.
  const rec = harness({ bound: undefined, countThrows: new Error("column bind_attempts does not exist") });

  await assert.rejects(() => dispatchPendingMessage(input()), /workspace_binding_required/);

  assert.deepEqual(rec.failed, [], "an uncountable attempt cannot be the last one");
  assert.ok(!rec.calls.includes("delete-pending"));
});

test("P5f a refusal with no run row keeps the message queued", async () => {
  // The run row is the only record the refusal leaves that anyone queries.
  // Deleting the queue row without one drops the user's message with a log
  // line as the sole trace -- and an unhealthy database, which is the usual
  // reason a binding is refused at all, is exactly when the insert fails too.
  const rec = harness({ bound: undefined, bindAttempts: 6, run: null });

  await assert.rejects(() => dispatchPendingMessage(input()), /workspace_binding_required/);

  assert.ok(
    !rec.calls.includes("delete-pending"),
    "the message has to survive for the next redelivery to try again",
  );
  assert.deepEqual(rec.failed, [], "there is no row to record the reason on");
  assert.deepEqual(rec.events, [], "and no turn was ended, because none was recorded");
});

test("P5g a counter that never answers still stops eventually", async () => {
  // The retry P5e asks for costs a redelivery that nobody limits, and the
  // handler it comes back into re-runs the completion from the top -- the turn
  // record, the memory write, the profile update, the summary and memory
  // extraction that call an LLM. Unbounded, that is the loop the counter was
  // added to stop, running on the one path the counter cannot see.
  const rec = harness({
    bound: undefined,
    countThrows: new Error("canceling statement due to statement timeout"),
  });
  const pendingId = 7001;

  // Twice the ordinary bound, so the message gets the retries it is owed first.
  for (let i = 0; i < 11; i++) {
    await assert.rejects(() => dispatchPendingMessage(input({ pendingId })));
  }
  assert.deepEqual(rec.events, [], "nothing has been given up on yet");

  const result = await dispatchPendingMessage(input({ pendingId }));

  assert.deepEqual(result, { runId: null }, "the caller must not be asked to retry this");
  assert.deepEqual(
    rec.events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"],
    "and the turn ends where the user can see it, like any other abandonment",
  );
  assert.ok(rec.calls.includes("delete-pending"));
});

test("P5h a refusal whose run row never opens stops at the second ceiling", async () => {
  // P5f is right to keep the message queued: the run row is the record an
  // operator queries, and a database that cannot write one is one that may be
  // able to a moment later. It cannot be right for ever, though -- the same
  // unbounded redelivery is behind it -- so past the second ceiling the turn is
  // ended on the log line and the session events alone.
  const rec = harness({ bound: undefined, bindAttempts: 12, run: null });

  const result = await dispatchPendingMessage(input({ pendingId: 7002 }));

  assert.deepEqual(result, { runId: null });
  assert.deepEqual(rec.failed, [], "there was no row to record the reason on");
  assert.deepEqual(
    rec.events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"],
    "the user still sees the turn end, which is the trace that matters most",
  );
  assert.ok(rec.calls.includes("delete-pending"), "and the queue stops replaying it");
});

test("P5i a delete refused after the events is recorded rather than raised", async () => {
  // Raising it multiplies. The nak brings this message back to the same row, and
  // the exec_complete just published brings a drain of the session to that row
  // as well, so every round leaves two successors for as long as the database
  // refuses the delete. By this point the refusal is already recorded -- the
  // turn is written and the run row is terminal -- so the caller is told to
  // stop, and the row is left for one drain to refuse again cheaply.
  const rec = harness({
    bound: undefined, bindAttempts: 6, deleteThrows: new Error("deadlock detected"),
  });

  const result = await dispatchPendingMessage(input({ pendingId: 7003 }));

  assert.deepEqual(result, { runId: null }, "asking for the message again is the amplification");
  assert.deepEqual(
    rec.events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"],
    "and the user's trace of the turn is unaffected by the row that would not go",
  );
  assert.ok(rec.calls.includes("delete-pending"), "the delete is attempted, and its failure kept");
});

test("P5b a queue row that has already gone is not replayed and not retried", async () => {
  // Another drain took it. Counting the attempt returns no row, and asking for
  // another attempt would only find the same absence ten seconds later.
  const rec = harness({ bound: undefined });

  assert.deepEqual(await dispatchPendingMessage(input()), { runId: null });
  assert.deepEqual(rec.failed, []);
  assert.ok(!rec.calls.includes("open"), "there is nothing left to open a run for");
});

test("P6 the queue row survives a failed publish", async () => {
  // Delete-then-publish loses the message outright when NATS is down, which is
  // the failure this ordering exists to prevent: the retry has to find the row
  // still there.
  const rec = harness({ publishThrows: refusal("no responders") });
  await assert.rejects(() => dispatchPendingMessage(input()), /no responders/);
  assert.ok(
    !rec.calls.includes("delete-pending"),
    "the queue row was deleted for a message that never went out",
  );
  assert.deepEqual(rec.failed, [{ runId: "ktsk_1", reason: "no responders" }]);
});

test("P6b a publish that only timed out keeps its row", async () => {
  // A publish is a request and a reply, so a timeout says the reply is missing,
  // not the message. The retry republishes under the same id and the stream
  // drops it as a duplicate -- meaning the first copy is the one that runs, and
  // it runs against this row. Failed here, that worker is refused on its first
  // heartbeat and the turn is lost rather than merely repeated.
  const rec = harness({ publishThrows: new Error("TIMEOUT") });
  await assert.rejects(() => dispatchPendingMessage(input()), /TIMEOUT/);
  assert.deepEqual(
    rec.failed, [],
    "a row whose turn may be running cannot be marked failed",
  );
  assert.ok(
    !rec.calls.includes("delete-pending"),
    "and the queue row stays, because the retry is what makes the duplicate id work",
  );
});

test("P7 a published turn clears the queue row, then marks the session running", async () => {
  const rec = harness();
  const result = await dispatchPendingMessage(input());

  assert.deepEqual(
    rec.calls,
    ["lookup", "bind", "open", "publish", "delete-pending", "mark-running"],
  );
  assert.equal(result.runId, "ktsk_1");
  assert.deepEqual(rec.sql[0].params, [42], "the row deleted is the one that was replayed");
  assert.match(rec.sql[1].text, /agent_status = 'running'/);
  assert.match(
    rec.sql[1].text, /deleted_at IS NULL/,
    "a session deleted mid-replay must not be resurrected as running",
  );
});

test("P8 a row that could not be opened does not publish", async () => {
  // Publishing without a row leaves a session running with no lease and no
  // deadline -- a worse failure than retrying. The queue row stays, so the
  // outer nak can try the insert again.
  const rec = harness({ run: null });

  await assert.rejects(
    () => dispatchPendingMessage(input()),
    (err: Error) => err.message === "chat_run.open_failed",
  );

  assert.equal(rec.published.length, 0, "an untracked message is worse than a retry");
  assert.ok(!rec.calls.includes("delete-pending"), "the queue row stays for the retry");
  assert.deepEqual(rec.calls, ["lookup", "bind", "open"]);
});

test("P9 a turn that cannot be serialised is a publish that certainly failed", async () => {
  // The flag means "this may have reached the server", and serialising happens
  // strictly before anything is sent. Set before the JSON.stringify, a payload
  // that would not serialise read as publish uncertainty: the row was left for
  // a redelivery that would find no message on the stream and nothing to close
  // it with, so it sat open until the lease reaper eventually noticed.
  const rec = harness();
  const circular: Record<string, unknown> = { session_id: "s-1" };
  circular.self = circular;

  await assert.rejects(() => dispatchPendingMessage(input({ task: circular })));

  assert.ok(!rec.calls.includes("publish"), "nothing was sent, and nothing could have been");
  assert.deepEqual(
    rec.failed.map((f) => f.runId), ["ktsk_1"],
    "so the row is closed here, where there is still something that can close it",
  );
});

function enableDoorbellCrypto(): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  pendingDispatchPorts.doorbellDispatch = true;
}

test("P10 a doorbell replay publishes a wakeup, not the execute request", async () => {
  enableDoorbellCrypto();
  pendingDispatchPorts.admit = async () => ({ kind: "admit" });
  const rec = harness();
  await dispatchPendingMessage(input({
    task: { session_id: "s-1", prompt: "carry on", llm_api_key: "sk-live" },
  }));

  assert.equal(rec.opened[0].status, "queued");
  assert.equal(rec.opened[0].issueLease, false);
  assert.equal(rec.published.length, 1);
  assert.equal(rec.published[0].task.kind, RUN_DOORBELL_KIND);
  assert.equal("llm_api_key" in rec.published[0].task, false);
  assert.ok(rec.calls.includes("delete-pending"));
});

test("P11 a queued doorbell replay does not publish, and still clears the pending row", async () => {
  enableDoorbellCrypto();
  pendingDispatchPorts.admit = async () => ({ kind: "queue", position: 2 });
  const rec = harness();
  const result = await dispatchPendingMessage(input());
  assert.equal(result.runId, "ktsk_1");
  assert.equal(rec.published.length, 0);
  assert.ok(rec.calls.includes("delete-pending"));
  assert.ok(rec.calls.includes("mark-running"));
});

test("P12 a hard admission refusal abandons the pending row", async () => {
  pendingDispatchPorts.doorbellDispatch = true;
  pendingDispatchPorts.admit = async () => ({ kind: "reject", reason: "runs_hard_limit" });
  const rec = harness();
  const result = await dispatchPendingMessage(input());
  assert.equal(result.runId, null);
  assert.equal(rec.published.length, 0);
  assert.ok(!rec.calls.includes("open"), "admission reject must not open a bind-abandon row");
  assert.ok(rec.calls.includes("event"), "the user has to see the turn end");
  assert.ok(rec.calls.includes("delete-pending"));
  assert.ok(rec.events.some((e) => e.type === "exec_complete" && e.failure_reason === "runs_hard_limit"));
});

