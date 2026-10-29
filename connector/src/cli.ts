// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { main } from "./commands.js";
import { resolveDirs } from "./paths.js";
import type { Connector } from "./connector.js";

let connector: Connector | null = null;
const stop = () => connector?.stop();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);

main(process.argv.slice(2), {
  dirs: resolveDirs(),
  env: process.env,
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  onConnector: (c) => { connector = c; },
}).then((code) => process.exit(code), (e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
