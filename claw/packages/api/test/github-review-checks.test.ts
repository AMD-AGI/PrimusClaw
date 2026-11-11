// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Whether the head commit is green: what counts, and what must never be read as green. */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateChecks, requiredContextsFromRules } from "../src/github-review/checks.js";

const run = (name: string, status = "completed", conclusion: string | null = "success") => ({ name, status, conclusion });
const base = { statuses: [], required: [], truncated: false };

test("green needs at least one check, and every one passing", () => {
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("a"), run("b", "completed", "skipped"), run("c", "completed", "neutral")] }).green, true);
  const none = evaluateChecks({ ...base, checkRuns: [] });
  assert.equal(none.green, false);
  assert.match(none.reasons.join(), /no check has reported/);
});

test("every other conclusion is a failure, an unfinished run is pending, and neither is green", () => {
  for (const c of ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]) {
    const v = evaluateChecks({ ...base, checkRuns: [run("a"), run("b", "completed", c)] });
    assert.equal(v.green, false, c);
    assert.equal(v.summary.failed, 1, c);
  }
  for (const s of ["queued", "in_progress", "waiting"]) {
    const v = evaluateChecks({ ...base, checkRuns: [run("a"), run("b", s, null)] });
    assert.equal(v.green, false, s);
    assert.equal(v.summary.pending, 1, s);
  }
});

test("the same name twice: the worse result stands", () => {
  const v = evaluateChecks({ ...base, checkRuns: [run("a", "completed", "success"), run("a", "completed", "failure")] });
  assert.equal(v.green, false);
});

test("commit statuses count too: success passes, pending waits, failure and error fail", () => {
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("a")], statuses: [{ context: "ci/x", state: "success" }] }).green, true);
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("a")], statuses: [{ context: "ci/x", state: "pending" }] }).summary.pending, 1);
  for (const state of ["failure", "error"]) {
    assert.equal(evaluateChecks({ ...base, checkRuns: [run("a")], statuses: [{ context: "ci/x", state }] }).green, false, state);
  }
});

test("a required check that never reported is missing, and one that did not pass is not green", () => {
  const missing = evaluateChecks({ ...base, checkRuns: [run("lint")], required: ["test"] });
  assert.equal(missing.green, false);
  assert.deepEqual(missing.summary.requiredMissing, ["test"]);
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("test", "completed", "failure")], required: ["test"] }).green, false);
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("test")], required: ["test"] }).green, true);
});

test("required checks that could not be read, and more checks than were read, are not green", () => {
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("a")], required: null }).green, false);
  assert.equal(evaluateChecks({ ...base, checkRuns: [run("a")], truncated: true }).green, false);
});

test("required contexts come from the rulesets of the branch, and a shape this does not understand is unreadable", () => {
  assert.deepEqual(requiredContextsFromRules([
    { type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }, { context: "lint" }, { context: "test" }] } },
  ]), ["test", "lint"]);
  assert.deepEqual(requiredContextsFromRules([]), []);
  assert.equal(requiredContextsFromRules(null), null);
  assert.equal(requiredContextsFromRules({}), null);
  assert.equal(requiredContextsFromRules([{ type: "required_status_checks", parameters: {} }]), null);
  assert.equal(requiredContextsFromRules([{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }]), null);
});

test("a failed check the base branch does not require is advisory when the rules require something; never when they require nothing", () => {
  // Primus-SaFE#873 (2026-11-11): only "Block Sensitive Secrets Scan" is required; codecov/patch was red and held the approval back.
  const runs = [run("Block Sensitive Secrets Scan"), run("Test SaFE Modules")];
  const statuses = [{ context: "codecov/patch", state: "failure" }];
  const v = evaluateChecks({ ...base, checkRuns: runs, statuses, required: ["Block Sensitive Secrets Scan"] });
  assert.equal(v.green, true, v.reasons.join("; "));
  assert.deepEqual([v.summary.failed, v.summary.failedNames, v.summary.advisoryFailed], [1, ["codecov/patch"], ["codecov/patch"]]);
  // The required one failing is red, and so is any failure where nothing is required, or the rules could not be read.
  const red = evaluateChecks({ ...base, checkRuns: [run("Block Sensitive Secrets Scan", "completed", "failure")], statuses, required: ["Block Sensitive Secrets Scan"] });
  assert.equal(red.green, false);
  assert.match(red.reasons.join(), /1 check\(s\) failed: Block Sensitive Secrets Scan/);
  for (const required of [[], null]) {
    const v2 = evaluateChecks({ ...base, checkRuns: runs, statuses, required });
    assert.equal(v2.green, false, JSON.stringify(required));
    assert.deepEqual(v2.summary.advisoryFailed, []);
  }
  // A check that has not finished is never advisory: a review does not approve before CI is done.
  const pending = evaluateChecks({ ...base, checkRuns: [...runs, run("e2e", "in_progress", null)], required: ["Block Sensitive Secrets Scan"] });
  assert.equal(pending.green, false);
  assert.deepEqual(pending.summary.pendingNames, ["e2e"]);
  assert.match(pending.reasons.join(), /not finished: e2e/);
});

test("GitHub's UNSTABLE lets a merge through only when CI is green apart from advisory failures; the audit names the checks that held it", async () => {
  const { mergeStateOpen, ciEvidence } = await import("../src/github-review/service.js");
  const green = evaluateChecks({ ...base, checkRuns: [run("test")], statuses: [{ context: "codecov/patch", state: "failure" }], required: ["test"] });
  const allGreen = evaluateChecks({ ...base, checkRuns: [run("test")], required: ["test"] });
  const red = evaluateChecks({ ...base, checkRuns: [run("test", "completed", "failure")], required: ["test"] });
  assert.equal(mergeStateOpen({ mergeStateStatus: "CLEAN", checks: allGreen }), true);
  assert.equal(mergeStateOpen({ mergeStateStatus: "UNSTABLE", checks: green }), true);
  assert.equal(mergeStateOpen({ mergeStateStatus: "UNSTABLE", checks: allGreen }), false, "UNSTABLE with nothing advisory is something this did not read");
  assert.equal(mergeStateOpen({ mergeStateStatus: "UNSTABLE", checks: red }), false);
  for (const s of ["BLOCKED", "DIRTY", "BEHIND", "UNKNOWN"]) assert.equal(mergeStateOpen({ mergeStateStatus: s, checks: green }), false, s);
  const held = evaluateChecks({ ...base, checkRuns: [run("test", "completed", "failure"), run("e2e", "queued", null)], statuses: [{ context: "codecov/patch", state: "failure" }], required: ["test"] });
  assert.deepEqual(ciEvidence(held.summary), ["ci_failed: test", "ci_pending: e2e"], "an advisory failure did not hold it, so it is not named");
  assert.deepEqual(ciEvidence(undefined), []);
});

test("a run with a conclusion is finished whatever its status says (PrimusClaw#712: in_progress with conclusion success, and its finished twin)", () => {
  const v = evaluateChecks({ ...base, required: ["test"], checkRuns: [
    run("test"),
    run("enforce withHandsTimeout in workspace-sync/reaper", "in_progress", "success"),
    run("enforce withHandsTimeout in workspace-sync/reaper", "completed", "success"),
  ] });
  assert.equal(v.green, true, v.reasons.join("; "));
  assert.deepEqual([v.summary.pending, v.summary.pendingNames], [0, []]);
  // The same shape with a failing conclusion is a failure, and a run with no conclusion yet still waits.
  assert.deepEqual(evaluateChecks({ ...base, checkRuns: [run("a", "in_progress", "failure")] }).summary.failedNames, ["a"]);
  assert.deepEqual(evaluateChecks({ ...base, checkRuns: [run("a", "in_progress", null)] }).summary.pendingNames, ["a"]);
});
