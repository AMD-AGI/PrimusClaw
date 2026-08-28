// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one list, and the shapes it has to take.
 *
 * There were two lists, and they had drifted into disagreeing about most of
 * their contents -- the shared disk dropped compile caches that S3 uploaded,
 * S3 dropped object files the shared disk kept. Restoring from the two
 * destinations gave different workspaces. What is pinned here is that there is
 * now one source, that each destination's syntax is derived from it rather
 * than written out again, and that the single intentional difference stays
 * single.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKSPACE_EXCLUDES,
  SKILLS_DIR,
  sharedDiskExcludes,
  s3Excludes,
  rsyncExcludeArgs,
  tarExcludeArgs,
  findExcludeArgs,
} from "../src/workspace/excludes.js";

test("the destinations differ over .skills and nothing else", () => {
  const shared = new Set(sharedDiskExcludes());
  const s3 = new Set(s3Excludes());

  assert.deepEqual([...shared].filter((p) => !s3.has(p)), [SKILLS_DIR]);
  assert.deepEqual([...s3].filter((p) => !shared.has(p)), []);
});

test("both destinations drop what the workspace can regenerate", () => {
  // The entries that motivated unifying: S3 was carrying gigabytes of ROCm
  // kernel objects and compile caches that are rebuilt on first use, because
  // only the shared-disk list had learned to skip them.
  for (const pat of ["hsa", "worktree", "__pycache__", "torchinductor_*", "*.co", "*.o", ".cache"]) {
    assert.ok(WORKSPACE_EXCLUDES.includes(pat as never), `common list missing ${pat}`);
    assert.ok(s3Excludes().includes(pat), `S3 upload no longer skips ${pat}`);
    assert.ok(sharedDiskExcludes().includes(pat), `shared disk no longer skips ${pat}`);
  }
});

test("what another lifecycle owns is left alone by both", () => {
  // Re-uploading .uploads/ would refresh the timestamps its expiry is based
  // on, so the sweeper would never collect any of it.
  assert.ok(WORKSPACE_EXCLUDES.includes(".uploads" as never));
  // The transcript directory is Brain's, and the S3 filters treat everything
  // under it as Brain's: never restored, never pruned. So a sandbox path of that
  // name must not reach it, or the user gets a file that cannot come back and
  // cannot be deleted.
  assert.ok(WORKSPACE_EXCLUDES.includes(".transcripts" as never));
  assert.ok(findExcludeArgs(s3Excludes()).includes("-not -path '*/.transcripts/*'"));
  // Brain's own artefacts in the user's directory: the binary bootstrap used to
  // leave there, and the log it still redirects Hands into. Neither is the
  // user's content, and both were found in a real snapshot.
  for (const pat of [".hands-binary", "hands.log"]) {
    assert.ok(WORKSPACE_EXCLUDES.includes(pat as never), `common list missing ${pat}`);
  }
});

test("rsync patterns are quoted and unanchored", () => {
  const args = rsyncExcludeArgs([".git", "*.co"]);
  assert.match(args, /--exclude '\.git'/);
  assert.match(args, /--exclude '\*\.co'/);
  // No trailing slash: that form matches directories only, and the list has
  // file patterns in it too.
  assert.doesNotMatch(args, /--exclude '\.git\/'/);
});

test("tar patterns reach the same depth as rsync's", () => {
  // tar's default is --no-anchored, so a bare component name drops that name
  // at any depth, which is what the rsync patterns do.
  const args = tarExcludeArgs([".git", "torchinductor_*"]);
  assert.match(args, /--exclude='\.git'/);
  assert.match(args, /--exclude='torchinductor_\*'/);
});

test("find predicates prune directories and match leaf globs", () => {
  const args = findExcludeArgs([".git", "*.co", "torchinductor_*"]);

  // find has no exclude flag; a directory name has to prune its whole subtree.
  assert.ok(args.includes("-not -path '*/.git/*'"));
  assert.ok(args.includes("-not -path '*/.git'"));
  // A glob matches a final path component...
  assert.ok(args.includes("-not -name '*.co'"));
  // ...but a glob that names a family of directories has to prune as well,
  // which is what torchinductor_* is.
  assert.ok(args.includes("-not -path '*/torchinductor_*/*'"));
});

test("every pattern survives into every syntax", () => {
  // The failure this guards against is a pattern that is in the list but
  // silently absent from one destination's rendering, which is the shape the
  // original divergence had.
  const patterns = sharedDiskExcludes();
  const rsync = rsyncExcludeArgs(patterns);
  const tar = tarExcludeArgs(patterns);
  const find = findExcludeArgs(patterns);
  for (const p of patterns) {
    assert.ok(rsync.includes(`'${p}'`), `rsync missing ${p}`);
    assert.ok(tar.includes(`'${p}'`), `tar missing ${p}`);
    assert.ok(find.includes(p), `find missing ${p}`);
  }
});
