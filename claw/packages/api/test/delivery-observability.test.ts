// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The delivery alert rules and dashboard the chart ships read only metrics the API exports. A rule over a name nothing
 * exports is never true, so it reads as "all clear" for ever; this is where a rename or a typo on either side is caught.
 *
 *   O1  every claw_* series the rules and the dashboard name is a metric in the API's registry
 *   O2  every delivery metric the API exports is read by a rule or a panel
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registry } from "../src/infra/metrics.js";

const chart = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "charts", "claw");
const rules = fs.readFileSync(path.join(chart, "alerts", "delivery.rules.yaml"), "utf8");
const dashboard = JSON.parse(fs.readFileSync(path.join(chart, "dashboards", "claw-delivery.json"), "utf8")) as { panels: Array<{ targets?: Array<{ expr: string }> }> };

/** The claw_* names in PromQL expressions, without the comments around them. */
const namesIn = (exprs: string[]): Set<string> => new Set(exprs.flatMap((e) => [...e.matchAll(/\b(claw_[a-z0-9_]+)\b/g)].map((m) => m[1])));
/** Each rule's `expr`, a one-liner or a `|` block (the lines indented deeper than the key). */
function exprsOf(yaml: string): string[] {
  const lines = yaml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)expr:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() !== "|") { out.push(m[2]); continue; }
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].match(/^\s*/)![0].length > m[1].length)) block.push(lines[++i].trim());
    out.push(block.join(" "));
  }
  return out;
}
const ruleExprs = exprsOf(rules);
const panelExprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));

test("O1 every series the delivery rules and dashboard read is exported by the API", () => {
  assert.equal(ruleExprs.length, 8, `found ${ruleExprs.length} rule expressions`);
  assert.ok(ruleExprs.every((e) => /claw_[a-z]/.test(e)), "every rule expression names a metric (a block read whole)");
  assert.ok(panelExprs.length >= 8, `found ${panelExprs.length} panel expressions`);
  for (const name of namesIn([...ruleExprs, ...panelExprs])) {
    assert.ok(registry.getSingleMetric(name), `${name} is read by a delivery rule or panel, and the API exports no such metric`);
  }
});

test("O2 every delivery metric is read by a rule or a panel", () => {
  const read = namesIn([...ruleExprs, ...panelExprs]);
  for (const name of [
    "claw_delivery_backlog_oldest_age_seconds", "claw_delivery_backlog_size", "claw_remote_connector_backlog_age_seconds",
    "claw_remote_connector_post_failures", "claw_remote_delivery_stalled", "claw_notification_subscriptions_failing",
    "claw_notification_subscription_failures_max", "claw_remote_events_post_total", "claw_api_event_redelivered_total",
    "claw_api_event_redelivery_oldest_age_seconds", "claw_delivery_stall_notices_total",
  ]) {
    assert.ok(registry.getSingleMetric(name), `${name} is registered`);
    assert.ok(read.has(name), `${name} is exported and nothing reads it`);
  }
});
