// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A machine set up before the approval hooks existed (0.1.22 and older), or without them, has the session hooks only. The
 * approval hooks are never added to Claude Code's settings without the owner's yes, so the next time the owner runs a command
 * of this program at a terminal they are offered there, once per Claude config directory: a yes adds them (what
 * `hooks install --approvals` does), anything else leaves the settings as they are and says the command that adds them. The
 * answer is kept in the state directory and the question is never asked again for that directory.
 *
 * Nothing is offered where nobody can answer (a script, a pipe, the service), to a command whose output a program reads
 * (`--json`), by `init`, `pair` and `hooks`, which install hooks themselves, or with `CLAW_APPROVAL_HOOKS=off` set.
 * Claw has no channel for a connector to put a notice in the owner's chat, so the terminal is where this is said.
 */
import fs from "node:fs";
import path from "node:path";
import { OPT_OUT_ENV, optedOut } from "./approval-skip.js";
import { approvalHooksStatus, hooksStatus, settingsFile } from "./hooks.js";
import type { Dirs } from "./paths.js";

export const approvalOfferFile = (d: Dirs): string => path.join(d.state, "approval-hooks-offer.json");
export const ENABLE_APPROVALS = "claw-connector hooks install --approvals";

/** Commands after which nothing is offered: they install hooks themselves, end this machine's sign-in, or are not run by people. */
const NOT_AFTER = new Set(["init", "pair", "hooks", "logout", "run", "supervise", "health-check"]);

type Answer = { answer: "yes" | "no"; at: string };
interface OfferState { v: 1; answered: Record<string, Answer> }

function readState(file: string): OfferState {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const answered = (doc as { answered?: unknown } | null)?.answered;
    if (typeof answered === "object" && answered !== null && !Array.isArray(answered)) return { v: 1, answered: answered as Record<string, Answer> };
  } catch { /* none yet, or unreadable: nothing answered */ }
  return { v: 1, answered: {} };
}

function writeState(file: string, st: OfferState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface OfferDeps {
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** Absent when nobody can answer: then nothing is offered (and nothing recorded, so the next command at a terminal offers). */
  ask?: (question: string) => Promise<boolean>;
  /** The Claude config directories this connector reads (as `hooks` picks them); computed only when there is someone to ask. */
  claudeDirs: () => string[];
  /** Adds the approval hooks to one directory, as `hooks install --approvals` does. */
  install: (dir: string) => { changed: boolean };
}

/** Whether a command that just ran (with these arguments) is one after which the offer may be made. */
export function offerAfter(cmd: string, args: string[]): boolean {
  return !NOT_AFTER.has(cmd) && !args.includes("--json");
}

/** Offer the approval hooks where the session hooks are and they are not, once per directory. Never throws. */
export async function offerApprovalHooks(d: OfferDeps): Promise<void> {
  if (!d.ask || optedOut(d.env)) return;
  const file = approvalOfferFile(d.dirs);
  let dirs: string[];
  try { dirs = d.claudeDirs(); } catch { return; }
  for (const dir of dirs) {
    const st = readState(file);
    if (st.answered[dir]) continue;
    if (hooksStatus(dir).events.length === 0 || approvalHooksStatus(dir).events.length > 0) continue;
    d.out("");
    d.out(`New: the approval hooks. With them, a question Claude Code asks in a terminal you started (run a command, edit a file,`);
    d.out(`approve a plan, a multiple-choice question) also comes to your chat as a card; the terminal keeps asking, and the first`);
    d.out(`answer wins. Sessions with nobody at the terminal send nothing: claude -p, bypass mode, the connector's own sessions,`);
    d.out(`and any started with ${OPT_OUT_ENV}=off. This is asked once.`);
    let yes = false;
    try { yes = await d.ask(`Add them to ${settingsFile(dir)}? [y/N] `); } catch { yes = false; }
    st.answered[dir] = { answer: yes ? "yes" : "no", at: new Date().toISOString() };
    try { writeState(file, st); } catch (e) { d.out(`(could not record the answer in ${file}: ${(e as Error).message}; this may be asked again)`); }
    if (!yes) { d.out(`left ${settingsFile(dir)} alone; to add them later: ${ENABLE_APPROVALS}`); continue; }
    try {
      d.out(d.install(dir).changed
        ? `installed the approval hooks in ${settingsFile(dir)} ("claw-connector hooks uninstall --approvals" takes them out)`
        : `the approval hooks are already in ${settingsFile(dir)}`);
    } catch (e) {
      d.out(`could not add the approval hooks: ${(e as Error).message}; fix it and run: ${ENABLE_APPROVALS}`);
    }
  }
}
