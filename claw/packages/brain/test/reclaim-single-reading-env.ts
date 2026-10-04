// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Let idle reclaim act on one jobs-probe reading, before config is imported.
 *
 * Production requires several agreeing sweeps and a quiet window after any
 * failed probe (see src/sandbox/reclaim-evidence.ts). The files that import
 * this are about something else -- the CAS, the run lease, the slot release,
 * the shared verdict -- and each drives a sandbox to the destroy decision in
 * one or two sweeps. The confirmation rule itself is pinned, at its defaults,
 * by keepalive-reclaim-confirm.test.ts. A module imported first is the only
 * ordering hook: ESM hoists imports above any assignment in the test file.
 */

process.env.SANDBOX_RECLAIM_CONFIRM_SWEEPS ??= "1";
process.env.SANDBOX_RECLAIM_QUIET_SECONDS ??= "0";
