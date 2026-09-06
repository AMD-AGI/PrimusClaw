// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * That the guide reaches for the executable helpers rather than restating them.
 *
 * The decisions themselves are exercised in rollout-lib.test.ts, against
 * `claw/deploy/rollout-lib.sh`. What is left here is the one thing that cannot
 * be: whether the document an operator actually follows uses that file. A guide
 * that pastes its own copy of `chart_dir` is a second implementation nothing
 * runs, which is the shape every finding below started as.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GUIDE = readFileSync(
  new URL("../../../docs/background-shell-rollout.md", import.meta.url), "utf8",
);

test("the guide sources the helper library instead of restating it", () => {
  assert.match(GUIDE, /\. claw\/deploy\/rollout-lib\.sh/);
  for (const fn of ["chart_dir", "inventory_judge", "inventory_rows", "deadline_verdict"]) {
    assert.ok(!new RegExp(`^${fn}\\(\\) \\{`, "m").test(GUIDE),
      `${fn} must be used from the library, not redefined in prose`);
  }
});

test("every helm render resolves the chart the upgrade actually deploys", () => {
  // A step pinned to the in-tree path passes on a chart CLAW_CHART_DIR points
  // somewhere else, which is the supported override the deploy scripts read.
  const renders = GUIDE.match(/helm template primus-claw [^\n]+/g) ?? [];
  assert.ok(renders.length >= 2, "P1 and P2 both render");
  for (const render of renders) {
    assert.match(render, /helm template primus-claw "\$\(chart_dir [^)]+\)"/, render);
  }
  assert.ok(!/helm template[^\n]*claw\/deploy\/charts\/claw/.test(GUIDE),
    "no render may hard-code the default path");
});

test("the enablement step names every setting Brain refuses to start without", () => {
  // Following the guide has to produce a Brain that starts. Both capacity
  // settings are required with the flag on and the chart ships them empty.
  const enable = GUIDE.slice(GUIDE.indexOf("## 3. Enable"), GUIDE.indexOf("## 4. Gates"));
  for (const key of [
    "BG_SHELL_ENABLED", "SANDBOX_KEEPALIVE_TARGET_CEILING", "SANDBOX_KEEPALIVE_RECONCILE_RESERVE",
  ]) {
    assert.ok(enable.includes(key), `${key} must be set in the same change as the flag`);
  }
});

test("the rollback runs at the empty-fleet boundary", () => {
  // An empty fleet is the true answer on a low-traffic deployment, and the flip
  // and the Brain restart still have to happen. `jq -e` over `.sessions[]`
  // exits non-zero on exactly that response, which aborted a rollback that had
  // nothing wrong with it.
  assert.match(GUIDE, /An empty file is a valid result and R2–R5\s*\n?\s*continue/);
  assert.match(GUIDE, /A successful read that is empty is not an\s+abort/);
  assert.match(GUIDE, /An empty file means\s*\n?\s*nothing to recycle, which is not a failure/);
  assert.ok(!/jq -e '\.sessions\[\]/.test(GUIDE),
    "the inventory guard must not be a jq -e over the session array");
});

test("the metrics read covers every replica, not whichever the service picked", () => {
  // The counter is process-local and BRAIN is the Service, so a baseline read
  // and a soak read can land on different replicas and compare two different
  // populations.
  assert.match(GUIDE, /brain_pods\(\) \{/);
  assert.match(GUIDE, /for ip in \$\(brain_pods\)/);
  assert.ok(!/curl[^\n]*"\$BRAIN\/metrics"/.test(GUIDE),
    "no metrics read may go through the load-balanced Service");
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
  assert.match(GUIDE, /DEADLINE_EPOCH=\$\(date -d "\$DEADLINE" \+%s\)/);
  assert.match(GUIDE, /SEEN_LIVE=true/, "the live observation is recorded, not inferred");
  assert.match(GUIDE, /deadline_verdict "\$state" "\$SEEN_LIVE"/);
  assert.match(GUIDE, /settle_verdict "\$\(settle "\$tid"\)" "\$ACTIVITY_MARKER"/,
    "judged against a token only the sandbox can produce: a task that completed, "
      + "or counted a call, or attempted one that failed, is none of them a refresh");
  assert.match(GUIDE, /ACTIVITY_MARKER=/, "and the marker is defined where the gates can see it");
  assert.ok(!/dispatch 'Run: echo alive' >\/dev\/null \|\| true/.test(GUIDE),
    "a loop that discards its own failed dispatches proves nothing about the cap");
});

test("every gate's helpers are defined once, in the guide or the library", () => {
  // `sb`, `cr`, `dispatch` and `settle` were used by the gates and defined
  // nowhere, so a step could not be run as written.
  for (const fn of ["sb", "cr", "dispatch", "settle", "probe", "inventory"]) {
    assert.ok(new RegExp(`^${fn}\\(\\) \\{`, "m").test(GUIDE), `${fn} is undefined`);
  }
  assert.match(GUIDE, /inventory_rows/, "every step iterates the rows helper, not .sessions[]");
});
