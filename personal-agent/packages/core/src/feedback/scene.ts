// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { fixed1 } from "../text/py-text.js";
import { tokenOf } from "./identifiers.js";
import { code, fence } from "./markdown.js";

/**
 * The scene of a report: who and where, the chat's last turns, the worker's last log lines for that chat. Recorded
 * without asking, so it carries ids, states, counts and tool names only, never what anybody wrote: every value taken
 * from an event is an enumerated field or an identifier-shaped token (`tokenOf`).
 */

export const LAST_TURNS = 2;
export const LOG_LINES = 30;
const MAX_TOOLS = 15;
const MAX_ERRORS = 5;
/** A turn with no end and no event for this long is "stuck". */
const STUCK_AFTER_SECONDS = 300;

/** One event of a session's history, as Claw's replay gives it (the stream's history has no `created_at`). */
export interface HistoryRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly data: unknown;
  readonly created_at: unknown;
}

/** An event of a turn: its id, type, data object and time (seconds since the epoch; undefined when not known). */
export interface TurnEvent {
  readonly id: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly at: number | undefined;
}

export type TurnStatus = "finished" | "failed" | "stopped" | "stuck" | "running" | "unfinished";

export interface TurnSummary {
  readonly turnId: string;
  readonly status: TurnStatus;
  readonly seconds: number | undefined;
  readonly tools: readonly string[];
  readonly toolErrors: number;
  readonly errors: readonly string[];
}

export interface Scene {
  readonly name: string;
  readonly platformUserId: string;
  /** "1:1" or "group". */
  readonly chat: string;
  /** Seconds since the epoch. */
  readonly at: number;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly workerVersion: string;
  readonly workerImage: string;
  readonly apiImage: string;
  readonly brainImage: string;
  /** Whether the session runs a turn now; undefined when that could not be read. */
  readonly busy: boolean | undefined;
  readonly turns: readonly TurnSummary[];
  /** Why there are no turns, when there are none. */
  readonly turnsNote: string;
  readonly logs: readonly string[];
}

export function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** ISO 8601's fraction of a second, which `Date.parse` cuts to milliseconds and Python keeps to microseconds. */
const FRACTION = /^(.*T\d{2}:\d{2}:\d{2})\.(\d+)(.*)$/;

/** A timestamp as Claw writes it (epoch seconds or milliseconds, or ISO 8601 to the microsecond), in seconds. */
export function secondsOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e11 ? value / 1000 : value;
  if (typeof value !== "string" || !value) return undefined;
  const parts = FRACTION.exec(value);
  const ms = Date.parse(parts ? `${parts[1] ?? ""}${parts[3] ?? ""}` : value);
  if (Number.isNaN(ms)) return undefined;
  const fraction = parts ? Number(`0.${(parts[2] ?? "").slice(0, 6)}`) : 0;
  return ms / 1000 + fraction;
}

function eventOf(row: HistoryRow): TurnEvent {
  const data = objectOf(row.data);
  const type = row.event_type || (typeof data["type"] === "string" ? data["type"] : "");
  return { id: row.event_id, type, data, at: secondsOf(row.created_at) };
}

/** The session's events grouped by turn: a turn starts at a UserMessage and runs to the next one. */
export function splitTurns(rows: readonly HistoryRow[]): TurnEvent[][] {
  const turns: TurnEvent[][] = [];
  for (const row of rows) {
    const event = eventOf(row);
    if (event.type === "UserMessage") turns.push([event]);
    else turns.at(-1)?.push(event);
  }
  return turns;
}

/** The id of a turn: the message id of its UserMessage, else that event's id. */
export function turnIdOf(events: readonly TurnEvent[]): string {
  const first = events[0];
  if (first === undefined) return "unknown";
  return tokenOf(first.data["message_id"]) ?? tokenOf(first.id) ?? "unknown";
}

function errorCode(data: Readonly<Record<string, unknown>>): string | undefined {
  const inner = objectOf(data["data"]);
  const error = objectOf(data["error"]);
  const candidates = [
    data["code"],
    data["error_code"],
    inner["code"],
    inner["error_code"],
    error["code"],
    error["type"],
  ];
  for (const value of candidates) {
    const token = tokenOf(value);
    if (token !== undefined) return token;
  }
  return undefined;
}

interface Tally {
  tools: string[];
  errors: string[];
  toolErrors: number;
  terminal: TurnStatus | undefined;
  elapsed: number | undefined;
}

function tallyTool(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  const name = tokenOf(data["tool"]);
  if (name !== undefined && !tally.tools.includes(name) && tally.tools.length < MAX_TOOLS) tally.tools.push(name);
  if (data["status"] === "error") tally.toolErrors += 1;
}

function tallyResult(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  const inner = data["data"];
  const subtype = typeof inner === "object" && inner !== null ? tokenOf(objectOf(inner)["subtype"]) : undefined;
  tally.terminal = subtype === "error" ? "failed" : "finished";
  if (subtype === "error") tally.errors.push("ResultMessage subtype=error");
  const ms = data["elapsed_ms"];
  if (typeof ms === "number") tally.elapsed = ms / 1000;
}

function tally(tally: Tally, event: TurnEvent): void {
  const { type, data } = event;
  if (type === "toolUsed") tallyTool(tally, data);
  else if (type === "ResultMessage") tallyResult(tally, data);
  else if (type === "statusUpdate" && (data["agentStatus"] === "failed" || data["agentStatus"] === "stopped")) {
    tally.terminal = data["agentStatus"];
    if (tally.terminal === "failed") tally.errors.push("statusUpdate failed");
  } else if (type === "error") {
    tally.terminal = "failed";
    const found = errorCode(data);
    tally.errors.push(found === undefined ? "error" : `error code=${found}`);
  }
}

/** Status, duration, tool names and errors of one turn, from event types and a few enumerated fields only. */
export function summarizeTurn(events: readonly TurnEvent[], now: number): TurnSummary {
  const t: Tally = { tools: [], errors: [], toolErrors: 0, terminal: undefined, elapsed: undefined };
  for (const event of events) tally(t, event);
  const times = events.flatMap((e) => (e.at === undefined ? [] : [e.at]));
  const latest = times.length > 0 ? Math.max(...times) : undefined;
  const seconds = times.length >= 2 && latest !== undefined ? latest - Math.min(...times) : t.elapsed;
  let status = t.terminal;
  if (status === undefined) {
    if (latest === undefined) status = "unfinished";
    else status = now - latest > STUCK_AFTER_SECONDS ? "stuck" : "running";
  }
  return {
    turnId: turnIdOf(events),
    status,
    seconds,
    tools: t.tools,
    toolErrors: t.toolErrors,
    errors: [...new Set(t.errors)].slice(0, MAX_ERRORS),
  };
}

/** The last `LAST_TURNS` turns of a history, summarized. */
export function lastTurns(rows: readonly HistoryRow[], now: number): TurnSummary[] {
  return splitTurns(rows)
    .slice(-LAST_TURNS)
    .map((events) => summarizeTurn(events, now));
}

function turnLine(turn: TurnSummary): string {
  const took = turn.seconds === undefined ? "duration unknown" : `${fixed1(turn.seconds)} s`;
  const tools = turn.tools.map(code).join(", ") || "none";
  const errors = turn.errors.map(code).join("; ") || "none";
  const failed = turn.toolErrors ? `, ${String(turn.toolErrors)} tool error(s)` : "";
  return `- ${code(turn.turnId)}: ${turn.status}, ${took}${failed}; tools: ${tools}; errors: ${errors}`;
}

function utcStamp(seconds: number): string {
  return new Date(Math.trunc(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** The scene as the issue shows it. */
export function sceneMarkdown(scene: Scene): string {
  const busy = scene.busy === undefined ? "unknown" : scene.busy ? "running now" : "idle";
  const user = scene.platformUserId ? `SaFE user ${code(scene.platformUserId)}` : "SaFE user unknown (chat not linked)";
  const lines = [
    "### Context (recorded automatically)",
    "",
    `- Reporter: ${code(scene.name || "unknown")} (${user})`,
    `- Chat: ${scene.chat}`,
    `- Reported at (UTC): ${utcStamp(scene.at)}`,
    `- Plugin id: ${code(scene.pluginId || "none")}`,
    `- Worker: version ${code(scene.workerVersion)}, image tag ${code(scene.workerImage)}`,
    `- Claw api image tag: ${code(scene.apiImage)}; brain image tag: ${code(scene.brainImage)}`,
    `- Session state: ${busy}`,
    "",
    "**Last turns** (ids, states and counts only; no message text)",
    "",
    ...(scene.turns.length > 0
      ? scene.turns.map(turnLine)
      : [`- none (${scene.turnsNote || "the session has no turns"})`]),
    "",
    `**Worker log, last ${String(LOG_LINES)} lines for this chat** (ids and levels only)`,
    "",
    fence(scene.logs.length > 0 ? scene.logs.join("\n") : "(no log lines for this chat)", "text"),
  ];
  return lines.join("\n");
}

/** The newest turn of the scene: what "my last question and answer" means. */
export function lastTurnId(scene: Scene): string {
  return scene.turns.at(-1)?.turnId ?? "";
}
