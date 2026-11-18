// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The kit passes whatever the hour: the echo surface once more with the wall clock at 23:30 in the default zone, inside a new
 * person's quiet hours, where a pushed notice or approval would be held for anyone who had not turned them off.
 */
import { mock } from "node:test";

import { echoUnderTest } from "./echo-driver.js";
import { surfaceConformance } from "./scenarios.js";

// 2026-11-12 23:30 Asia/Shanghai (only `Date` is replaced: timers and `performance.now()` run as they do)
mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 12, 15, 30) });

surfaceConformance(echoUnderTest("echo, at night"));
