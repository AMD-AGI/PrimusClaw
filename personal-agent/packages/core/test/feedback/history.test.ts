// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of the worker-side half of tests/test_feedback_history.py (`feedback.read_history`). */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ClawError,
  HISTORY_MAX_BYTES,
  HISTORY_TAIL,
  LAST_TURNS,
  ReplayRefused,
  readHistory,
  silentLogger,
  type HistoryReader,
  type JsonObject,
  type SseEvent,
} from "@primusclaw/personal-agent";

import { FakeClock } from "../../../../test-support/index.js";

function reader(replay: () => Promise<JsonObject[]>, events: SseEvent[], streamed: string[]): HistoryReader {
  return {
    sessions: {
      events: () => replay(),
      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator stands in for Claw's stream
      stream: async function* (): AsyncGenerator<SseEvent> {
        streamed.push("stream");
        for (const e of events) yield e;
        yield { id: "", name: "historyComplete", data: {} };
        yield { id: "late", name: "statusUpdate", data: {} }; // live events after the history are not read
      },
    },
    clock: new FakeClock(),
    log: silentLogger,
  };
}

test("an older claw whose whole history is too large is refused unread and the stream tail is used", async () => {
  const streamed: string[] = [];
  const events = Array.from({ length: 12_000 }, (_, i) => ({
    id: `e${String(i + 1)}`,
    name: "toolUsed",
    data: { n: i + 1 },
  }));
  const rows = await readHistory(
    reader(() => Promise.reject(new ReplayRefused("too large")), events, streamed),
    "ak-a",
    "s1",
  );
  assert.deepEqual(
    rows.map((r) => (r.data as { n: number }).n),
    Array.from({ length: HISTORY_TAIL }, (_, i) => 12_001 - HISTORY_TAIL + i),
  ); // the stream, its last 200 only
  assert.ok(rows.every((r) => r.created_at === null));
  assert.deepEqual(streamed, ["stream"]);
});

test("a refused key is not retried on the stream", async () => {
  for (const status of [401, 403]) {
    const streamed: string[] = [];
    await assert.rejects(
      readHistory(
        reader(() => Promise.reject(new ClawError(status)), [], streamed),
        "ak-a",
        "s1",
      ),
      (e: unknown) => e instanceof ClawError && e.status === status,
    );
    assert.deepEqual(streamed, []);
  }
});

test("the replay's rows are read as Python reads them", async () => {
  const rows = await readHistory(
    reader(
      () => Promise.resolve([{ event_id: 7, event_type: "toolUsed", data: { a: 1 }, created_at: "x" }, {}]),
      [],
      [],
    ),
    "ak-a",
    "s1",
  );
  assert.deepEqual(rows, [
    { event_id: "7", event_type: "toolUsed", data: { a: 1 }, created_at: "x" },
    { event_id: "", event_type: "", data: undefined, created_at: undefined },
  ]);
});

test("the limits leave room for the worker", () => {
  assert.equal(HISTORY_TAIL, 200);
  assert.equal(HISTORY_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(LAST_TURNS, 2);
});
