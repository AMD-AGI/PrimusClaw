// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Re-exported so this package's callers keep one import path while the table
 * itself lives beside the record shape, which Brain reads over the exec channel
 * and must classify identically.
 */
export {
  PROTECTED_CLASSES, callerVisibleClass, classifyShellRecord,
  type EpochFreshness, type ProcessView, type RegistryView,
  type ShellClass, type ShellEvidence,
} from "@claw/protocol";
