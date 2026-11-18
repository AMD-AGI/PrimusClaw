// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The echo surface (`test-support/echo-surface`, the walkthrough of `docs/adding-a-surface.md`) passes the conformance
 * kit: once with everything it can do, once as a surface that cannot stream, edit, delete or say a message's id.
 */
import { ECHO_CAPS } from "../echo-surface/index.js";
import { echoUnderTest } from "./echo-driver.js";
import { surfaceConformance } from "./scenarios.js";

surfaceConformance(echoUnderTest("echo"));

surfaceConformance(
  echoUnderTest("echo, plain", {
    ...ECHO_CAPS,
    channel: "echo-plain",
    streaming: false,
    edit: false,
    delete: false,
    messageIds: false,
  }),
);
