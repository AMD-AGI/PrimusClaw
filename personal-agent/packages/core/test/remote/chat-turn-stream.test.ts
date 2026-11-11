// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A remote turn's words in the answer's bubble while the agent writes them: a code span still open is not streamed. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteStep } from "../../src/remote/events.js";
import type { RemoteLive } from "../../src/remote/ports.js";
import { RemoteStatusPolicy, withoutOpenCode } from "../../src/remote/turns/chat-turn.js";

const live: RemoteLive = { header: "", apply: () => false, render: () => "", statusLines: () => [] };
const words = (policy: RemoteStatusPolicy, text: string) =>
  policy.applyStep(remoteStep({ chunk: { kind: "message", text } }));
const textOf = (message: unknown): string => JSON.stringify(message);

test("a reply that begins with a code span ends its bubble with the whole answer, never a lone look-alike backtick", () => {
  // (2026-11-11 guide re-check: the first chunk was "`", streamed as "ˋ"; the bubble ended on it and the answer came after it)
  const policy = new RemoteStatusPolicy(live, (t) => t, null);
  words(policy, "`");
  const first = policy.streamable("");
  assert.equal(first, "", "nothing settled yet: the backtick may open a code span");
  words(policy, "hook.txt` was not created: the write was rejected.");
  const streamed = policy.streamable(first);
  assert.equal(streamed, "`hook.txt` was not created: the write was rejected.");
  assert.ok(!streamed.includes("\u{2cb}"));
  const end = policy.finishStream({
    streamed,
    streamable: policy.streamable(streamed),
    messages: [],
    parts: [],
    options: {},
  });
  assert.ok(end);
  assert.ok(textOf(end.final).includes("`hook.txt` was not created"), textOf(end.final));
  assert.ok(!textOf(end.final).includes("\u{2cb}"), textOf(end.final));
  assert.deepEqual(end.rest, [], "one message: the bubble holds the whole answer");
});

test("an answer that ends with an unclosed backtick still says it whole at the end", () => {
  const policy = new RemoteStatusPolicy(live, (t) => t, null);
  words(policy, "Done. The stray mark is `");
  const streamed = policy.streamable("");
  assert.equal(streamed, "Done. The stray mark is");
  const end = policy.finishStream({
    streamed,
    streamable: policy.streamable(streamed),
    messages: [],
    parts: [],
    options: {},
  });
  assert.ok(end && textOf(end.final).includes("Done. The stray mark is \u{2cb}"), textOf(end?.final));
  assert.deepEqual(end.rest, []);
});

test("only a code span still open on the last line is held back", () => {
  assert.equal(withoutOpenCode("plain"), "plain");
  assert.equal(withoutOpenCode("`a` and `b"), "`a` and ");
  assert.equal(withoutOpenCode("`a` and `b`"), "`a` and `b`");
  assert.equal(withoutOpenCode("x ``y` z"), "x ");
  assert.equal(withoutOpenCode("x ``y` z``"), "x ``y` z``");
  assert.equal(withoutOpenCode("line `one\nsecond line"), "line `one\nsecond line", "an earlier line is settled");
  assert.equal(withoutOpenCode("say \\` it"), "say \\` it", "an escaped backtick opens nothing");
  assert.equal(withoutOpenCode("text\n```ts"), "text\n```ts", "a fence line is a code block, not a span");
});
