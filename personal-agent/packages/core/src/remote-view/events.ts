// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a remote session's events. Claw relays what the agent says and does not interpret it, so every reader here is tolerant:
 * a chunk's text may come as an ACP `session/update` (`{update: {content: {text}}}`) or flat (`{text}`), and a field that is missing
 * or of the wrong type is a field that is not shown, never a crash. Every string is untrusted text.
 */
import { z } from "zod";

import type { SseEvent } from "../claw/model.js";
import type { PublicErrors } from "../public-error/public-errors.js";

import { neutral } from "./inert.js";
import { strip } from "./py-text.js";
import { RESUME_REF_MAX } from "./limits.js";

export interface ToolUpdate {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/** What the runner does after one event. Every field but the flags is null when the event does not say it. */
export interface RemoteStep {
  readonly chunk: { readonly kind: "message" | "thought"; readonly text: string } | null;
  readonly tool: ToolUpdate | null;
  /** One line saying where the plan stands. */
  readonly plan: string | null;
  /** A permissionRequest's payload, to turn into a card. */
  readonly permission: Readonly<Record<string, unknown>> | null;
  /** A permission_resolved payload: another client answered. */
  readonly resolved: Readonly<Record<string, unknown>> | null;
  readonly mode: string | null;
  readonly modes: readonly string[] | null;
  /** The session, as it is now, does not ask before a step. */
  readonly unattended: boolean | null;
  /** Mode id -> whether selecting it makes the session unattended, for the modes that say. */
  readonly modeFlags: Readonly<Record<string, boolean>> | null;
  /** One line for the view (a resume, a mode change, an error). */
  readonly note: string | null;
  readonly started: boolean;
  /** The turn is over. */
  readonly finished: boolean;
  readonly stopReason: string;
  /** The session ended: the reason, "" when none was given. */
  readonly closed: string | null;
  /** A command the connector refused. */
  readonly rejected: { readonly type: string; readonly reason: string } | null;
  /** An event of history the agent replayed: never shown as new. */
  readonly replay: boolean;
  /** The session only watches a conversation open in a terminal. */
  readonly readOnly: boolean | null;
  /** The connector restarted and the session is back. */
  readonly recovered: { readonly interrupted: boolean; readonly continuing: boolean } | null;
  /** A message for a terminal's conversation waits for that terminal (the connector's reason). */
  readonly queued: string | null;
  /** What the person typed at the terminal of a conversation shared with the chat. */
  readonly typed: string | null;
  /** What is sent is typed into a terminal on the machine (`input: "terminal"`). */
  readonly terminal: boolean | null;
  /** That terminal's permission mode as its connector read it at the start. */
  readonly terminalMode: string | null;
  /** The conversation id the agent runs the session under on the machine. */
  readonly acp: string | null;
}

export const NOTHING: RemoteStep = Object.freeze({
  chunk: null,
  tool: null,
  plan: null,
  permission: null,
  resolved: null,
  mode: null,
  modes: null,
  unattended: null,
  modeFlags: null,
  note: null,
  started: false,
  finished: false,
  stopReason: "",
  closed: null,
  rejected: null,
  replay: false,
  readOnly: null,
  recovered: null,
  queued: null,
  typed: null,
  terminal: null,
  terminalMode: null,
  acp: null,
});

/** A step that says only `fields`. */
export function remoteStep(fields: Partial<RemoteStep> = {}): RemoteStep {
  return { ...NOTHING, ...fields };
}

const Record_ = z.record(z.string(), z.unknown());
type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json {
  const parsed = Record_.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** The part of an ACP `session/update` that says what happened (`update`), or the payload itself when it is flat. */
function update(payload: Json): Json {
  const inner = Record_.safeParse(payload["update"]);
  return inner.success ? inner.data : payload;
}

function textOf(payload: Json): string {
  const u = update(payload);
  const content = u["content"];
  const inner = Record_.safeParse(content);
  if (inner.success && typeof inner.data["text"] === "string") return inner.data["text"];
  if (typeof content === "string") return content;
  return str(u["text"]);
}

/** ACP's stop reasons, and "error". Any other text is no word to show: even a snake_case one may be a service's name. */
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"]);

function availableModes(raw: unknown): unknown {
  const state = Record_.safeParse(raw); // ACP's SessionModeState: {currentModeId, availableModes}
  return state.success ? state.data["availableModes"] : raw;
}

/** Mode ids from an agent's `availableModes` (objects with an `id`, or plain ids); null when it names none. */
function modeIds(raw: unknown): string[] | null {
  const list = availableModes(raw);
  if (!Array.isArray(list)) return null;
  const ids = list.map((m: unknown) => {
    const mode = Record_.safeParse(m);
    return mode.success ? mode.data["id"] : m;
  });
  return ids.filter((i): i is string => typeof i === "string" && i !== "").slice(0, 20);
}

/** `{mode id: unattended}` for the modes that carry a boolean `unattended`; null when none does (a connector that predates the key). */
function modeFlags(raw: unknown): Record<string, boolean> | null {
  const list = availableModes(raw);
  const flags: Record<string, boolean> = {};
  for (const m of Array.isArray(list) ? list : []) {
    const mode = record(m);
    const id = mode["id"];
    const unattended = flag(mode["unattended"]);
    if (typeof id === "string" && id !== "" && unattended !== null) flags[id] = unattended;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

function currentMode(payload: Json): string | null {
  const modes = Record_.safeParse(payload["modes"]);
  for (const source of [update(payload), payload, modes.success ? modes.data : {}]) {
    for (const name of ["currentModeId", "currentMode", "mode", "modeId"]) {
      const value = source[name];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return null;
}

const PLAN_ITEM_MAX = 80;

function planLine(payload: Json): string | null {
  const entries = update(payload)["entries"];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const items = entries.flatMap((e: unknown) => {
    const item = Record_.safeParse(e);
    return item.success ? [item.data] : [];
  });
  if (items.length === 0) return null;
  const done = items.filter((e) => e["status"] === "completed").length;
  const current = items.find((e) => e["status"] === "in_progress") ?? items.find((e) => e["status"] !== "completed");
  let line = `\u{1f4cb} Plan: ${String(done)} of ${String(items.length)} done`;
  if (current && str(current["content"])) line += `, now: ${neutral(current["content"], PLAN_ITEM_MAX)}`;
  return line;
}

/** What Claude Code itself writes into a transcript as the user's turn (a slash command's tags, a reminder, an interrupt
 * marker): not words the person typed. */
const NOT_TYPED = /^(?:<(command-|local-command-|system-reminder|bash-|user-prompt-submit-hook)|\[Request interrupted)/;

type Reader = (payload: Json, kind: string, errors: PublicErrors) => RemoteStep;

function chunk(payload: Json, kind: string): RemoteStep {
  const text = textOf(payload);
  if (!text) return NOTHING;
  return remoteStep({ chunk: { kind: kind === "agent_message_chunk" ? "message" : "thought", text } });
}

function typed(payload: Json): RemoteStep {
  // (a prompt typed at the terminal: the connector does not echo the chat's own messages)
  const text = strip(textOf(payload));
  return text && !NOT_TYPED.test(text) ? remoteStep({ typed: text }) : NOTHING;
}

function tool(payload: Json, kind: string): RemoteStep {
  const u = update(payload);
  const id = str(u["toolCallId"]) || str(u["tool_call_id"]) || str(u["id"]);
  const status = str(u["status"]) || (kind === "tool_call" ? "pending" : "");
  return remoteStep({ tool: { id, title: str(u["title"]), status } });
}

function turnEnd(payload: Json, _kind: string, errors: PublicErrors): RemoteStep {
  let reason = str(payload["stopReason"]) || "end_turn";
  let error = str(payload["error"]) || str(payload["message"]);
  if (!STOP_REASONS.has(reason)) {
    error = error || `an internal error (ref ${errors.withhold("remote_stop_reason", reason)})`;
    reason = "error";
  }
  return remoteStep({
    finished: true,
    stopReason: reason,
    note: error ? neutral(errors.publicReason(error, "remote_turn_end"), 300) : null,
  });
}

function sessionStarted(payload: Json): RemoteStep {
  return remoteStep({
    started: true,
    mode: currentMode(payload),
    modes: modeIds(payload["modes"]),
    unattended: flag(payload["unattended"]),
    modeFlags: modeFlags(payload["modes"]),
    readOnly: flag(payload["read_only"]) ?? false,
    terminal: payload["input"] === "terminal",
    terminalMode: neutral(str(payload["terminal_mode"]), 40) || null,
    acp: neutral(str(payload["acp_session_id"]), RESUME_REF_MAX) || null,
  });
}

function modeUpdate(payload: Json): RemoteStep {
  const mode = currentMode(payload);
  return remoteStep({
    mode,
    unattended: flag(payload["unattended"]),
    note: mode ? `Mode is now ${neutral(mode, 40)}.` : null,
  });
}

function sessionResumed(payload: Json): RemoteStep {
  const readOnly = flag(payload["read_only"]) ?? false;
  return remoteStep({
    note: readOnly ? null : "Session resumed.",
    mode: currentMode(payload),
    modes: modeIds(payload["modes"]),
    unattended: flag(payload["unattended"]),
    modeFlags: modeFlags(payload["modes"]),
    readOnly,
    terminal: payload["input"] === "terminal",
  });
}

function sessionClosed(payload: Json, _kind: string, errors: PublicErrors): RemoteStep {
  const reason = str(payload["reason"]) || str(payload["message"]) || str(payload["error"]);
  return remoteStep({ closed: neutral(errors.publicReason(reason, "remote_session_closed"), 300) });
}

function commandRejected(payload: Json, _kind: string, errors: PublicErrors): RemoteStep {
  // (a refused prompt also gets its turn_end, or Claw ends it: this only names the refusal)
  const reason = str(payload["reason"]);
  return remoteStep({
    rejected: {
      type: str(payload["type"]),
      reason: neutral(errors.publicReason(reason, "remote_command_rejected"), 300),
    },
  });
}

function failed(payload: Json, _kind: string, errors: PublicErrors): RemoteStep {
  const text = str(payload["message"]) || str(payload["error"]) || str(payload["reason"]);
  return remoteStep({
    finished: true,
    stopReason: "error",
    note: neutral(errors.publicReason(text, "remote_error") || "The agent reported an error.", 300),
  });
}

const READERS: Readonly<Record<string, Reader>> = {
  agent_message_chunk: chunk,
  agent_thought_chunk: chunk,
  user_message_chunk: typed,
  tool_call: tool,
  tool_call_update: tool,
  plan: (payload) => remoteStep({ plan: planLine(payload) }),
  permissionRequest: (payload) => remoteStep({ permission: payload }),
  permission_resolved: (payload) => remoteStep({ resolved: payload }),
  turn_end: turnEnd,
  session_started: sessionStarted,
  mode_update: modeUpdate,
  session_resumed: sessionResumed,
  session_recovered: (payload) =>
    remoteStep({
      recovered: { interrupted: payload["interrupted"] === true, continuing: payload["continuing"] === true },
    }),
  session_closed: sessionClosed,
  command_rejected: commandRejected,
  error: failed,
  session_error: failed,
  turn_error: failed,
  // (the session types into a terminal on the machine, which is busy: the message waits)
  terminal_input_queued: (payload) => remoteStep({ queued: str(payload["reason"]) || "terminal_working" }),
};

/** One SSE frame of a remote session to what the runner does. What cannot be read is skipped (usage_update, history_complete
 * and every type this client does not know are nothing). */
export function decode(event: SseEvent, errors: PublicErrors): RemoteStep {
  const payload = record(event.data["data"]);
  if (payload["replay"] === true) return remoteStep({ replay: true });
  const reader = Object.hasOwn(READERS, event.name) ? READERS[event.name] : undefined;
  return reader ? reader(payload, event.name, errors) : NOTHING;
}
