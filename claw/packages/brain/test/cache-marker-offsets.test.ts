// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// cache-marker-offsets.test.ts
//
// Where the markers landed, not just how many there were.
//
// `breakpointsApplied` sits at its healthy maximum while the chain those
// markers form is broken -- the break is a DISTANCE, two consecutive markers
// further apart than the provider's lookback, which a single turn appending
// many blocks can open in one step. The offsets are what make that visible,
// and they are only true of the turn that failed: by the next turn the plan
// has rolled and the evidence is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@claw/protocol";
import { prepareAnthropicRequest, stripCacheControl } from "../src/llm/anthropic-cache.js";

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

/** Every block the request carries, in the order the flat walk visits them. */
function flatBlocks(req: ReturnType<typeof prepareAnthropicRequest>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [...(req.system ?? [])];
  for (const m of req.messages) {
    out.push(...(Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]));
  }
  return out;
}

test("offsets address the marked blocks in the flat walk", () => {
  const req = prepareAnthropicRequest(convo(6), H);
  const blocks = flatBlocks(req);

  assert.equal(req.totalBlocks, blocks.length, "the walk must cover every block sent");
  assert.equal(req.markerBlockOffsets.length, req.breakpointsApplied,
    "one offset per applied marker, or the two disagree about the same request");

  for (const off of req.markerBlockOffsets) {
    assert.ok(off >= 0 && off < req.totalBlocks, `offset ${off} outside the walk`);
    assert.ok("cache_control" in blocks[off], `offset ${off} does not address a marked block`);
  }
  const marked = blocks.reduce((n, b, i) => n + (("cache_control" in b) && !req.markerBlockOffsets.includes(i) ? 1 : 0), 0);
  assert.equal(marked, 0, "every marked block must have an offset");
});

test("offsets are ascending, so consecutive differences are the gaps", () => {
  const req = prepareAnthropicRequest(convo(8), H);
  const offs = req.markerBlockOffsets;
  for (let i = 1; i < offs.length; i++) {
    assert.ok(offs[i] > offs[i - 1], `offsets out of order at ${i}: ${offs.join(",")}`);
  }
});

test("a string-content message occupies a slot even though it cannot be marked", () => {
  // Skipping unmarkable blocks would shorten every gap measured past them and
  // make a broken chain read as a healthy one.
  const msgs: Message[] = [
    { role: "user", content: "plain string" },
    { role: "assistant", content: "another plain string" },
    { role: "user", content: [{ type: "text", text: "block form" }] },
  ];
  const req = prepareAnthropicRequest(msgs, H);
  assert.equal(req.totalBlocks, 3, "one block each, strings included");
});

test("a wide append opens a gap the count cannot show", () => {
  // Two requests, same marker count, different chain health. If the count were
  // the only signal these would be indistinguishable.
  const narrow = prepareAnthropicRequest(convo(6), H);

  const wide = convo(6);
  wide.push({
    role: "assistant",
    content: Array.from({ length: 60 }, (_, i) => (
      { type: "tool_use", id: `p${i}`, name: "bash", input: { command: "x" } }
    )),
  });
  const req = prepareAnthropicRequest(wide, H);

  const maxGap = (r: ReturnType<typeof prepareAnthropicRequest>) => {
    const o = r.markerBlockOffsets;
    if (o.length === 0) return r.totalBlocks;
    let g = o[0];
    for (let i = 1; i < o.length; i++) g = Math.max(g, o[i] - o[i - 1]);
    return Math.max(g, r.totalBlocks - o[o.length - 1]);
  };

  assert.ok(maxGap(req) > maxGap(narrow),
    `a 60-block append must widen the largest gap: wide=${maxGap(req)} narrow=${maxGap(narrow)}`);
});

test("stripCacheControl clears the offsets it invalidates and keeps the walk length", () => {
  // The undecorated retry sends a request with no markers at all. Offsets left
  // over from the decorated attempt would claim markers were sent on a request
  // that carried none -- the provider zeroes the count on this path, and these
  // have to move with it.
  const req = prepareAnthropicRequest(convo(4), H);
  assert.ok(req.markerBlockOffsets.length > 0, "precondition: the decorated request had markers");

  const bare = stripCacheControl(req);
  assert.deepEqual(bare.markerBlockOffsets, [], "no markers were sent, so no offsets");
  assert.equal(bare.breakpointsApplied, 0);
  assert.equal(bare.totalBlocks, req.totalBlocks, "stripping markers does not change the block count");
  assert.equal(flatBlocks(bare).some((b) => "cache_control" in b), false);
});
