// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// llm-cache-plan.test.ts
//
// planCacheBreakpoints decides where prompt-cache markers go. Every test here
// pins a specific production rule; deleting the rule from cache-plan.ts must
// turn the corresponding test red.
//
// The shapes exercised are the ones production actually produces, taken from
// live NATS KV checkpoints and from the code that writes them:
//   - messages[0].content is a bare STRING (engine.ts pushes fullPrompt)
//   - no leading role:"system" message on the task-dispatch path
//   - assistant messages can END in a thinking block (claude-sonnet-5 runs
//     adaptive thinking by default and supports interleaved thinking)
//   - one user message can carry a whole batch of tool_result blocks

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@claw/protocol";
import {
  planCacheBreakpoints,
  leadingSystemRun,
  MAX_BREAKPOINTS,
  MAX_STRIDE_BLOCKS,
} from "../src/llm/cache-plan.js";

const TTL = { ttl: "1h" as const };

function textBlock(text: string) {
  return { type: "text", text };
}
function toolUse(id: string) {
  return { type: "tool_use", id, name: "bash", input: { command: "echo hi" } };
}
function toolResult(id: string) {
  return { type: "tool_result", tool_use_id: id, content: "ok" };
}
function thinking(text: string) {
  return { type: "thinking", thinking: text, signature: "sig" };
}

/** The production task-dispatch shape: a string first message, then turns. */
function conversation(turns: number): Message[] {
  const out: Message[] = [
    { role: "user", content: "task prompt ".repeat(200) },
  ];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "assistant", content: [thinking(`t${i}`), textBlock(`say ${i}`), toolUse(`c${i}`)] });
    out.push({ role: "user", content: [toolResult(`c${i}`)] });
  }
  return out;
}

test("anchor lands on messages[0] when there is no system message", () => {
  const plan = planCacheBreakpoints(conversation(3), TTL);
  assert.equal(plan.systemRunLength, 0);
  const anchor = plan.breakpoints[0];
  assert.equal(anchor.kind, "message");
  assert.equal(anchor.messageIndex, 0);
  assert.equal(anchor.blockIndex, 0);
  // messages[0].content is a string; the renderer has to widen it before the
  // marker can attach. Losing this flag means marking a character.
  assert.equal(anchor.wrapStringContent, true);
});

test("anchor lands on the last system block when a leading system run exists", () => {
  const msgs: Message[] = [
    { role: "system", content: [textBlock("rules a"), textBlock("rules b")] },
    ...conversation(2),
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  assert.equal(plan.systemRunLength, 1);
  const anchor = plan.breakpoints[0];
  assert.equal(anchor.kind, "system");
  assert.equal(anchor.messageIndex, 0);
  assert.equal(anchor.blockIndex, 1, "the LAST system block, not the first");
  assert.equal(anchor.wrapStringContent, false);
});

test("leadingSystemRun counts only the leading run", () => {
  assert.equal(leadingSystemRun([]), 0);
  assert.equal(leadingSystemRun(conversation(1)), 0);
  assert.equal(
    leadingSystemRun([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "c" },
      { role: "system", content: "not leading" },
    ]),
    2,
  );
});

test("a marker never lands on a thinking block, even when thinking is last", () => {
  // Interleaved thinking: the model emits thinking AFTER the tool_use, so the
  // last block of the assistant message is ineligible. cache_control on a
  // thinking block is an unconditional 400.
  const msgs: Message[] = [
    { role: "user", content: "prompt ".repeat(200) },
    { role: "assistant", content: [thinking("a"), toolUse("c0"), thinking("b")] },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  const onLast = plan.breakpoints.filter((b) => b.messageIndex === 1);
  assert.equal(onLast.length, 1);
  assert.equal(onLast[0].blockIndex, 1, "must fall back to the tool_use at index 1");
});

test("a message with no markable block is skipped entirely", () => {
  const msgs: Message[] = [
    { role: "user", content: "prompt ".repeat(200) },
    { role: "assistant", content: [toolUse("c0")] },
    { role: "user", content: [toolResult("c0")] },
    { role: "assistant", content: [thinking("only thinking")] },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  assert.equal(
    plan.breakpoints.some((b) => b.messageIndex === 3),
    false,
    "the thinking-only message must not be marked",
  );
});

test("the last message being a bare string is marked, not indexed into", () => {
  // The resume hint is appended as {role:"user", content:"[system-notice]: ..."}
  // -- a bare string in LAST position. Indexing into it yields a character and
  // the request 400s on a content block with no `type`.
  const msgs: Message[] = [
    ...conversation(2),
    { role: "user", content: "[system-notice]: workspace was rebuilt" },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  const last = plan.breakpoints.find((b) => b.messageIndex === msgs.length - 1);
  assert.ok(last, "the trailing string message must still be markable");
  assert.equal(last.blockIndex, 0);
  assert.equal(last.wrapStringContent, true);
});

test("consecutive markers stay within the lookback window across a huge tool batch", () => {
  // One user message can hold a whole batch of tool_results. Marking "every
  // message boundary" would put two markers 26 blocks apart while looking
  // correct -- past the 20-block lookback, so the chain silently breaks.
  const big = Array.from({ length: 25 }, (_, i) => toolResult(`c${i}`));
  const msgs: Message[] = [
    { role: "user", content: "prompt ".repeat(200) },
    { role: "assistant", content: Array.from({ length: 25 }, (_, i) => toolUse(`c${i}`)) },
    { role: "user", content: [...big, textBlock("sandbox was rebuilt")] },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);

  // Flatten the same way the planner does so we can measure real distances.
  const flat: Array<{ m: number; b: number }> = [];
  msgs.forEach((msg, m) => {
    if (Array.isArray(msg.content)) msg.content.forEach((_, b) => flat.push({ m, b }));
    else flat.push({ m, b: 0 });
  });
  const idx = (bp: { messageIndex: number; blockIndex: number }) =>
    flat.findIndex((p) => p.m === bp.messageIndex && p.b === bp.blockIndex);

  const rolling = plan.breakpoints.filter((b) => b.messageIndex > 0).map(idx).sort((a, b) => a - b);
  assert.ok(rolling.length >= 2, "expected at least two rolling markers on a 26-block message");
  for (let i = 1; i < rolling.length; i++) {
    assert.ok(
      rolling[i] - rolling[i - 1] <= MAX_STRIDE_BLOCKS,
      `markers ${rolling[i - 1]} and ${rolling[i]} are ${rolling[i] - rolling[i - 1]} blocks apart, > ${MAX_STRIDE_BLOCKS}`,
    );
  }
});

test("never exceeds the API breakpoint cap", () => {
  for (const turns of [0, 1, 2, 5, 40, 400]) {
    const plan = planCacheBreakpoints(conversation(turns), TTL);
    assert.ok(
      plan.breakpoints.length <= MAX_BREAKPOINTS,
      `${turns} turns produced ${plan.breakpoints.length} breakpoints`,
    );
  }
  // An explicit lower cap is honoured too.
  const capped = planCacheBreakpoints(conversation(40), { ttl: "1h", maxBreakpoints: 2 });
  assert.ok(capped.breakpoints.length <= 2);
});

test("breakpoints are unique and ordered front-to-back", () => {
  const plan = planCacheBreakpoints(conversation(40), TTL);
  const keys = plan.breakpoints.map((b) => `${b.messageIndex}:${b.blockIndex}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate breakpoint positions");
  for (let i = 1; i < plan.breakpoints.length; i++) {
    const prev = plan.breakpoints[i - 1];
    const cur = plan.breakpoints[i];
    assert.ok(
      cur.messageIndex > prev.messageIndex
        || (cur.messageIndex === prev.messageIndex && cur.blockIndex > prev.blockIndex),
      "breakpoints must be ordered from the front of the prompt to the back",
    );
  }
});

test("planning is deterministic", () => {
  // streamTurnWithRetry re-enters the provider up to 4 times per turn. A marker
  // that moves between attempts turns every retry from a cache read into a
  // paid cache write.
  const msgs = conversation(12);
  const a = planCacheBreakpoints(msgs, TTL);
  const b = planCacheBreakpoints(msgs, TTL);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("planning does not mutate its input", () => {
  // llmMessages IS this.workingMessages in production (filterResumeNotices
  // returns the same array object at <= 3 notices), and workingMessages is
  // written into the task checkpoint by reference. A mutation here is persisted.
  const msgs = conversation(6);
  const before = JSON.stringify(msgs);
  Object.freeze(msgs);
  msgs.forEach((m) => {
    Object.freeze(m);
    if (Array.isArray(m.content)) {
      Object.freeze(m.content);
      m.content.forEach((b) => Object.freeze(b));
    }
  });
  planCacheBreakpoints(msgs, TTL);
  assert.equal(JSON.stringify(msgs), before);
});

test("degenerate inputs do not throw and produce no bogus markers", () => {
  assert.deepEqual(planCacheBreakpoints([], TTL).breakpoints, []);
  assert.deepEqual(
    planCacheBreakpoints([{ role: "assistant", content: [] }], TTL).breakpoints,
    [],
  );
  assert.deepEqual(
    planCacheBreakpoints([{ role: "user", content: "" }], TTL).breakpoints,
    [],
    "an empty string carries no cacheable text",
  );
  // A single-message conversation: anchor and rolling collapse to one marker.
  const one = planCacheBreakpoints([{ role: "user", content: "hello" }], TTL);
  assert.equal(one.breakpoints.length, 1);
});

test("ttl is carried through to the plan", () => {
  assert.equal(planCacheBreakpoints(conversation(2), { ttl: "5m" }).ttl, "5m");
  assert.equal(planCacheBreakpoints(conversation(2), { ttl: "1h" }).ttl, "1h");
});

/** Flatten the same way the planner does, so distances are comparable. */
function flatIndex(msgs: Message[]): Array<{ m: number; b: number }> {
  const out: Array<{ m: number; b: number }> = [];
  msgs.forEach((msg, m) => {
    if (Array.isArray(msg.content)) msg.content.forEach((_, b) => out.push({ m, b }));
    else out.push({ m, b: 0 });
  });
  return out;
}
function markIndices(msgs: Message[]): number[] {
  const flat = flatIndex(msgs);
  return planCacheBreakpoints(msgs, TTL).breakpoints
    .map((bp) => flat.findIndex((p) => p.m === bp.messageIndex && p.b === bp.blockIndex))
    .sort((a, b) => a - b);
}

test("every marker on the next request can reach one from this request", () => {
  // The property that actually matters, and the one a per-request invariant
  // cannot express: a breakpoint searches backwards at most 20 blocks for an
  // EXISTING entry, and the only entries are the marks the PREVIOUS request
  // wrote. Checking spacing within one request is a proxy that can pass while
  // the chain across requests is broken -- which is what happened: two rolling
  // markers left a 32-block hole on a 51-block turn.
  const LOOKBACK = 20;
  for (const appended of [2, 3, 6, 20, 51]) {
    const before: Message[] = [{ role: "user", content: "task prompt ".repeat(12) }];
    for (let i = 0; i < 4; i++) {
      before.push({ role: "assistant", content: [toolUse(`p${i}`)] });
      before.push({ role: "user", content: [toolResult(`p${i}`)] });
    }
    const half = Math.max(1, Math.floor(appended / 2));
    const after: Message[] = [
      ...before,
      { role: "assistant", content: Array.from({ length: half }, (_, i) => toolUse(`n${i}`)) },
      { role: "user", content: Array.from({ length: appended - half }, (_, i) => toolResult(`n${i}`)) },
    ];

    const prev = markIndices(before);
    const next = markIndices(after);

    // The invariant is NOT "every marker reaches a prior entry" -- markers
    // that land in newly appended territory cannot, because that content did
    // not exist last turn, and that is physics rather than a defect. What must
    // hold is that the DEEPEST entry the previous request wrote is reachable,
    // because that is what makes the whole shared prefix a read instead of a
    // rewrite.
    const deepestPrior = prev[prev.length - 1];
    const reaches = next.some((q) => q >= deepestPrior && q - deepestPrior <= LOOKBACK);
    assert.ok(
      reaches,
      `turn appending ${appended} blocks: nothing reaches the previous request's deepest`
      + ` entry at ${deepestPrior} within ${LOOKBACK}`
      + ` (previous marked ${JSON.stringify(prev)}, this one ${JSON.stringify(next)})`,
    );
  }
});

test("all four breakpoint slots are used once the conversation is long enough", () => {
  // Leaving one of the four unused is a slot forfeited, and it is what opened
  // the hole above.
  const msgs: Message[] = [{ role: "user", content: "prompt ".repeat(12) }];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: "assistant", content: [textBlock(`t${i}`), toolUse(`c${i}`)] });
    msgs.push({ role: "user", content: [toolResult(`c${i}`)] });
  }
  assert.equal(planCacheBreakpoints(msgs, TTL).breakpoints.length, MAX_BREAKPOINTS);
});

test("the anchor stays at the head when messages[1] contributes no blocks", () => {
  // The anchor scope used to be "first block of message 1, minus one", which
  // finds nothing when message 1 has no blocks -- an assistant turn that only
  // called tools, or an empty content array. The scope then collapsed to the
  // whole array and the anchor landed at the TAIL, losing the one marker that
  // is supposed to never move.
  const msgs: Message[] = [
    { role: "user", content: "the stable prompt ".repeat(20) },
    { role: "assistant", content: [] },
    { role: "user", content: [toolResult("c0")] },
    { role: "assistant", content: [textBlock("done")] },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  assert.equal(plan.breakpoints[0].messageIndex, 0, "the anchor must stay on messages[0]");
});

test("the anchor stays at the end of the system run when it contributes blocks unevenly", () => {
  const msgs: Message[] = [
    { role: "system", content: [textBlock("rules a")] },
    { role: "system", content: [] },
    { role: "user", content: "go ".repeat(20) },
    { role: "assistant", content: [textBlock("ok")] },
  ];
  const plan = planCacheBreakpoints(msgs, TTL);
  assert.equal(plan.systemRunLength, 2);
  assert.equal(plan.breakpoints[0].messageIndex, 0, "last markable block inside the system run");
});
