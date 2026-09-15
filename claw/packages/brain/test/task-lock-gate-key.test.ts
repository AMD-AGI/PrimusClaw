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

const { pickLockKey, pickRunScope, pickShellRun } = await import("../src/tasks/lock.js");

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

test("a conversation's shells are filed under no run, so the next turn can reach them", () => {
  const turnOne = pickShellRun(req({ session_id: "s-1", task_id: "ktsk_turn_1" }));
  const turnTwo = pickShellRun(req({ session_id: "s-1", task_id: "ktsk_turn_2" }));

  assert.equal(turnOne, "", "no run: the third state Hands documents for shells that outlive one");
  assert.equal(turnOne, turnTwo,
    "two turns of one conversation address the same shells, which is the point of "
      + "starting one in the background");
});

test("a DAG node's shells stay filed under the node, so a sibling cannot reach them", () => {
  const node = pickShellRun(req({
    session_id: "s-1", task_id: "ktsk_node_a", dag_root_task_id: "ktsk_root", dag_node_id: "a",
  }));
  const sibling = pickShellRun(req({
    session_id: "s-1", task_id: "ktsk_node_b", dag_root_task_id: "ktsk_root", dag_node_id: "b",
  }));

  assert.equal(node, "ktsk_node_a", "a node's shells are its own, and its report reaps them");
  assert.notEqual(node, sibling,
    "a sibling under one graph root is not entitled to the other's work");
});

test("a DAG node named only by its node id is still a node", () => {
  // Both fields carry the same fact and a request may arrive with either, so a
  // check on one alone files half of them as a conversation's -- shells a
  // sibling could then reach and no node report would reap.
  assert.equal(
    pickShellRun(req({ session_id: "s-1", task_id: "ktsk_n", dag_node_id: "a" })),
    "ktsk_n",
  );
  assert.equal(
    pickShellRun(req({ session_id: "s-1", task_id: "ktsk_n", dag_root_task_id: "r" })),
    "ktsk_n",
  );
});

test("a DAG node without a task id uses its node id and stays separate from siblings", () => {
  for (const task_id of [undefined, ""]) {
    for (const dag_root_task_id of [undefined, "root-1"]) {
      const fields = { task_id, dag_root_task_id };
      assert.equal(pickShellRun(req({ ...fields, dag_node_id: "node-a" })), "node-a");
      assert.equal(pickShellRun(req({ ...fields, dag_node_id: "node-b" })), "node-b");
    }
  }
});

test("a DAG request without a task or node id cannot use the conversation shell scope", () => {
  for (const task_id of [undefined, ""]) {
    for (const dag_node_id of [undefined, ""]) {
      assert.throws(
        () => pickShellRun(req({ task_id, dag_node_id, dag_root_task_id: "root-1" })),
        /DAG shell scope requires a non-empty task_id or dag_node_id/,
      );
    }
  }
  assert.equal(pickShellRun(req()), "");
});
