// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `CLAW_MEMORY_DEFAULT_ON` set to true: a user who never chose has memory on; one who chose keeps
 * their choice. The cases are in `support/memory-default-suite.ts`.
 */
import { memoryDefaultSuite } from "./support/memory-default-suite.js";

memoryDefaultSuite(true);
