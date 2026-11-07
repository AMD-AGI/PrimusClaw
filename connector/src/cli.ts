// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { main } from "./commands.js";
import { resolveDirs } from "./paths.js";
import type { Connector } from "./connector.js";
import { probeAgents } from "./probe.js";
import { inheritSystemCa, trustSystemCAs } from "./system-ca.js";

// Before any connection: trust the CAs this machine trusts as well as Node's own list (system-ca.ts), and hand the same
// trust to the processes the connector starts.
inheritSystemCa(process.env, trustSystemCAs(process.env));

let connector: Connector | null = null;

/** A yes/no question at the terminal; only offered when both ends are one (a script or a pipe gets the default, no). */
const ask = process.stdin.isTTY && process.stdout.isTTY
  ? async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-D or Ctrl-C at the question is a no, not a crash. readline takes Ctrl-C as a keystroke (SIGINT on the
    // interface, not the process): without this the question would never settle and init would end silently.
    const ac = new AbortController();
    rl.on("SIGINT", () => { process.stdout.write("\n"); ac.abort(); });
    try { return /^\s*y(es)?\s*$/i.test(await rl.question(question, { signal: ac.signal })); } catch { return false; } finally { rl.close(); }
  }
  : undefined;
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
  cli: fileURLToPath(import.meta.url),
  env: process.env,
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  ask,
  probe: probeAgents,
  installAdapters: true,
  onConnector: (c) => {
    connector = c;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, onSignal);
    // `claw-connector doctor` asks a running connector to check the machine again. SIGWINCH, whose default is to do nothing,
    // so the same ask sent to an older connector that does not listen is harmless.
    process.on("SIGWINCH", () => c.recheckHealth());
  },
}).then((code) => process.exit(code), (e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
