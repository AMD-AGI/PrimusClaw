// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an A2A task is, derived from a run row and the events of that run.
 *
 * Pure: no database, NATS or server. The state a caller reads is a function of
 * two inputs, so the whole mapping is driven as tables. The routes that serve
 * it are in a2a-context-tasks.test.ts.
 *
 * Coverage:
 *   V1 state of a run: every row status, with and without events
 *   V2 the request a run is waiting on opens, and closes, with its own events
 *   V3 a task carries accumulated text, a tool log, a failure and the question asked
 *   V4 live events become stream events, once, in order, and say when the stream ends
 *   V5 the caller's answer to a waiting task
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  accumulatedText, artifactsOf, closingEvents, inputRequiredMessage, isRunEnd, mapLiveEvent,
  newStreamState, parseAnswer, pendingInputOf, stateOfRun, taskOf, TEXT_CHUNK_SEPARATOR,
  type PendingInput, type RunEvent, type RunRecord,
} from "../src/routes/a2a-task-view.js";
import { Role, TaskState, type Part } from "../src/routes/a2a-types.js";

const RUN: RunRecord = {
  taskId: "ktsk_1", sessionId: "a2a-s1", contextId: "ctx-1", messageId: "m-1", status: "running",
  prompt: "hello", failureReason: null, errorMessage: null,
  createdAt: new Date("2026-10-29T10:00:00Z"), completedAt: null,
};
const run = (over: Partial<RunRecord> = {}): RunRecord => ({ ...RUN, ...over });

let seq = 0;
const ev = (event: string, data: Record<string, unknown> = {}): RunEvent =>
  ({ id: ++seq, event, data: { type: event, ...data }, createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, seq)) });
const said = (text: string) => ev("AssistantMessage", { data: { content: [{ type: "text", text }] } });
const started = () => ev("statusUpdate", { agentStatus: "running" });
const approval = (id: string, over: Record<string, unknown> = {}) =>
  ev("permissionRequest", { actionId: id, tool: "bash", input: { command: "ls" }, description: "bash: ls", timeout_ms: 300000, ...over });
const question = (id: string) =>
  ev("userQuestion", { actionId: id, questions: [{ id: "q1", question: "Pick", options: [{ id: "a", label: "A" }] }] });
const decided = (id: string) => ev("decisionResult", { actionId: id, decision: "allow" });

describe("V1 the state of a run", () => {
  const cases: Array<{ name: string; status: string; events: RunEvent[]; want: TaskState }> = [
    { name: "queued, nothing heard", status: "queued", events: [], want: TaskState.SUBMITTED },
    { name: "preparing, nothing heard", status: "preparing", events: [], want: TaskState.SUBMITTED },
    { name: "preparing, Brain has a sandbox and is starting", status: "preparing", events: [started()], want: TaskState.WORKING },
    { name: "running", status: "running", events: [], want: TaskState.WORKING },
    { name: "preparing, a held call", status: "preparing", events: [started(), approval("a1")], want: TaskState.INPUT_REQUIRED },
    { name: "running, a question", status: "running", events: [question("q-1")], want: TaskState.INPUT_REQUIRED },
    { name: "a held call that was decided is working again", status: "running", events: [approval("a1"), decided("a1")], want: TaskState.WORKING },
    { name: "completed", status: "completed", events: [said("hi")], want: TaskState.COMPLETED },
    { name: "failed", status: "failed", events: [], want: TaskState.FAILED },
    { name: "cancelled", status: "cancelled", events: [], want: TaskState.CANCELED },
    // The caller asked for the stop; a task that goes back to WORKING while the worker winds down un-cancels itself.
    { name: "cancelling already reads as canceled", status: "cancelling", events: [started()], want: TaskState.CANCELED },
    { name: "a finished run with a request left open is not waiting", status: "completed", events: [approval("a1")], want: TaskState.COMPLETED },
    { name: "a status nobody maps is submitted, not an error", status: "waiting_deps", events: [], want: TaskState.SUBMITTED },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(stateOfRun({ status: c.status }, c.events), c.want));
  }

  // A task the caller cancelled is CANCELED for good: a worker that was already
  // finishing its answer closes the row from its own completion, and the task
  // must not go from CANCELED to what the worker reports.
  const cancelled = "2026-10-29T10:00:05.000Z";
  const stays: Array<{ name: string; status: string; events: RunEvent[] }> = [
    { name: "cancel accepted, the row still running", status: "running", events: [started()] },
    { name: "cancel accepted, the row cancelling", status: "cancelling", events: [] },
    { name: "cancel accepted, the in-flight answer then lands: the row says completed", status: "completed", events: [said("late answer")] },
    { name: "cancel accepted, the worker then fails: the row says failed", status: "failed", events: [] },
    { name: "cancel accepted, a request is still open", status: "running", events: [approval("a1")] },
    { name: "cancel accepted, the row cancelled", status: "cancelled", events: [] },
  ];
  for (const c of stays) {
    test(c.name, () => {
      assert.equal(stateOfRun({ status: c.status, cancelRequestedAt: cancelled }, c.events), TaskState.CANCELED);
      assert.equal(taskOf(run({ status: c.status, cancelRequestedAt: cancelled }), c.events).status.state, TaskState.CANCELED);
    });
  }
  test("no cancel on the row, a completed run is COMPLETED", () => {
    for (const none of [undefined, null]) {
      assert.equal(stateOfRun({ status: "completed", cancelRequestedAt: none }, []), TaskState.COMPLETED);
    }
  });
  test("a cancelled task keeps what the worker said after the stop, as artifacts", () => {
    const task = taskOf(run({ status: "completed", cancelRequestedAt: cancelled }), [said("late answer")]);
    assert.equal(task.status.state, TaskState.CANCELED);
    assert.equal(task.artifacts?.[0].parts[0].text, "late answer");
    assert.equal(task.status.message, undefined, "and says nothing of a failure");
  });
});

describe("V2 the request a run is waiting on", () => {
  test("a held call opens and its decision closes it", () => {
    assert.equal(pendingInputOf([approval("a1")])?.actionId, "a1");
    assert.equal(pendingInputOf([approval("a1"), decided("a1")]), null);
  });

  test("a question opens and the question tool's own result closes it", () => {
    assert.equal(pendingInputOf([question("q-1")])?.kind, "question");
    for (const status of ["success", "error"]) {
      assert.equal(
        pendingInputOf([question("q-1"), ev("toolUsed", { tool: "ask_user_question", actionId: "q-1", status })]),
        null, `a ${status} result closes it`,
      );
    }
    // The start of the call is not an answer.
    assert.notEqual(pendingInputOf([question("q-1"), ev("toolUsed", { tool: "ask_user_question", actionId: "q-1", status: "start" })]), null);
  });

  test("the newest open request is the one to answer, and a decision closes only its own", () => {
    const open = pendingInputOf([approval("a1"), approval("a2"), decided("a1")]);
    assert.equal(open?.actionId, "a2");
    assert.equal(pendingInputOf([approval("a1"), approval("a2"), decided("a2")])?.actionId, "a1");
  });

  test("tool_use_id names a request as actionId does, and an event with neither opens nothing", () => {
    assert.equal(pendingInputOf([ev("permissionRequest", { tool_use_id: "t1", tool: "bash" })])?.actionId, "t1");
    assert.equal(pendingInputOf([ev("permissionRequest", { tool: "bash" })]), null);
  });

  test("the summary is Brain's, then its description, then a plain sentence", () => {
    const summaryOf = (d: Record<string, unknown>) =>
      (pendingInputOf([ev("permissionRequest", { actionId: "x", tool: "bash", ...d })]) as Extract<PendingInput, { kind: "approval" }>).summary;
    assert.equal(summaryOf({ summary: "Runs ls", description: "bash: ls" }), "Runs ls");
    assert.equal(summaryOf({ description: "bash: ls" }), "bash: ls");
    assert.equal(summaryOf({}), "Approval needed for bash");
  });
});

describe("V3 the task a caller reads", () => {
  test("text accumulates the way Brain joins it, and the tool log follows", () => {
    const events = [
      said("first"), ev("toolUsed", { tool: "bash", status: "start" }),
      ev("toolUsed", { tool: "bash", status: "success", description: "ran ls" }), said("second"),
    ];
    assert.equal(accumulatedText(events), `first${TEXT_CHUNK_SEPARATOR}second`);
    const artifacts = artifactsOf("ktsk_1", events);
    assert.deepEqual(artifacts.map((a) => a.artifactId), ["ktsk_1-text", "ktsk_1-tools"]);
    assert.equal(artifacts[0].parts[0].text, "first\nsecond");
    assert.equal(artifacts[1].parts[0].text, "[Tool: bash] ran ls");
  });

  test("with no message event kept, a finished run's text is its completion's", () => {
    const done = taskOf(run({ status: "completed" }), [ev("exec_complete", { final_text: "the answer" })]);
    assert.equal(done.artifacts?.[0].parts[0].text, "the answer");
    // Not a failure's text (that is the status message), not a stopped run's partial one, and never over what was said.
    assert.equal(taskOf(run({ status: "failed" }), [ev("exec_complete", { final_text: "[Task failed: x]", failed: true })]).artifacts, undefined);
    assert.equal(taskOf(run({ status: "cancelled" }), [ev("exec_complete", { final_text: "partial", interrupted: true })]).artifacts, undefined);
    assert.equal(taskOf(run({ status: "completed" }), [said("said"), ev("exec_complete", { final_text: "other" })]).artifacts?.[0].parts[0].text, "said");
  });

  test("an INPUT_REQUIRED task carries the request as a text part and a data part", () => {
    const task = taskOf(run(), [started(), approval("a1")]);
    assert.equal(task.status.state, TaskState.INPUT_REQUIRED);
    const msg = task.status.message!;
    assert.equal(msg.role, Role.AGENT);
    assert.equal(msg.taskId, "ktsk_1");
    assert.equal(msg.parts[0].text, "bash: ls");
    assert.deepEqual(msg.parts[1].data, {
      kind: "approval", actionId: "a1", tool: "bash", input: { command: "ls" },
      options: ["allow", "deny"], timeoutMs: 300000,
    });
  });

  test("a question carries its questions both as text and as data", () => {
    const task = taskOf(run(), [question("q-1")]);
    const msg = task.status.message!;
    assert.match(msg.parts[0].text!, /Pick \(a: A\)/);
    assert.equal((msg.parts[1].data as { kind: string }).kind, "question");
  });

  test("a failed task says why", () => {
    const failed = taskOf(run({ status: "failed", errorMessage: "sandbox died" }), []);
    assert.equal(failed.status.state, TaskState.FAILED);
    assert.equal(failed.status.message?.parts[0].text, "sandbox died");
    const fromEvent = taskOf(run({ status: "failed" }), [ev("exec_complete", { final_text: "[Task failed: boom]", failed: true })]);
    assert.equal(fromEvent.status.message?.parts[0].text, "[Task failed: boom]");
    assert.equal(taskOf(run({ status: "completed" }), []).status.message, undefined);
  });

  test("history and artifacts are what the caller asked for", () => {
    const events = [said("hi")];
    assert.equal(taskOf(run(), events, { historyLength: 0 }).history, undefined);
    assert.equal(taskOf(run(), events).history?.[0].parts[0].text, "hello");
    assert.equal(taskOf(run(), events, { includeArtifacts: false }).artifacts, undefined);
    assert.equal(taskOf(run(), []).artifacts, undefined, "no text yet, no artifact");
  });

  test("the timestamp is the finish for a finished run and the last event for a live one", () => {
    const done = taskOf(run({ status: "completed", completedAt: new Date("2026-10-29T11:00:00Z") }), [said("x")]);
    assert.equal(done.status.timestamp, "2026-10-29T11:00:00.000Z");
    const events = [said("x")];
    assert.equal(taskOf(run(), events).status.timestamp, (events[0].createdAt as Date).toISOString());
  });
});

describe("V4 live events as stream events", () => {
  const R = { taskId: "ktsk_1", contextId: "ctx-1", messageId: "m-1" };

  test("text chunks append to one artifact, the first without append and later ones after the separator", () => {
    const s = newStreamState();
    const one = mapLiveEvent(R, { type: "AssistantMessage", data: { content: [{ text: "a" }] } }, s)!;
    const two = mapLiveEvent(R, { type: "AssistantMessage", data: { content: [{ text: "b" }] } }, s)!;
    const first = (one.responses[0] as { artifactUpdate: { append: boolean; artifact: { artifactId: string; parts: Part[] } } }).artifactUpdate;
    const second = (two.responses[0] as { artifactUpdate: { append: boolean; artifact: { parts: Part[] } } }).artifactUpdate;
    assert.equal(first.artifact.artifactId, "ktsk_1-text");
    assert.equal(first.append, false);
    assert.equal(first.artifact.parts[0].text, "a");
    assert.equal(second.append, true);
    assert.equal(second.artifact.parts[0].text, "\nb");
    assert.equal(one.end, "none");
  });

  test("running is announced once", () => {
    const s = newStreamState();
    const first = mapLiveEvent(R, { type: "statusUpdate", agentStatus: "running" }, s);
    assert.equal((first!.responses[0] as { statusUpdate: { status: { state: string } } }).statusUpdate.status.state, TaskState.WORKING);
    assert.equal(mapLiveEvent(R, { type: "statusUpdate", agentStatus: "running" }, s), null);
    assert.equal(mapLiveEvent(R, { type: "statusUpdate", agentStatus: "stopped" }, s), null);
  });

  test("a held call and a question end the stream as INPUT_REQUIRED", () => {
    for (const event of [
      { type: "permissionRequest", actionId: "a1", tool: "bash", input: {} },
      { type: "userQuestion", actionId: "q-1", questions: [] },
    ]) {
      const mapped = mapLiveEvent(R, event, newStreamState())!;
      assert.equal(mapped.end, "interrupted");
      const update = (mapped.responses[0] as { statusUpdate: { status: { state: string; message?: unknown } } }).statusUpdate;
      assert.equal(update.status.state, TaskState.INPUT_REQUIRED);
      assert.ok(update.status.message);
    }
  });

  test("a decision, or the question tool's result, is the run working again", () => {
    for (const event of [
      { type: "decisionResult", actionId: "a1", decision: "allow" },
      { type: "toolUsed", tool: "ask_user_question", actionId: "q-1", status: "success", description: "{}" },
      { type: "toolUsed", tool: "ask_user_question", actionId: "q-1", status: "error", description: "timed out" },
    ]) {
      const mapped = mapLiveEvent(R, event, newStreamState())!;
      const first = mapped.responses[0] as { statusUpdate: { status: { state: string } } };
      assert.equal(first.statusUpdate.status.state, TaskState.WORKING, JSON.stringify(event));
      assert.equal(mapped.end, "none");
    }
    // The start of the question tool is not.
    assert.equal(mapLiveEvent(R, { type: "toolUsed", tool: "ask_user_question", status: "start" }, newStreamState()), null);
  });

  test("an event of another turn is not this task's", () => {
    const s = newStreamState();
    const other = { type: "AssistantMessage", message_id: "m-0", data: { content: [{ text: "old" }] } };
    assert.equal(mapLiveEvent(R, other, s), null);
    assert.equal(s.textChunks, 0);
    assert.notEqual(mapLiveEvent(R, { ...other, message_id: "m-1" }, s), null);
  });

  test("only a successful tool call is logged, and exec_complete is the end of the run", () => {
    assert.equal(mapLiveEvent(R, { type: "toolUsed", tool: "bash", status: "start" }, newStreamState()), null);
    assert.ok(mapLiveEvent(R, { type: "toolUsed", tool: "bash", status: "success", description: "ok" }, newStreamState()));
    assert.equal(isRunEnd({ type: "exec_complete", message_id: "m-1" }, "m-1"), true);
    assert.equal(isRunEnd({ type: "exec_complete" }, "m-1"), true);
    assert.equal(isRunEnd({ type: "exec_complete", message_id: "m-0" }, "m-1"), false);
    assert.equal(isRunEnd({ type: "ResultMessage" }, "m-1"), false);
  });

  test("the closing events close what was opened, then say the state", () => {
    const s = newStreamState();
    mapLiveEvent(R, { type: "AssistantMessage", data: { content: [{ text: "a" }] } }, s);
    const out = closingEvents(R, TaskState.CANCELED, s);
    assert.equal(out.length, 2);
    assert.equal((out[0] as { artifactUpdate: { lastChunk: boolean } }).artifactUpdate.lastChunk, true);
    assert.equal((out[1] as { statusUpdate: { status: { state: string } } }).statusUpdate.status.state, TaskState.CANCELED);
    assert.equal(closingEvents(R, TaskState.COMPLETED, newStreamState()).length, 1, "nothing opened, nothing to close");
  });
});

describe("V5 the answer to a waiting task", () => {
  const approvalReq: PendingInput = { kind: "approval", actionId: "a1", tool: "bash", input: {}, summary: "s", timeoutMs: null };
  const questionReq = (n: number): PendingInput => ({
    kind: "question", actionId: "q-1",
    questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: "?" })),
  });
  const data = (d: Record<string, unknown>): Part => ({ data: d });

  const cases: Array<{ name: string; pending: PendingInput; parts: Part[]; want: Record<string, unknown> | { error: RegExp } }> = [
    { name: "allow as data", pending: approvalReq, parts: [data({ decision: "allow" })], want: { kind: "approval", decision: "allow", reason: "" } },
    { name: "deny with a reason", pending: approvalReq, parts: [data({ decision: "deny", reason: "no" })], want: { kind: "approval", decision: "deny", reason: "no" } },
    { name: "the action named correctly", pending: approvalReq, parts: [data({ actionId: "a1", decision: "ALLOW" })], want: { kind: "approval", decision: "allow" } },
    { name: "a bare word", pending: approvalReq, parts: [{ text: " Approve " }], want: { kind: "approval", decision: "allow" } },
    { name: "a bare no", pending: approvalReq, parts: [{ text: "no" }], want: { kind: "approval", decision: "deny" } },
    { name: "another request's action", pending: approvalReq, parts: [data({ actionId: "zzz", decision: "allow" })], want: { error: /does not name/ } },
    // Never read as consent: edit and remember are not offered, and anything else is not an answer.
    { name: "edit is not offered", pending: approvalReq, parts: [data({ decision: "edit" })], want: { error: /allow/ } },
    { name: "chatter", pending: approvalReq, parts: [{ text: "sure, go ahead" }], want: { error: /allow/ } },
    { name: "nothing", pending: approvalReq, parts: [], want: { error: /allow/ } },
    { name: "a question, one asked, answered in text", pending: questionReq(1), parts: [{ text: "blue" }], want: { kind: "question", answers: { q1: "blue" } } },
    { name: "a question, several asked, answered in text", pending: questionReq(2), parts: [{ text: "blue" }], want: { kind: "question", answers: { answer: "blue" } } },
    { name: "a question answered as data", pending: questionReq(2), parts: [data({ answers: { q1: ["a"], q2: ["b"] } })], want: { kind: "question", answers: { q1: ["a"], q2: ["b"] } } },
    { name: "a question with no answer", pending: questionReq(1), parts: [], want: { error: /text/ } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = parseAnswer(c.pending, c.parts);
      if ("error" in c.want) {
        assert.equal(got.ok, false);
        assert.match((got as { error: string }).error, c.want.error);
      } else {
        assert.equal(got.ok, true);
        for (const [key, value] of Object.entries(c.want)) {
          assert.deepEqual((got as unknown as Record<string, unknown>)[key], value, key);
        }
      }
    });
  }
});

test("the request message names the task and context it belongs to", () => {
  const msg = inputRequiredMessage({ taskId: "ktsk_1", contextId: "ctx-1" }, {
    kind: "approval", actionId: "a1", tool: "bash", input: {}, summary: "s", timeoutMs: null,
  });
  assert.deepEqual([msg.taskId, msg.contextId, msg.messageId], ["ktsk_1", "ctx-1", "input-required-a1"]);
  assert.equal("timeoutMs" in (msg.parts[1].data as object), false, "no timeout is not a null timeout");
});
