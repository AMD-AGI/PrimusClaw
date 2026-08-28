// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import path from "node:path";
import { WORKSPACE } from "../config.js";

/**
 * Resolve inputPath to an absolute path. Relative paths are resolved against
 * WORKSPACE; absolute paths are returned as-is after normalization.
 *
 * No access restriction — the sandbox container is the security boundary.
 * Tools like read/write/glob need to access mounted volumes (e.g. /shared,
 * /opt) that live outside /workspace.
 */
export function guardPath(inputPath: string): string {
  return path.resolve(WORKSPACE, inputPath);
}
