// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * /claw-events for a person the worker cannot reach (Python test_reviewer_reach, the endpoint part): 410 where Claw
 * takes it as dropped, 200 "dropped" for an older Claw; and how long a delivered event took, counted in the metrics.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openTestStore } from "../../../../test-support/store.js";
import { clawEventsRoute } from "../../src/http/claw-events.js";
import type { HttpResponse } from "../../src/http/routes.js";
import { PrometheusMetrics } from "../../src/metrics/prometheus-metrics.js";
import type { SqliteStore } from "../../src/sqlite/store.js";
import type { FakeClock } from "../../../../test-support/clock.js";
import { linkedAlice, RecordingSink, signed } from "./fixtures.js";

const NOW_MS = Date.UTC(2023, 10, 14, 22, 13, 20);

function completed(extra: Record<string, string> = {}) {
  return {
    event_id: "ev-1",
    type: "run.completed",
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: "u-alice",
    session_id: "s1",
    ...extra,
  };
}

function route(store: SqliteStore, clock: FakeClock, gone: boolean, metrics?: PrometheusMetrics) {
  return clawEventsRoute({
    notifySubs: store.notifySubs,
    links: store.links,
    references: store.references,
    claims: store.idempotency,
    deliver: new RecordingSink().deliver,
    clock,
    gone,
    ...(metrics ? { metrics } : {}),
  });
}

function answer(r: HttpResponse): [number, unknown] {
  return [r.status, "json" in r ? r.json : r.text];
}

test("an event for a person with no chat is 410 with the switch on", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store, false);
  const r = route(store, clock, true);
  assert.deepEqual(answer(await r.handle(signed(clock, completed()))), [410, { error: "no_chat", status: "dropped" }]);
  // (not this user's: nowhere to go either)
  const other = await r.handle(signed(clock, completed({ event_id: "ev-2", user_id: "nobody" })));
  assert.equal(other.status, 410);
});

test("without the switch it is 200 dropped as an older claw needs", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store, false);
  assert.deepEqual(answer(await route(store, clock, false).handle(signed(clock, completed()))), [
    200,
    { status: "dropped" },
  ]);
});

test("a delivered event is counted with how long it took", async () => {
  const { store, clock } = openTestStore();
  clock.setEpochMs(NOW_MS);
  linkedAlice(store);
  const metrics = new PrometheusMetrics(clock);
  const r = route(store, clock, false, metrics);
  // (now is 22:13:20Z: 3 s before)
  assert.equal((await r.handle(signed(clock, completed({ occurred_at: "2023-11-14T22:13:17Z" })))).status, 200);
  const text = metrics.render();
  assert.ok(text.includes('clawy_event_to_chat_seconds_count{type="run.completed"} 1'), text);
  assert.ok(text.includes('clawy_event_to_chat_seconds_bucket{type="run.completed",le="3"} 1'));
  assert.ok(text.includes('clawy_event_to_chat_seconds_bucket{type="run.completed",le="2"} 0'));
  assert.ok(text.includes('clawy_event_handle_seconds_count{type="run.completed"} 1'));
});

test("an event that did not reach the chat is not counted", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store, false);
  const metrics = new PrometheusMetrics(clock);
  await route(store, clock, false, metrics).handle(signed(clock, completed()));
  assert.ok(metrics.render().includes('clawy_event_to_chat_seconds_count{type="run.completed"} 0'));
});
