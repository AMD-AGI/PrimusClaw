// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An ES module run by plain node, as dist/cli.js is: six reads of FIFOs nobody writes (a network disk that stopped
 * answering holds a libuv thread for each), then a DNS lookup, which needs a thread of the same pool. Prints the
 * lookup's milliseconds, or "stuck" after 2 s. Run it with SIGKILL ready: the stuck reads keep it from exiting.
 */
import dns from "node:dns";
import fsp from "node:fs/promises";

for (const f of process.argv.slice(2)) void fsp.readFile(f).catch(() => {});
const t0 = Date.now();
const r = await Promise.race([
  new Promise((resolve) => dns.lookup("localhost", () => resolve(String(Date.now() - t0)))),
  new Promise((resolve) => setTimeout(() => resolve("stuck"), 2_000)),
]);
process.stdout.write(`${r}\n`);
