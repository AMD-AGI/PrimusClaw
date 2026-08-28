// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The row a chat turn now writes for itself.
 *
 * Two properties matter more than the contents of the row, and both are about
 * this being the first half of a change rather than the whole of it:
 *
 *   1. Nothing here may break a conversation. The rows are written so they can
 *      be compared against the sessions they shadow before anything depends on
 *      them; a shadow that can fail a dispatch defeats the purpose of writing
 *      it first. Every function swallows its errors, and these tests pin that.
 *   2. The rows close. An open row that outlives its run is the discrepancy
 *      that would make the second half unsafe -- the sweeper reaps by session
 *      key, and a session outlives any one turn.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  openChatRun,
  markChatRunRunning,
  closeChatRun,
  failChatRunDispatch,
  interruptUnstartedChatRuns,
  queuedMessageId,
} from "../src/tasks/chat-run.js";
import { RUN_BUDGET_DEFAULT_SEC } from "../src/tasks/run-budget.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

function stubDb(behaviour?: (sql: string) => unknown): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    const custom = behaviour?.(sql);
    if (custom) return custom;
    return { rows: [{ task_id: "ktsk_x" }], rowCount: 1 };
  }) as typeof db.query;
  return seen;
}

const INPUT = {
  sessionId: "s-1",
  userId: "u-1",
  messageId: "claw-1700000000000",
  prompt: "summarise the logs",
  workspaceId: "ws-1",
};

test("opening a run records what it is and what it owns", async () => {
  const seen = stubDb();
  const run = await openChatRun(INPUT);

  assert.ok(run?.taskId.startsWith("ktsk_"), "chat runs get the same id shape as every other row");
  // The row first, then the workspace bookkeeping that depends on having a
  // run id to reference. Order matters only in that direction; the rest of
  // the workspace statements are pinned in workspace-store.test.
  assert.match(seen[0].sql, /^INSERT INTO claw_tasks/);
  assert.ok(
    seen.slice(1).every((q) => /claw_workspace/.test(q.sql)),
    "opening a run touches its own row and the workspace it writes, nothing else",
  );

  const params = seen[0].params;
  assert.ok(params.includes("s-1"));
  assert.ok(params.includes("chat"), "origin, so the sweeper can tell this from a standalone task");
  assert.ok(params.includes("ws-1"), "workspace ownership recorded rather than inferred from paths");
  assert.ok(params.includes("preparing"));

  const metadata = JSON.parse(
    params.find((p) => typeof p === "string" && p.includes("message_id")) as string,
  );
  assert.equal(metadata.message_id, INPUT.messageId, "how Brain refers to this run");
});

test("a run bound by its caller is not bound again here", async () => {
  // The caller has to know the workspace before it writes anything, because a
  // turn that cannot be bound is refused and the refusal must leave nothing
  // behind. Looking it up a second time here would let the reference and the
  // writer claim land on a different workspace than the one the gate was told
  // about -- and the gate is what stops two runs deleting each other's files.
  const seen = stubDb();
  const run = await openChatRun({ ...INPUT, filesWorkspaceId: "kws_bound" });

  assert.equal(run?.workspaceId, "kws_bound");
  assert.ok(
    !seen.some((q) => /FROM claw_workspace_refs r/.test(q.sql)),
    "the answer was already decided; asking again is a second chance to disagree",
  );
  const ref = seen.find((q) => /^INSERT INTO claw_workspace_refs/.test(q.sql));
  assert.ok(
    ref?.params.includes("kws_bound"),
    "the reference has to name the workspace this run's gate is keyed on",
  );
});

test("the row records when it started, since nothing will transition it into starting", async () => {
  // A chat run opens at `preparing` and is never transitioned into it, so the
  // stamp transitionStatus applies on that edge never happens here. Without it
  // the row is invisible to every rule keyed on `started_at` -- including the
  // arm of the stale reaper that closes a run no worker ever claimed, which is
  // exactly the row a process that died before publishing leaves behind.
  const seen = stubDb();
  await openChatRun(INPUT);

  assert.match(
    seen[0].sql,
    /started_at/,
    "an open row with no started_at is one no reaper can match on",
  );
  assert.match(
    seen[0].sql,
    /deadline_at/,
    "and without a deadline the budget arm of that reaper cannot see it either",
  );
  assert.match(
    seen[0].sql,
    /CASE WHEN \$26::text = 'preparing' THEN NOW\(\) END/,
    "stamped from the status being inserted, not passed in by this caller",
  );
});

test("the run is handed a lease it can renew, and only the hash is kept", async () => {
  // Liveness has to be a fact the row carries rather than something inferred
  // from the queue, and the worker can only write it if it is given a token.
  const seen = stubDb();
  const run = await openChatRun(INPUT);

  assert.ok(run?.lease.url.endsWith(`/v1/internal/tasks/${run.taskId}/lease`));
  assert.match(run!.lease.token, /^[0-9a-f]{64}$/);
  assert.ok(
    !seen[0].params.includes(run!.lease.token),
    "storing the token itself would make the row a copy of the credential",
  );
  assert.ok(
    seen[0].params.some((p) =>
      typeof p === "string" && /^[0-9a-f]{64}$/.test(p) && p !== run!.lease.token),
    "the sha256 of it is what the endpoint compares against",
  );
});

test("a chat run gets no callback url with its lease", async () => {
  // The callback endpoints move rows between states and wake the scheduler.
  // These rows are still a shadow record, so the run is given the one credential
  // it needs to say "still alive" and nothing that could act on the row.
  const seen = stubDb();
  await openChatRun(INPUT);

  assert.ok(
    !seen[0].params.some((p) => typeof p === "string" && p.includes("/agent_done")),
    "a shadow row must not be drivable by the worker shadowing it",
  );
});

test("a failed insert is reported by returning null, not by throwing", async () => {
  // This function stays best-effort: it reports by returning null and lets the
  // caller decide. What the caller decides has since changed for one part of
  // it -- a turn that could not be bound to a workspace is now refused rather
  // than dispatched without file-level serialisation (see
  // requireWorkspaceBinding) -- but that decision belongs there, not here.
  stubDb(() => { throw new Error("column origin does not exist"); });
  assert.equal(await openChatRun(INPUT), null);
});

test("starting the engine moves the session's open run, and only that", async () => {
  const seen = stubDb();
  await markChatRunRunning("s-1");

  assert.match(seen[0].sql, /SET status = 'running'/);
  assert.match(seen[0].sql, /origin = 'chat'/, "must not touch DAG or standalone rows");
  assert.match(seen[0].sql, /status = 'preparing'/, "and only a row that has not moved on");
  assert.match(seen[0].sql, /deadline_at = COALESCE/,
    "COALESCE so a row that already got a deadline at insert keeps it");
  assert.equal(seen[0].params[0], "s-1");
  assert.equal(seen[0].params[1], RUN_BUDGET_DEFAULT_SEC.chat);
  assert.equal(seen[0].params[2], RUN_BUDGET_DEFAULT_SEC.dag_node);
});

test("closing prefers the run the completion event names", async () => {
  const seen = stubDb();
  await closeChatRun("s-1", "claw-42", "completed");

  assert.match(seen[0].sql, /metadata->>'message_id' = \$6/);
  assert.equal(seen[0].params[5], "claw-42");
  assert.equal(seen[0].params[2], "completed");
  assert.equal(seen[0].params[3], null, "a run that completed has no failure reason");
});

test("closing falls back to the only open run when the event names none", async () => {
  // What events from a Brain predating this look like. Closing every open row
  // was the previous fallback, and it is not safe: a session is not actually
  // one-turn-at-a-time across the queued-drain window or a forced interrupt
  // idle. The statement therefore insists there is no other open row.
  const seen = stubDb();
  await closeChatRun("s-1", undefined, "completed");
  assert.equal(seen[0].params[5], null);
  assert.match(seen[0].sql, /\$6::text IS NULL/);
  assert.match(seen[0].sql, /NOT EXISTS/,
    "two open rows are not both the run that just ended");
});

test("an interrupted run is recorded as cancelled, not failed", async () => {
  const seen = stubDb();
  await closeChatRun("s-1", "claw-42", "cancelled");
  assert.equal(seen[0].params[2], "cancelled");
});

test("a failure reason is recorded and bounded", async () => {
  const seen = stubDb();
  await closeChatRun("s-1", "claw-42", "failed", "x".repeat(5000));

  assert.equal(seen[0].params[2], "failed");
  assert.equal(
    (seen[0].params[4] as string).length, 2000,
    "failure paths are where oversized strings come from",
  );
});

test("closing nothing is reported but not thrown", async () => {
  stubDb(() => ({ rows: [], rowCount: 0 }));
  await closeChatRun("s-1", "claw-42", "completed");
});

test("a publish failure closes the row describing the run that never ran", async () => {
  const seen = stubDb();
  await failChatRunDispatch("ktsk_x", "nats unreachable");

  assert.match(seen[0].sql, /UPDATE claw_tasks SET status = 'failed'/);
  assert.deepEqual(seen[0].params, ["ktsk_x", "dispatch_failed", "nats unreachable"]);
  assert.match(
    seen[0].sql,
    /status IN \('queued','preparing','running'\)/,
    "a CAS, so a run that has since been swept or cancelled is left alone",
  );
  assert.ok(seen.some((q) => /claw_workspace_refs|workspace/i.test(q.sql)),
    "and an unclaimed row's workspace reference is handed back");
});

test("a publish failure leaves a row a Brain has already claimed alone", async () => {
  // The compensation used to be an unguarded transition, on the grounds that a
  // dispatch which failed had never run. `peekNextQueued` matches the row the
  // instant the insert commits -- before the post-insert recheck and before the
  // wakeup goes out -- so claim-next can be executing the turn by the time any
  // of those steps fails, and closing it then also hands the workspace back
  // underneath the run.
  const seen = stubDb(() => ({ rows: [], rowCount: 0 }));
  await failChatRunDispatch("ktsk_held", "nats unreachable");

  assert.match(seen[0].sql, /lease_owner IS NULL/, "the settle is holder-guarded");
  // What follows is a read, not a write: matching no row is two situations --
  // a holder, or a row already terminal -- and the caller is told which. The
  // property this test is here for is that neither of them hands the
  // workspace back under a run that may still be using it.
  assert.ok(
    seen.every((q) => !/claw_workspace/.test(q.sql)),
    "no workspace release follows a settle that matched nothing",
  );
  assert.ok(
    seen.slice(1).every((q) => /^\s*SELECT/i.test(q.sql)),
    "and nothing after the settle writes",
  );
});

test("there is nothing to close when the row was never written", async () => {
  const seen = stubDb();
  await failChatRunDispatch(null, "nats unreachable");
  assert.deepEqual(seen, []);
});

test("a queued turn is dispatched under the same id however often it is replayed", async () => {
  // The drain that sends it is not the last thing the completion handler does,
  // so a failure after publishing brings the handler back with the queued row
  // still there. The old id was `claw-<now>`, which made the replay a different
  // turn to everything downstream: a second run row, a second published task,
  // and a second transcript entry that the uniqueness on (session_id,
  // message_id) cannot see is a duplicate of the first.
  assert.equal(queuedMessageId(42), queuedMessageId(42));
});

test("two queued turns are never dispatched under one id", async () => {
  // The other half of the same property, and the reason the clock was not
  // simply given more precision: two messages drained in the same millisecond
  // used to collide, which is the same duplicate arrived at from the far side.
  assert.notEqual(queuedMessageId(42), queuedMessageId(43));
});

test("the doorbell path opens without a lease token, because claim mints it", async () => {
  const seen = stubDb();
  const run = await openChatRun({ ...INPUT, spec: { prompt: "hello" }, issueLease: false, status: "queued" });

  assert.equal(run?.lease, undefined);
  const meta = seen[0].params.find((p) => typeof p === "string" && p.includes("doorbell"));
  assert.ok(typeof meta === "string" && JSON.parse(meta).dispatch === "doorbell");
  assert.equal(
    seen[0].params.some((p) => typeof p === "string" && /^[0-9a-f]{64}$/.test(p)),
    false,
    "no hash is stored when nothing was issued",
  );
});

test("interrupt cancels a queued doorbell the worker never claimed", async () => {
  const seen = stubDb((sql) => {
    if (/SET status = 'cancelled'/.test(sql)) {
      return {
        rows: [{ task_id: "ktsk_q", message_id: "m-1", user_id: "u-1", prompt: "hi" }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  assert.equal(await interruptUnstartedChatRuns("s-1"), 1);
  assert.match(seen[0].sql, /status = 'queued'/);
  assert.match(seen[0].sql, /lease_owner IS NULL/);
});

test("Stop only reaches doorbell rows, and asks the right question about what is left", async () => {
  // A fat row sits at `preparing` with a null lease_owner for the whole of
  // delivery and the workspace wait, so the unscoped predicate cancelled runs
  // that were about to execute.
  const seen = stubDb();
  await interruptUnstartedChatRuns("s-1");
  const cancel = seen.find((q) => /SET status = 'cancelled'/.test(q.sql))?.sql ?? "";
  assert.match(cancel, /metadata->>'dispatch' = 'doorbell'/);
  assert.match(cancel, /status = 'preparing' AND lease_owner IS NULL/);
});
