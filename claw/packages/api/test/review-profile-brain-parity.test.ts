// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review profile is written twice: the API puts it on the task (`github-review/review-profile.ts`) and Brain applies it again from the
 * mark alone (`brain/src/agent/review-profile.ts`), allowing only what both allow. A tool on one list and not the other is offered by
 * neither, so the two must be the same list; Brain's closed-set guard (`brain/test/review-profile-wait.test.ts`) holds its half to
 * "bash and bash_output mean wait too", and this holds the API's half to Brain's. Brain's module imported here is the pure one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_PROFILE_TOOLS } from "../../brain/src/agent/review-profile.js";
import { reviewProfileTools } from "../src/github-review/review-profile.js";

test("the API's review profile with a sandbox is Brain's, wait included", () => {
  assert.deepEqual(reviewProfileTools(true), [...REVIEW_PROFILE_TOOLS]);
  assert.ok(reviewProfileTools(true).includes("wait"), "a review told to background a build and wait for it may wait");
});
