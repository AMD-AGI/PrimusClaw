// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Typing into a conversation that a terminal on this machine has open, as the person at that terminal would.
 *
 * A conversation open in a terminal has one writer, the terminal's own `claude` process; a second process that resumed it
 * would fork its transcript (attach.ts). So a message from the phone is not given to a second agent: it is typed into the
 * terminal itself, when that terminal is a tmux pane. tmux is the one place a terminal's input can be reached from outside
 * by its own user, with the user's own authority, without another process on the conversation: `send-keys -l` types the
 * text literally (no key names are read from it), and a multi-line message is pasted as one bracketed paste
 * (`paste-buffer -p`), the way a terminal pastes, so that its newlines do not submit it line by line. Claude Code records
 * it as a typed prompt (`promptSource: "typed"`), and the terminal and the phone see the same conversation.
 *
 * It types only into an input box that is empty, and only while Claude Code says it is idle: what the person at the
 * terminal has half-typed is never sent with it, and a menu or a permission question on the screen (where Enter would
 * choose something) is never answered by it. A pane that cannot be read, or a screen that is not plainly an empty input
 * box, is "not ready", never "ready".
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errMessage } from "./util.js";

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
  return { ok: true, pane: { socket, pane, pid } };
}

// --- the screen ---------------------------------------------------------------------------

export type BoxState = "empty" | "typed" | "unknown";

const SGR_RE = /\x1b\[[0-9;:]*m/g;
/** Claude Code's prompt glyph (2.1.x); `>` in older versions. */
const PROMPT_RE = /^(?:❯|>)[  ]?/;
const RULE_RE = /^─{8,}$/;

/**
 * What Claude Code's input box holds, read from a `capture-pane -e` of its screen: a rule, the prompt line, a rule. `empty`
 * when the prompt line holds nothing or only its dimmed suggestion; `typed` when it holds anything else or more than one
 * line; `unknown` when there is no such box (a menu, a permission question, a dialog, another program).
 */
export function inputBox(screen: string): BoxState {
  const raw = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const plain = raw.map((l) => l.replace(SGR_RE, "").replace(/\s+$/, ""));
  let at = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(plain[i]!.trimStart()) && i > 0 && RULE_RE.test(plain[i - 1]!.trim())) { at = i; break; }
  }
  if (at < 0) return "unknown";
  let end = -1;
  for (let j = at + 1; j < plain.length; j++) if (RULE_RE.test(plain[j]!.trim())) { end = j; break; }
  if (end < 0) return "unknown";
  if (end !== at + 1) return "typed";
  const text = plain[at]!.trimStart().replace(PROMPT_RE, "").trim();
  if (!text) return "empty";
  // The suggestion Claude Code shows in an empty box is the only thing on the line, dimmed (SGR 2) throughout.
  return onlyDim(raw[at]!.replace(/^(?:\s|\x1b\[[0-9;:]*m)*(?:❯|>)/, "")) ? "empty" : "typed";
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

/** Whether every visible character of `line` is drawn dim (SGR 2): a suggestion, not text. */
function onlyDim(line: string): boolean {
  let dim = false;
  let i = 0;
  while (i < line.length) {
    const m = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (m) {
      for (const p of (m[1] || "0").split(/[;:]/)) {
        if (p === "2") dim = true;
        else if (p === "0" || p === "" || p === "22") dim = false;
      }
      i += m[0].length;
      continue;
    }
    const ch = line[i]!;
    if (ch === "\x1b") return false;
    if (!/[\s\u00a0]/.test(ch) && !dim) return false;
    i++;
  }
  return true;
}

export type Readiness = { ready: true } | { ready: false; why: "typing" | "screen" | "copy_mode" | "gone" };

/** One tmux pane that holds a conversation open, and the typing into it. */
export class TerminalInput {
  constructor(readonly ref: PaneRef, private readonly tmux: TmuxRunner, private readonly echoWaitMs = 3_000) {}

  /** Whether the pane can be typed into now: alive, not scrolled back (copy mode), and its input box empty. */
  async readiness(): Promise<Readiness> {
    let info: string;
    try {
      info = await this.tmux.run(["display-message", "-p", "-t", this.ref.pane, "#{pane_in_mode} #{pane_dead}"]);
    } catch {
      return { ready: false, why: "gone" };
    }
    const [mode, dead] = info.trim().split(" ");
    if (dead === "1") return { ready: false, why: "gone" };
    if (mode !== "0") return { ready: false, why: "copy_mode" };
    const box = inputBox(await this.screen());
    return box === "empty" ? { ready: true } : { ready: false, why: box === "typed" ? "typing" : "screen" };
  }

  private async screen(): Promise<string> {
    try { return await this.tmux.run(["capture-pane", "-p", "-e", "-t", this.ref.pane]); } catch { return ""; }
  }

  /**
   * Type `text` (already {@link cleanInput}) into the box and submit it. One line goes through `send-keys -l` (literal: no
   * key names); several go through a named buffer pasted with `-p` (bracketed paste) and deleted (`-d`). Enter is pressed
   * only once the box shows something: a paste the program did not take is not followed by an Enter into whatever is there.
   */
  async type(text: string): Promise<void> {
    if (!text) throw new Error("nothing to type");
    if (!text.includes("\n")) {
      await this.tmux.run(["send-keys", "-t", this.ref.pane, "-l", "--", text]);
    } else {
      const buffer = `claw-${randomUUID()}`;
      await this.tmux.run(["load-buffer", "-b", buffer, "-"], text);
      try {
        await this.tmux.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", this.ref.pane]);
      } catch (e) {
        await this.tmux.run(["delete-buffer", "-b", buffer]).catch(() => undefined);
        throw e;
      }
    }
    const by = Date.now() + this.echoWaitMs;
    for (;;) {
      if (inputBox(await this.screen()) === "typed") break;
      if (Date.now() >= by) throw new Error("the terminal did not show the typed text");
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.tmux.run(["send-keys", "-t", this.ref.pane, "Enter"]);
  }

  /** Esc: Claude Code stops the turn it is running. */
  async interrupt(): Promise<void> {
    await this.tmux.run(["send-keys", "-t", this.ref.pane, "Escape"]);
  }
}
