// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The connector's timings for the tests: short, so a test waits milliseconds where production waits seconds. */
import type { ConnectorTiming } from "../../src/connector.js";

export const FAST: Partial<ConnectorTiming> = {
  heartbeatMs: 150, watchdogMs: 700, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 150, pausePollMs: 40,
  idleMs: 60_000, permissionTtlMs: 60_000, modeConfirmMs: 250,
};
