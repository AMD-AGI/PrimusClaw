// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { AUDIT_EXCEPTIONS, failingAdvisories, gate } from "../scripts/audit-gate.js";

/** An `npm audit --json` report naming `advisories` (id, severity), each on its own package. */
function report(...advisories: Array<[string, string]>): unknown {
  const entries: Array<[string, unknown]> = [];
  for (const [id, severity] of advisories) {
    entries.push([
      `pkg-${id}`,
      {
        name: `pkg-${id}`,
        severity,
        via: [
          {
            source: 1,
            name: `pkg-${id}`,
            title: `advisory ${id}`,
            url: `https://github.com/advisories/${id}`,
            severity,
          },
        ],
      },
    ]);
    // A package that is vulnerable only through another one names it by string: not an advisory of its own.
    entries.push([`dependent-of-${id}`, { name: `dependent-of-${id}`, severity, via: [`pkg-${id}`] }]);
  }
  return { auditReportVersion: 2, vulnerabilities: Object.fromEntries(entries), metadata: {} };
}

const EXCEPTED = "GHSA-fc5q-39xc-vjpf";
const NONE = report();

test("the exception list holds the picomatch advisory only, until 2026-12-18", () => {
  assert.deepEqual(
    AUDIT_EXCEPTIONS.map((e) => [e.id, e.expires]),
    [[EXCEPTED, "2026-12-18"]],
  );
});

test("high and critical advisories are read once each; moderate and lower are not", () => {
  const r = report(["GHSA-a", "high"], ["GHSA-b", "critical"], ["GHSA-c", "moderate"]);
  assert.deepEqual(
    failingAdvisories(r)
      .map((a) => a.id)
      .sort(),
    ["GHSA-a", "GHSA-b"],
  );
  assert.deepEqual(failingAdvisories(null), []);
});

test("the excepted advisory in development dependencies only passes until it expires", () => {
  const dev = report([EXCEPTED, "high"]);
  for (const today of ["2026-11-18", "2026-12-18"]) {
    const r = gate(dev, NONE, today);
    assert.equal(r.ok, true, today);
    assert.match(r.lines.join("\n"), /::warning::GHSA-fc5q-39xc-vjpf .*excepted until 2026-12-18/);
  }
});

test("the excepted advisory in the production dependencies fails", () => {
  const r = gate(report([EXCEPTED, "high"]), report([EXCEPTED, "high"]), "2026-11-18");
  assert.equal(r.ok, false);
  assert.match(
    r.lines.join("\n"),
    /::error::GHSA-fc5q-39xc-vjpf .*in the production dependencies; its exception covers development dependencies only/,
  );
  // Reported by the production audit alone, it still fails.
  assert.equal(gate(NONE, report([EXCEPTED, "high"]), "2026-11-18").ok, false);
});

test("the excepted advisory fails from the day after its exception expires", () => {
  const r = gate(report([EXCEPTED, "high"]), NONE, "2026-12-19");
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /::error::GHSA-fc5q-39xc-vjpf .*its exception expired on 2026-12-18/);
});

test("any other high or critical advisory fails, in development dependencies too", () => {
  assert.equal(gate(report(["GHSA-other", "high"]), NONE, "2026-11-18").ok, false);
  assert.equal(gate(report(["GHSA-other", "critical"], [EXCEPTED, "high"]), NONE, "2026-11-18").ok, false);
  assert.equal(gate(report(["GHSA-other", "moderate"]), NONE, "2026-11-18").ok, true);
  assert.deepEqual(gate(NONE, NONE, "2026-11-18"), { ok: true, lines: [] });
});
