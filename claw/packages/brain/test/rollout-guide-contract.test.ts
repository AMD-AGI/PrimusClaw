// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rollout guide's three executable claims, checked against the guide text.
 *
 * These are content checks, not runtime behaviour: the guide is what an
 * operator runs, and each of the findings below was a step that would pass
 * while proving nothing. A prose document cannot be exercised, but it can be
 * held to naming the right thing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GUIDE = readFileSync(
  new URL("../../../docs/background-shell-rollout.md", import.meta.url), "utf8",
);

test("every helm render resolves the chart the upgrade actually deploys", () => {
  // A step pinned to the in-tree path passes on a chart CLAW_CHART_DIR points
  // somewhere else, which is the supported override the deploy scripts read.
  assert.match(GUIDE, /chart_dir\(\) \{[^}]*CLAW_CHART_DIR/);
  const renders = GUIDE.match(/helm template primus-claw [^\s]+/g) ?? [];
  assert.ok(renders.length >= 2, "P1 and P2 both render");
  for (const render of renders) {
    assert.match(render, /helm template primus-claw "\$\(chart_dir\)"/, render);
  }
  assert.ok(!/helm template[^\n]*claw\/deploy\/charts\/claw/.test(GUIDE),
    "no render may hard-code the default path");
});

test("the rollback runs at the empty-fleet boundary", () => {
  // An empty fleet is the true answer on a low-traffic deployment, and the flip
  // and the Brain restart still have to happen. `jq -e` over `.sessions[]`
  // exits non-zero on exactly that response, which aborted a rollback that had
  // nothing wrong with it.
  assert.match(GUIDE, /An empty file is a valid result and R2–R5\s*\n?\s*continue/);
  assert.match(GUIDE, /A successful read that is empty is not an abort/);
  assert.match(GUIDE, /An empty file means\s*\n?\s*nothing to recycle, which is not a failure/);
  assert.ok(!/jq -e '\.sessions\[\]/.test(GUIDE),
    "the inventory guard must not be a jq -e over the session array");
});

test("the foreground-ceiling stop condition reads a foreground-timeout signal", () => {
  // A killed-run count is not one: a clamped command is answered as a tool
  // result and its run completes normally, so the affected runs are
  // indistinguishable from unaffected ones in every terminal fact exposed.
  assert.match(GUIDE, /claw_bash_foreground_timeout_total\{[^}]*clamped="true"/);
  assert.match(GUIDE, /A count of runs that ended in a killed state is \*\*not\*\* this signal/);
});

test("the absolute-lifetime gate cannot pass on idle reclamation", () => {
  // Three properties, each carried by its own line: every refresh succeeded,
  // the CR was live before the deadline, and its deletion is accepted only at
  // or after it.
  assert.match(GUIDE, /activity dispatch failed; the session is no longer held busy/);
  assert.match(GUIDE, /the session is not being held busy/);
  assert.match(GUIDE, /DEADLINE_EPOCH=\$\(date -d "\$DEADLINE" \+%s\)/);
  assert.match(GUIDE, /now" -ge "\$DEADLINE_EPOCH"/);
  assert.match(GUIDE, /now" -lt "\$DEADLINE_EPOCH"/);
  assert.ok(!/dispatch 'Run: echo alive' >\/dev\/null \|\| true/.test(GUIDE),
    "a loop that discards its own failed dispatches proves nothing about the cap");
});

test("the census both halves of the fleet, and refuses a partial read", () => {
  assert.match(GUIDE, /\(\.unreadable \/\/ error\("no unreadable field"\)\) == 0/);
  assert.match(GUIDE, /\(\.dag_handles \| type\) == "array"/);
  assert.match(GUIDE, /rows \$?\(?"?\$?raw/, "every step iterates rows(), not .sessions[]");
});
