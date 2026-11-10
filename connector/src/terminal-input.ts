// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Typing into a conversation that a terminal on this machine has open, as the person at that terminal would.
 *
 * A conversation open in a terminal has one writer, the terminal's own `claude` process; a second process that resumed it
 * would fork its transcript (attach.ts). So a message from the phone is not given to a second agent: it is typed into the
 * terminal itself, when that terminal is a tmux pane. tmux is the one place a terminal's input can be reached from outside
 * by its own user, with the user's own authority, without another process on the conversation: the message is pasted as one
 * bracketed paste (`paste-buffer -p`), the way a terminal pastes, so that no key name is read from it, its newlines do not
 * submit it line by line, and a question on the screen does not take any of it as its choice. Claude Code records
 * it as a typed prompt (`promptSource: "typed"`), and the terminal and the phone see the same conversation.
 *
 * It types only into an input box that is empty, whatever Claude Code is doing: a message typed while a turn runs is queued by
 * Claude Code itself and taken in at its next step (or once the turn ends), as one typed by the person at the terminal is. What
 * the person has half-typed is never sent with it, and a menu or a permission question on the screen (where Enter would choose
 * something: an Enter on a permission question approves a tool call) is never answered by it: Enter goes only on a screen that
 * shows the box holding exactly the message and no question. A pane that cannot be read, or a screen that is not plainly an
 * empty input box, is "not ready", never "ready".
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processStart } from "./children.js";
import { errMessage } from "./util.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs the tmux client against one server socket. The seam the tests replace. */
export interface TmuxRunner {
  run(args: string[], input?: string): Promise<string>;
}

/** tmux, as `cli`, against the server at `socket`; no shell, a bounded wait, its output as text. */
export function tmuxRunner(cli: string, socket: string, timeoutMs = 5_000): TmuxRunner {
  return {
    run: (args, input) => new Promise((resolve, reject) => {
      const child = execFile(cli, ["-S", socket, ...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
      // A client that exits before reading its input (a server that is gone, a refused command) closes the pipe under
      // this write. Its EPIPE is that run's failure, which the callback above already reports; unheard, it would be an
      // unhandled 'error' event and end the process.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    }),
  };
}

export interface PaneRef {
  /** The tmux server's socket. */
  socket: string;
  /** The pane id (`%12`). */
  pane: string;
  /** The process that holds the conversation open, inside that pane. */
  pid: number;
  /** Its start time when it was proven (Linux): a pid that names another process later is not this one. */
  procStart: string | null;
}

export type PaneLookup = { ok: true; pane: PaneRef } | { ok: false; why: string };

const PANE_RE = /^%\d{1,9}$/;
const MAX_ANCESTRY = 64;

/** The environment a process was started with (Linux), or null when it cannot be read. */
function processEnv(pid: number): Map<string, string> | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    const out = new Map<string, string>();
    for (const kv of raw.split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) out.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return out;
  } catch {
    return null;
  }
}

function parentOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** Whether `ancestor` is `pid` or one of its parents. */
export function descendsFrom(pid: number, ancestor: number): boolean {
  let p: number | null = pid;
  for (let i = 0; p !== null && i < MAX_ANCESTRY; i++) {
    if (p === ancestor) return true;
    p = parentOf(p);
  }
  return false;
}

/**
 * The tmux pane a process runs in. Read from what the process was started with (`TMUX`: the server's socket; `TMUX_PANE`:
 * the pane) and then proven: the socket is a socket that belongs to this user, and that server names the pane's own process as
 * one of the process's parents. A process that only says so (an environment copied from elsewhere, a pane since reused) is
 * not typed into. Linux only: elsewhere the environment of another process cannot be read.
 */
export async function findPane(pid: number, cli: string, runner: (socket: string) => TmuxRunner = (s) => tmuxRunner(cli, s)): Promise<PaneLookup> {
  if (process.platform !== "linux") return { ok: false, why: "typing into a terminal is supported on Linux only" };
  const env = processEnv(pid);
  if (!env) return { ok: false, why: `the environment of process ${pid} cannot be read` };
  const tmux = env.get("TMUX");
  const pane = env.get("TMUX_PANE");
  if (!tmux || !pane) return { ok: false, why: "the terminal is not a tmux pane" };
  const socket = tmux.split(",")[0] ?? "";
  if (!path.isAbsolute(socket) || !PANE_RE.test(pane)) return { ok: false, why: "the terminal's tmux variables are not well-formed" };
  try {
    const st = fs.statSync(socket);
    if (!st.isSocket()) return { ok: false, why: "the terminal's tmux socket is not a socket" };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { ok: false, why: "the terminal's tmux server belongs to another user" };
  } catch (e) {
    return { ok: false, why: `the terminal's tmux server is gone (${errMessage(e).split("\n")[0]})` };
  }
  let out: string;
  try {
    out = await runner(socket).run(["display-message", "-p", "-t", pane, "#{pane_pid} #{pane_dead}"]);
  } catch (e) {
    return { ok: false, why: `tmux does not answer for that pane (${errMessage(e).split("\n")[0]!.slice(0, 200)})` };
  }
  const [panePid, dead] = out.trim().split(" ");
  if (dead === "1") return { ok: false, why: "the terminal's pane has exited" };
  const n = Number(panePid);
  if (!Number.isInteger(n) || n <= 1 || !descendsFrom(pid, n)) return { ok: false, why: "the tmux pane it names does not run that process" };
  return { ok: true, pane: { socket, pane, pid, procStart: processStart(pid) } };
}

// --- the screen ---------------------------------------------------------------------------

export type BoxState = "empty" | "typed" | "unknown";

const SGR_RE = /\x1b\[[0-9;:]*m/g;
/** Claude Code's prompt glyph (2.1.x); `>` in older versions. */
const PROMPT_RE = /^(?:❯|>)[  ]?/;
/**
 * A rule above or below the box. Claude Code writes a conversation's name (`/rename`, or the name a session was started with) into
 * the rule above the box: `──────── clean ─`. That rule is still the box's edge.
 */
const RULE_RE = /^─{8,}(?: +\S(?:.*\S)? +─+)?$/;

/**
 * What Claude Code's input box holds, read from a `capture-pane -e` of its screen: a rule, the prompt line, a rule. `empty`
 * when the prompt line holds nothing or only its dimmed suggestion; `typed` when it holds anything else or more than one
 * line; `unknown` when there is no such box (a menu, a permission question, a dialog, another program).
 */
export function inputBox(screen: string): BoxState {
  const { raw, plain, at, end } = boxOf(screen);
  if (at < 0 || end < 0) return "unknown";
  const text = plain.slice(at, end).map((l, i) => (i ? l : l.trimStart().replace(PROMPT_RE, ""))).join("").trim();
  if (!text) return end === at + 1 ? "empty" : "typed";   // (blank rows: someone's line breaks)
  // The placeholder or the prompt suggestion Claude Code shows in an empty box is dimmed (SGR 2) throughout, on every row it takes
  // (a long one wraps), the cursor drawn reversed on its first character when the terminal shows one: none of that is anyone's text.
  const rows = raw.slice(at, end).map((l, i) => (i ? l : l.replace(/^(?:\s|\x1b\[[0-9;:]*m)*(?:❯|>)/, "")));
  return rows.every((r, i) => onlyDim(r, i === 0)) ? "empty" : "typed";
}

/** Where Claude Code's input box is on a screen: its prompt line (`at`) and the rule below it (`end`); -1 when there is none. */
function boxOf(screen: string): { raw: string[]; plain: string[]; at: number; end: number } {
  const raw = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const plain = raw.map((l) => l.replace(SGR_RE, "").replace(/\s+$/, ""));
  let at = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(plain[i]!.trimStart()) && i > 0 && RULE_RE.test(plain[i - 1]!.trim())) { at = i; break; }
  }
  let end = -1;
  if (at >= 0) for (let j = at + 1; j < plain.length; j++) if (RULE_RE.test(plain[j]!.trim())) { end = j; break; }
  return { raw, plain, at, end };
}

/** The conversation name in the rule above Claude Code's input box (`──────── clean ─`), or null when the rule names none. */
export function boxName(screen: string): string | null {
  const { plain, at, end } = boxOf(screen);
  if (at < 1 || end < 0) return null;
  const m = /^─{8,} +(\S(?:.*\S)?) +─+$/.exec(plain[at - 1]!.trim());
  return m ? m[1]! : null;
}

/**
 * Claude Code's permission modes, as its footer names each one (`<indicator> on`, below the input box) and the id the agent and
 * its transcript use for it: Claude Code's own table (`indicator` and `external`), the same in 2.1.285 and 2.1.319. Every mode is
 * named there, the default one too ("manual mode on").
 */
export const CLAUDE_MODE_INDICATORS: Readonly<Record<string, string>> = {
  "manual mode": "default", "plan mode": "plan", "accept edits": "acceptEdits", "bypass permissions": "bypassPermissions", "don't ask": "dontAsk", "auto mode": "auto",
};
const MODE_RE = new RegExp(`(?:^|[\\s·⏵⏸▶])(${Object.keys(CLAUDE_MODE_INDICATORS).join("|")}) on\\b`, "g");
const FOOTER_LINES = 3;

/**
 * The permission mode the terminal's Claude Code is in now, read from the footer below its input box. The screen is the one place
 * that says it as it is: the transcript records the mode only with the next prompt, so a switch (shift+tab) at an idle terminal is
 * not in it. null when the footer does not name exactly one mode (no box, another program, a notice in its place, an older Claude
 * Code that does not name the default mode): then nothing is typed.
 */
export function terminalMode(screen: string): string | null {
  const { plain, at, end } = boxOf(screen);
  if (at < 0 || end < 0) return null;
  const found = new Set<string>();
  for (const line of plain.slice(end + 1, end + 1 + FOOTER_LINES)) {
    for (const m of line.matchAll(MODE_RE)) found.add(CLAUDE_MODE_INDICATORS[m[1]!]!);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * The modes in which Claude Code acts without asking first: a message typed from the phone into a terminal in one of these runs
 * its tools at once. The terminal's mode is its owner's choice and a message is typed in any of them; the session says the mode
 * (`session_started.terminal_mode`) so the chat can say so.
 */
export const MODES_THAT_DO_NOT_ASK: readonly string[] = ["auto", "bypassPermissions", "dontAsk", "acceptEdits"];

/**
 * Whether a message would act as a command in Claude Code's input box instead of being a prompt: `!` runs the rest as a shell
 * command with no permission question, and `/` runs a slash command (`/permissions`, `/add-dir` change what the session may do).
 * Such a message is never typed.
 */
export function actsAsCommand(text: string): boolean {
  return /^[!/]/.test(text.trimStart());
}

/**
 * The person's message as it is typed: line ends as `\n`, tabs as spaces, and every other control character (C0, DEL, C1,
 * the line and paragraph separators) removed, so nothing in it can act as a key: no Enter mid-message, no escape sequence,
 * no end of the bracketed paste. Trailing blank lines are dropped.
 */
export function cleanInput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\n+$/, "")
    .replace(/^\n+/, "");
}

/**
 * Whether every visible character of `line` is drawn dim (SGR 2): a suggestion, not text. `cursorFirst`: the first visible character
 * may instead be drawn reversed (SGR 7), as a terminal's cursor on a suggestion is; only that one.
 */
function onlyDim(line: string, cursorFirst = false): boolean {
  let dim = false;
  let reverse = false;
  let first = true;
  let i = 0;
  while (i < line.length) {
    const m = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (m) {
      for (const p of (m[1] || "0").split(/[;:]/)) {
        if (p === "2") dim = true;
        else if (p === "7") reverse = true;
        else if (p === "27") reverse = false;
        else if (p === "0" || p === "") { dim = false; reverse = false; }
        else if (p === "22") dim = false;
      }
      i += m[0].length;
      continue;
    }
    const ch = line[i]!;
    if (ch === "\x1b") return false;
    if (!/[\s\u00a0]/.test(ch)) {
      const cursor = cursorFirst && first && reverse;
      if (!dim && !cursor) return false;
      first = false;
    }
    i++;
  }
  return true;
}

/**
 * The lines of a question, a menu or a confirmation on Claude Code's screen (a permission question, AskUserQuestion, a plan to
 * approve, a /command's picker): Enter there chooses the highlighted option, so a message's Enter is never sent while one shows.
 */
const DIALOG_RE = /(?:Esc to cancel|Enter to confirm|Enter to select|Tab to amend|Do you want to (?:proceed|make this edit|create)|Would you like to proceed|^\s*[❯>]?\s*\d+\.\s+(?:Yes|No)\b)/i;

/**
 * Whether a question, a menu or a confirmation is on Claude Code's screen, or its input box is not (a permission question takes
 * the box's place while it asks): no key is sent then, as any key might answer it.
 */
export function dialogOnScreen(screen: string): boolean {
  const { plain, at, end } = boxOf(screen);
  if (at < 0 || end < 0) return plain.some((l) => DIALOG_RE.test(l));
  return plain.slice(end + 1).some((l) => DIALOG_RE.test(l));
}

/**
 * Why Enter must not be sent now for a message typed into the box (null: it may). All on the one screen read: Claude Code's input
 * box is there, the bottom-most thing on the screen apart from its footer; it holds exactly what was typed (whitespace aside, as the
 * box wraps it; a long paste shows as `[Pasted text #n …]`); and no line below the box is a question's or a menu's. Whether a turn
 * runs does not matter: Claude Code queues a message submitted meanwhile, and a question shows in place of the box, never beside it.
 */
export function enterGuard(screen: string, text: string): string | null {
  const { plain, at, end } = boxOf(screen);
  if (at < 0 || end < 0) return "no input box on the screen";
  if (plain.slice(end + 1).some((l) => DIALOG_RE.test(l))) return "a question or a menu is on the screen";
  const lines = plain.slice(at, end).map((l, i) => (i === 0 ? l.trimStart().replace(PROMPT_RE, "") : l));
  if (heldExactly(lines, plain.slice(at, end).map(displayWidth), displayWidth(plain[end]!.trim()), text)) return null;
  // A long paste shows collapsed, `[Pasted text #n +k lines]` (k: its line breaks) or, one long line, `[Pasted text #n]` (Claude Code
  // 2.1.285): only that, and only with this text's count of line breaks.
  const breaks = text.split("\n").length - 1;
  const marker = lines.length === 1 ? /^\[Pasted text #\d+(?: \+(\d+) lines)?\]$/.exec(lines[0]!.trim()) : null;
  if (marker && (marker[1] === undefined ? breaks === 0 && text.length > PASTE_INLINE_MAX : Number(marker[1]) === breaks)) return null;
  return "the box does not hold exactly what was typed";
}

/** The longest one-line paste Claude Code 2.1.285 was measured to show as it is (700 characters did, 1500 did not). */
const PASTE_INLINE_MAX = 700;

/** How many terminal columns a string takes (East Asian wide and fullwidth characters take two). */
function displayWidth(x: string): number {
  let n = 0;
  for (const ch of x) {
    const c = ch.codePointAt(0)!;
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
      || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return n;
}

/**
 * Whether the box's lines are exactly `text` as the box draws it: each line of the text is one or more of the box's lines, nothing
 * more or less. A text line goes on to the next box line only where the box wrapped it, which the widths tell (`widths`: each box
 * row's columns, prompt or indent included; `boxWidth`: the rule's): at a space, when the next word would not have fit on the row
 * (the space is not drawn); inside a word, when the next character would not have fit. A row that ends short of that is a line break of the text, never
 * a wrap. Runs of whitespace count as one space (the box draws them so). Measured on Claude Code 2.1.285, a 200-column pane: rows
 * filled to at most 199 columns.
 */
function heldExactly(lines: string[], widths: number[], boxWidth: number, text: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim();
  const want = text.split("\n").map(norm);
  const got = lines.map(norm);
  const limit = boxWidth - 1;
  let g = 0;
  for (const line of want) {
    // (an empty line of the text is an empty line of the box)
    if (!line) { if (got[g] !== "") return false; g++; continue; }
    let rest = line;
    for (;;) {
      const part = got[g];
      if (!part || !rest.startsWith(part)) return false;
      rest = rest.slice(part.length);
      const row = widths[g]!;
      g++;
      if (!rest) break;
      // (it goes on in the next row: only where the box wrapped it)
      if (rest.startsWith(" ")) {
        rest = rest.slice(1);
        if (row + 1 + displayWidth(rest.split(" ")[0]!) <= limit) return false;   // (the space and the next word would have fit)
      } else if (row + displayWidth([...rest][0]!) <= limit) {
        return false;   // (the next character would have fit: a wide one may leave the last column empty)
      }
    }
  }
  return g === got.length;
}

/** How long the screen must keep passing {@link enterGuard} before Enter goes: it is read again after this. */
export const ENTER_SETTLE_MS = 250;

export type Readiness = { ready: true; mode: string | null } | { ready: false; why: "typing" | "screen" | "copy_mode" | "gone" | "dialog" };

/** How a message is typed: what to do when a question shows before its Enter, and whether it is still wanted while one does. */
export interface TypeOptions {
  /** Called once when a question or a menu shows after the text was typed: the Enter waits for it to go. */
  onDialog?: () => void;
  /** Asked while a question shows: false ends the wait (`TerminalNotSubmitted`), nothing more is typed. */
  stillWanted?: () => boolean;
  /** Whether the terminal's transcript already shows the message submitted (by the person at the terminal): it is not typed again. */
  submitted?: () => boolean;
  /** Called right before the text first enters the pane (the paste itself): from then on what the transcript shows of it can be this message. */
  onPaste?: () => void;
}

/**
 * What submits the box: End (`ESC [ F`) and Enter (`CR`) as the bytes of ONE key of `send-keys -H`, so tmux writes them to the terminal
 * in one write and Claude Code reads them as one input, nothing between them. In the box End moves to the end of the text and Enter
 * submits it; on a question or a menu that came up in the moment after the screen was read, End moves to its last option (a
 * permission question's "No") and Enter chooses that, so an Enter from the phone never approves anything. Measured on Claude Code
 * 2.1.285, 2026-11-10, with these four bytes in one write: on a permission question each time "No" ("Interrupted", nothing run);
 * in the box, submitted. (A question cannot come up between the two: they are one input.)
 */
export const SUBMIT_BYTES: readonly string[] = ["1b", "5b", "46", "0d"];

/** How often a screen with a question on it is read again, waiting for it to go. */
const DIALOG_POLL_MS = 200;
/** How many times a message whose text a question took out of the box is typed again, once the question is gone. */
const MAX_TYPINGS = 3;

/** What was typed is in the box but was not submitted: the screen did not pass {@link enterGuard}. */
export class TerminalNotSubmitted extends Error {
  constructor(readonly why: string) {
    super(`typed but not submitted: ${why}`);
  }
}

/** One tmux pane that holds a conversation open, and the typing into it. */
export class TerminalInput {
  constructor(readonly ref: PaneRef, private readonly tmux: TmuxRunner, private readonly echoWaitMs = 3_000, private readonly settleMs = ENTER_SETTLE_MS) {}

  /** Whether the process proven at the start is still the one there, and still runs in this pane. */
  private stillThere(panePid: number): boolean {
    if (this.ref.procStart !== null && processStart(this.ref.pid) !== this.ref.procStart) return false;
    return Number.isInteger(panePid) && panePid > 1 && descendsFrom(this.ref.pid, panePid);
  }

  /**
   * Whether the pane can be typed into now: the same process in it, alive, not scrolled back (copy mode), its input box empty and no
   * question or menu on the screen; when it can, with the permission mode its footer shows on that same screen (null when it does
   * not show one). Whether a turn runs there does not matter (Claude Code queues what is submitted meanwhile).
   */
  async readiness(): Promise<Readiness> {
    let info: string;
    try {
      info = await this.tmux.run(["display-message", "-p", "-t", this.ref.pane, "#{pane_in_mode} #{pane_dead} #{pane_pid}"]);
    } catch {
      return { ready: false, why: "gone" };
    }
    const [mode, dead, panePid] = info.trim().split(" ");
    if (dead === "1" || !this.stillThere(Number(panePid))) return { ready: false, why: "gone" };
    if (mode !== "0") return { ready: false, why: "copy_mode" };
    const screen = await this.screen();
    if (dialogOnScreen(screen)) return { ready: false, why: "dialog" };
    const box = inputBox(screen);
    return box === "empty" ? { ready: true, mode: terminalMode(screen) } : { ready: false, why: box === "typed" ? "typing" : "screen" };
  }

  /** Whether the same process still runs in the pane (false: the pane, or that process, is gone). */
  private async alive(): Promise<boolean> {
    try {
      const [, dead, panePid] = (await this.tmux.run(["display-message", "-p", "-t", this.ref.pane, "#{pane_in_mode} #{pane_dead} #{pane_pid}"])).trim().split(" ");
      return dead !== "1" && this.stillThere(Number(panePid));
    } catch {
      return false;
    }
  }

  private async screen(): Promise<string> {
    try { return await this.tmux.run(["capture-pane", "-p", "-e", "-t", this.ref.pane]); } catch { return ""; }
  }

  /**
   * Put `text` into the box as one bracketed paste (a named buffer, `paste-buffer -p`, deleted with `-d`), one line or several. Never
   * as keystrokes: a question that shows in the moment between the screen read and the keys takes a typed digit as its choice (a lone
   * `1` approves a permission question, measured on Claude Code 2.1.285, 2026-11-10), while a paste is not taken as one.
   */
  private async put(text: string, onPaste?: () => void): Promise<void> {
    const buffer = `claw-${randomUUID()}`;
    await this.tmux.run(["load-buffer", "-b", buffer, "-"], text);
    // (right before the text enters the pane: what the transcript shows of it from here on can be this message)
    onPaste?.();
    try {
      await this.tmux.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", this.ref.pane]);
    } catch (e) {
      await this.tmux.run(["delete-buffer", "-b", buffer]).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Type `text` (already {@link cleanInput}) into the box and submit it, whatever Claude Code is doing (a running turn queues it).
   * It goes in as one bracketed paste ({@link put}).
   *
   * Enter goes only on a screen that, read twice ENTER_SETTLE_MS apart, shows the box holding exactly this text and no question or
   * menu ({@link enterGuard}): an Enter on a permission question would approve it. When a question shows instead (it came after the
   * text was typed), no key at all is sent while it does (any key might answer it): the wait goes on until it is gone, and then the
   * Enter goes if the box holds the text again, or the text is typed again if the box is empty. A box holding anything else (the
   * person at the terminal typed into it) is left as it is and the message is refused (`TerminalNotSubmitted`).
   */
  async type(text: string, opts: TypeOptions = {}): Promise<void> {
    if (!text) throw new Error("nothing to type");
    let told = false;
    let declined = 0;
    // (a message cancelled or withdrawn meanwhile gets no further key: what is in the box stays there)
    const stillWanted = () => { if (opts.stillWanted && !opts.stillWanted()) throw new TerminalNotSubmitted("no longer wanted"); };
    // No key while a question shows: told once, waited out (or given up when the message is no longer wanted, or the terminal went).
    const waitOutDialog = async () => {
      if (!told) { told = true; opts.onDialog?.(); }
      for (;;) {
        if (opts.stillWanted && !opts.stillWanted()) throw new TerminalNotSubmitted("no longer wanted while a question was on the screen");
        if (!(await this.alive())) throw new TerminalNotSubmitted("the terminal went away while a question was on the screen");
        if (!dialogOnScreen(await this.screen())) return;
        await sleep(DIALOG_POLL_MS);
      }
    };
    for (let typings = 1; ; typings++) {
      // (read once more right before the paste: a question on the screen now gets nothing at all until it is gone)
      const waited = dialogOnScreen(await this.screen());
      if (waited) await waitOutDialog();
      // (after a question, or to type again, the box is read anew: someone's text there is never pasted onto)
      if ((waited || typings > 1) && inputBox(await this.screen()) !== "empty") throw new TerminalNotSubmitted("the box is no longer empty");
      stillWanted();
      await this.put(text, typings === 1 ? opts.onPaste : undefined);
      const by = Date.now() + this.echoWaitMs;
      let dialog = false;
      for (;;) {
        const screen = await this.screen();
        if (dialogOnScreen(screen)) { dialog = true; break; }
        if (inputBox(screen) === "typed") break;
        if (Date.now() >= by) throw new Error("the terminal did not show the typed text");
        await sleep(100);
      }
      for (;;) {
        if (dialog) {
          await waitOutDialog();
          dialog = false;
        }
        let why: string | null = null;
        let screen = "";
        for (let i = 0; i < 2 && !why; i++) {
          await sleep(this.settleMs);
          screen = await this.screen();
          why = enterGuard(screen, text);
        }
        if (!why) {
          stillWanted();
          // End and Enter in one write (SUBMIT_BYTES): the box takes them as "to the end, submit"; a question that came up after the read
          // above takes End as its last option, "No", and Enter chooses that. Never a "Yes".
          await this.tmux.run(["send-keys", "-t", this.ref.pane, "-H", ...SUBMIT_BYTES]);
          // Submitted, or did a question take the keys? A box that still holds exactly the text, or a question on the screen, means the
          // keys did not submit it: that is waited out and tried again.
          await sleep(this.settleMs);
          const after = await this.screen();
          if (dialogOnScreen(after)) { if (++declined > MAX_TYPINGS) throw new TerminalNotSubmitted("a question took the Enter, again and again"); dialog = true; continue; }
          if (enterGuard(after, text) === null && !opts.submitted?.()) {
            if (++declined > MAX_TYPINGS) throw new TerminalNotSubmitted("the Enter did not submit it");
            continue;
          }
          return;
        }
        if (dialogOnScreen(screen)) { dialog = true; continue; }
        // (the question took the text out of the box: typed again, unless the terminal already shows it submitted)
        if (told && inputBox(screen) === "empty" && typings < MAX_TYPINGS) {
          if (opts.submitted?.()) return;
          break;
        }
        throw new TerminalNotSubmitted(why);
      }
    }
  }

  /** Esc: Claude Code stops the turn it is running. */
  async interrupt(): Promise<void> {
    await this.tmux.run(["send-keys", "-t", this.ref.pane, "Escape"]);
  }
}
