// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// notification-metrics.test.ts
//
// The notification counters are exported at 0 before anything is delivered or quarantined. Prometheus can only see a
// quarantine as an increase if it has seen the series at 0 first: a series that first appears at 1 reads as no increase,
// and ClawNotificationQuarantined (claw/deploy/promql/notification-outbox.rules.yaml) would miss a pod's first quarantine.
// This file runs in its own process, so the registry here is the one a pod has just after start-up.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  metrics, registry, NOTIFICATION_DELIVERY_OUTCOMES, NOTIFICATION_QUARANTINE_REASONS,
} from "../src/infra/metrics.js";

/** The value of one exported sample, or undefined when the series is not exported at all. */
function exported(text: string, name: string, label: string, value: string): number | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`)) continue;
    if (!line.includes(`${label}="${value}"`)) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return undefined;
}

test("every quarantine reason and delivery outcome is exported at 0 before anything happens", async () => {
  const text = await registry.metrics();
  for (const reason of NOTIFICATION_QUARANTINE_REASONS) {
    assert.equal(exported(text, "claw_notification_quarantined_total", "reason", reason), 0, reason);
  }
  for (const outcome of NOTIFICATION_DELIVERY_OUTCOMES) {
    assert.equal(exported(text, "claw_notification_delivery_total", "outcome", outcome), 0, outcome);
  }
});

test("a quarantine then moves the series from 0 to 1", async () => {
  metrics.onNotificationQuarantined("isolated_failures");
  const text = await registry.metrics();
  assert.equal(exported(text, "claw_notification_quarantined_total", "reason", "isolated_failures"), 1);
  assert.equal(exported(text, "claw_notification_delivery_total", "outcome", "quarantined"), 1);
  assert.equal(exported(text, "claw_notification_delivery_total", "outcome", "delivered"), 0);
});
