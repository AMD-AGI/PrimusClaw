// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { main } from "./commands.js";
import { resolveDirs } from "./paths.js";
import type { Connector } from "./connector.js";

let connector: Connector | null = null;
let stopping = false;

/**
 * Only `run` takes over the signals: it has something to wind down (adapters it started). Every other command
 * keeps Node's default, so Ctrl-C ends `login` (a ten-minute poll) or `stop` (a 15 s wait) at once. A second
 * signal while `run` is winding down gives up waiting.
 */
const onSignal = () => {
  if (stopping) process.exit(130);
  stopping = true;
  connector?.stop();
};

main(process.argv.slice(2), {
  dirs: resolveDirs(),
  env: process.env,
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  onConnector: (c) => {
    connector = c;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, onSignal);
  },
}).then((code) => process.exit(code), (e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
