// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Turn sweeper eviction on before config is imported.
 *
 * It defaults to 0 -- disabled -- so a test of what the sweeper destroys would
 * otherwise assert against a path that never runs. A module imported first is
 * the only ordering hook: ESM hoists imports above any assignment in the test
 * file itself.
 */

process.env.SANDBOX_SWEEPER_EVICT_AFTER_FAILURES ??= "1";
