// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a workspace snapshot leaves behind, for every destination.
 *
 * There used to be two lists, one in the shared-filesystem sync and one in the
 * S3 upload, and they had drifted into disagreeing about most of their
 * contents: the shared disk dropped `.cache`, `.runtime`, `hsa`, `worktree`,
 * `__pycache__` and `torchinductor_*` while S3 uploaded all of them; S3 dropped
 * `*.o` and `.task-venv` while the shared disk kept them. Neither divergence
 * was intended -- each list had simply been extended when whichever path hurt
 * at the time. The visible effect was that restoring from the two destinations
 * gave different workspaces, and that S3 was carrying gigabytes of ROCm kernel
 * objects and compile caches that are regenerated on first use anyway.
 *
 * So there is one list. The single deliberate difference is `.skills`, and it
 * is expressed here rather than by having a second list.
 *
 * The names here are reserved from the user's point of view: one of their own
 * directories called `.uploads` or `.transcripts` is silently dropped from the
 * snapshot and gone in the next sandbox. That is only defensible if they can
 * find out, so the reserved names are listed in the repository README under
 * "Reserved Workspace Paths"; anything added here belongs there too.
 *
 * The reverse does not hold, and reading the README as this list is how it went
 * wrong before. Reserving a name and dropping it from the snapshot are separate
 * decisions: `.zip-cache/` is reserved and is uploaded and restored like any
 * other directory, and `.skills/` is left out of the shared-filesystem snapshot
 * alone. The README says which of the two each name is, so a name added there
 * needs no entry here unless it is really meant to vanish.
 */

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
 */
export const WORKSPACE_EXCLUDES = [
  // Version control and dependency trees.
  ".git",
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
  // Historical bootstrap artefact (~100MB) from Brain releases that wrote the
  // Hands binary into /workspace. Current Brain puts it under /tmp; kept
  // because old workspaces still have one.
  ".hands-binary",
  // Where bootstrap redirects the Hands process's own output. It is Brain's
  // log that happens to live in the user's directory, and bootstrap truncates
  // it at every launch -- so a snapshot carrying it forward preserves whatever
  // fragment the previous sandbox had reached, under a name that reads like
  // the current one's.
  "hands.log",
] as const;

/**
 * The one deliberate divergence.
 *
 * `/workspace/.skills/` is left off the shared filesystem because the sandbox
 * image provides it: restoring a snapshot would overlay a stale copy onto
 * whatever the image shipped. It is uploaded to S3 because that copy is an
 * archive rather than something restored on top of an image, and the
 * per-session skill state is worth keeping for traceability. The API's file
 * listing hides it from the frontend either way.
 */
export const SKILLS_DIR = ".skills";

/** Exclusions for the shared-filesystem snapshot, which is restored onto an image. */
export function sharedDiskExcludes(): string[] {
  return [...WORKSPACE_EXCLUDES, SKILLS_DIR];
}

/** Exclusions for the S3 archive, which keeps per-session skill state. */
export function s3Excludes(): string[] {
  return [...WORKSPACE_EXCLUDES];
}

/** `rsync --exclude` arguments. A trailing slash would stop a pattern matching files. */
export function rsyncExcludeArgs(patterns: string[]): string {
  return patterns.map((p) => `--exclude '${p}'`).join(" \\\n    ");
}

/** `tar --exclude` arguments, matching rsync's reach via tar's unanchored default. */
export function tarExcludeArgs(patterns: string[]): string {
  return patterns.map((p) => `--exclude='${p}'`).join(" ");
}

/**
 * `find` predicates equivalent to the same patterns.
 *
 * `find` has no exclude flag, so each pattern becomes a negated test: a
 * directory name prunes anything beneath it, and a glob matches a final path
 * component. Built from the same list so the S3 upload cannot quietly diverge
 * from the shared-disk sync again.
 */
export function findExcludeArgs(patterns: string[]): string {
  return patterns
    .map((p) =>
      p.includes("*")
        // A glob is a filename pattern for a leaf, except when it names a
        // directory family like torchinductor_*, which has to prune too.
        ? `-not -name '${p}' -not -path '*/${p}/*'`
        : `-not -path '*/${p}/*' -not -path '*/${p}'`,
    )
    .join(" ");
}
