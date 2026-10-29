// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a peer said, reduced to the one result a2a_call hands the model: the state
 * spelling, the task/stream-to-result mapping, and the SSE framing. Pure functions,
 * so these are tables.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SseParser, TaskView, normalizeState, type A2AState, type WireTask } from "../src/clients/a2a-result.js";

test("normalizeState: every spelling a peer uses, and nothing it does not", () => {
  const table: Array<[unknown, A2AState]> = [
    ["TASK_STATE_SUBMITTED", "submitted"], ["TASK_STATE_WORKING", "working"],
    ["TASK_STATE_INPUT_REQUIRED", "input_required"], ["TASK_STATE_AUTH_REQUIRED", "auth_required"],
    ["TASK_STATE_COMPLETED", "completed"], ["TASK_STATE_FAILED", "failed"],
    ["TASK_STATE_CANCELED", "canceled"], ["TASK_STATE_REJECTED", "rejected"],
    ["input-required", "input_required"], ["INPUT_REQUIRED", "input_required"], ["completed", "completed"],
    ["cancelled", "canceled"], ["TASK_STATE_CANCELLED", "canceled"], [" working ", "working"],
    ["TASK_STATE_UNSPECIFIED", "unknown"], ["bogus", "unknown"], ["", "unknown"],
    [undefined, "unknown"], [null, "unknown"], [3, "unknown"],
  ];
  for (const [raw, want] of table) assert.equal(normalizeState(raw), want, JSON.stringify(raw));
});

const text = (t: string) => ({ text: t });

test("a Task snapshot becomes {state, task_id, context_id, text, artifacts}", () => {
  const table: Array<{ what: string; task: WireTask; want: Record<string, unknown> }> = [
    {
      what: "completed: the artifact is the answer, the status message is not repeated",
      task: {
        id: "t1", contextId: "c1",
        status: { state: "TASK_STATE_COMPLETED", message: { parts: [text("Request is completed!")] } },
        artifacts: [{ artifactId: "a1", name: "report", parts: [text("line one"), text("line two")] }],
      },
      want: { state: "completed", task_id: "t1", context_id: "c1", text: "line one\nline two" },
    },
    {
      what: "completed with several artifacts: separated, in order",
      task: { id: "t1", status: { state: "completed" }, artifacts: [{ artifactId: "a", parts: [text("A")] }, { artifactId: "b", parts: [text("B")] }] },
      want: { state: "completed", text: "A\n\nB" },
    },
    {
      what: "completed with no artifact: the status message answers",
      task: { id: "t1", status: { state: "TASK_STATE_COMPLETED", message: { parts: [text("done")] } } },
      want: { state: "completed", text: "done" },
    },
    {
      what: "completed with neither: the last agent message in the history",
      task: {
        id: "t1", status: { state: "TASK_STATE_COMPLETED" },
        history: [{ role: "ROLE_USER", parts: [text("q")] }, { role: "ROLE_AGENT", parts: [text("first")] }, { role: "agent", parts: [text("last")] }],
      },
      want: { state: "completed", text: "last" },
    },
    {
      what: "failed: the reason in the status message comes first",
      task: {
        id: "t1", status: { state: "TASK_STATE_FAILED", message: { parts: [text("out of quota")] } },
        artifacts: [{ artifactId: "a", parts: [text("partial")] }],
      },
      want: { state: "failed", text: "out of quota\n\npartial" },
    },
    {
      what: "canceled",
      task: { id: "t1", status: { state: "TASK_STATE_CANCELED", message: { parts: [text("stopped")] } } },
      want: { state: "canceled", text: "stopped" },
    },
    {
      what: "working: no answer yet",
      task: { id: "t1", status: { state: "TASK_STATE_WORKING" } },
      want: { state: "working", text: "" },
    },
  ];
  for (const { what, task, want } of table) {
    const view = new TaskView();
    view.applyTask(task);
    const r = view.toResult();
    for (const [k, v] of Object.entries(want)) assert.equal((r as unknown as Record<string, unknown>)[k], v, `${what}: ${k}`);
    assert.equal(r.input_required, undefined, `${what}: not waiting`);
  }
});

test("input_required: the question is reported as one, never as the answer", () => {
  const view = new TaskView();
  view.applyTask({
    id: "t1", contextId: "c1",
    status: {
      state: "TASK_STATE_INPUT_REQUIRED",
      message: {
        parts: [
          text("Deploy to production? Please approve."),
          { data: { kind: "approval", actionId: "act-77", tool: "deploy", input: { env: "prod" }, options: ["allow", "deny"], timeoutMs: 60000 } },
          { data: { other: 1 } },
        ],
      },
    },
  });
  const r = view.toResult();
  assert.equal(r.state, "input_required");
  assert.equal(r.text, "", "the question is not the peer's answer");
  assert.equal(r.input_required?.text, "Deploy to production? Please approve.");
  assert.deepEqual(r.input_required?.approval, {
    action_id: "act-77", tool: "deploy", input: { env: "prod" }, options: ["allow", "deny"], timeout_ms: 60000,
  });
  assert.deepEqual(r.input_required?.data, ['{"other":1}']);

  const auth = new TaskView();
  auth.applyTask({ id: "t2", status: { state: "TASK_STATE_AUTH_REQUIRED", message: { parts: [text("log in at the peer")] } } });
  assert.equal(auth.toResult().input_required?.text, "log in at the peer", "an interrupted state of either kind carries its question");
});

test("a stream of events accumulates into the same result a snapshot would give", () => {
  const view = new TaskView();
  const events: Array<Record<string, unknown>> = [
    { task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_SUBMITTED" } } },
    { statusUpdate: { taskId: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING", message: { parts: [text("working")] } } } },
    { artifactUpdate: { taskId: "t1", artifact: { artifactId: "s", parts: [text("chunk0 ")] }, append: false } },
    { artifactUpdate: { taskId: "t1", artifact: { artifactId: "s", parts: [text("chunk1")] }, append: true } },
    { artifactUpdate: { taskId: "t1", artifact: { artifactId: "log", name: "log", parts: [text("L")] } } },
    { statusUpdate: { taskId: "t1", status: { state: "TASK_STATE_COMPLETED" } } },
  ];
  const states: string[] = [];
  for (const e of events) { view.applyEvent(e); states.push(view.state); }
  assert.deepEqual(states, ["submitted", "working", "working", "working", "working", "completed"]);
  const r = view.toResult();
  assert.equal(r.text, "chunk0 chunk1\n\nL");
  assert.deepEqual(r.artifacts.map((a) => [a.artifact_id, a.text_chars]), [["s", 13], ["log", 1]]);
  assert.equal(r.task_id, "t1");
  assert.equal(r.context_id, "c1");
});

test("a Message with no task is a finished answer; a replaced artifact replaces", () => {
  const msg = new TaskView();
  msg.applyEvent({ message: { role: "ROLE_AGENT", parts: [text("just an answer")] } });
  assert.equal(msg.answered, true);
  const r = msg.toResult();
  assert.equal(r.state, "completed");
  assert.equal(r.text, "just an answer");
  assert.equal(r.task_id, undefined);

  const rep = new TaskView();
  rep.applyEvent({ artifactUpdate: { artifact: { artifactId: "x", parts: [text("old")] } } });
  rep.applyEvent({ artifactUpdate: { artifact: { artifactId: "x", parts: [text("new")] }, append: false } });
  assert.equal(rep.toResult().text, "new");
});

test("artifacts that are not text are described, never inlined", () => {
  const view = new TaskView();
  view.applyTask({
    id: "t", status: { state: "completed" },
    artifacts: [{ artifactId: "f", name: "out", parts: [
      text("see files"),
      { url: "https://peer.example/f.png", filename: "f.png", mediaType: "image/png" },
      { raw: Buffer.alloc(30).toString("base64"), filename: "blob.bin" },
      { data: { rows: 3 } },
    ] }],
  });
  const a = view.toResult().artifacts[0];
  assert.equal(a.text_chars, 9);
  assert.deepEqual(a.other_parts, [
    { kind: "file", url: "https://peer.example/f.png", filename: "f.png", media_type: "image/png" },
    { kind: "file", filename: "blob.bin", media_type: undefined, bytes: 30 },
    { kind: "data", json: '{"rows":3}' },
  ]);
  assert.equal(view.toResult().text, "see files");
});

test("a very long answer is clipped, and says so", () => {
  const view = new TaskView();
  view.applyTask({ id: "t", status: { state: "completed" }, artifacts: [{ artifactId: "a", parts: [text("x".repeat(150_000))] }] });
  const r = view.toResult();
  assert.ok(r.text.length < 101_000);
  assert.match(r.text, /truncated, 50000 more characters/);
});

// ── SSE framing ─────────────────────────────────────────────────────────────

test("SseParser: the same events however the bytes are cut, in every line-ending style", () => {
  const events = ['{"a":1}', '{"b":"two"}', "line1\nline2"];
  const wireFor = (eol: string) =>
    `: keep-alive${eol}${eol}data: ${events[0]}${eol}${eol}data:${events[1]}${eol}${eol}`
    + `: comment${eol}data: line1${eol}data: line2${eol}${eol}`;
  for (const eol of ["\n", "\r\n", "\r"]) {
    const wire = wireFor(eol);
    for (let cut = 0; cut <= wire.length; cut++) {
      const p = new SseParser();
      const got = [...p.push(wire.slice(0, cut)), ...p.push(wire.slice(cut)), ...p.flush()];
      assert.deepEqual(got, events, `eol=${JSON.stringify(eol)} cut=${cut}`);
    }
  }
});

test("SseParser: an event with no closing blank line is delivered at the end of the stream, a comment never is", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: {\"x\":1}\n"), []);
  assert.deepEqual(p.flush(), ['{"x":1}']);
  const q = new SseParser();
  assert.deepEqual([...q.push(": ping\n\n: ping\n\n"), ...q.flush()], []);
});
