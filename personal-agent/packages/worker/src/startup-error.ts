// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A setting the worker cannot work with, found while it is built: the start stops with this error's message (one CRITICAL
 * line, status 1). The surface's own settings stop it the same way.
 */
export class StartupError extends Error {
  override name = "StartupError";
}
