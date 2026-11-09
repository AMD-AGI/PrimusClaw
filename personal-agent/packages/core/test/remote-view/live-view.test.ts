// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { type SseEvent, decode, remoteStep } from "../../src/remote-view/events.js";
import { RemoteLiveView } from "../../src/remote-view/live-view.js";
import { PLAIN_ERRORS, acp, frame } from "./frames.js";

const view = () => new RemoteLiveView("Codex on dev-pod");

function feed(v: RemoteLiveView, ...events: SseEvent[]): string {
  for (const event of events) v.apply(decode(event, PLAIN_ERRORS));
  return v.render();
}

test("the view says who is working", () => {
  assert.equal(view().render(), "Working on it (Codex on dev-pod)...");
  assert.equal(new RemoteLiveView("cx", "zh").render(), "正在处理（cx）…");
});

test("text streams into one block and a tool starts a new one", () => {
  const v = view();
  let text = feed(
    v,
    acp("agent_message_chunk", "1", { content: { text: "I will " } }),
    acp("agent_message_chunk", "1", { content: { text: "look." } }),
  );
  assert.ok(text.endsWith("\n\nI will look."));
  text = feed(
    v,
    acp("tool_call", "1", { toolCallId: "t1", title: "Read README.md" }),
    acp("agent_message_chunk", "1", { content: { text: "Found it." } }),
  );
  assert.deepEqual(text.split("\n\n").slice(1), ["I will look.", "Found it.", "⏳ Read README.md"]);
});

test("thoughts are dim italic lines without markup of their own", () => {
  const text = feed(view(), acp("agent_thought_chunk", "1", { content: { text: "Check *the* file_name `now`" } }));
  assert.ok(text.endsWith("\n\n_\u{1f4ad} Check the file name now_"));
});

test("a long thought keeps its end", () => {
  const line =
    feed(view(), acp("agent_thought_chunk", "1", { content: { text: "a".repeat(500) + " THE END" } })).split(
      "\n\n",
    )[1] ?? "";
  assert.ok(line.endsWith("THE END_") && line.includes("…") && line.length < 230);
});

test("the running step is one line and leaves nothing when it goes well", () => {
  const v = view();
  assert.ok(feed(v, acp("tool_call", "1", { toolCallId: "t1", title: "Run tests" })).endsWith("\n\n⏳ Run tests"));
  assert.ok(feed(v, acp("tool_call", "1", { toolCallId: "t2", title: "Edit a.py" })).endsWith("\n\n⏳ Edit a.py"));
  assert.ok(
    feed(v, acp("tool_call_update", "1", { toolCallId: "t2", status: "completed" })).endsWith("\n\n⏳ Run tests"),
  );
  assert.equal(
    feed(v, acp("tool_call_update", "1", { toolCallId: "t1", status: "completed" })),
    "Working on it (Codex on dev-pod)...",
  );
});

test("a step that failed leaves one line under the title it started with", () => {
  const v = view();
  feed(v, acp("tool_call", "1", { toolCallId: "t1", title: "Run tests" }));
  const text = feed(v, acp("tool_call_update", "1", { toolCallId: "t1", status: "failed" }));
  assert.equal(text, "Working on it (Codex on dev-pod)...\n\n⚠️ Run tests failed, continuing");
});

test("a tool title is untrusted text", () => {
  const title = "open [click](https://evil.example) <b>now</b> " + "x".repeat(300);
  const line = feed(view(), acp("tool_call", "1", { toolCallId: "t1", title })).split("\n\n")[1] ?? "";
  assert.ok(!line.includes("](") && !line.includes("<") && !line.includes("[") && line.length <= 110);
});

test("the plan is one line updated in place", () => {
  const v = view();
  feed(
    v,
    acp("plan", "1", {
      entries: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending" },
      ],
    }),
  );
  feed(v, acp("agent_message_chunk", "1", { content: { text: "working" } }));
  const text = feed(
    v,
    acp("plan", "1", {
      entries: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ],
    }),
  );
  assert.equal(text.split("Plan:").length - 1, 1);
  assert.equal(text.split("\n\n")[1], "\u{1f4cb} Plan: 1 of 2 done, now: b");
});

test("a credential split across two chunks is still masked", () => {
  const text = feed(
    view(),
    acp("agent_message_chunk", "1", { content: { text: "the key is sk-EXAMPLE-abcdef" } }),
    acp("agent_message_chunk", "1", { content: { text: "0123456789abcdef0123456789" } }),
  );
  assert.ok(!text.includes("sk-EXAMPLE-abcdef0123456789abcdef0123456789") && !text.includes("abcdef012345"));
});

test("a long turn shows only the newest part", () => {
  const v = view();
  for (let n = 0; n < 60; n += 1) {
    feed(
      v,
      acp("tool_call", "1", { toolCallId: `t${String(n)}`, title: `step ${String(n)}` }),
      acp("tool_call_update", "1", { toolCallId: `t${String(n)}`, status: "completed" }),
      acp("agent_message_chunk", "1", { content: { text: `paragraph ${String(n)} ` + "w".repeat(200) } }),
    );
  }
  const text = v.render();
  assert.ok(text.length <= 2500 + v.header.length + 10);
  assert.ok(text.includes("paragraph 59") && !text.includes("paragraph 0 "));
  assert.equal((text.split("```").length - 1) % 2, 0);
});

for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
  test(`one endless block does not grow the view without bound [${kind}]`, () => {
    const v = view();
    for (let i = 0; i < 300; i += 1)
      v.apply(decode(acp(kind, "1", { content: { text: "x".repeat(1000) } }), PLAIN_ERRORS));
    assert.ok(v.render().length <= 2500 + v.header.length + 10);
    // (one block: the header, then the newest part of it, "..." marking what was cut)
    assert.equal(
      v
        .render()
        .split("\n\n")
        .filter((p) => p !== "...").length,
      2,
    );
  });
}

test("steps that never end cannot grow the running list without bound", () => {
  const v = view();
  for (let n = 0; n < 500; n += 1)
    v.apply(decode(acp("tool_call", "1", { toolCallId: `t${String(n)}`, title: `step ${String(n)}` }), PLAIN_ERRORS));
  assert.ok(v.render().includes("step 499") && !v.render().includes("step 0"));
  for (let n = 499; n >= 460; n -= 1)
    v.apply(decode(acp("tool_call_update", "1", { toolCallId: `t${String(n)}`, status: "completed" }), PLAIN_ERRORS));
  assert.equal(v.render(), v.header); // (forty were in flight; none older is left)
});

test("apply says whether the view changed", () => {
  const v = view();
  assert.equal(v.apply(decode(acp("usage_update"), PLAIN_ERRORS)), false);
  assert.equal(v.apply(decode(acp("agent_message_chunk", "1", { content: { text: "x" } }), PLAIN_ERRORS)), true);
  assert.equal(v.apply(remoteStep({ finished: true })), false);
});

test("a note is a line of its own", () => {
  const v = view();
  assert.ok(feed(v, frame("session_resumed")).endsWith("\n\nSession resumed."));
  assert.ok(feed(v, frame("mode_update", { currentModeId: "plan" })).endsWith("\n\nMode is now plan."));
});

test("the live view of a remote turn says its step in the floating status and never its words", () => {
  const v = new RemoteLiveView("⬛ Codex on dev-pod");
  v.apply(remoteStep({ chunk: { kind: "message", text: "I will run the tests" } }));
  assert.deepEqual(v.statusLines(), []);
  v.apply(remoteStep({ tool: { id: "t1", title: "make test", status: "in_progress" } }));
  v.apply(remoteStep({ plan: "\u{1f4cb} Plan: 1 of 3 done" }));
  assert.deepEqual(v.statusLines(), ["\u{1f4cb} Plan: 1 of 3 done", "⏳ make test"]);
  v.apply(remoteStep({ tool: { id: "t1", title: "make test", status: "failed" } }));
  assert.equal(v.statusLines().at(-1), "⚠️ make test failed, continuing");
});
