// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The command the Claude Code approval hooks run (approvals.ts):
 *   `approval-hook.js ask|settled --dir <Claude config dir> --socket <connector socket> --managed-by claw-connector`
 *
 * `ask` (the `PermissionRequest` hook) hands the request to the running connector and prints the owner's decision, if one
 * comes; `settled` (the events that follow an answer, run in the background) only tells the connector. Only a session in a
 * terminal is handed on (`CLAUDE_CODE_ENTRYPOINT=cli`): one the connector itself runs already asks through its own cards.
 *
 * It imports nothing of the connector and never gets in the way: no connector, a connector that does not answer, anything
 * unexpected, and it prints nothing and exits 0, which leaves the question to the terminal, where Claude Code shows it all the
 * while. Claude Code stops it with SIGTERM when the person at the terminal interrupts the turn; the connector sees the socket
 * close and withdraws the card.
 */
import net from "node:net";

const CONNECT_MS = 300;
const STDIN_MS = 2000;
const MAX_STDIN = 2 * 1024 * 1024;

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
  if ((mode !== "ask" && mode !== "settled") || !dir || !socket) {
    process.stderr.write("usage: approval-hook ask|settled --dir <Claude config dir> --socket <path>\n");
    return;
  }
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== "cli") return;
  const text = await readStdin();
  if (text.length >= MAX_STDIN) return;
  let event: unknown;
  try { event = JSON.parse(text); } catch { return; }
  if (typeof event !== "object" || event === null) return;

  const reply = await new Promise<string>((resolve) => {
    let buf = "";
    const sock = net.createConnection(socket);
    const connectTimer = setTimeout(() => { sock.destroy(); resolve(""); }, CONNECT_MS);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      clearTimeout(connectTimer);
      sock.write(`${JSON.stringify({ v: 1, type: mode, dir, event })}\n`);
      if (mode === "settled") sock.end();
    });
    sock.on("data", (c: string) => { if (buf.length < MAX_STDIN) buf += c; });
    sock.on("error", () => { clearTimeout(connectTimer); resolve(""); });
    sock.on("close", () => { clearTimeout(connectTimer); resolve(buf); });
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
  const decision = typeof r === "object" && r !== null ? (r as { decision?: unknown }).decision : null;
  if (typeof decision !== "object" || decision === null) return;
  const behavior = (decision as { behavior?: unknown }).behavior;
  if (behavior !== "allow" && behavior !== "deny") return;
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  // Written in full before the exit below (stdout is asynchronous on some platforms).
  await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
}

main().then(() => process.exit(0), (e) => {
  process.stderr.write(`approval-hook: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(0);
});
