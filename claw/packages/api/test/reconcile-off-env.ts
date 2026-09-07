// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Refuse the fat-dispatch reconciliation contract before config.ts is read.
 *
 * The setting is read at import, so a plain assignment in the test file does
 * not work: ESM hoists every import above it. A module imported first is
 * evaluated first, which is the only ordering hook available.
 */

process.env.RUN_FAT_PREPARING_RECONCILE = "false";
