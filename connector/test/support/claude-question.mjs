// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claude Code's permission questions as it draws them in place of its input box, byte for byte (colours included) as Claude Code
 * 2.1.325 drew them in a tmux pane 130 columns wide (captured with `capture-pane -p -e`, 2026-11-18); only the paths and the
 * descriptions are the tests' own. Lines are joined with "\n" (`capture-pane`) or "\r\n" (a terminal drawing them).
 */
const RULE = (n) => "─".repeat(n);
const DASHED = (n) => "╌".repeat(n);

/** A Bash command's question; `warning`: the line Claude Code adds for a command it will not allow on its own (a dangerous `rm`). */
export function bashQuestion({ command, description, warning = null, width = 130 }) {
  return [
    `\x1b[38;5;153m${RULE(width)}`,
    "\x1b[39m \x1b[1m\x1b[38;5;153mBash command\x1b[0m",
    ` \x1b[38;5;246m${description}\x1b[39m`,
    `\x1b[38;5;239m${DASHED(width)}`,
    `\x1b[39m ${command}`,
    `\x1b[38;5;239m${DASHED(width)}`,
    ...(warning ? [
      `\x1b[39m \x1b[2m│\x1b[0m ${warning}`,
      " \x1b[38;5;220m⚠\x1b[39m \x1b[38;5;220mClaude\x1b[39m \x1b[38;5;220mCode\x1b[39m \x1b[38;5;220mwill\x1b[39m \x1b[38;5;220mautomatically\x1b[39m \x1b[38;5;220mblock\x1b[39m \x1b[38;5;220mthis\x1b[39m \x1b[38;5;220mrequest\x1b[39m \x1b[38;5;220min\x1b[39m \x1b[38;5;220m1:37,\x1b[39m \x1b[38;5;220mto\x1b[39m \x1b[38;5;220mavoid\x1b[39m \x1b[38;5;220mholding\x1b[39m \x1b[38;5;220mup\x1b[39m \x1b[38;5;220man\x1b[39m \x1b[38;5;220munattended\x1b[39m \x1b[38;5;220msession\x1b[39m",
      "",
      "",
    ] : []),
    " Do you want to proceed?",
    " \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m \x1b[38;5;153mYes\x1b[39m",
    "   \x1b[38;5;246m2.\x1b[39m No",
    "",
    " \x1b[38;5;246mEsc\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mcancel\x1b[39m \x1b[38;5;246m·\x1b[39m \x1b[38;5;246mTab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mamend\x1b[39m",
  ];
}

/** A Write tool's question for a new file (its content between the dashed rules). */
export function createFileQuestion({ file, content, width = 130 }) {
  return [
    `\x1b[38;5;153m${RULE(width)}`,
    "\x1b[39m \x1b[1m\x1b[38;5;153mCreate file\x1b[0m",
    ` \x1b[38;5;246m${file}\x1b[39m`,
    `\x1b[38;5;239m${DASHED(width)}`,
    `\x1b[39m \x1b[2m\x1b[38;5;231m 1 \x1b[0m\x1b[38;5;231m${content}\x1b[39m`,
    `\x1b[38;5;239m${DASHED(width)}`,
    `\x1b[39m Do you want to create \x1b[1m${file}\x1b[0m?`,
    " \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mYes\x1b[39m",
    "   \x1b[38;5;246m2.\x1b[39m Yes, and switch to \x1b[1maccept\x1b[0m \x1b[1medits\x1b[0m for this session",
    "   \x1b[38;5;246m3.\x1b[39m No",
    "",
    " \x1b[38;5;246mEsc\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mcancel\x1b[39m \x1b[38;5;246m·\x1b[39m \x1b[38;5;246mTab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mamend\x1b[39m",
  ];
}

/** The tool call line above a question, as the transcript part of the screen shows it while the question waits. */
export function toolLine(tool, arg) {
  return [`\x1b[38;5;246m\x1b[49m●\x1b[39m \x1b[1m${tool}\x1b[0m(${arg})`, "\x1b[38;5;246m  ⎿  Waiting…\x1b[39m", ""];
}
