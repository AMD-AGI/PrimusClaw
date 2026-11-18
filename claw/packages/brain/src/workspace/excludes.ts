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
 * find out, so the reserved names are listed in claw/README.md under
 * "Reserved Workspace Paths"; anything added here belongs there too.
 *
 * The reverse does not hold, and reading the README as this list is how it went
 * wrong before. Reserving a name and dropping it from the snapshot are separate
 * decisions: `.zip-cache/` is reserved and is uploaded and restored like any
 * other directory, and `.skills/` is left out of the shared-filesystem snapshot
 * alone. The README says which of the two each name is, so a name added there
 * needs no entry here unless it is really meant to vanish.
 */

import { WORKSPACE_EXCLUDES } from "@claw/protocol";

// The list itself lives in @claw/protocol, shared with Hands' grep.
export { TOOL_RESULTS_DIR, WORKSPACE_EXCLUDES } from "@claw/protocol";

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

/**
 * Where a user's personal skills are written in the sandbox: `.skills/.personal-skills/<name>/`. Left out of every
 * destination, the S3 archive included. A personal skill is the user's own text, served to their own turns only; the
 * archive is a copy of the session, and what a copy of a session carries (sharing, copying, forking it) must not be
 * where the user's skills reach someone else. Its source is the API, so nothing is lost: the next turn that needs one
 * writes it again.
 */
export const PERSONAL_SKILLS_DIR = ".personal-skills";

/** Exclusions for the shared-filesystem snapshot, which is restored onto an image. */
export function sharedDiskExcludes(): string[] {
  return [...WORKSPACE_EXCLUDES, SKILLS_DIR, PERSONAL_SKILLS_DIR];
}

/** Exclusions for the S3 archive, which keeps per-session skill state (but not the user's personal skills). */
export function s3Excludes(): string[] {
  return [...WORKSPACE_EXCLUDES, PERSONAL_SKILLS_DIR];
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
