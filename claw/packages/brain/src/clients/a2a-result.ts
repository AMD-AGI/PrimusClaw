// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an A2A peer said, reduced to the one shape `a2a_call` hands the model.
 *
 * Pure: nothing here touches the network, so the mapping from the wire (a Task
 * snapshot, or the events of a stream) to the result is table-testable.
 *
 * The result is
 *   { state, task_id, context_id, text, artifacts, input_required? }
 * where `state` is the task's state lower-cased without the proto prefix
 * (`TASK_STATE_INPUT_REQUIRED` -> `input_required`), `text` is what the peer
 * answered, `artifacts` lists what it produced (the text of text artifacts is in
 * `text`, not repeated), and `input_required` carries the question when the peer
 * is waiting for the caller.
 */

export type A2AState =
  | "submitted" | "working" | "input_required" | "auth_required"
  | "completed" | "failed" | "canceled" | "rejected" | "unknown";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "submitted", "working", "input_required", "auth_required", "completed", "failed", "canceled", "rejected",
]);

/** The task is over: nothing more will arrive for it. */
export const TERMINAL_STATES: ReadonlySet<A2AState> = new Set(["completed", "failed", "canceled", "rejected"]);
/** The peer is waiting for the caller. */
export const INTERRUPTED_STATES: ReadonlySet<A2AState> = new Set(["input_required", "auth_required"]);

/** `TASK_STATE_INPUT_REQUIRED`, `input-required`, `INPUT_REQUIRED` and `input_required` are one state. A 0.3 spelling of cancelled is too. */
export function normalizeState(raw: unknown): A2AState {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().replace(/^TASK_STATE_/i, "").toLowerCase().replace(/[-\s]+/g, "_");
  const spelled = s === "cancelled" ? "canceled" : s;
  return KNOWN_STATES.has(spelled) ? (spelled as A2AState) : "unknown";
}

// ---------------------------------------------------------------------------
// Wire shapes, as loose as a peer we do not control makes them
// ---------------------------------------------------------------------------
export interface WirePart {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
  mimeType?: string;
  kind?: string;
}
export interface WireMessage {
  messageId?: string;
  role?: string;
  parts?: WirePart[];
  taskId?: string;
  contextId?: string;
}
export interface WireArtifact { artifactId?: string; name?: string; parts?: WirePart[] }
export interface WireTask {
  id?: string;
  contextId?: string;
  status?: { state?: unknown; message?: WireMessage };
  artifacts?: WireArtifact[];
  history?: WireMessage[];
}

const MAX_TEXT_CHARS = 100_000;
const MAX_DATA_CHARS = 2_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated, ${text.length - max} more characters]`;
}

function partsText(parts: WirePart[] | undefined): string {
  return (parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

function isAgentRole(role: unknown): boolean {
  return typeof role === "string" && /agent/i.test(role);
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------
export interface A2AInputRequired {
  /** What the peer asked, in words. */
  text: string;
  /** A structured approval request (design: data part `{kind:"approval", actionId, tool, input, options, timeoutMs}`). */
  approval?: { action_id: string; tool?: string; input?: unknown; options?: unknown; timeout_ms?: unknown };
  /** Any other structured part the peer attached, clipped. */
  data?: string[];
}

export interface A2AArtifactInfo {
  artifact_id: string;
  name?: string;
  /** Length of the artifact's text, which is part of `text` above. */
  text_chars?: number;
  /** Parts that are not text: the model is told they exist and where, never handed their bytes. */
  other_parts?: Array<{ kind: "data" | "file"; url?: string; filename?: string; media_type?: string; bytes?: number; json?: string }>;
}

export interface A2AResult {
  state: A2AState;
  task_id?: string;
  context_id?: string;
  text: string;
  artifacts: A2AArtifactInfo[];
  input_required?: A2AInputRequired;
  /** Guidance for the model about what to do next; never the peer's words. */
  note?: string;
}

function inputRequiredOf(message: WireMessage | undefined): A2AInputRequired {
  const out: A2AInputRequired = { text: partsText(message?.parts) };
  for (const p of message?.parts ?? []) {
    if (p?.data === undefined || p.data === null || typeof p.data !== "object") continue;
    const d = p.data as Record<string, unknown>;
    if (d.kind === "approval" || typeof d.actionId === "string") {
      if (typeof d.actionId === "string" && out.approval === undefined) {
        out.approval = { action_id: d.actionId, tool: str(d.tool), input: d.input, options: d.options, timeout_ms: d.timeoutMs };
        continue;
      }
    }
    (out.data ??= []).push(clip(JSON.stringify(d), MAX_DATA_CHARS));
  }
  if (out.approval?.input !== undefined) out.approval.input = clipJson(out.approval.input);
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function clipJson(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > MAX_DATA_CHARS ? clip(s, MAX_DATA_CHARS) : v;
}

interface ArtifactAcc { name?: string; parts: WirePart[] }

/**
 * Accumulates a task from a snapshot, a stream of events, or both, and reads the
 * result off it. A later snapshot replaces what the earlier ones said; an
 * artifact update appends or replaces by its `append` flag.
 */
export class TaskView {
  taskId?: string;
  contextId?: string;
  state: A2AState = "unknown";
  private statusMessage?: WireMessage;
  private readonly artifacts = new Map<string, ArtifactAcc>();
  private readonly replies: string[] = [];
  private history: WireMessage[] = [];
  /** Set once any event or snapshot has been applied. */
  seen = false;

  /** A Task: the whole picture as of now. */
  applyTask(task: WireTask | undefined): void {
    if (!task || typeof task !== "object") return;
    this.seen = true;
    if (typeof task.id === "string") this.taskId = task.id;
    if (typeof task.contextId === "string") this.contextId = task.contextId;
    this.setStatus(task.status);
    if (Array.isArray(task.artifacts)) {
      this.artifacts.clear();
      for (const a of task.artifacts) this.putArtifact(a, false);
    }
    if (Array.isArray(task.history)) this.history = task.history;
  }

  /** One event of a stream: `{task}`, `{message}`, `{statusUpdate}` or `{artifactUpdate}`. */
  applyEvent(result: Record<string, unknown> | undefined): void {
    if (!result || typeof result !== "object") return;
    if (result.task) { this.applyTask(result.task as WireTask); return; }
    if (result.message) {
      this.seen = true;
      const m = result.message as WireMessage;
      if (typeof m.taskId === "string") this.taskId ??= m.taskId;
      if (typeof m.contextId === "string") this.contextId ??= m.contextId;
      const text = partsText(m.parts);
      if (text) this.replies.push(text);
      return;
    }
    if (result.statusUpdate) {
      this.seen = true;
      const su = result.statusUpdate as { taskId?: string; contextId?: string; status?: WireTask["status"] };
      if (typeof su.taskId === "string") this.taskId = su.taskId;
      if (typeof su.contextId === "string") this.contextId = su.contextId;
      this.setStatus(su.status);
      return;
    }
    if (result.artifactUpdate) {
      this.seen = true;
      const au = result.artifactUpdate as { taskId?: string; contextId?: string; artifact?: WireArtifact; append?: boolean };
      if (typeof au.taskId === "string") this.taskId ??= au.taskId;
      if (typeof au.contextId === "string") this.contextId ??= au.contextId;
      this.putArtifact(au.artifact, au.append === true);
    }
  }

  /** A `Message` reply to SendMessage: no task, the peer just answered. */
  applyDirectMessage(message: WireMessage | undefined): void {
    this.applyEvent({ message });
  }

  /** The peer answered with a Message and no task: that is a finished exchange, whatever else is missing. */
  get answered(): boolean {
    return this.state === "unknown" && this.replies.length > 0;
  }

  private setStatus(status: WireTask["status"]): void {
    if (!status || typeof status !== "object") return;
    this.state = normalizeState(status.state);
    this.statusMessage = status.message;
  }

  private putArtifact(a: WireArtifact | undefined, append: boolean): void {
    if (!a || typeof a !== "object") return;
    const id = typeof a.artifactId === "string" && a.artifactId ? a.artifactId : `artifact-${this.artifacts.size + 1}`;
    const held = this.artifacts.get(id);
    if (append && held) {
      for (const part of a.parts ?? []) {
        const last = held.parts[held.parts.length - 1];
        // Chunks of one streamed text are one text: joining them as separate parts would put a line break
        // wherever the peer happened to cut.
        if (typeof part?.text === "string" && typeof last?.text === "string") held.parts[held.parts.length - 1] = { ...last, text: last.text + part.text };
        else held.parts.push(part);
      }
      if (a.name && !held.name) held.name = a.name;
    } else {
      this.artifacts.set(id, { name: a.name, parts: [...(a.parts ?? [])] });
    }
  }

  toResult(note?: string): A2AResult {
    const interrupted = INTERRUPTED_STATES.has(this.state);
    const artifactTexts = [...this.artifacts.values()].map((a) => partsText(a.parts)).filter(Boolean);
    const artifactText = artifactTexts.join("\n\n");
    const statusText = partsText(this.statusMessage?.parts);
    const replyText = this.replies.join("\n\n");
    const lastAgent = [...this.history].reverse().find((m) => isAgentRole(m.role) && partsText(m.parts));

    let text: string;
    if (this.state === "failed" || this.state === "rejected" || this.state === "canceled") {
      text = [statusText, artifactText || replyText].filter(Boolean).join("\n\n");
    } else {
      // An interrupted task's status message is its question, reported under
      // `input_required`; it is not an answer.
      text = artifactText || replyText || (interrupted ? "" : statusText || (lastAgent ? partsText(lastAgent.parts) : ""));
    }

    const artifacts: A2AArtifactInfo[] = [];
    for (const [id, a] of this.artifacts) {
      const info: A2AArtifactInfo = { artifact_id: id };
      if (a.name) info.name = a.name;
      const t = partsText(a.parts);
      if (t) info.text_chars = t.length;
      const others: NonNullable<A2AArtifactInfo["other_parts"]> = [];
      for (const p of a.parts) {
        if (typeof p?.text === "string") continue;
        if (p?.data !== undefined) others.push({ kind: "data", json: clip(JSON.stringify(p.data), MAX_DATA_CHARS) });
        else if (typeof p?.url === "string") {
          others.push({ kind: "file", url: p.url, filename: p.filename, media_type: p.mediaType ?? p.mimeType });
        } else if (typeof p?.raw === "string") {
          others.push({ kind: "file", filename: p.filename, media_type: p.mediaType ?? p.mimeType, bytes: Math.floor((p.raw.length * 3) / 4) });
        }
      }
      if (others.length) info.other_parts = others;
      artifacts.push(info);
    }

    const result: A2AResult = {
      state: this.answered && !this.taskId ? "completed" : this.state,
      ...(this.taskId ? { task_id: this.taskId } : {}),
      ...(this.contextId ? { context_id: this.contextId } : {}),
      text: clip(text, MAX_TEXT_CHARS),
      artifacts,
    };
    if (interrupted) result.input_required = inputRequiredOf(this.statusMessage);
    if (note) result.note = note;
    return result;
  }
}

export function renderResult(result: A2AResult): string {
  return JSON.stringify(result, null, 2);
}

/** Whether a result means the work the model asked for did not happen. */
export function resultIsFailure(result: A2AResult): boolean {
  return result.state === "failed" || result.state === "rejected";
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/**
 * Splits a byte stream into SSE events and returns each event's `data`. Comments
 * (`: keep-alive`) are dropped; they are the connection's liveness, not an event.
 * A `data:` value may or may not have the single space after the colon, lines end
 * in LF, CRLF or CR, and an event may carry several `data:` lines.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) break;
      // A lone CR at the very end may be the first half of a CRLF split across chunks.
      if (m[0] === "\r" && m.index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }

  /** The stream ended: an event with no closing blank line is still an event. */
  flush(): string[] {
    const out = this.push("\n\n");
    this.buffer = "";
    this.data = [];
    return out;
  }
}
