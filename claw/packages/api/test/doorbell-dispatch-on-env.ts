// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Declare the deployment's intent before config.ts is read.
 *
 * The flag is read at import, so a plain assignment in the test file does not
 * work: ESM hoists every import above it. A module imported first is evaluated
 * first, which is the only ordering hook available.
 */

process.env.RUN_DOORBELL_DISPATCH = "true";
