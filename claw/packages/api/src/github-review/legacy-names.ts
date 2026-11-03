// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Names an earlier release of this feature wrote, kept only so that what it left behind is still understood. They are read and never
 * written: a review it posted keeps its marker, and a repository that already carries its configuration file keeps it working.
 * `test/github-review-public-tree.test.ts` bans the product name everywhere in this feature except on the `export const` lines below.
 */

/** The prefix of the hidden marker that an earlier release put in a review; the run, the event and a digest follow it. */
export const LEGACY_RUN_MARKER_PREFIX = "clawy:run";
/** The stem of the repository configuration file an earlier release read, `.github/<stem>.yml`. Plain letters only: it is put into a pattern. */
export const LEGACY_REPO_CONFIG_STEM = "clawy";
