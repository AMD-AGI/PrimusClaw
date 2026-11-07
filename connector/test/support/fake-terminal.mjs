// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in for Claude Code's terminal interface, run inside a real tmux pane by the tests: an input box drawn the way
 * Claude Code 2.1.x draws it (a rule, `❯` and the text or a dimmed suggestion, a rule), bracketed paste, Enter to submit,
 * Ctrl-U to clear. A submitted message is written to the transcript as a typed prompt, the registry row says `busy` while it
 * "works", then an answer and the end of the turn are written and the row says `idle` again.
 *
 * FAKE_TRANSCRIPT: the transcript file. FAKE_ROW: the registry row (written by the test; only its status is changed here).
 * FAKE_SESSION: the session id. FAKE_WORK_MS: how long a turn takes.
 */
import fs from "node:fs";

const transcript = process.env.FAKE_TRANSCRIPT;
const rowFile = process.env.FAKE_ROW;
const sessionId = process.env.FAKE_SESSION;
const workMs = Number(process.env.FAKE_WORK_MS || "300");
let buffer = "";
let pasting = false;
let working = false;
let pending = "";

const status = (s) => {
  try {
    const row = JSON.parse(fs.readFileSync(rowFile, "utf8"));
    row.status = s;
    fs.writeFileSync(rowFile, JSON.stringify(row));
  } catch { /* the test has not written it yet */ }
};
const line = (doc) => fs.appendFileSync(transcript, `${JSON.stringify({ sessionId, isSidechain: false, ...doc })}\n`);

function draw() {
  const rule = "─".repeat(60);
  const lines = buffer ? buffer.split("\n") : [];
  const box = lines.length ? [`\x1b[39m❯ ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)] : ["\x1b[39m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m"];
  process.stdout.write(`\x1b[2J\x1b[H${working ? "✻ Working…" : "  ready"}\r\n${rule}\r\n${box.join("\r\n")}\r\n${rule}\r\n  ⏵⏵ fake mode\r\n`);
}

function submit() {
  const text = buffer;
  buffer = "";
  if (!text.trim()) return draw();
  working = true;
  status("busy");
  line({ type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
  draw();
  setTimeout(() => {
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }], stop_reason: "end_turn" } });
    line({ type: "system", subtype: "turn_duration", durationMs: workMs });
    working = false;
    status("idle");
    draw();
  }, workMs);
}

process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[?2004h");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { pasting = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { pasting = false; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b") && pending.length < 6 && "\x1b[200~".startsWith(pending)) break;   // the rest comes next
    const ch = pending[0];
    pending = pending.slice(1);
    if (pasting) { buffer += ch === "\r" ? "\n" : ch; continue; }
    if (ch === "\r") { if (!working) submit(); continue; }
    if (ch === "\x15") { buffer = ""; continue; }   // Ctrl-U
    if (ch === "\x1b" || ch < " ") continue;
    buffer += ch;
  }
  draw();
});
draw();
setInterval(() => {}, 60_000);
