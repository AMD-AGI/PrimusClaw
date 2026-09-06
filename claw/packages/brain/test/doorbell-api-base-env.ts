// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Give the claim client an API base before it is imported.
 *
 * Without one `taskActionUrl` returns an empty string and every claim in these
 * files fails for a reason that has nothing to do with what they test. A
 * module imported first is the only ordering hook: ESM hoists imports above
 * any assignment in the test file itself.
 */

process.env.INTERNAL_BACKEND_URL ??= "http://api.invalid";
