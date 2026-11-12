// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which Claude Code sessions the approval hooks leave alone: those with nobody at the terminal to be asked. Such a session
 * behaves as if the hooks were not installed (the hook prints nothing and exits at once), so nothing of it reaches the phone.
 *
 * Measured with Claude Code 2.1.322, from what a hook is handed (its stdin and its environment):
 *  - `claude -p`, and `claude` with its stdin piped in (which Claude Code runs as `-p`): `CLAUDE_CODE_ENTRYPOINT=sdk-cli` and
 *    `CLAUDE_CODE_SESSION_ATTENDED=0`, also when the shell that started it exported `cli` and `1` (Claude Code sets both itself).
 *    These sessions do raise `PermissionRequest`.
 *  - A session the connector's own ACP adapter runs: `sdk-cli` (measured on 2.1.314, terminals.ts); its questions already come
 *    to the phone through the connector's own cards.
 *  - A terminal session: `cli` and `1`, in every permission mode.
 *  - `--dangerously-skip-permissions` (or `--permission-mode bypassPermissions`, or shift+tab into it): no question about a
 *    command or an edit, but `AskUserQuestion` still raises `PermissionRequest`, with `permission_mode: "bypassPermissions"`.
 *    A session in that mode is usually one nobody watches, so its questions stay in the terminal. `dontAsk` never asks at all.
 *  - Neither stdin nor the parent's terminal tells anything: a hook's stdin is always a pipe, and the shell Claude Code starts it
 *    from has no controlling terminal, in a terminal session as much as in `-p`.
 *
 * What cannot be told apart from a person (a script that drives an interactive `claude` in tmux, for one) is left out with
 * `CLAW_APPROVAL_HOOKS=off` in its environment; the hooks inherit it from the `claude` they run under.
 *
 * Codex (`--agent codex`, measured on 0.153.4) sets neither variable, so for Codex only the opt-out and the permission mode apply
 * here: its events carry `permission_mode` too (`bypassPermissions` under `--dangerously-bypass-approvals-and-sandbox` or
 * approval policy `never`, `default` otherwise). That Codex has a person at its terminal is told by the hook itself
 * (approval-hook.ts): only the TUI (`originator: "codex-tui"`, so never `codex exec` or codex-acp), only a terminal device.
 *
 * Imports nothing: the hook program is a bundle of its own that Claude Code waits for.
 */

/** The opt-out: set to one of these (any case), the hooks pass nothing on. */
export const OPT_OUT_ENV = "CLAW_APPROVAL_HOOKS";
const OFF = new Set(["off", "0", "false", "no", "disable", "disabled"]);

/** Permission modes a session nobody is asked in runs in. */
export const UNATTENDED_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);

export function optedOut(env: Record<string, string | undefined>): boolean {
  return OFF.has((env[OPT_OUT_ENV] ?? "").trim().toLowerCase());
}

/**
 * Why the hook leaves this session alone, or null to pass the event on. `event` is what Claude Code handed the hook; only the
 * permission request itself is held to its mode (an event that only says the terminal answered is still passed on, so a card
 * already out is withdrawn when the person switches modes meanwhile).
 */
export function skipReason(
  env: Record<string, string | undefined>, event: Record<string, unknown> | null, mode: "ask" | "settled", agent: "claude" | "codex" = "claude",
): string | null {
  if (optedOut(env)) return "opted_out";
  if (agent === "claude" && env.CLAUDE_CODE_ENTRYPOINT !== "cli") return "not_a_terminal";
  if (agent === "claude" && env.CLAUDE_CODE_SESSION_ATTENDED === "0") return "unattended";
  if (mode === "ask" && event && typeof event.permission_mode === "string" && UNATTENDED_MODES.has(event.permission_mode)) return "unattended_mode";
  return null;
}
