// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The wire contract of the remote-agents capability.
 *
 * A remote agent is a program on a user's own machine that dials out to Claw. A
 * small client there (a "connector") reports which agents it can run, receives
 * commands over a long-lived `text/event-stream`, and posts the events those
 * agents produce back in batches. Nothing here knows what an agent is: `kind` is
 * an opaque label the connector reports, and an event's `data` is whatever the
 * agent said. The server relays, stores and audits; it never interprets.
 *
 * Both ends import this file so that the limits, the field rules and the frame
 * shapes have one definition. Every parser is total: it returns a typed refusal
 * rather than throwing, and it never trusts a field it did not check.
 */
import { createHash } from "node:crypto";

/** Version carried in every command frame, as `v`. */
export const REMOTE_AGENT_PROTOCOL_VERSION = 1;

export const REMOTE_AGENT_LIMITS = {
  /** Connectors one user may keep (revoked ones do not count). */
  maxConnectorsPerUser: 5,
  /** Sessions one user may have open at once. */
  maxActiveSessionsPerUser: 10,
  /** Bytes of one event's `data`, as JSON. */
  maxEventBytes: 64 * 1024,
  maxEventsPerBatch: 200,
  maxAgentsPerConnector: 20,
  /** Bytes of the capabilities object one agent reports. */
  maxCapabilitiesBytes: 4 * 1024,
  /** Bytes of one prompt. */
  maxPromptBytes: 64 * 1024,
  /** Commands one user may issue per minute, across all connectors. */
  commandsPerMinute: 60,
} as const;

export const REMOTE_AGENT_TIMING = {
  /** The server sends an `event: ping` frame this often on every stream. */
  pingMs: 25_000,
  /** A connector posts a heartbeat this often. */
  heartbeatMs: 30_000,
  /**
   * A connector is online while its command stream is open and its last
   * heartbeat is at most this old. Three missed heartbeats.
   */
  onlineWindowMs: 90_000,
  /**
   * How long a `prompt`, `set_mode` or `resume` (the commands with `needsOnline`) stays
   * deliverable once queued. They are accepted only while the connector is online, so one
   * still uncollected after this was sent into a connection that had died unnoticed, and
   * nobody is waiting on it: it is dropped, not replayed when the machine wakes hours later.
   * Longer than the connector's watchdog plus a reconnect, so an ordinary blip loses nothing.
   */
  liveCommandTtlMs: 5 * 60_000,
  /** A connector that sees no byte for this long drops the stream and reconnects. */
  watchdogMs: 75_000,
} as const;

/** Event types the server itself acts on; every other type is stored and relayed as is. */
export const REMOTE_EVENT_PERMISSION_REQUEST = "permissionRequest";
export const REMOTE_EVENT_PERMISSION_RESOLVED = "permission_resolved";
export const REMOTE_EVENT_SESSION_CLOSED = "session_closed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
// No control characters, so a name cannot forge a line in a log or a frame.
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const OPAQUE_ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v) ?? "").length;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A UUID in canonical lower case, or null. */
export function parseRemoteId(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
}

export interface RemoteAgentDescriptor {
  agent_id: string;
  /** Opaque to the server; a client picks an icon from it. */
  kind: string;
  name: string;
  /**
   * Whatever the connector reports, stored and relayed unchanged (at most `maxCapabilitiesBytes`). The connector in
   * this repository reports `unattended` and `unattended_allowed` (docs/remote-agents.md, "Whether a session asks
   * before it acts"); the server does not read them.
   */
  capabilities: Record<string, unknown>;
}

export interface RemoteHeartbeat {
  version: string | null;
  agents: RemoteAgentDescriptor[];
  /** Highest `cmd_seq` the connector has fully handled; the server may forget up to it. */
  cmdCursor: number | null;
}

function parseVersion(v: unknown): Parsed<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string" || v.length > 64 || !NAME_RE.test(v)) return fail("invalid_version");
  return { ok: true, value: v };
}

export function parseConnectorRegistration(body: unknown): Parsed<{ name: string; version: string | null }> {
  if (!isObject(body)) return fail("body_required");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 64 || !NAME_RE.test(name)) return fail("invalid_name");
  const version = parseVersion(body.version);
  if (!version.ok) return version;
  return { ok: true, value: { name, version: version.value } };
}

export function parseHeartbeat(body: unknown): Parsed<RemoteHeartbeat> {
  if (!isObject(body)) return fail("body_required");
  const parsedVersion = parseVersion(body.version);
  if (!parsedVersion.ok) return parsedVersion;
  const version = parsedVersion.value;
  if (!Array.isArray(body.agents)) return fail("agents_required");
  if (body.agents.length > REMOTE_AGENT_LIMITS.maxAgentsPerConnector) return fail("too_many_agents");
  const agents: RemoteAgentDescriptor[] = [];
  const seen = new Set<string>();
  for (const raw of body.agents) {
    if (!isObject(raw)) return fail("invalid_agent");
    const { agent_id: id, kind, name } = raw;
    if (typeof id !== "string" || !AGENT_ID_RE.test(id)) return fail("invalid_agent_id");
    if (seen.has(id)) return fail("duplicate_agent_id");
    seen.add(id);
    if (typeof kind !== "string" || !LABEL_RE.test(kind)) return fail("invalid_agent_kind");
    if (typeof name !== "string" || !NAME_RE.test(name)) return fail("invalid_agent_name");
    const capabilities = raw.capabilities ?? {};
    if (!isObject(capabilities) || jsonBytes(capabilities) > REMOTE_AGENT_LIMITS.maxCapabilitiesBytes) {
      return fail("invalid_agent_capabilities");
    }
    agents.push({ agent_id: id, kind, name, capabilities });
  }
  let cmdCursor: number | null = null;
  if (body.cmd_cursor !== undefined && body.cmd_cursor !== null) {
    if (!isCount(body.cmd_cursor)) return fail("invalid_cmd_cursor");
    cmdCursor = body.cmd_cursor;
  }
  return { ok: true, value: { version, agents, cmdCursor } };
}

export interface RemoteEventIn {
  session_id: string;
  seq: number;
  type: string;
  /** Milliseconds since the epoch, as the connector's clock saw it. */
  ts: number;
  data: Record<string, unknown>;
}

/** An accepted event, with its position in the posted array so a later refusal can name it. */
export interface ParsedRemoteEvent extends RemoteEventIn {
  index: number;
}

export interface RemoteEventRejection {
  /** Position in the posted array. */
  index: number;
  session_id: string | null;
  seq: number | null;
  reason: string;
}

export interface RemoteEventBatch {
  batchId: string;
  /** Events that passed the field rules, in posted order. */
  events: ParsedRemoteEvent[];
  /** Events that did not. They are never stored, and retrying them cannot help. */
  rejected: RemoteEventRejection[];
}

/**
 * A malformed envelope refuses the whole batch; a malformed event refuses only
 * itself. A client that kept resending one bad event would otherwise block every
 * good one behind it, forever.
 */
export function parseEventBatch(body: unknown): Parsed<RemoteEventBatch> {
  if (!isObject(body)) return fail("body_required");
  const batchId = body.batch_id;
  if (typeof batchId !== "string" || !OPAQUE_ID_RE.test(batchId) || batchId.length > 64) return fail("invalid_batch_id");
  if (!Array.isArray(body.events)) return fail("events_required");
  if (body.events.length > REMOTE_AGENT_LIMITS.maxEventsPerBatch) return fail("too_many_events");
  const events: ParsedRemoteEvent[] = [];
  const rejected: RemoteEventRejection[] = [];
  body.events.forEach((raw, index) => {
    const sessionId = isObject(raw) ? parseRemoteId(raw.session_id) : null;
    const seq = isObject(raw) && typeof raw.seq === "number" ? raw.seq : null;
    const refuse = (reason: string) => rejected.push({ index, session_id: sessionId, seq, reason });
    if (!isObject(raw)) return refuse("invalid_event");
    if (!sessionId) return refuse("invalid_session_id");
    if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 1) return refuse("invalid_seq");
    if (typeof raw.type !== "string" || !LABEL_RE.test(raw.type)) return refuse("invalid_type");
    if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || raw.ts < 0 || raw.ts > 8.64e15) return refuse("invalid_ts");
    if (!isObject(raw.data)) return refuse("invalid_data");
    if (jsonBytes(raw.data) > REMOTE_AGENT_LIMITS.maxEventBytes) return refuse("event_too_large");
    events.push({ index, session_id: sessionId, seq: raw.seq as number, type: raw.type, ts: raw.ts, data: raw.data });
  });
  return { ok: true, value: { batchId, events, rejected } };
}

export interface RemoteSessionNew {
  connector_id: string;
  agent_id: string;
  cwd: string;
  mode: string | null;
}

export function parseSessionNew(body: unknown): Parsed<RemoteSessionNew> {
  if (!isObject(body)) return fail("body_required");
  const connectorId = parseRemoteId(body.connector_id);
  if (!connectorId) return fail("invalid_connector_id");
  if (typeof body.agent_id !== "string" || !AGENT_ID_RE.test(body.agent_id)) return fail("invalid_agent_id");
  // The connector decides which directories are allowed; the server only keeps
  // the string sane. Any operating system's path shape is accepted.
  if (typeof body.cwd !== "string" || body.cwd.length < 1 || body.cwd.length > 4096 || /[\u0000-\u001f\u007f]/u.test(body.cwd)) {
    return fail("invalid_cwd");
  }
  let mode: string | null = null;
  if (body.mode !== undefined && body.mode !== null) {
    if (typeof body.mode !== "string" || !LABEL_RE.test(body.mode)) return fail("invalid_mode");
    mode = body.mode;
  }
  return { ok: true, value: { connector_id: connectorId, agent_id: body.agent_id, cwd: body.cwd, mode } };
}

/**
 * The commands a user can issue into an existing session.
 *
 * `session.new` is not here: it creates the session and goes through
 * {@link parseSessionNew}. The set is closed on purpose. A connector is not a
 * remote shell, so a type that is not listed is refused at the server and
 * dropped (and audited) at the connector.
 */
export const REMOTE_COMMAND_TYPES = ["prompt", "cancel", "set_mode", "resume", "close", "decision"] as const;
export type RemoteCommandType = (typeof REMOTE_COMMAND_TYPES)[number];

export interface RemoteCommandSpec {
  /**
   * Whether the command is refused while the connector is offline instead of
   * being queued. An instruction nobody could see being waited on must not run
   * half an hour later; an answer, a cancel or a close is safe to deliver late.
   */
  needsOnline: boolean;
  /** Whether it ends the session once it is accepted. */
  closesSession: boolean;
  /** Validated fields as the connector will receive them (without the frame fields). */
  parse(body: Record<string, unknown>): Parsed<Record<string, unknown>>;
  /** What the audit trail keeps. Never the text a user typed. */
  audit(payload: Record<string, unknown>): Record<string, unknown>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const REMOTE_COMMANDS: Record<RemoteCommandType, RemoteCommandSpec> = {
  prompt: {
    needsOnline: true,
    closesSession: false,
    parse(body) {
      const text = body.text;
      if (typeof text !== "string" || text.trim() === "") return fail("text_required");
      if (new TextEncoder().encode(text).length > REMOTE_AGENT_LIMITS.maxPromptBytes) return fail("prompt_too_large");
      return { ok: true, value: { text } };
    },
    audit: (p) => ({ sha256: sha256(String(p.text)), length: String(p.text).length }),
  },
  cancel: {
    needsOnline: false,
    closesSession: false,
    parse: () => ({ ok: true, value: {} }),
    audit: () => ({}),
  },
  set_mode: {
    needsOnline: true,
    closesSession: false,
    parse(body) {
      if (typeof body.mode_id !== "string" || !LABEL_RE.test(body.mode_id)) return fail("invalid_mode_id");
      return { ok: true, value: { mode_id: body.mode_id } };
    },
    audit: (p) => ({ mode_id: p.mode_id }),
  },
  resume: {
    needsOnline: true,
    closesSession: false,
    parse: () => ({ ok: true, value: {} }),
    audit: () => ({}),
  },
  close: {
    needsOnline: false,
    closesSession: true,
    parse: () => ({ ok: true, value: {} }),
    audit: () => ({}),
  },
  decision: {
    needsOnline: false,
    closesSession: false,
    parse(body) {
      const actionId = body.action_id ?? body.actionId;
      const optionId = body.option_id ?? body.optionId;
      if (typeof actionId !== "string" || !OPAQUE_ID_RE.test(actionId)) return fail("invalid_action_id");
      if (typeof optionId !== "string" || !OPAQUE_ID_RE.test(optionId)) return fail("invalid_option_id");
      return { ok: true, value: { action_id: actionId, option_id: optionId } };
    },
    audit: (p) => ({ action_id: p.action_id, option_id: p.option_id }),
  },
};

export function isRemoteCommandType(v: unknown): v is RemoteCommandType {
  return typeof v === "string" && (REMOTE_COMMAND_TYPES as readonly string[]).includes(v);
}

/** One server-sent-events frame. `id` is omitted for frames a client must not resume from. */
export function sseFrame(event: string | null, data: unknown, id?: string | number): string {
  return (id !== undefined ? `id: ${id}\n` : "") + (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;
}

/** The SSE resume position: `Last-Event-ID` or `after`, a non-negative integer, or a refusal. */
export function parseCursor(...candidates: unknown[]): Parsed<number> {
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const text = Array.isArray(c) ? c[0] : c;
    if (typeof text !== "string" || !/^\d{1,15}$/.test(text)) return fail("invalid_cursor");
    return { ok: true, value: Number(text) };
  }
  return { ok: true, value: 0 };
}
