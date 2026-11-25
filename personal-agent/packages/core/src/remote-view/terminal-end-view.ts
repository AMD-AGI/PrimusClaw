// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a turn that ended in a terminal while nobody was at it (Claw's `remote.end`, `kind` done or error): which conversation,
 * at a glance (its name and its status in the title; the tool, the machine, the folder, that the terminal sat idle and the item number
 * in one small line under it), what the agent did in a few lines, its last answer whole behind "Show all", and buttons that send the
 * commands for it as the person's own message: attach the chat to that conversation (`/agent attach <ref>`, when Claw offers it) and
 * mute it (`/approvals mute #N`). Everything the agent or its machine wrote is inert text.
 */
import type { TerminalEnd } from "../assistant/events.js";
import type { Lang } from "../locales/lang.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import { lit } from "../remote/inert.js";
import { wordsText } from "./terminal-ask-view.js";

/** A button that sends `command` as if the person typed it (Teams: an imBack). */
export interface CommandButton {
  readonly title: string;
  readonly command: string;
}

export interface TerminalEndView {
  readonly lang: Lang;
  /** The conversation's name and its status: "ops 做完了". */
  readonly title: string;
  readonly failed: boolean;
  /** The tool, the machine, the folder, the terminal idle and the item, in one small line. */
  readonly where: string;
  /** What it did (markup escaped, links broken); "" when it said nothing. */
  readonly summary: string;
  /** Its last answer whole (markdown kept, links broken), shown on "Show all"; "" when the summary is all of it. */
  readonly full: string;
  readonly fullLabel: string;
  /** "The rest is in the terminal." when something was left out and there is no whole answer to show; else "". */
  readonly rest: string;
  readonly buttons: readonly CommandButton[];
}

export interface TerminalEndInput {
  readonly end: TerminalEnd;
  readonly machine: string;
  /** The tool's name as people know it (Claude Code, Codex), or the agent's id. */
  readonly agent: string;
  readonly lang: Lang;
}

/** The view of one turn's end, as Claw described it. */
export function terminalEndView(input: TerminalEndInput): TerminalEndView {
  const { end, lang } = input;
  const words = terminalApprovalText.in(lang);
  const failed = end.error !== "";
  const name = lit(end.name, 80) || lit(input.agent, 40);
  const status = failed ? words.endError({ error: lit(end.error, 40) }) : words.endDone;
  const where = [
    end.name ? lit(input.agent, 40) : "",
    lit(input.machine, 60),
    lit(end.folder, 80),
    words.endIdle,
    `#${String(end.itemSeq)}`,
  ].filter(Boolean);
  const summary = end.summary
    .split("\n")
    .map((line) => lit(line, 400))
    .filter(Boolean)
    .join("\n\n");
  const full = end.more && end.full.trim() ? wordsText(end.full.trim()) : "";
  const buttons: CommandButton[] = [];
  if (end.attach) buttons.push({ title: words.endAttach, command: end.attach });
  buttons.push({ title: words.endMute, command: `/approvals mute #${String(end.itemSeq)}` });
  return {
    lang,
    title: `${name} ${status}`,
    failed,
    where: where.join(" · "),
    summary,
    full,
    fullLabel: words.endFull,
    rest: end.more && !full ? words.endRest : "",
    buttons,
  };
}
