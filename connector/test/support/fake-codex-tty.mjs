// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Stands in for the Codex TUI under a real pseudo-terminal (`script`): it holds the terminal on its stdin and reads it, as the
// TUI does, and runs the approval hook as Codex does (the event on the hook's stdin, the decision on its stdout).
// Prints `READY <tty> <pid>`; on SIGUSR1 runs the hook (argv[2..] after `--`) with the event in FAKE_CODEX_EVENT and prints
// `HOOK <exit code> <base64 stdout>`.
import { spawn } from "node:child_process";
import fs from "node:fs";

const tty = fs.readlinkSync("/proc/self/fd/0");
process.stdin.on("data", () => {});
process.stdout.write(`READY ${tty} ${process.pid}\n`);
process.on("SIGUSR1", () => {
  const [cmd, ...args] = process.argv.slice(process.argv.indexOf("--") + 1);
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(process.env.FAKE_CODEX_EVENT);
  child.on("exit", (code) => { process.stdout.write(`HOOK ${code} ${Buffer.from(out).toString("base64")}\n`); setTimeout(() => process.exit(0), 50); });
});
