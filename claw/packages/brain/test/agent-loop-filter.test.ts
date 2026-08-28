// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// agent-loop-filter.test.ts
//
// §5.4.1 NP1-2: filterResumeNotices keeps the most recent K
// "[system-notice]:" user messages and drops earlier ones, while
// leaving every non-notice message untouched. Verifies:
//   - no-op when ≤ K notices are present
//   - drops earlier notices when > K are present, preserving order
//   - does NOT touch other user messages (no false positive on
//     normal user prompts that happen to mention the prefix string
//     mid-content)
//   - non-string content (tool_use blocks) is treated as non-notice

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@claw/protocol";
import { filterResumeNotices } from "../src/agent/agent-loop.js";
import { registry } from "../src/infra/metrics.js";

// NP1-2 metric existence check: reading the prom-client registry by
// metric name proves the counter is registered AND scrapable from the
// brain /metrics endpoint. A silent drop of `registers: [registry]`
// would surface here as `getSingleMetric` returning undefined.
async function getResumeNoticeFilteredCount(): Promise<number> {
  const metric = registry.getSingleMetric("claw_brain_resume_notice_filtered_total");
  if (!metric) return NaN;
  const v = await metric.get();
  return v.values[0]?.value ?? 0;
}

const N = "[system-notice]: ";

function notice(body: string): Message { return { role: "user", content: `${N}${body}` }; }
function user(body: string): Message { return { role: "user", content: body }; }
function assistant(body: string): Message { return { role: "assistant", content: body }; }

test("≤ 3 notices: returns original array reference", () => {
  const msgs: Message[] = [notice("a"), user("hello"), notice("b"), assistant("hi")];
  const out = filterResumeNotices(msgs);
  // Implementation is allowed to return either the same reference OR
  // a new array of identical length; assert on equivalence + length.
  assert.equal(out.length, msgs.length);
  assert.deepEqual(out, msgs);
});

test("> 3 notices: keeps the last 3, drops earlier ones", () => {
  const msgs: Message[] = [
    notice("a"), notice("b"), notice("c"),
    user("hello"),
    notice("d"), notice("e"),
    assistant("hi"),
  ];
  const out = filterResumeNotices(msgs);
  const noticesOut = out.filter((m) =>
    m.role === "user"
    && typeof m.content === "string"
    && (m.content as string).startsWith(N),
  );
  assert.equal(noticesOut.length, 3);
  assert.deepEqual(
    noticesOut.map((m) => m.content),
    [`${N}c`, `${N}d`, `${N}e`],
  );
});

test("preserves non-notice ordering when dropping notices", () => {
  const msgs: Message[] = [
    notice("a"),
    user("U1"),
    notice("b"),
    assistant("A1"),
    notice("c"),
    user("U2"),
    notice("d"),
    notice("e"),
  ];
  const out = filterResumeNotices(msgs);
  // Non-notice messages remain in their original order
  const nonNotice = out.filter((m) =>
    !(m.role === "user"
      && typeof m.content === "string"
      && (m.content as string).startsWith(N)),
  );
  assert.deepEqual(
    nonNotice.map((m) => m.content),
    ["U1", "A1", "U2"],
  );
});

test("does not flag normal user messages that merely mention the prefix mid-content", () => {
  const msgs: Message[] = [
    user(`embedded reference to ${N}foo`),
    notice("a"),
    notice("b"),
    notice("c"),
    notice("d"),
  ];
  const out = filterResumeNotices(msgs);
  // The embedded-reference user message MUST survive even though we
  // dropped one of the four notices.
  assert.ok(
    out.some((m) =>
      m.role === "user"
      && typeof m.content === "string"
      && (m.content as string).startsWith("embedded reference"),
    ),
    "non-notice user message wrongly dropped",
  );
});

test("NP1-2 metric ticks once per filter pass that dropped notices", async () => {
  // Establish baseline AFTER prior tests; the in-process registry is
  // a module singleton so earlier "> 3 notices" tests will have already
  // incremented the counter. We assert the delta, not the absolute.
  const before = await getResumeNoticeFilteredCount();
  // Pass that drops: 5 notices, KEEP_RECENT=3 → 2 drops, 1 pass.
  filterResumeNotices([
    notice("a"), notice("b"), notice("c"), notice("d"), notice("e"),
  ]);
  const afterDrop = await getResumeNoticeFilteredCount();
  assert.equal(afterDrop - before, 1, "expected +1 tick after a drop pass");
  // Pass that does NOT drop: 2 notices, KEEP_RECENT=3 → 0 drops, no tick.
  filterResumeNotices([notice("a"), notice("b")]);
  const afterNoDrop = await getResumeNoticeFilteredCount();
  assert.equal(afterNoDrop - afterDrop, 0, "expected no tick when nothing dropped");
});

test("non-string content (assistant tool_use blocks) is left intact", () => {
  const toolBlock: Message = {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] as unknown as string,
  };
  const msgs: Message[] = [
    notice("a"), notice("b"), notice("c"), notice("d"),
    toolBlock,
  ];
  const out = filterResumeNotices(msgs);
  // The tool_use block must still be the last message after filtering.
  assert.equal(out[out.length - 1].role, "assistant");
  assert.equal(
    Array.isArray(out[out.length - 1].content),
    true,
    "tool_use content array must survive",
  );
});
