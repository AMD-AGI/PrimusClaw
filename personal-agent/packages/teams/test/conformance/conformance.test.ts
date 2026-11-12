// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Teams surface passes the surface conformance kit (`test-support/surface-conformance`), on its own worker through the
 * release gate's test entry and the recording Bot Connector: what every surface package must pass.
 */
import { surfaceConformance } from "../../../../test-support/surface-conformance/scenarios.js";
import { teamsUnderTest } from "./teams-driver.js";

surfaceConformance(teamsUnderTest());
