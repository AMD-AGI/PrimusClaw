// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FILES_DROPPED_PATHS, SecurityLog, silentLogger, type SecurityEventName } from "@primusclaw/personal-agent";
import { FakeClock } from "../../../../test-support/index.js";
import { ALERTED, CONTENT_TYPE, HELP, PrometheusMetrics } from "../../src/index.js";

const AAD = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
// A label value is a closed-list word: lower case and `_`, or, for the histograms, an event type or a bucket bound; a
// value is a count, or a histogram's sum of seconds.
const SAMPLE = /^([a-z_]+)(\{([a-z_]+="[a-z_.0-9+A-Z]*"(,[a-z_]+="[a-z_.0-9+A-Z]*")*)\})? (\d+(?:\.\d+)?)$/;

/** name and sorted labels -> value, failing on any line that is not the text format. */
function samples(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of text.split("\n").filter((l) => l !== "")) {
    if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) continue;
    const m = SAMPLE.exec(line);
    assert.ok(m, `not a sample line: ${line}`);
    const labels = (m[3] ?? "")
      .split(",")
      .filter((p) => p !== "")
      .map((p) => p.replace(/"/g, ""))
      .sort();
    found.set(`${m[1] ?? ""}|${labels.join(",")}`, Number(m[5]));
  }
  return found;
}

const key = (name: string, labels: Readonly<Record<string, string>> = {}): string =>
  `${name}|${Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(",")}`;

function world() {
  const clock = new FakeClock();
  const metrics = new PrometheusMetrics(clock);
  const log = new SecurityLog(silentLogger, metrics);
  const event = (name: string, labels: Readonly<Record<string, string>> = {}): number | undefined =>
    samples(metrics.render()).get(key("clawy_security_events_total", { event: name, ...labels }));
  return { clock, metrics, log, event };
}

describe("security events counted", () => {
  it("counts lockouts by scope", () => {
    const { log, event } = world();
    log.event("link_lockout", { aad_object_id: AAD, scope: "global", count: 100, limit: 100, window_seconds: 600 });
    for (let i = 0; i < 3; i++) {
      log.event("link_lockout", { aad_object_id: AAD, scope: "user", count: 5, limit: 5, window_seconds: 600 });
    }
    assert.equal(event("link_lockout", { scope: "global" }), 1);
    assert.equal(event("link_lockout", { scope: "user" }), 3);
  });

  it("counts rate limits by reason", () => {
    const { log, event } = world();
    log.event("rate_limited", {
      aad_object_id: AAD,
      operation: "message",
      reason: "user_limit",
      scope: "user",
      limit: 20,
    });
    log.event("rate_limited", {
      aad_object_id: AAD,
      operation: "pr_review",
      reason: "concurrency_limit",
      scope: "user",
    });
    log.event("rate_limited", {
      aad_object_id: AAD,
      operation: "claw_turn",
      reason: "concurrency_limit",
      scope: "user",
    });
    assert.equal(event("rate_limited", { scope: "user", reason: "user_limit" }), 1);
    assert.equal(event("rate_limited", { scope: "user", reason: "concurrency_limit" }), 2);
  });

  it("counts link attempts by outcome", () => {
    const { log, event } = world();
    for (const outcome of ["wrong", "wrong", "success", "expired"])
      log.event("link_attempt", { aad_object_id: AAD, outcome });
    assert.equal(event("link_attempt", { outcome: "wrong" }), 2);
    assert.equal(event("link_attempt", { outcome: "success" }), 1);
    assert.equal(event("link_attempt", { outcome: "expired" }), 1);
  });

  it("counts unlinked keys by reason", () => {
    const { log, event } = world();
    log.event("key_unlinked", { aad_object_id: AAD, reason: "rejected" });
    log.event("key_unlinked", { aad_object_id: AAD, reason: "user_request" });
    assert.equal(event("key_unlinked", { reason: "rejected" }), 1);
    assert.equal(event("key_unlinked", { reason: "user_request" }), 1);
  });
});

describe("security event labels", () => {
  it("counts every event, whatever the logger lets through", () => {
    const { log, event } = world(); // the silent logger drops every line
    log.event("link_attempt", { outcome: "wrong" });
    assert.equal(event("link_attempt", { outcome: "wrong" }), 1);
  });

  it("has no label that names a person or carries free text", () => {
    const { log, metrics } = world();
    log.event("link_lockout", {
      aad_object_id: AAD,
      activity_id: "act-secret-1",
      conversation_id: "19:conv@thread.v2",
      scope: "user",
      repo: "AMD-AGI/Primus",
      tool: "bash",
    });
    log.event("rate_limited", { aad_object_id: AAD, reason: "something a caller made up", scope: "user" });
    metrics.securityEvent({ event: "rate_limited", scope: "user", reason: 'x"} 1\nevil' });
    metrics.securityEvent({ event: "not_an_event" as SecurityEventName, scope: "user" });
    const text = metrics.render();
    for (const leaked of [AAD, "act-secret-1", "19:conv", "Primus", "bash", "made up", "evil", "not_an_event"]) {
      assert.ok(!text.includes(leaked), leaked);
    }
    const found = [...samples(text).keys()];
    const names = new Set(
      found.flatMap((k) =>
        (k.split("|")[1] ?? "")
          .split(",")
          .filter(Boolean)
          .map((p) => p.split("=")[0]),
      ),
    );
    for (const name of names)
      assert.ok(["event", "scope", "outcome", "reason", "type", "le", "path"].includes(name ?? ""));
    const paths = found.filter((k) => k.startsWith("clawy_files_dropped_total|")).map((k) => k.split("path=")[1]);
    assert.deepEqual(paths.sort(), [...FILES_DROPPED_PATHS].sort());
  });

  it("writes the alerted series before their first event", () => {
    const { event, metrics } = world();
    assert.equal(event("link_lockout", { scope: "global" }), 0);
    const found = samples(metrics.render());
    for (const [name, labels] of ALERTED) {
      assert.ok(found.has(key("clawy_security_events_total", { event: name, ...Object.fromEntries(labels) })), name);
    }
  });
});

describe("files and inbound counted", () => {
  it("counts dropped files where they were dropped, and only there", () => {
    const { metrics } = world();
    const dropped = (path: string): number | undefined =>
      samples(metrics.render()).get(key("clawy_files_dropped_total", { path }));
    for (const path of FILES_DROPPED_PATHS) assert.equal(dropped(path), 0, "every series exists before its first file");
    metrics.filesDropped("assistant", 2);
    metrics.filesDropped("unreadable");
    metrics.filesDropped("somewhere a caller made up", 5);
    metrics.filesDropped("session", 0);
    assert.deepEqual([dropped("assistant"), dropped("unreadable"), dropped("session")], [2, 1, 0]);
    assert.ok(!metrics.render().includes("made up"));
  });

  it("keeps the longest wait of the last minute as the lag gauge", async () => {
    const { clock, metrics } = world();
    const lag = (): number | undefined => samples(metrics.render()).get(key("clawy_inbound_lag_max_ms"));
    metrics.processed(5000, 10, true);
    await clock.advance(20_000);
    metrics.processed(90000, 10, true);
    await clock.advance(20_000);
    metrics.processed(1000, 10, true);
    assert.equal(metrics.lagMaxMs(), 90000);
    await clock.advance(41_000); // the 90 s wait was handled 61 s ago
    assert.equal(metrics.lagMaxMs(), 1000);
    await clock.advance(20_000);
    assert.equal(metrics.lagMaxMs(), 0);
    assert.equal(lag(), 0);
    metrics.processed(null, 10, true); // no enqueue time: handled, no lag
    assert.equal(metrics.lagMaxMs(), 0);
    assert.equal(metrics.handled, 4);
  });

  it("counts refusals by a limit by reason", () => {
    const { metrics } = world();
    metrics.limited("user_limit");
    metrics.limited("concurrency_limit");
    metrics.limited("concurrency_limit");
    metrics.limited("a reason a caller made up"); // counted as user_limit, never under its own name
    const found = samples(metrics.render());
    assert.equal(found.get(key("clawy_inbound_limited_total", { reason: "user_limit" })), 2);
    assert.equal(found.get(key("clawy_inbound_limited_total", { reason: "concurrency_limit" })), 2);
  });

  it("gives every series its help and type", () => {
    const text = new PrometheusMetrics(new FakeClock()).render();
    const names = new Set(
      [...samples(text).keys()].map((k) => {
        const name = k.split("|")[0] ?? "";
        const base = name.replace(/_(bucket|sum|count)$/, "");
        return base !== name && HELP[base]?.[0] === "histogram" ? base : name;
      }),
    );
    assert.deepEqual([...names].sort(), Object.keys(HELP).sort());
    for (const [name, [kind]] of Object.entries(HELP)) {
      assert.ok(text.includes(`# TYPE ${name} ${kind}\n`) && text.includes(`# HELP ${name} `), name);
    }
    assert.equal(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  });
});

describe("the text the Python worker wrote", () => {
  it("is written byte for byte", async () => {
    // data/python-render.txt is `Metrics.render()` of the Python worker after the same calls.
    const clock = new FakeClock();
    const m = new PrometheusMetrics(clock);
    m.securityEvent({ event: "link_attempt", outcome: "wrong" });
    m.securityEvent({ event: "rate_limited", scope: "user", reason: "user_limit" });
    m.securityEvent({ event: "merge_confirmed", outcome: "confirmed" });
    m.securityEvent({ event: "approval_answered" });
    m.securityEvent({ event: "token_rejected", reason: "expired", scope: "global", outcome: "failure" });
    m.processed(5000, 250, true);
    await clock.advance(1000);
    m.processed(null, 10, false);
    m.processed(1200, 7, true);
    m.limited("concurrency_limit");
    m.limited("made_up");
    m.filesDropped("review", 3);
    m.eventDelivered("assistant.say", 0.3, 4.2);
    m.eventDelivered("assistant.say", 7.123456, null);
    m.eventDelivered("weird", 0.5, -2.0);
    m.eventDelivered("approval.requested", 65.0, 0.0004);
    const expected = readFileSync(new URL("data/python-render.txt", import.meta.url), "utf8");
    assert.equal(m.render(), expected);
  });
});
