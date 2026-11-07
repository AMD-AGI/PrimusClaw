// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One sentence per refusal reason, saying what to do about it. A refused session (`session_closed`) or command
 * (`command_rejected`) carries its stable `reason` for a client to translate, and this `hint` beside it, so even a
 * client that does not know a reason can show something a person can act on. A hint names commands and settings,
 * never a path, a session's content or anything secret: it travels to Claw and to a phone.
 */
import path from "node:path";
import type { AgentConfig } from "./config.js";

type Family = "claude" | "codex" | "cursor" | "other";

/** Which agent an entry runs, from its command line (the kind is only a label). */
export function agentFamily(a: Pick<AgentConfig, "command" | "args"> & { kind?: string }): Family {
  const words = [a.command, ...a.args].map((s) => path.basename(s));
  if (words.some((s) => s.includes("claude-agent-acp") || s.includes("claude-code-acp"))) return "claude";
  if (words.some((s) => s.includes("codex-acp"))) return "codex";
  const cmd = path.basename(a.command);
  if (cmd === "agent" || cmd === "cursor-agent") return "cursor";
  // A preset's own label, when the command line does not tell (a wrapper script).
  if (a.kind === "claude" || a.kind === "attach") return "claude";
  if (a.kind === "codex" || a.kind === "cursor") return a.kind;
  return "other";
}

const SIGN_IN: Record<Family, string> = {
  claude: `Claude Code is not signed in on that machine: run "claude" there and sign in with /login, or set ANTHROPIC_API_KEY (or your gateway's ANTHROPIC_AUTH_TOKEN) for this agent in agents.toml under [agents.env]; a service installed from a shell that has the variable keeps it too`,
  codex: `Codex is not signed in on that machine: run "codex login" there (or "codex login --with-api-key"), or set OPENAI_API_KEY for this agent in agents.toml under [agents.env]`,
  cursor: `Cursor is not signed in on that machine: run "agent login" there, or set CURSOR_API_KEY for this agent in agents.toml under [agents.env]`,
  other: `the agent is not signed in on that machine: sign it in there, then try again`,
};

const DOCTOR = `run "claw-connector doctor" on that machine; it names the fix`;

const HINTS: Record<string, string> = {
  invalid_cwd: "give the folder to work in: a full path, ~/path, or the name of a folder inside one of this agent's roots",
  cwd_not_absolute: "give the folder as a full path, as ~/path, or as the name of a folder inside one of this agent's roots",
  cwd_not_found: "that folder does not exist on that machine: pick an existing folder inside one of this agent's roots, or create it there first",
  cwd_not_directory: "that is a file, not a folder: pick a folder inside one of this agent's roots",
  cwd_ambiguous: "more than one of this agent's roots has a folder by that name: give its full path",
  cwd_outside_roots: "this agent may only work inside its roots (agents.toml on that machine): pick a folder inside one of them, or add the folder to roots there and restart the connector",
  cwd_mismatch: "that conversation belongs to another folder: take it over without naming a folder, or name the one it was started in",
  root_unavailable: "the folder's disk is not answering on that machine (a network mount that is down or not mounted yet): try again in a minute, or check the mount there",
  unknown_agent: "that machine no longer offers this agent: check agents.toml there, then restart the connector",
  too_many_sessions: "that machine already runs the most sessions it allows at once (10): close one, then try again",
  mode_not_allowed: `that mode does not ask before each step, and this agent may use such a mode only with approval = "never" in agents.toml on that machine`,
  mode_unavailable: `the agent does not offer the mode this machine requires for it: ${DOCTOR}`,
  mode_not_enforced: `the agent would not run in a mode that asks before each step (often because Claude's own settings default to bypassPermissions): ${DOCTOR}, or set approval = "never" for this agent there`,
  mode_not_confirmed: `the agent did not confirm the mode this machine requires: ${DOCTOR}`,
  mode_mismatch: `the agent switched to a mode other than the one this machine requires: ${DOCTOR}`,
  adapter_start_failed: `the agent's program could not start on that machine (not installed, not on the service's PATH, or the download failed): ${DOCTOR}`,
  adapter_error: `the agent failed while opening the session: ${DOCTOR}; the adapter's log is in the connector's logs directory there`,
  adapter_protocol: `the agent answered in a way the connector does not understand: ${DOCTOR}, and update the agent's adapter`,
  adapter_cannot_resume: "this agent cannot reopen an earlier session: start a new one",
  adapter_gone: "the agent stopped while the session was opening: try again",
  resume_not_supported: "this agent starts new conversations only: start a new session instead of continuing one",
  resume_ref_required: "this agent only takes over conversations that already exist on that machine: pick one from its list, or use the agent that starts new ones",
  invalid_resume_ref: "that is not a conversation this machine lists: pick one from its list",
  attach_unavailable: "taking over conversations is not available for this agent on that machine: start a new session instead",
  already_attached: "that conversation is already open from the chat: use that session",
  unknown_session: "that machine no longer has this conversation (or it is outside the agent's roots): pick another one from its list",
  catalog_unavailable: `that machine could not list its conversations just now: try again; if it keeps failing, ${DOCTOR}`,
  session_live: "that conversation is open in a terminal on that machine: exit it there (/exit), then try again",
  recently_written: "that conversation was written to a moment ago: wait a few seconds, then try again",
  terminal_did_not_exit: "the terminal that has that conversation open did not exit when asked: exit it there (/exit), then take it over again",
  session_live_elsewhere: "that conversation is open on another machine or container sharing this Claude config directory: exit it there, then try again",
  takeover_not_permitted: "the terminal that has that conversation open belongs to another user: exit it there, then try again",
  takeover_expired: "the confirmation to take that conversation over reached the machine too late: open it again and confirm again",
  takeover_failed: "the connector could not end the terminal that has that conversation open: exit it there (/exit), then try again",
  twin_check_failed: "the connector could not check whether a terminal holds that conversation open: try again in a moment",
  too_many_queued_prompts: "five messages are already waiting for this session: wait for the agent to finish one",
  text_required: "the message was empty",
  session_closed: "the session has already ended: start a new one",
};

/** What to do about `reason`, for the agent it is about (a sign-in hint names that agent's own command); null when there is nothing to do. */
export function hintFor(reason: string, agent?: Pick<AgentConfig, "command" | "args"> & { kind?: string } | null): string | null {
  if (reason === "agent_auth_required") return SIGN_IN[agent ? agentFamily(agent) : "other"];
  return HINTS[reason] ?? null;
}

/** `data` with the hint for its `reason`, when there is one. */
export function withHint<T extends { reason: string }>(data: T, agent?: Pick<AgentConfig, "command" | "args"> & { kind?: string } | null): T & { hint?: string } {
  const hint = hintFor(data.reason, agent);
  return hint ? { ...data, hint } : data;
}
