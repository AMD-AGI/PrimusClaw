// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of a session's objects the user is shown.
 *
 * The session prefix holds more than the workspace: presigned zips, uploads with
 * their own expiry, mirrored skill assets, per-run archives, and now Brain's run
 * transcripts. Hiding is decided by one predicate shared by the file listing and
 * the zip download, and getting it wrong is quiet in both directions -- an
 * internal directory shown is clutter, a user's artifact hidden is a file they
 * cannot get at and no error anywhere.
 *
 * The transcripts are the case worth pinning. They moved into `.transcripts/`
 * because the sync could not otherwise tell them from a `.jsonl` a user's own
 * run wrote, and a reserved directory is exactly the shape this predicate hides
 * -- so the storage change would have withdrawn a download that has always
 * worked, as a side effect nobody asked for.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isHiddenSessionFile } from "../src/routes/sessions.js";

test("a run's transcript stays downloadable", () => {
  assert.equal(isHiddenSessionFile(".transcripts/claw-1786000000000.jsonl"), false);
  assert.equal(isHiddenSessionFile(".transcripts/claw-1786000000000-attempt2.jsonl"), false);
});

test("the directories that belong to another lifecycle stay hidden", () => {
  assert.equal(isHiddenSessionFile(".zip-cache/ktsk_1.zip"), true);
  assert.equal(isHiddenSessionFile(".uploads/input.csv"), true);
  assert.equal(isHiddenSessionFile(".skills/pdf/SKILL.md"), true);
  // Nested too: an archive of a past run carries the same directories inside it.
  assert.equal(isHiddenSessionFile("claw-1786000000000/.uploads/input.csv"), true);
});

test("a repository's object store is hidden, wherever the repository is", () => {
  // The snapshot carries .git so a restored sandbox is still a repository; that
  // puts thousands of objects under the session prefix, none of them artifacts.
  assert.equal(isHiddenSessionFile(".git/HEAD"), true);
  assert.equal(isHiddenSessionFile("repo/.git/objects/pack/pack-1.pack"), true);
  // The project's own git-adjacent files are the user's.
  assert.equal(isHiddenSessionFile("repo/.gitignore"), false);
  assert.equal(isHiddenSessionFile("repo/.github/workflows/ci.yml"), false);
  assert.equal(isHiddenSessionFile(".git-notes.md"), false);
});

test("the user's own files are shown", () => {
  assert.equal(isHiddenSessionFile("src/main.py"), false);
  assert.equal(isHiddenSessionFile("results.jsonl"), false);
  // A name that starts the same way is not the directory: the match needs the
  // separator, or a user's `.uploads-notes.md` would vanish from their listing.
  assert.equal(isHiddenSessionFile(".uploads-notes.md"), false);
});
