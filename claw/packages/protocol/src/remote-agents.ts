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
  /** Files one prompt may carry (`prompt.files`). */
  maxPromptFiles: 10,
  /** Bytes of all the files of one prompt together, decoded (base64 makes them a third larger on the wire). */
  maxPromptFileBytes: 2 * 1024 * 1024,
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

/** The npm package the connector is published as; its command is `claw-connector`. */
export const CONNECTOR_PACKAGE = "@primusclaw/connector";

/**
 * Which connector versions a server takes. Below `minimum` a connector still registers and is listed (so its owner
 * sees why), but no new session is started on it (`409 connector_outdated`); below `recommended` it works and its
 * owner is told to upgrade. A server may move both with `CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION` and
 * `CLAW_REMOTE_AGENTS_RECOMMENDED_CONNECTOR_VERSION`. 0.1.3 is the first release with `service install`; 0.1.4 names
 * the prompt every `turn_end` ends, without which an assistant item stays in progress after its last instruction.
 */
export const CONNECTOR_VERSIONS = { minimum: "0.1.3", recommended: "0.1.4" } as const;

/** `current`: at least the recommended version; `outdated`: works, upgrade; `unsupported`: below the minimum; `unknown`: no readable version. */
export type ConnectorVersionStatus = "current" | "outdated" | "unsupported" | "unknown";

const SEMVER_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** A version's `[major, minor, patch, prerelease]`, or null when it is no `x.y.z`. */
function semver(v: string): [number, number, number, string | null] | null {
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/** Two prerelease tags in semver's order: identifier by identifier, numbers numerically and below words, a shorter prefix first. */
function comparePrerelease(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    // (read once into locals: a consumer compiling this file with noUncheckedIndexedAccess sees them narrowed)
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined) return -1;
    if (yi === undefined) return 1;
    const nx = /^\d+$/.test(xi);
    const ny = /^\d+$/.test(yi);
    if (nx && ny) { const d = Number(xi) - Number(yi); if (d) return d < 0 ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (xi !== yi) return xi < yi ? -1 : 1;
  }
  return 0;
}

/**
 * Compares two `x.y.z` versions as semver orders them (a prerelease sorts before its release; build metadata is ignored). Null when
 * either is not a version.
 */
export function compareConnectorVersions(a: string, b: string): number | null {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return comparePrerelease(x[3], y[3]);
}

/** Where `version` stands against `policy`. A connector that reports no version, or one that is no `x.y.z`, is `unknown`: it is not refused. */
export function connectorVersionStatus(
  version: string | null | undefined, policy: { minimum: string; recommended: string } = CONNECTOR_VERSIONS,
): ConnectorVersionStatus {
  if (!version) return "unknown";
  const toMin = compareConnectorVersions(version, policy.minimum);
  if (toMin === null) return "unknown";
  if (toMin < 0) return "unsupported";
  const toRec = compareConnectorVersions(version, policy.recommended);
  return toRec !== null && toRec < 0 ? "outdated" : "current";
}

/** Event types the server itself acts on; every other type is stored and relayed as is. */
export const REMOTE_EVENT_PERMISSION_REQUEST = "permissionRequest";
export const REMOTE_EVENT_PERMISSION_RESOLVED = "permission_resolved";
export const REMOTE_EVENT_SESSION_CLOSED = "session_closed";
/**
 * A turn of a conversation open in a terminal ended while nobody was at that terminal, posted on the conversation's terminal-hook
 * session (`origin` "terminal_hook") by its connector: `{ref, outcome: "done" | "error", error?, message, agent, cwd, ended_at,
 * away_ms}`. `message` is the end of what the agent last said (untrusted text); `error` names why a turn that failed did
 * (Claude Code's `StopFailure` reason, such as `rate_limit`). The connector posts it only once the terminal has had no input for a
 * minute after the turn ended, and never while a chat follows the conversation; Claw tells the owner, unless they turned the
 * terminal pushes off or muted that conversation.
 */
export const REMOTE_EVENT_TERMINAL_TURN_END = "terminal_turn_end";
/**
 * What the person sent a session (a `prompt` command), written by Claw itself when it queues the prompt: `{text, cmd_id, cmd_seq,
 * client, by: "claw"}` with a negative `seq`. An agent's events carry only its own side, so without it a window opened on the
 * session elsewhere (another device, the web page beside a Teams chat) shows answers to questions it cannot see. A connector may
 * not post it: a frame of this type is always Claw's account of what was sent.
 */
export const REMOTE_EVENT_USER_PROMPT = "user_prompt";

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
  /** What the connector holds that Claw has not acknowledged yet (`outbox` on the wire); absent from an older connector. */
  outbox?: RemoteOutboxReport | null;
  /**
   * The git repository of each folder its sessions work in (`workspaces` on the wire, {@link parseWorkspacesReport}); absent (null)
   * from a connector that does not report it, which is every connector before the agent capability `git_info`.
   */
  workspaces?: RemoteWorkspace[] | null;
}

/**
 * How much of the folders' git facts one heartbeat carries. A folder named by anyone, a remote and a branch named by whoever made the
 * repository: each is cut to a shape that cannot carry more than a name, and the whole report is bounded.
 */
export const REMOTE_WORKSPACE_LIMITS = {
  /** Folders one heartbeat reports, at most. */
  maxEntries: 32,
  maxCwdChars: 1024,
  /** A remote as {@link normalizeGitRemote} writes it: `host/owner/repo`. */
  maxRemoteChars: 200,
  maxBranchChars: 100,
} as const;

/** One folder's git facts: the remote its `origin` names and the branch checked out, each null when there is none or it is unreadable. */
export interface RemoteWorkspace {
  cwd: string;
  git_remote: string | null;
  git_branch: string | null;
}

/** A path segment of a remote that is a credential, not a name: a token's known prefixes, or a long opaque run. */
const REMOTE_SECRET_SEGMENT_RE = /^(?:gh[opsur]_[A-Za-z0-9]{16,}|github_pat_\w{16,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{10,}|x-access-token|[A-Za-z0-9+=_-]{40,})$/i;
const REMOTE_SEGMENT_RE = /^[A-Za-z0-9._~-]{1,100}$/;
const REMOTE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/**
 * A git remote as `host/owner/repo` (lower-case host, no scheme, no `.git`), or null when it is not a remote that can be written that
 * way. Whatever names a person or carries a secret goes: the user (`git@`, `user:token@`), a query and a fragment; and a remote with a
 * path segment shaped like a credential (`ghp_...`, a long opaque run) is no remote at all, never one with the secret cut out. A local
 * path (`/srv/repo.git`, `file://`) is null: it names a folder on that machine, not a repository anyone else knows.
 */
export function normalizeGitRemote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f\s]/u.test(text)) return null;
  let host: string;
  let path: string;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (scheme) {
    if (!/^(?:https?|ssh|git|git\+ssh|ssh\+git)$/i.test(scheme[1]!)) return null;
    const rest = scheme[2]!.replace(/[?#].*$/, "");
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    path = slash < 0 ? "" : rest.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1);
  } else {
    // scp-like: [user@]host:path (never a Windows drive, `C:\repo`, which has no host).
    const m = /^(?:[^@/:]+@)?([^@/:]+):(?!\/\/)(.+)$/.exec(text);
    if (!m || m[1]!.length < 2) return null;
    host = m[1]!;
    path = m[2]!.replace(/[?#].*$/, "");
  }
  host = host.toLowerCase();
  if (!REMOTE_HOST_RE.test(host)) return null;
  const segments = path.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!segments.length || segments.length > 8) return null;
  for (const seg of segments) {
    if (!REMOTE_SEGMENT_RE.test(seg) || seg === "." || seg === ".." || REMOTE_SECRET_SEGMENT_RE.test(seg)) return null;
  }
  const out = `${host}/${segments.join("/")}`;
  return out.length > REMOTE_WORKSPACE_LIMITS.maxRemoteChars ? null : out;
}

/**
 * A remote as a connector reports it: already `host/owner/repo` ({@link normalizeGitRemote} on the machine), checked to be exactly
 * that shape again; else null. A URL (a connector that sent one raw) is normalized here the same way.
 */
export function normalizedRemote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/^[^/:@]+(?::\d{1,5})?\/[^:@]+$/.test(raw)) {
    const again = normalizeGitRemote(`https://${raw}`);
    return again === raw ? raw : null;
  }
  return normalizeGitRemote(raw);
}

/** A branch name as git allows it (and no more), or null: no `..`, no leading `-` or `/`, no control or space, at most 100 characters. */
export function normalizeGitBranch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const b = raw.trim().replace(/^refs\/heads\//, "");
  if (!b || b.length > REMOTE_WORKSPACE_LIMITS.maxBranchChars) return null;
  if (!/^[A-Za-z0-9._/+@-]+$/.test(b) || b.includes("..") || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".lock")) return null;
  return b;
}

/**
 * The heartbeat's `workspaces`, or null when it is absent or not a list. Lenient, as the outbox report is: an entry that does not fit
 * is left out, never a reason to refuse the heartbeat; a remote or a branch that does not normalize is null; at most
 * {@link REMOTE_WORKSPACE_LIMITS.maxEntries} folders, each once. Normalized again here whatever the connector did: Claw never stores
 * what it did not shape itself.
 */
export function parseWorkspacesReport(raw: unknown): RemoteWorkspace[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RemoteWorkspace[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (out.length >= REMOTE_WORKSPACE_LIMITS.maxEntries) break;
    if (!isObject(e) || typeof e.cwd !== "string") continue;
    const cwd = e.cwd;
    if (!cwd || cwd.length > REMOTE_WORKSPACE_LIMITS.maxCwdChars || /[\u0000-\u001f\u007f]/u.test(cwd) || seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ cwd, git_remote: normalizedRemote(e.git_remote), git_branch: normalizeGitBranch(e.git_branch) });
  }
  return out;
}

/** Sessions an outbox report names at most, the longest waiting first. */
export const REMOTE_OUTBOX_REPORT_MAX_SESSIONS = 20;

/** One session's part of an outbox report. */
export interface RemoteOutboxSession {
  sessionId: string;
  /** Its events not acknowledged yet. */
  pending: number;
  /** How long the oldest of them has waited, in milliseconds. */
  oldestAgeMs: number;
}

/**
 * The connector's own account of its event outbox, sent with every heartbeat (`outbox`, snake_case on the wire): how many
 * events wait, how long the oldest has, and how many posts in a row failed and for how long. It is what tells Claw that a
 * machine's replies are not getting through when the reason is on Claw's side (a batch Claw keeps refusing with a 5xx) as
 * well as when it is not (a proxy, a network). Only ever a report: a malformed one is ignored, never a reason to refuse the
 * heartbeat that carries it.
 */
export interface RemoteOutboxReport {
  pending: number;
  oldestAgeMs: number;
  /** Consecutive failed posts; 0 once a post succeeded. */
  failures: number;
  /** How long ago the first of those failures was, in milliseconds; 0 with no failure. */
  failingMs: number;
  /** What the last failure was: `http_<status>`, `network` or `error`; null with no failure. */
  lastError: string | null;
  /** The sessions with events waiting, the longest waiting first, at most {@link REMOTE_OUTBOX_REPORT_MAX_SESSIONS}. */
  sessions: RemoteOutboxSession[];
}

/** A day: an age or a duration beyond it is clamped, so a skewed or hostile report cannot overflow anything. */
const OUTBOX_MAX_MS = 86_400_000;
const OUTBOX_ERROR_RE = /^(?:http_[1-5]\d\d|network|error)$/;

/**
 * The heartbeat's `outbox`, or null when it is absent or malformed. Total, like every parser here, and lenient by design: a
 * report is advice about delivery, and a heartbeat refused over it would take the machine offline.
 */
export function parseOutboxReport(raw: unknown): RemoteOutboxReport | null {
  if (!isObject(raw)) return null;
  const { pending, oldest_age_ms: oldest, failures, failing_ms: failing, last_error: lastError, sessions } = raw;
  if (!isCount(pending) || !isCount(oldest) || !isCount(failures) || !isCount(failing)) return null;
  const out: RemoteOutboxSession[] = [];
  if (Array.isArray(sessions)) {
    for (const s of sessions.slice(0, REMOTE_OUTBOX_REPORT_MAX_SESSIONS)) {
      if (!isObject(s)) continue;
      const sid = parseRemoteId(s.session_id);
      if (!sid || !isCount(s.pending) || !isCount(s.oldest_age_ms)) continue;
      out.push({ sessionId: sid, pending: s.pending, oldestAgeMs: Math.min(s.oldest_age_ms, OUTBOX_MAX_MS) });
    }
  }
  return {
    pending, oldestAgeMs: Math.min(oldest, OUTBOX_MAX_MS), failures, failingMs: Math.min(failing, OUTBOX_MAX_MS),
    lastError: typeof lastError === "string" && OUTBOX_ERROR_RE.test(lastError) ? lastError : null,
    sessions: out,
  };
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
  return { ok: true, value: { version, agents, cmdCursor, outbox: parseOutboxReport(body.outbox), workspaces: parseWorkspacesReport(body.workspaces) } };
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
    if (raw.type === REMOTE_EVENT_USER_PROMPT) return refuse("reserved_type");
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
  /**
   * Names a session of that agent that already exists on the machine, to continue it instead of starting a new
   * one. Claw does not interpret it: the connector reported the value (in an agent's `capabilities`) and is the
   * only one that knows what it means.
   */
  resume_ref: string | null;
  /**
   * With `resume_ref`: the person confirmed that whatever holds that session open on the machine (a terminal) is to be
   * ended so that this session can continue it. Without it a session held open elsewhere is only watched, read-only.
   */
  takeover: boolean;
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
  let resumeRef: string | null = null;
  if (body.resume_ref !== undefined && body.resume_ref !== null) {
    if (typeof body.resume_ref !== "string" || !OPAQUE_ID_RE.test(body.resume_ref)) return fail("invalid_resume_ref");
    resumeRef = body.resume_ref;
  }
  if (body.takeover !== undefined && body.takeover !== null && typeof body.takeover !== "boolean") return fail("invalid_takeover");
  const takeover = body.takeover === true;
  if (takeover && !resumeRef) return fail("takeover_needs_resume_ref");
  return { ok: true, value: { connector_id: connectorId, agent_id: body.agent_id, cwd: body.cwd, mode, resume_ref: resumeRef, takeover } };
}

/**
 * Approvals a terminal asks for, carried to the phone (`POST /v1/remote-agents/connectors/:cid/terminal-sessions`).
 *
 * A coding agent its person started in their own terminal asks there before it runs a command, edits a file, leaves plan mode or
 * puts a multiple-choice question. A connector whose hook sees such a prompt opens (or finds) one session per terminal conversation
 * (`ref`, the agent's own conversation id) and posts each prompt on it as a `permissionRequest`, with
 * `data.origin` {@link REMOTE_ORIGIN_TERMINAL_HOOK}; the owner answers it as any other, with a `decision`. The terminal keeps its own
 * prompt: whichever answer comes first is the one the agent takes, and the connector says which (`permission_resolved.by`).
 *
 * Such a session carries nothing else: no prompt, no turn, no mode. It is not one of the sessions a user opens, so it neither counts
 * against {@link REMOTE_AGENT_LIMITS.maxActiveSessionsPerUser} nor is closed to make room for one.
 */
export const REMOTE_ORIGIN_TERMINAL_HOOK = "terminal_hook";

/** The only commands a terminal-hook session takes: an answer, and closing it. */
export const TERMINAL_HOOK_COMMANDS: readonly RemoteCommandType[] = ["decision", "close"];

export const TERMINAL_SESSION_LIMITS = {
  /** Terminal-hook sessions one user may open per minute, across their machines (a new terminal conversation opens one). */
  opensPerMinute: 30,
  /** Characters of a session's title (the conversation's name, or the start of its first prompt). */
  maxTitleChars: 80,
} as const;

/** A conversation ref as a connector names it, and nothing else. */
const TERMINAL_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RemoteTerminalSessionOpen {
  agent_id: string;
  /** The agent's own id of the conversation open in the terminal. */
  ref: string;
  cwd: string;
  /** The conversation's name, or the start of its first prompt; empty when the connector has neither. */
  title: string;
}

export function parseTerminalSessionOpen(body: unknown): Parsed<RemoteTerminalSessionOpen> {
  if (!isObject(body)) return fail("body_required");
  if (typeof body.agent_id !== "string" || !AGENT_ID_RE.test(body.agent_id)) return fail("invalid_agent_id");
  if (typeof body.ref !== "string" || !TERMINAL_REF_RE.test(body.ref)) return fail("invalid_ref");
  if (typeof body.cwd !== "string" || body.cwd.length < 1 || body.cwd.length > 4096 || /[\u0000-\u001f\u007f]/u.test(body.cwd)) {
    return fail("invalid_cwd");
  }
  let title = "";
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string" || /[\u0000-\u001f\u007f]/u.test(body.title)) return fail("invalid_title");
    title = Array.from(body.title.trim()).slice(0, TERMINAL_SESSION_LIMITS.maxTitleChars).join("");
  }
  return { ok: true, value: { agent_id: body.agent_id, ref: body.ref, cwd: body.cwd, title } };
}

/** The owner's switch for approvals from terminals (`GET`/`PUT /v1/remote-agents/approvals`). On unless they turned it off. */
export function parseApprovalsSetting(body: unknown): Parsed<{ enabled: boolean }> {
  if (!isObject(body) || typeof body.enabled !== "boolean") return fail("enabled_required");
  return { ok: true, value: { enabled: body.enabled } };
}

/** `PUT /v1/remote-agents/approvals/mutes`: mute (or unmute) the conversation behind work item `#item`, one open in a terminal. */
export function parseTerminalMute(body: unknown): Parsed<{ item: number; muted: boolean }> {
  if (!isObject(body) || typeof body.muted !== "boolean") return fail("muted_required");
  if (typeof body.item !== "number" || !Number.isSafeInteger(body.item) || body.item < 1) return fail("item_required");
  return { ok: true, value: { item: body.item, muted: body.muted } };
}

/**
 * Hiding conversations of a machine from its owner's lists (`POST /v1/remote-agents/connectors/:cid/hidden`), and the
 * listing that leaves them out (`GET /v1/remote-agents/connectors`, `?hidden=include` to list them too). Nothing on the
 * machine changes: only which of the conversations it reports (`capabilities.resumable`) the owner's lists show.
 */
export const REMOTE_HIDE_LIMITS = {
  /** Conversation refs one request names, at least one. */
  maxRefs: 50,
  /** A ref as the machine reported it: printable ASCII, no space. */
  maxRefChars: 128,
} as const;

/** The value of `?hidden=` that lists the hidden conversations too, each marked `hidden: true`. */
export const REMOTE_HIDDEN_INCLUDE = "include";

const HIDE_REF_RE = new RegExp(`^[\\x21-\\x7e]{1,${REMOTE_HIDE_LIMITS.maxRefChars}}$`);

/** The body of a hide (or, `hidden: false`, show again). */
export interface RemoteHiddenRequest {
  refs: string[];
  hidden: boolean;
}

/** Why a conversation was not hidden: a process has it open (or a session holds it), or the machine does not report it now. */
export type RemoteHideRefusalReason = "live" | "unknown_conversation";

export interface RemoteHideRefusal {
  ref: string;
  reason: RemoteHideRefusalReason;
}

/** The answer of a hide or show (`data`): the refs that changed, and the ones refused with why. */
export interface RemoteHidden {
  changed: string[];
  refused: RemoteHideRefusal[];
}

/** One conversation of `capabilities.resumable` as the owner's listing returns it: as the machine reported it, marked when hidden. */
export type RemoteResumableListed = Record<string, unknown> & { hidden?: true };

/**
 * What the listing makes of an agent's `capabilities` once its owner hid any of its conversations: the conversations left
 * (`?hidden=include`: all of them, the hidden ones marked) and how many are hidden. Absent while nothing of it is hidden.
 */
export interface RemoteHiddenCapabilities {
  resumable: RemoteResumableListed[];
  hidden_count: number;
}

/** A hide request as the route takes it: `hidden` a boolean, then 1 to 50 refs of printable ASCII. */
export function parseHiddenRequest(body: unknown): Parsed<RemoteHiddenRequest> {
  const fields = isObject(body) ? body : {};
  if (typeof fields.hidden !== "boolean") return fail("hidden_must_be_boolean");
  const refs = Array.isArray(fields.refs) ? (fields.refs as unknown[]) : null;
  if (!refs || refs.length === 0 || refs.length > REMOTE_HIDE_LIMITS.maxRefs) return fail("invalid_refs");
  if (!refs.every((r): r is string => typeof r === "string" && HIDE_REF_RE.test(r))) return fail("invalid_refs");
  return { ok: true, value: { refs, hidden: fields.hidden } };
}

/**
 * The commands a user can issue into an existing session.
 *
 * `session.new` is not here: it creates the session and goes through
 * {@link parseSessionNew}. The set is closed on purpose. A connector is not a
 * remote shell, so a type that is not listed is refused at the server and
 * dropped (and audited) at the connector.
 */
export const REMOTE_COMMAND_TYPES = ["prompt", "cancel", "set_mode", "resume", "close", "decision", "withdraw"] as const;
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

/** A file a prompt carries, as the connector receives it. */
export interface RemotePromptFile {
  /** One safe path component: letters, digits, `._ -`, no leading dot, at most 100 characters. */
  name: string;
  media_type: string;
  /** The bytes, base64. */
  data: string;
}

// (no "/" and no leading dot: never a directory, never "." or "..", never a hidden file)
const PROMPT_FILE_NAME_RE = /^(?!\.)[A-Za-z0-9._ -]{1,100}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Bytes a base64 text decodes to (it is already known to be base64). */
function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}

/**
 * The files a prompt carries (`files`, optional): at most {@link REMOTE_AGENT_LIMITS.maxPromptFiles}, each a safe name, a
 * media type and its bytes in base64, all together at most {@link REMOTE_AGENT_LIMITS.maxPromptFileBytes} decoded, no two
 * with one name (compared without case). A connector that says it can (the agent capability `prompt_files`) saves them on its machine and names
 * where in the prompt; Claw keeps them only while the command waits to be delivered, never in the session's events.
 */
export function parsePromptFiles(raw: unknown): Parsed<RemotePromptFile[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > REMOTE_AGENT_LIMITS.maxPromptFiles) return fail("invalid_files");
  const files: RemotePromptFile[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const f of raw) {
    if (!isObject(f)) return fail("invalid_files");
    const { name, media_type: mediaType, data } = f;
    // (two names that differ only in case are one file where the machine's file system ignores case: macOS, Windows)
    if (typeof name !== "string" || !PROMPT_FILE_NAME_RE.test(name) || names.has(name.toLowerCase())) {
      return fail("invalid_file_name");
    }
    if (typeof mediaType !== "string" || !MEDIA_TYPE_RE.test(mediaType)) return fail("invalid_file_media_type");
    if (typeof data !== "string" || data === "" || data.length % 4 !== 0) return fail("invalid_file_data");
    total += base64Bytes(data);
    if (total > REMOTE_AGENT_LIMITS.maxPromptFileBytes) return fail("files_too_large");
    if (!BASE64_RE.test(data)) return fail("invalid_file_data");
    names.add(name.toLowerCase());
    files.push({ name, media_type: mediaType, data });
  }
  return { ok: true, value: files };
}

export const REMOTE_COMMANDS: Record<RemoteCommandType, RemoteCommandSpec> = {
  prompt: {
    needsOnline: true,
    closesSession: false,
    parse(body) {
      const text = body.text;
      if (typeof text !== "string" || text.trim() === "") return fail("text_required");
      if (new TextEncoder().encode(text).length > REMOTE_AGENT_LIMITS.maxPromptBytes) return fail("prompt_too_large");
      if (body.answer_only !== undefined && body.answer_only !== null && typeof body.answer_only !== "boolean") return fail("invalid_answer_only");
      const files = parsePromptFiles(body.files);
      if (!files.ok) return files;
      // `answer_only`: the turn only answers. A connector that knows it (the agent capability `answer_only`) refuses every permission
      // the agent asks for in that turn on the machine, so nothing is changed or run there; one that does not ignores the field and asks as always.
      return {
        ok: true,
        value: { text, ...(files.value.length ? { files: files.value } : {}), ...(body.answer_only === true ? { answer_only: true } : {}) },
      };
    },
    // (a file's name, type and size and the hash of its bytes; never the bytes)
    audit: (p) => ({
      sha256: sha256(String(p.text)),
      length: String(p.text).length,
      ...(Array.isArray(p.files) && p.files.length
        ? {
            files: (p.files as RemotePromptFile[]).map((f) => ({
              name: f.name,
              media_type: f.media_type,
              size: base64Bytes(f.data),
              sha256: createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex"),
            })),
          }
        : {}),
      ...(p.answer_only === true ? { answer_only: true } : {}),
    }),
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
  /**
   * Take back the prompts that have not started (waiting for a terminal to be free, or queued behind a running turn): each is refused
   * by name (`withdrawn`). Nothing that runs is touched: no Escape into a terminal, no cancel of the turn, no permission answered. A
   * chat that lets a session go while its message still waits sends it (a connector says it can with the agent capability
   * `withdraw`); safe to deliver late, like a cancel.
   */
  withdraw: {
    needsOnline: false,
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
