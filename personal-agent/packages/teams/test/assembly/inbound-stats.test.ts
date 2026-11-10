// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The inbound path's `inbound_stats` line (Python `InboundStats(metrics=...)`), with every count also in /metrics. */
import assert from "node:assert/strict";
import { it } from "node:test";

import { InboundStats } from "@primusclaw/personal-agent";
import { PrometheusMetrics } from "@primusclaw/personal-agent-runtime";

import { FakeClock } from "../../../../test-support/clock.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { withInboundStats } from "../../src/assembly/worker.js";

it("a minute of handled messages and refusals is one inbound_stats line, and each is counted in /metrics too", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const prometheus = new PrometheusMetrics(clock);
  const metrics = withInboundStats(prometheus, new InboundStats(clock, logger, prometheus));
  metrics.processed(120, 40, true);
  metrics.limited("rate_limit");
  await clock.advance(61_000);
  metrics.processed(null, 10, false);
  const line = logger.lines.find((l) => l.message === "inbound_stats");
  assert.ok(line !== undefined, JSON.stringify(logger.lines));
  assert.deepEqual([line.fields["handled"], line.fields["failed"], line.fields["rate_limited"]], [2, 1, 1]);
  assert.match(prometheus.render(), /clawy_inbound_handled_total 2/);
});
