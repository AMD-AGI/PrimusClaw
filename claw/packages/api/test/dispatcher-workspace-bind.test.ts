// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A DAG node whose workspace could not be bound.
 *
 * The refusal is correct -- a run dispatched without a workspace takes a gate
 * key that lets siblings over one directory overwrite each other -- but ending
 * the task on it was not. A DAG node has no retry of its own: `retryTask`
 * rejects anything carrying a `dag_root_task_id` and `cascadeFailures` marks
 * every downstream row `deps_failed`, so a database that was away for a moment
 * cost the whole graph, unrecoverably, with `agent_error` on the row as the
 * only explanation of why.
 *
 * Coverage:
 *   B1 a binding failure puts the task back on the queue
 *   B2 the requeued row does not read as one that has already failed
 *   B3 past the window the task fails, with a reason of its own
 *   B4 every other dispatch failure is still terminal, and still agent_error
 *   B5 a binding that times out is retried like any other binding failure
 *   B6 a dispatched DAG run holds a reference to the files it writes
 *   B7 the run that took it does not claim the write side at dispatch time
 *   B8 a refused publish fails the row; one that only went quiet leaves it open
 *   B9 a payload that will not serialise is a publish that certainly failed
 *   B10 a queued chat doorbell is put back without moving a claimed lease
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";

// The stage timeout has to be reachable without waiting the shipped fifteen
// seconds for one, and the dispatcher reads it once at import. Long enough that
// the stages which answer immediately below are never caught by it.
process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
const originalPublish = taskPublisher.publish;
after(() => {
  db.query = originalQuery;
  taskPublisher.publish = originalPublish;
});

/** A status change on a task row: `UPDATE ... SET status = $1 ... status = ANY($n)`. */
const STATUS_WRITE = /^UPDATE claw_tasks SET status/;

function taskRow(startedAt: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "ktsk_1",
    session_id: "s-1",
    dag_id: "dag-1",
    dag_node_id: "node-a",
    dag_root_task_id: "ktsk_root",
    status: "preparing",
    started_at: startedAt,
    prompt: null,
    script: null,
    sandbox_spec: null,
    input,
    metadata: {},
    depends_on: [],
    mode: "llm",
  };
}

type DbAnswer = () => Promise<{ rows: unknown[]; rowCount: number }>;

/** The default: the database the workspace rows live in has gone away. */
const WORKSPACE_UNREACHABLE: DbAnswer = () => {
  throw new Error("terminating connection due to administrator command");
};

/** The session has a workspace, so the dispatch reaches the publish. */
const WORKSPACE_BOUND: DbAnswer = async () => ({
  rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }],
  rowCount: 1,
});

/**
 * Everything the dispatcher reads answers, except the workspace, which behaves
 * however the caller asks -- by default the way an unreachable database
 * behaves, which the store swallows into "no workspace could be recorded".
 */
function stubDb(
  startedAt: string,
  workspace: DbAnswer = WORKSPACE_UNREACHABLE,
  input: Record<string, unknown> = {},
  rowPatch: Record<string, unknown> = {},
): SeenQuery[] {
  const seen: SeenQuery[] = [];
  const row = () => ({ ...taskRow(startedAt, input), ...rowPatch });
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (/claw_workspace/.test(sql)) return workspace();
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [row()], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row()], rowCount: 1 };
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      // A session carrying its submitter's key, which is what every entry point
      // now stamps before queueing a task. An empty config here used to dispatch
      // anyway, under the cluster's shared identity.
      return { rows: [{ user_id: "u-1", config: SERVER_MANAGED_CONFIG }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return seen;
}

/**
 * A session config as the entry points write it: the submitter's platform key,
 * marked server-managed so the dispatcher will trust it.
 */
const SERVER_MANAGED_CONFIG = {
  platform_key: "pk-user-1",
  _server_managed_credentials: true,
};

/** The status transitions attempted, in order, read as `from -> to`. */
function transitions(seen: SeenQuery[]): string[] {
  return seen
    .filter((q) => STATUS_WRITE.test(q.sql))
    .map((q) => `${(q.params[q.params.length - 1] as string[]).join("|")} -> ${String(q.params[0])}`);
}

test("B1 a binding failure puts the task back on the queue", async () => {
  const seen = stubDb(new Date().toISOString());

  const result = await dispatchTask("ktsk_1");

  assert.equal(result.ok, false);
  assert.deepEqual(
    transitions(seen),
    ["queued -> preparing", "preparing -> queued"],
    "the row goes back to where the scheduler will pick it up again, and nowhere else",
  );
  assert.ok(
    !transitions(seen).some((t) => t.endsWith("-> failed")),
    "a node failed here takes its whole downstream with it and cannot be retried",
  );
});

test("B2 the requeued row does not read as one that has already failed", async () => {
  const seen = stubDb(new Date().toISOString());
  await dispatchTask("ktsk_1");

  const requeue = seen.filter((q) => STATUS_WRITE.test(q.sql)).at(-1)!;
  assert.equal(requeue.params[0], "queued");
  assert.ok(
    requeue.params.includes(null),
    "a queued row carrying a failure_reason reads as one that has given up",
  );
  assert.ok(
    requeue.params.some((p) => typeof p === "string" && /refusing to dispatch/.test(p)),
    "the reason it is cycling has to be on the row, or it looks like a task that is simply slow",
  );
});

test("B3 past the window the task fails, with a reason of its own", async () => {
  // Retrying has to end somewhere: past the window the cause is an outage rather
  // than a blip, and a task that cycles until someone notices is worse than one
  // that says what happened. Ten minutes is past any window an operator would
  // configure, so this does not depend on the default.
  const seen = stubDb(new Date(Date.now() - 10 * 60_000).toISOString());

  await dispatchTask("ktsk_1");

  const final = seen.filter((q) => STATUS_WRITE.test(q.sql)).at(-1)!;
  assert.equal(final.params[0], "failed");
  assert.ok(
    final.params.includes("workspace_bind_failed"),
    "no agent ran, so calling it agent_error sends whoever reads it to the wrong place",
  );
});

test("B4 every other dispatch failure is still terminal, and still agent_error", async () => {
  // The retry is for the one failure that is worth another attempt. Widening it
  // by accident would have the scheduler cycling on unrenderable templates.
  const seen = stubDb(new Date().toISOString());
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [taskRow(new Date().toISOString())], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) {
      return { rows: [taskRow(new Date().toISOString())], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  const result = await dispatchTask("ktsk_1");

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /session s-1 not found/);
  const final = seen.filter((q) => STATUS_WRITE.test(q.sql)).at(-1)!;
  assert.equal(final.params[0], "failed");
  assert.ok(final.params.includes("agent_error"));
});

test("B5 a binding that times out is retried like any other binding failure", async () => {
  // The same failure twice over: a database that is unwell has the store
  // swallowing the error and answering null, and one that is unwell enough to
  // stop answering has the stage timeout firing instead. Only the second used
  // to escape as a plain Error, which failed the node -- and a failed node
  // takes its whole downstream with it and cannot be retried.
  const seen = stubDb(new Date().toISOString(), () => new Promise<never>(() => {}));

  await dispatchTask("ktsk_1");

  assert.deepEqual(
    transitions(seen),
    ["queued -> preparing", "preparing -> queued"],
    "a timeout is transient, so the row goes back to the scheduler like any other",
  );
});

test("B6 a dispatched DAG run holds a reference to the files it writes", async () => {
  // Without it, only the session referenced the workspace, and a session whose
  // reference is released -- by an idle sweep, or by being deleted -- left the
  // files of a DAG run that is still writing them unreferenced, which is the
  // collector's permission to take them. The publish is out of reach here (no
  // NATS connection in a unit test), so what is pinned is the reference being
  // recorded before the message goes out rather than after.
  const seen = stubDb(new Date().toISOString(), WORKSPACE_BOUND);

  await dispatchTask("ktsk_1");

  const ref = seen.find((q) => /^INSERT INTO claw_workspace_refs/.test(q.sql));
  assert.deepEqual(ref?.params, ["kws_1", "run", "ktsk_1"],
    "the run, against the workspace its gate key is built from");
  assert.match(ref?.sql ?? "", /DO UPDATE SET released_at = NULL/,
    "a redispatch of the same row re-takes the reference it let go of");
});

test("B7 the run that took it does not claim the write side at dispatch time", async () => {
  // The claim exists to count how often two runs really write one workspace, and
  // it cannot count that from here: nothing is written at dispatch, the run
  // reaches the files later once Brain lets it through the gate, and the
  // scheduler sends siblings in a batch. Claimed here, the first of a batch holds
  // it for an hour and every other logs `workspace.writer_contended` over runs the
  // gate serialises perfectly -- and since their releases no longer match on
  // `writer_run_id`, the version stops moving as well.
  const seen = stubDb(new Date().toISOString(), WORKSPACE_BOUND);

  await dispatchTask("ktsk_1");

  assert.ok(
    !seen.some((q) => /SET writer_run_id = \$2/.test(q.sql)),
    "a measurement of dispatch batches is not a measurement of concurrent writes",
  );
});

test("B8 a publish the server refused fails the row; one that only went quiet does not", async () => {
  // The two halves of the distinction, and it has to be both: the catch
  // deliberately keeps the workspace reference, because the message may be on
  // the stream and the run may be executing against those files -- and marking
  // the row `failed` releases that reference on the next tick of
  // `releaseRefsOfFinishedRuns`, under a run that is still writing. Left at
  // `preparing` instead, the deadline backstop closes it and interrupts
  // whatever ran.
  //
  // Injected through the seam rather than by leaving NATS unconnected: an
  // absent client throws a TypeError, which is a publish that certainly did not
  // happen, so that arrangement can only ever exercise the certain side.
  const refused = Object.assign(new Error("no responders available"), { code: "503" });
  const stubPublisher = (err: Error): void => {
    taskPublisher.publish = async () => { throw err; };
  };

  let seen = stubDb(new Date().toISOString(), WORKSPACE_BOUND);
  stubPublisher(refused);
  assert.equal((await dispatchTask("ktsk_1")).ok, false);
  assert.deepEqual(
    transitions(seen), ["queued -> preparing", "preparing -> failed"],
    "the server said it did not take the message, so nothing is running to protect",
  );

  seen = stubDb(new Date().toISOString(), WORKSPACE_BOUND);
  stubPublisher(new Error("timeout waiting for ack"));
  assert.equal((await dispatchTask("ktsk_1")).ok, false);
  assert.deepEqual(
    transitions(seen), ["queued -> preparing"],
    "a missing ack is not a missing message, and failing it releases the files under the run",
  );
});

test("B9 a payload that will not serialise is a publish that certainly failed", async () => {
  // Serialising happens inside the try, before anything is sent. Counted as a
  // publish that may have landed, the row sits at `preparing` until the
  // deadline backstop reaches it -- an hour by default -- with the whole DAG
  // waiting behind a node whose message was never built, let alone sent.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const seen = stubDb(new Date().toISOString(), WORKSPACE_BOUND, { user_env: circular });
  taskPublisher.publish = async () => { throw new Error("should never be reached"); };

  assert.equal((await dispatchTask("ktsk_1")).ok, false);

  assert.deepEqual(transitions(seen), ["queued -> preparing", "preparing -> failed"]);
});

test("B10 a queued chat doorbell is put back, not published as a fat execute", async () => {
  const seen = stubDb(
    new Date().toISOString(),
    WORKSPACE_BOUND,
    { dispatch: "doorbell" },
    { origin: "chat" },
  );
  let published = 0;
  taskPublisher.publish = async () => { published += 1; };

  const result = await dispatchTask("ktsk_1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "chat_run_not_scheduled");
  assert.equal(published, 0, "the execute request stays off the durable");
  const putBack = seen.find((q) => /lease_owner IS NULL/.test(q.sql));
  assert.ok(putBack, "a Brain that claimed in the preparing window must keep the row");
  assert.match(putBack.sql, /origin = 'chat'/);
  assert.match(putBack.sql, /status = 'preparing'/);
});
