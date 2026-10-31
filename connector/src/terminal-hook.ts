// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The command the Claude Code hooks run: `terminal-hook.js start|end --dir <Claude config dir> --managed-by claw-connector`
 * (see terminals.ts; the last two words are only the mark hooks.ts recognises its own entries by, and are not read here).
 *
 * It is its own entry point, with nothing imported but the registry code, because `SessionStart` holds up the first
 * turn of every Claude Code session until it returns. It prints nothing to stdout (a `SessionStart` hook's stdout is
 * handed to the model as context) and always exits 0: a hook that fails or hangs must never get in the way of the
 * session it is watching, so a problem goes to stderr and the connector's other detection covers for it.
 */
import { readStdin, runHook } from "./terminals.js";

async function main(): Promise<void> {
  const [event, flag, dir] = process.argv.slice(2);
  if ((event !== "start" && event !== "end") || flag !== "--dir" || !dir) {
    process.stderr.write("usage: terminal-hook start|end --dir <Claude config dir>\n");
    return;
  }
  const stdin = await readStdin(process.stdin);
  const r = runHook({ event, configDir: dir, stdin, env: process.env, ppid: process.ppid });
  if (process.env.CLAW_CONNECTOR_HOOK_DEBUG) process.stderr.write(`terminal-hook ${event}: ${r.done}${r.why ? ` (${r.why})` : ""}\n`);
}

main().then(() => process.exit(0), (e) => {
  process.stderr.write(`terminal-hook: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(0);
});
