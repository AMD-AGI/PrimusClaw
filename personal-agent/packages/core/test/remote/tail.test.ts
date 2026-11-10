// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Where a session's events end, folded the way the Python worker folded them (`remote/tail.ts`). The expected tails in
// data/tail-golden.json were produced by the Python worker's own fold from the same rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decode } from "../../src/remote/events.js";
import { type EventRow, TAIL_PAGE, readTail } from "../../src/remote/tail.js";

interface Golden {
  readonly rows: EventRow[];
  readonly tail: Record<string, unknown>;
}

const golden = JSON.parse(readFileSync(new URL("data/tail-golden.json", import.meta.url), "utf8")) as Record<
  string,
  Golden
>;
const errors = { publicReason: (reason: string) => reason, withhold: () => "ref" };
const decodeStep = (event: Parameters<typeof decode>[0]) => decode(event, errors);

/** The tail in the Python worker's field names, for comparison with what it produced. */
function asPython(tail: Awaited<ReturnType<typeof readTail>>): Record<string, unknown> {
  return {
    cursor: tail.cursor,
    mode: tail.mode,
    modes: tail.modes,
    unattended: tail.unattended,
    mode_flags: tail.modeFlags,
    read_only: tail.readOnly,
    terminal: tail.terminal,
    active: tail.active,
    steps: tail.steps,
    pending: tail.pending,
    asked: tail.asked,
  };
}

test("the tail of a session is folded as the python worker folds it", async () => {
  for (const [name, { rows, tail }] of Object.entries(golden)) {
    const read = (after: string | null, limit: number) =>
      Promise.resolve(rows.filter((r) => Number(r.id) > Number(after ?? 0)).slice(0, limit));
    assert.deepEqual(asPython(await readTail(read, decodeStep)), tail, name);
  }
});

test("a long history is read page by page from where the last page ended", async () => {
  const rows: EventRow[] = Array.from({ length: TAIL_PAGE + 3 }, (_, i) => ({
    id: String(i + 1),
    type: "agent_message_chunk",
    data: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } },
  }));
  const asked: (string | null)[] = [];
  const read = (after: string | null, limit: number) => {
    asked.push(after);
    return Promise.resolve(rows.filter((r) => Number(r.id) > Number(after ?? 0)).slice(0, limit));
  };
  const tail = await readTail(read, decodeStep);
  assert.deepEqual(asked, [null, String(TAIL_PAGE)]);
  assert.equal(tail.cursor, String(TAIL_PAGE + 3));
  assert.ok(tail.active);
});

// A connector replays the session's history on every reconnect: a page can be all replayed rows. The read must go on past them
// (review of #636: it asked for the same page for ever), while the tail's cursor stays the session's own last event.
test("a page of replayed rows alone is read past and the tail ends", async () => {
  const chunk = (id: number, replay: boolean): EventRow => ({
    id: String(id),
    type: "agent_message_chunk",
    data: {
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      ...(replay ? { replay: true } : {}),
    },
  });
  const rows: EventRow[] = [
    chunk(1, false),
    ...Array.from({ length: TAIL_PAGE }, (_, i) => chunk(i + 2, true)),
    chunk(TAIL_PAGE + 2, true),
  ];
  const asked: (string | null)[] = [];
  const read = (after: string | null, limit: number) => {
    asked.push(after);
    if (asked.length > 5) throw new Error(`asked ${String(asked.length)} times: ${JSON.stringify(asked.slice(0, 5))}`);
    return Promise.resolve(rows.filter((r) => Number(r.id) > Number(after ?? 0)).slice(0, limit));
  };
  const tail = await readTail(read, decodeStep);
  assert.deepEqual(asked, [null, String(TAIL_PAGE)]); // (two pages: the first ends at a replayed row, the next starts after it)
  assert.equal(tail.cursor, "1"); // the session's own last event, as Python's tail says
});
