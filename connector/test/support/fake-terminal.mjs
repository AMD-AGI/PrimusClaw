// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in for Claude Code's terminal interface, run inside a real tmux pane by the tests: an input box drawn the way
 * Claude Code 2.1.x draws it (a rule, `❯` and the text or a dimmed suggestion, a rule), bracketed paste, Enter to submit,
 * Ctrl-U to clear. A submitted message is written to the transcript as a typed prompt, the registry row says `busy` while it
 * "works", then an answer and the end of the turn are written and the row says `idle` again.
 *
 * FAKE_TRANSCRIPT: the transcript file. FAKE_ROW: the registry row (written by the test; only its status is changed here).
 * FAKE_SESSION: the session id. FAKE_WORK_MS: how long a turn takes. FAKE_MODE_FILE: a file holding the permission mode the footer
 * below the box names, as Claude Code names it (`manual mode on` for `default`, `accept edits on`...); `none` draws a footer that
 * names no mode; `nobox` draws a screen with no input box at all (another program, a layout the connector does not know). Read
 * again every 50 ms, so the test can switch it as shift+tab would. FAKE_TITLE: a conversation name Claude Code writes into the rule
 * above the box (`/rename`). FAKE_IDLE_STATUS: what the row says between turns (`idle`; `shell` is what Claude Code 2.1.32x says
 * when background shells run). FAKE_TORN_ROW=1: the row is never written (Claude Code gives up on a row it cannot read). FAKE_TASKS_DIR:
 * a conversation's task folder the process keeps open, as Claude Code does once that conversation ran a background task.
 * A message submitted while a turn runs is queued, as Claude Code 2.1.285 queues it (measured 2026-11-10): `queue-operation`
 * enqueue with its text at once; then, with FAKE_QUEUE=absorb, taken into the running turn (`remove` absorbed_mid_turn and a
 * `queued_command` attachment, answered in that turn), or else after that turn's end (`dequeue`, then a turn of its own as a typed
 * prompt).
 * FAKE_BUSY_MS: a turn of its own runs from the start for this long (a prompt that is not the phone's; `esc to interrupt` below the
 * box, the row `busy`).
 * FAKE_DIALOG_FILE: an adversary. Once anything is typed or pasted (the first time only), a permission question is drawn under the box (the
 * typed text still shows in it), and an Enter while it shows approves it: "approved" is written to this file and nothing is
 * submitted. Once the file FAKE_DIALOG_DISMISS exists, the question is answered at the terminal and goes; with FAKE_DIALOG_CLEARS=1
 * that also empties the box.
 * A question's options are Yes and No, Yes highlighted; End highlights the last (No), as Claude Code's do; Enter chooses the
 * highlighted one: Yes writes "approved" to FAKE_DIALOG_FILE, No writes "denied" to FAKE_DIALOG_FILE.denied; either way the
 * question goes and the box keeps what it held.
 * FAKE_DIALOG_AT_ENTER=1 (with FAKE_DIALOG_FILE): an adversary for the moment between the last screen read and the Enter: the question
 * shows as the first Enter arrives, before it is read.
 * FAKE_ESC_FILE: every Esc the terminal receives is recorded in this file (a line each).
 * FAKE_DIALOG_ON_KEY=1 (with FAKE_DIALOG_FILE): an adversary for the moment between the screen read and the keys. The question shows
 * as the first input arrives, before it is read; while it shows, a typed digit answers it ("approved", as Claude Code 2.1.285 takes a
 * lone `1`) and a paste is dropped (as Claude Code drops one, measured 2026-11-10).
 */
import fs from "node:fs";

const transcript = process.env.FAKE_TRANSCRIPT;
const rowFile = process.env.FAKE_ROW;
const sessionId = process.env.FAKE_SESSION;
const workMs = Number(process.env.FAKE_WORK_MS || "300");
const idleStatus = process.env.FAKE_IDLE_STATUS || "idle";
if (process.env.FAKE_TASKS_DIR) fs.openSync(process.env.FAKE_TASKS_DIR, "r");   // (held open for as long as it runs)
let buffer = "";
let pasting = false;
let working = false;
let pending = "";
const modeFile = process.env.FAKE_MODE_FILE;
// Claude Code's own table (indicator per mode id), as the connector reads it back.
const INDICATOR = { default: "manual mode", plan: "plan mode", acceptEdits: "accept edits", bypassPermissions: "bypass permissions", dontAsk: "don't ask", auto: "auto mode" };
const readMode = () => { try { return fs.readFileSync(modeFile, "utf8").trim(); } catch { return "default"; } };
let mode = readMode();
let dialog = false;
let dialogShown = false;
let selected = 0;   // (0: Yes, 1: No)
const queue = [];
const footer = () => (mode === "none" ? "  ? for shortcuts" : mode === "default"
  ? "  \x1b[38;5;246m⏸ manual mode on · ? for shortcuts\x1b[39m"
  : `  \x1b[38;5;147m⏵⏵ ${INDICATOR[mode] ?? mode} on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m          ◐ medium · /effort`);

const status = (s) => {
  if (process.env.FAKE_TORN_ROW === "1") return;
  try {
    const row = JSON.parse(fs.readFileSync(rowFile, "utf8"));
    row.status = s;
    // (written whole and moved into place, as a reader must never see half a row)
    const real = fs.realpathSync(rowFile);
    fs.writeFileSync(`${real}.tmp`, JSON.stringify(row));
    fs.renameSync(`${real}.tmp`, real);
  } catch { /* the test has not written it yet */ }
};
const line = (doc) => fs.appendFileSync(transcript, `${JSON.stringify({ sessionId, isSidechain: false, ...doc })}\n`);

function draw() {
  const rule = "─".repeat(60);
  const top = process.env.FAKE_TITLE ? `${"─".repeat(50)} ${process.env.FAKE_TITLE} ─` : rule;
  if (mode === "nobox") { process.stdout.write("\x1b[2J\x1b[H  another program\r\n  nothing to type into here\r\n"); return; }
  const lines = buffer ? buffer.split("\n") : [];
  const box = lines.length ? [`\x1b[39m❯ ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)] : ["\x1b[39m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m"];
  const question = dialog ? `\r\n Bash command\r\n   touch approved.txt\r\n Do you want to proceed?\r\n ${selected === 0 ? "❯" : " "} 1. Yes\r\n ${selected === 1 ? "❯" : " "} 2. No\r\n Esc to cancel · Tab to amend\r\n` : "";
  const queued = queue.map((q) => `❯ ${q.split("\n")[0]}\r\n`).join("");
  process.stdout.write(`\x1b[2J\x1b[H${queued}${working ? "✻ Working…" : "  ready"}\r\n${top}\r\n${box.join("\r\n")}\r\n${rule}\r\n${footer()}${working ? " · esc to interrupt" : ""}\r\n${question}`);
}

/** A turn that answers `text` (null: one that is not the phone's), ending after workMs, and what was queued meanwhile. */
function runTurn(text, ms) {
  working = true;
  status("busy");
  draw();
  setTimeout(() => {
    if (text !== null) line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }], stop_reason: "end_turn" } });
    if (process.env.FAKE_QUEUE === "absorb") {
      for (const q of queue.splice(0)) {
        line({ type: "queue-operation", operation: "remove", content: q, reason: "absorbed_mid_turn" });
        line({ type: "attachment", attachment: { type: "queued_command", prompt: q, commandMode: "prompt" } });
        line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo: ${q}` }], stop_reason: "end_turn" } });
      }
    }
    line({ type: "system", subtype: "turn_duration", durationMs: ms });
    working = false;
    status(idleStatus);
    const next = queue.shift();
    if (next !== undefined) {
      line({ type: "queue-operation", operation: "dequeue" });
      buffer = next;
      return submit();
    }
    draw();
  }, ms);
}

function submit() {
  const text = buffer;
  buffer = "";
  if (!text.trim()) return draw();
  line({ type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
  runTurn(text, workMs);
}

process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[?2004h");
process.stdin.setEncoding("utf8");
const showDialog = () => { dialog = true; dialogShown = true; selected = 0; };
process.stdin.on("data", (chunk) => {
  if (process.env.FAKE_DIALOG_ON_KEY === "1" && !dialogShown) showDialog();
  if (process.env.FAKE_DIALOG_AT_ENTER === "1" && !dialogShown && !pasting && chunk.includes("\r")) showDialog();
  pending += chunk;
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { pasting = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) {
      pasting = false;
      pending = pending.slice(6);
      if (process.env.FAKE_DIALOG_FILE && !process.env.FAKE_DIALOG_AT_ENTER && !process.env.FAKE_DIALOG_ON_KEY && !dialogShown && buffer) showDialog();
      continue;
    }
    // (a lone ESC at the end of what came is Esc: tmux sends a paste's start in one piece)
    if (pending === "\x1b") {
      pending = "";
      if (process.env.FAKE_ESC_FILE) fs.appendFileSync(process.env.FAKE_ESC_FILE, "esc\n");
      if (dialog) { dialog = false; fs.writeFileSync(`${process.env.FAKE_DIALOG_FILE}.denied`, "denied"); }
      continue;
    }
    if (pending.startsWith("\x1b") && pending.length < 6 && "\x1b[200~".startsWith(pending)) break;   // the rest comes next
    // A key sent as an escape sequence (End: ESC [ F, ESC O F, ESC [ 4 ~, ESC [ 8 ~); a lone ESC is Esc.
    const key = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(pending);
    if (key) {
      pending = pending.slice(key[0].length);
      if (dialog && /^\x1b(?:\[F|OF|\[4~|\[8~)$/.test(key[0])) selected = 1;
      continue;
    }
    if (pending.startsWith("\x1b") && !pending.startsWith("\x1b[")) {
      pending = pending.slice(1);
      if (process.env.FAKE_ESC_FILE) fs.appendFileSync(process.env.FAKE_ESC_FILE, "esc\n");
      if (dialog) { dialog = false; fs.writeFileSync(`${process.env.FAKE_DIALOG_FILE}.denied`, "denied"); }
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    if (pasting) { if (!(dialog && process.env.FAKE_DIALOG_ON_KEY === "1")) buffer += ch === "\r" ? "\n" : ch; continue; }
    if (dialog && process.env.FAKE_DIALOG_ON_KEY === "1" && /[0-9]/.test(ch)) { fs.writeFileSync(process.env.FAKE_DIALOG_FILE, "approved"); dialog = false; continue; }
    if (ch === "\r") {
      if (dialog) {
        if (selected === 0) fs.writeFileSync(process.env.FAKE_DIALOG_FILE, "approved");
        else fs.writeFileSync(`${process.env.FAKE_DIALOG_FILE}.denied`, "denied");
        dialog = false;
        continue;
      }
      if (!working) submit();
      else if (buffer.trim()) {
        // (Claude Code queues it: taken at the running turn's next step, or once it ends)
        queue.push(buffer);
        line({ type: "queue-operation", operation: "enqueue", content: buffer });
        buffer = "";
      }
      continue;
    }
    if (ch === "\x15") { buffer = ""; continue; }   // Ctrl-U
    if (ch === "\x1b" || ch < " ") continue;
    buffer += ch;
    if (process.env.FAKE_DIALOG_FILE && !process.env.FAKE_DIALOG_AT_ENTER && !process.env.FAKE_DIALOG_ON_KEY && !dialogShown) showDialog();
  }
  draw();
});
if (Number(process.env.FAKE_BUSY_MS) > 0) {
  line({ type: "user", message: { role: "user", content: "a long task of its own" }, origin: { kind: "human" } });
  runTurn(null, Number(process.env.FAKE_BUSY_MS));
}
draw();
setInterval(() => {
  const m = readMode();
  if (m !== mode) { mode = m; draw(); }
  if (dialog && process.env.FAKE_DIALOG_DISMISS) {
    if (fs.existsSync(process.env.FAKE_DIALOG_DISMISS)) {
      dialog = false;
      if (process.env.FAKE_DIALOG_CLEARS === "1") buffer = "";
      draw();
    }
  }
}, 50);
