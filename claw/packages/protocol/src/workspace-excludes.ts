// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a workspace snapshot leaves behind (Brain's workspace/excludes.ts says how each
// destination applies it). Here because Hands' recursive grep skips the same trees:
// they are large, not work, and one list cannot drift from the other.

/**
 * Dropped from every destination.
 *
 * Three kinds of thing, and it is worth keeping them straight when adding to
 * this list:
 *
 *   - Regenerable build and compile output. Costs inode count and sync time,
 *     and on a large ROCm workspace was enough to push the sync past its
 *     timeout, which loses the whole snapshot rather than part of it.
 *   - Dependency trees, which are large, restorable from a manifest, and
 *     frequently not valid on the machine they would be restored onto.
 *   - Things owned by another lifecycle. `.uploads` has its own expiry managed
 *     by the upload sweeper, and copying it forward would keep refreshing the
 *     timestamps that expiry is based on.
 *
 * Written as bare component names: both rsync's trailing-slash patterns and
 * tar's default unanchored matching drop a name at any depth, and the `find`
 * predicates below are built to match.
 *
 * `.git` is not on this list, and was until it cost someone their commits: a
 * repository is the one dependency-shaped tree that holds work no manifest can
 * regenerate. It is carried, within a size bound, by Brain's `workspace/git-dirs.ts`, which is
 * also where the rule for git's own transient files lives -- a bare `*.lock`
 * here would drop the user's `yarn.lock`.
 */
/**
 * Where a tool result too long for the conversation is kept whole, under
 * /workspace (Brain's tools/router.ts spillToolResult). For the sandbox that produced
 * it: potentially large, and re-created by running the command again.
 */
export const TOOL_RESULTS_DIR = ".tool-results";

export const WORKSPACE_EXCLUDES = [
  // Dependency trees.
  "node_modules",
  ".task-venv",
  // Caches and other regenerable state.
  ".cache",
  ".runtime",
  "__pycache__",
  "torchinductor_*",
  // ROCm gfx kernel code objects and per-specialist git checkouts. Both are
  // rebuilt on demand and both are enormous in inode terms.
  "hsa",
  "worktree",
  "*.co",
  "*.o",
  // Owned by another lifecycle, or an artefact of one.
  ".uploads",
  // Brain writes the run transcripts straight to S3 under this name, and both
  // S3 filters read the whole directory as Brain's: nothing under it is
  // restored, and nothing under it is ever pruned. A sandbox path of the same
  // name would be uploaded into that directory and inherit both, leaving the
  // user with a file they cannot get back and cannot delete. Excluding it here
  // is what makes "no sandbox writes here" a fact rather than an assumption.
  ".transcripts",
  TOOL_RESULTS_DIR,
  // Historical bootstrap artefact (~100MB) from Brain releases that wrote the
  // Hands binary into /workspace. Current Brain puts it under /tmp; kept
  // because old workspaces still have one.
  ".hands-binary",
  // Where bootstrap used to redirect the Hands process's own output. Kept so a
  // workspace snapshotted before the log moved into the Hands-owned state area
  // does not carry the old file forward, under a name that reads like a current
  // one's.
  "hands.log",
] as const;
