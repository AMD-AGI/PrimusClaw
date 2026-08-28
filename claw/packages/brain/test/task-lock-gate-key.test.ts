// Which runs are allowed to overlap, under the default gate key.
//
// The key answers "do these two runs write the same files". Getting it wrong
// is not visible as a failure anywhere: too coarse and a DAG fan-out that used
// to run wide silently serialises, too fine and two runs share a directory and
// the second one's rsync --delete removes the first one's work.
//
// The session-keyed fallback is exercised in task-lock-gate-key-session: the
// setting is read at module load and the test runner gives each file a
// process.
//
// Coverage:
//   G1 runs sharing a workspace get one key, whatever else differs
//   G2 a run without a workspace id falls back to the old key
//   G3 workspace keys cannot collide with session or DAG-root keys
//   G4 the scope background shells are addressed in does not widen with the gate
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

const { pickLockKey, pickRunScope } = await import("../src/tasks/lock.js");

function req(over: Record<string, unknown> = {}): ExecuteRequest {
  return {
    session_id: "sess-1",
    message_id: "msg-1",
    prompt: "hello",
    history: [],
    user_id: "u1",
    ...over,
  } as unknown as ExecuteRequest;
}

test("G1 runs sharing a workspace get one key, whatever else differs", () => {
  // The case this exists for: two DAG roots over one session, which took
  // different keys under the old scheme and overwrote each other's files.
  const a = pickLockKey(req({ files_workspace_id: "kws_1", dag_root_task_id: "root-a" }));
  const b = pickLockKey(req({
    files_workspace_id: "kws_1",
    dag_root_task_id: "root-b",
    session_id: "sess-2",
  }));
  assert.equal(a, b, "same files means one at a time");
  assert.notEqual(a, pickLockKey(req({ files_workspace_id: "kws_2" })));
});

test("G2 a run that declares no workspace keeps the old key", () => {
  // Messages already on the queue when this shipped, and any dispatch whose
  // workspace bookkeeping failed. The fallback is never worse than what the
  // deployment did before; it is just not what was asked for, which is why
  // the code logs it at error.
  assert.equal(pickLockKey(req({ dag_root_task_id: "root-9" })), "root-9");
  assert.equal(pickLockKey(req()), "sess-1");
});

test("G3 workspace keys live in their own namespace", () => {
  // Workspace ids and session ids are drawn from different alphabets today,
  // but the gate is one flat KV keyspace shared with locks named after
  // sessions and DAG roots. The prefix is what makes a collision between the
  // two naming schemes unable to merge two unrelated gates.
  assert.equal(pickLockKey(req({ files_workspace_id: "sess-1" })), "ws.sess-1");
});

test("G4 background shells stay addressable per conversation, not per workspace", () => {
  // Brain used to hand Hands whatever the gate key was, back when the gate key
  // was the session. Now that one workspace can hold several sessions, the same
  // wiring would let a run poll and kill background processes started by an
  // unrelated session that happens to share the directory.
  const shared = { files_workspace_id: "kws_1" };
  const mine = pickRunScope(req({ ...shared }));
  const theirs = pickRunScope(req({ ...shared, session_id: "sess-2" }));

  assert.equal(pickLockKey(req({ ...shared })), pickLockKey(req({ ...shared, session_id: "sess-2" })),
    "the premise: both runs queue behind one gate");
  assert.notEqual(mine, theirs, "but they cannot reach each other's shells");
  assert.equal(mine, "sess-1");
  assert.equal(pickRunScope(req({ ...shared, dag_root_task_id: "root-7" })), "root-7",
    "a DAG's nodes share one scope, since a node inherits the sandbox upstream left");
});
