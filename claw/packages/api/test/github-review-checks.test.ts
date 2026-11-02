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
