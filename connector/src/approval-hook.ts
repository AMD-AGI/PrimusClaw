// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The command the approval hooks run (approvals.ts):
 *   `approval-hook.js ask|settled --dir <config dir> --socket <connector socket> [--agent codex [--idle <s>]] --managed-by claw-connector`
 *
 * `ask` (the `PermissionRequest` hook) hands the request to the running connector and prints the owner's decision, if one
 * comes; `settled` (the events that follow an answer, run in the background) only tells the connector.
 *
 * Claude Code (the default): only a session in a terminal is handed on (`CLAUDE_CODE_ENTRYPOINT=cli`): one the connector itself
 * runs already asks through its own cards. Claude Code shows its own dialog while this waits.
 *
 * Codex (`--agent codex`, measured on 0.153.4): Codex runs this before it shows its own prompt, and shows that prompt only once
 * this has exited without a decision. So the question goes to the phone only when the session is the `codex` TUI (the
 * transcript's `session_meta` says `originator: "codex-tui"`; anything else, `codex exec` or codex-acp that the connector runs,
 * is left alone) and nobody has typed in its terminal for `--idle` seconds (default 30; the terminal device's access time, which the
 * kernel moves on input, at most 8 s late, as `w` reads it). While the card waits, typing anything in that terminal gives the
 * question back to it: this exits without a decision and Codex shows its prompt. Esc stops the turn, and Codex kills this.
 *
 * It imports nothing of the connector but the small helpers in codex-terminal.ts, and never gets in the way: no connector, a connector that does not answer, no terminal
 * to watch, anything unexpected, and it prints nothing and exits 0, which leaves the question to the terminal. When it goes
 * away (stopped by Claude Code or Codex, or given back to the terminal) the connector sees the socket close and withdraws the card.
 */
import net from "node:net";
import { codexTuiTranscript, lastInputMs, terminalOf } from "./codex-terminal.js";

const CONNECT_MS = 300;
const STDIN_MS = 2000;
const MAX_STDIN = 2 * 1024 * 1024;
const DEFAULT_IDLE_S = 30;
const WATCH_MS = 1000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(done, STDIN_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => { if (buf.length < MAX_STDIN) buf += c; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const dir = arg("--dir");
  const socket = arg("--socket");
  const agent = arg("--agent") === "codex" ? "codex" : "claude";
  if ((mode !== "ask" && mode !== "settled") || !dir || !socket) {
    process.stderr.write("usage: approval-hook ask|settled --dir <config dir> --socket <path> [--agent codex [--idle <s>]]\n");
    return;
  }
  if (agent === "claude" && process.env.CLAUDE_CODE_ENTRYPOINT !== "cli") return;
  const text = await readStdin();
  if (text.length >= MAX_STDIN) return;
  let event: unknown;
  try { event = JSON.parse(text); } catch { return; }
  if (typeof event !== "object" || event === null) return;

  // Codex: only the TUI, only a terminal nobody is typing in, and only until someone does.
  let tty: string | null = null;
  let since = 0;
  if (agent === "codex" && mode === "ask") {
    if (!codexTuiTranscript((event as { transcript_path?: unknown }).transcript_path)) return;
    tty = terminalOf(process.ppid);
    const last = tty ? lastInputMs(tty) : null;
    if (!tty || last === null) return;
    const idle = Number(arg("--idle") ?? DEFAULT_IDLE_S);
    if (Date.now() - last < (Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_IDLE_S) * 1000) return;
    since = last;
  }

  const reply = await new Promise<string>((resolve) => {
    let buf = "";
    let watch: NodeJS.Timeout | undefined;
    const sock = net.createConnection(socket);
    const connectTimer = setTimeout(() => { sock.destroy(); resolve(""); }, CONNECT_MS);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      clearTimeout(connectTimer);
      sock.write(`${JSON.stringify({ v: 1, type: mode, dir, ...(agent === "codex" ? { agent } : {}), event })}\n`);
      if (mode === "settled") sock.end();
      // Someone typed in the terminal: the question is theirs there. Closing the socket withdraws the card.
      if (tty) watch = setInterval(() => { const t = lastInputMs(tty!); if (t === null || t > since) { sock.destroy(); resolve(""); } }, WATCH_MS);
    });
    sock.on("data", (c: string) => { if (buf.length < MAX_STDIN) buf += c; });
    sock.on("error", () => { clearTimeout(connectTimer); clearInterval(watch); resolve(""); });
    sock.on("close", () => { clearTimeout(connectTimer); clearInterval(watch); resolve(buf); });
    // Interrupted at the terminal: the connector sees the socket close.
    const leave = () => { sock.destroy(); process.exit(0); };
    process.once("SIGTERM", leave);
    process.once("SIGHUP", leave);
    process.once("SIGINT", leave);
  });
  if (mode !== "ask") return;
  const line = reply.split("\n")[0] ?? "";
  if (!line) return;
  let r: unknown;
  try { r = JSON.parse(line); } catch { return; }
  let decision = typeof r === "object" && r !== null ? (r as { decision?: unknown }).decision : null;
  if (typeof decision !== "object" || decision === null) return;
  const behavior = (decision as { behavior?: unknown }).behavior;
  if (behavior !== "allow" && behavior !== "deny") return;
  // Codex fails a hook that returns anything but `behavior` and `message`.
  if (agent === "codex") {
    const message = (decision as { message?: unknown }).message;
    decision = { behavior, ...(behavior === "deny" && typeof message === "string" ? { message } : {}) };
  }
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  // Written in full before the exit below (stdout is asynchronous on some platforms).
  await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
}

main().then(() => process.exit(0), (e) => {
  process.stderr.write(`approval-hook: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(0);
});
