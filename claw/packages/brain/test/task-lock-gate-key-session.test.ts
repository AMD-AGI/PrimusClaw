// The other side of the switch: `RUN_GATE_KEY=session` restores the key the
// gate used before workspaces had ids.
//
// It is kept because keying on the files is a throughput change as well as a
// fix -- runs that used to proceed in parallel now queue -- and a deployment
// that would rather have the overlap than the queue needs a way back that
// does not involve shipping a different build.
//
// Its own file because the setting is read at module load and the test runner
// gives each file a process; the default is in task-lock-gate-key.
//
// Coverage:
//   G4 the DAG root wins, with the session as the chat-path fallback
//   G5 a workspace id on the wire is ignored entirely
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

process.env.RUN_GATE_KEY = "session";
const { pickLockKey } = await import("../src/tasks/lock.js");

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

test("G4 the DAG root is the key, with the session as the chat-path fallback", () => {
  assert.equal(pickLockKey(req({ dag_root_task_id: "root-9" })), "root-9");
  assert.equal(pickLockKey(req()), "sess-1");
});

test("G5 the workspace id is ignored, so the rollback is a real rollback", () => {
  assert.equal(
    pickLockKey(req({ files_workspace_id: "kws_1", dag_root_task_id: "root-9" })),
    "root-9",
  );
  assert.equal(pickLockKey(req({ files_workspace_id: "kws_1" })), "sess-1");
});
