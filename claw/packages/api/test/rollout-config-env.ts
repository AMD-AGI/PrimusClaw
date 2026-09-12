// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Give this file's process a fully-enabled rollout before config.js is read.
 *
 * The ceilings and the doorbell flag are module-scope constants evaluated once
 * at import, so an assignment in the test body would run too late. A module
 * imported first is the only ordering hook: ESM hoists imports above every
 * statement in the importing file.
 */

process.env.RUN_DOORBELL_DISPATCH = "true";
process.env.ADMIT_SOFT_RUNS = "5";
process.env.ADMIT_HARD_SANDBOXES = "7";
