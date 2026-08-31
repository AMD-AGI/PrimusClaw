// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// anthropic-cache.test.ts
//
// prepareAnthropicRequest turns a cache plan into the bytes that go on the
// wire. What matters here is not "a marker exists" but WHERE it lands and
// what it did to the caller's array on the way -- the loop hands us
// workingMessages itself, and that array is checkpointed by reference.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@claw/protocol";
import { prepareAnthropicRequest, renderCacheMarkers, stripCacheControl } from "../src/llm/anthropic-cache.js";
import { MAX_BREAKPOINTS } from "../src/llm/cache-plan.js";

const H = { ttl: "1h" as const };

function convo(turns: number): Message[] {
  const out: Message[] = [{ role: "user", content: "task prompt ".repeat(12) }];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `t${i}`, signature: "s" },
        { type: "tool_use", id: `c${i}`, name: "bash", input: { command: "x" } },
      ],
    });
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "ok" }] });
  }
  return out;
}

function allBlocks(req: { system?: Array<Record<string, unknown>>; messages: Message[] }) {
  const out: Array<Record<string, unknown>> = [...(req.system ?? [])];
  for (const m of req.messages) if (Array.isArray(m.content)) out.push(...m.content);
  return out;
}

test("with no system message the string first message is widened and marked", () => {
  const req = prepareAnthropicRequest(convo(3), H);
  assert.equal(req.system, undefined, "nothing to hoist on the task-dispatch path");
  const head = req.messages[0];
  assert.ok(Array.isArray(head.content), "a string cannot carry cache_control");
  const block = (head.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.type, "text");
  assert.deepEqual(block.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("a leading system run is hoisted to the top-level system parameter", () => {
  const msgs: Message[] = [
    { role: "system", content: [{ type: "text", text: "rules a" }, { type: "text", text: "rules b" }] },
    ...convo(2),
  ];
  const req = prepareAnthropicRequest(msgs, H);
  assert.ok(req.system, "system must be lifted out of messages[]");
  assert.equal(req.messages[0].role, "user", "no role:'system' may remain in messages[]");
  assert.equal(req.messages.some((m) => m.role === "system"), false);
  // The marker anchors the tools+system prefix, so it goes on the LAST block.
  assert.equal(req.system[0].cache_control, undefined);
  assert.deepEqual(req.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("a string system message is widened when hoisted", () => {
  const msgs: Message[] = [{ role: "system", content: "be terse" }, ...convo(1)];
  const req = prepareAnthropicRequest(msgs, H);
  assert.ok(req.system);
  assert.equal(req.system[0].type, "text");
  assert.equal(req.system[0].text, "be terse");
});

test("no marker ever lands on a thinking block", () => {
  const req = prepareAnthropicRequest(convo(6), H);
  for (const b of allBlocks(req)) {
    if (b.type === "thinking" || b.type === "redacted_thinking") {
      assert.equal(b.cache_control, undefined, "cache_control on a thinking block is a 400");
    }
  }
});

test("the rendered body never carries more than the API cap", () => {
  for (const turns of [0, 1, 3, 40, 300]) {
    const req = prepareAnthropicRequest(convo(turns), H);
    const marked = allBlocks(req).filter((b) => "cache_control" in b).length;
    assert.ok(marked <= MAX_BREAKPOINTS, `${turns} turns rendered ${marked} markers`);
    assert.equal(req.breakpointsApplied, marked, "the count must come off the rendered body");
  }
});

test("the caller's messages are never mutated", () => {
  // The decisive one. filterResumeNotices returns this.workingMessages itself
  // at <= 3 notices (the production case is 0), and the checkpoint writes that
  // same array by reference. Object.freeze makes an in-place write throw under
  // ESM strict mode instead of silently persisting.
  const msgs = convo(8);
  const before = JSON.stringify(msgs);
  msgs.forEach((m) => {
    if (Array.isArray(m.content)) m.content.forEach((b) => Object.freeze(b));
    Object.freeze(m.content);
    Object.freeze(m);
  });
  Object.freeze(msgs);

  const req = prepareAnthropicRequest(msgs, H);
  assert.equal(JSON.stringify(msgs), before, "input changed");
  assert.ok(req.breakpointsApplied > 0, "and it still marked something");
});

test("messages the plan did not touch are passed through by identity", () => {
  // Structural sharing is not a micro-optimisation here: these arrays reach
  // 900 messages, and a full clone per turn would be copied again into every
  // checkpoint write.
  const msgs = convo(20);
  const req = prepareAnthropicRequest(msgs, H);
  const changed = msgs.filter((m, i) => req.messages[i] !== m);
  assert.ok(changed.length > 0, "something must have been marked");
  assert.ok(changed.length <= MAX_BREAKPOINTS, `${changed.length} messages copied, expected <= ${MAX_BREAKPOINTS}`);
  for (let i = 0; i < msgs.length; i++) {
    if (req.messages[i] === msgs[i]) continue;
    // A copied message must still share every block it did not mark.
    const src = msgs[i].content as Array<Record<string, unknown>>;
    const dst = req.messages[i].content as Array<Record<string, unknown>>;
    if (!Array.isArray(src)) continue;
    const shared = dst.filter((b, j) => b === src[j]).length;
    assert.ok(shared >= dst.length - 1, "only the marked block may be replaced");
  }
});

test("5m renders the bare ephemeral marker, 1h adds the ttl field", () => {
  const five = prepareAnthropicRequest(convo(2), { ttl: "5m" });
  const oneH = prepareAnthropicRequest(convo(2), { ttl: "1h" });
  const marker = (r: ReturnType<typeof prepareAnthropicRequest>) =>
    allBlocks(r).find((b) => "cache_control" in b)!.cache_control;
  assert.deepEqual(marker(five), { type: "ephemeral" }, "5m is the default: no ttl field");
  assert.deepEqual(marker(oneH), { type: "ephemeral", ttl: "1h" });
});

test("stripCacheControl removes every marker and keeps the rest intact", () => {
  const msgs: Message[] = [{ role: "system", content: "rules" }, ...convo(4)];
  const req = prepareAnthropicRequest(msgs, H);
  assert.ok(req.breakpointsApplied > 0);
  const bare = stripCacheControl(req);
  assert.equal(bare.breakpointsApplied, 0);
  assert.equal(allBlocks(bare).filter((b) => "cache_control" in b).length, 0);
  // Everything except the markers must survive: same system text, same
  // message count, same block payloads.
  assert.equal(bare.messages.length, req.messages.length);
  assert.equal(bare.system?.length, req.system?.length);
  // Everything but the markers survives. Compare against the rendered request
  // with cache_control deep-deleted, rather than re-planning: the point is
  // that stripping changes exactly one thing.
  const expectSystem = JSON.parse(JSON.stringify(req.system), (k, v) => (k === "cache_control" ? undefined : v));
  const expectMessages = JSON.parse(JSON.stringify(req.messages), (k, v) => (k === "cache_control" ? undefined : v));
  assert.deepEqual(bare.system, expectSystem);
  assert.deepEqual(bare.messages, expectMessages);
});

test("degenerate inputs render without throwing", () => {
  assert.deepEqual(prepareAnthropicRequest([], H).messages, []);
  const empty = prepareAnthropicRequest([{ role: "assistant", content: [] }], H);
  assert.equal(empty.breakpointsApplied, 0);
});

test("a marker the planner asks for but the renderer refuses is not counted", () => {
  // plan and render cannot disagree on any input the planner produces today.
  // Injecting a plan that points at a thinking block is the only way to
  // exercise the refusal, and it is the regression breakpointsApplied exists
  // to catch: a future planner change that starts selecting a block type the
  // wire format rejects must show up as a shortfall, not as a silent success.
  const msgs: Message[] = [
    { role: "user", content: "prompt" },
    { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
  ];
  const bogus = {
    ttl: "1h" as const,
    systemRunLength: 0,
    breakpoints: [
      { kind: "message" as const, messageIndex: 0, blockIndex: 0, wrapStringContent: true },
      { kind: "message" as const, messageIndex: 1, blockIndex: 0, wrapStringContent: false },
    ],
  };
  const req = renderCacheMarkers(msgs, bogus);
  const thinkingBlock = (req.messages[1].content as Array<Record<string, unknown>>)[0];
  assert.equal(thinkingBlock.cache_control, undefined, "must refuse to mark a thinking block");
  assert.equal(req.breakpointsApplied, 1, "the refused marker must not be counted");
});
