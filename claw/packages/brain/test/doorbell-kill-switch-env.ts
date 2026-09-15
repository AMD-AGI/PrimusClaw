// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Turn the kill-switch off before config.ts is evaluated.
 *
 * A plain assignment at the top of the test file does not work: ESM hoists
 * every import above it, so config.ts would already have read the environment.
 * A module imported first is evaluated first, which is the only ordering hook
 * available for a setting read at import.
 */

import "./doorbell-api-base-env.js";

process.env.RUN_DOORBELL_DISPATCH = "false";
