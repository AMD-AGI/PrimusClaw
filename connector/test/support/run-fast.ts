// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw-connector run` in a process of its own, with the fast test timings: for a test that blocks a file the
 * connector writes (a FIFO nobody reads stands in for a network disk that stopped answering), where a blocked
 * synchronous write would freeze the test's own process too. CLAW_CONNECTOR_HOME names its home.
 */
import { main } from "../../src/commands.js";
import { resolveDirs } from "../../src/paths.js";
import { FAST } from "./harness.js";

const code = await main(["run"], {
  dirs: resolveDirs(process.env), env: process.env, timing: { ...FAST, heartbeatMs: 100 },
  out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"),
});
process.exit(code);
