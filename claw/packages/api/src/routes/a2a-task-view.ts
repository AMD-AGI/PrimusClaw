// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// What an A2A task looks like, derived from a run row and the session events
// written during that run.
//
// With the context/task model a task is one run (`claw_tasks`, origin 'a2a')
// and a context is the session it ran in. The run row says whether the run
// started, finished, failed or was stopped; the events say whether it is
// waiting for the caller (a held tool call, a question). Nothing here reads a
// database or NATS, so the state machine can be driven by table tests.
// ---------------------------------------------------------------------------

import {
  type Artifact, type Message, type Part, type StreamResponse, type Task,
  Role, TaskState,
} from "./a2a-types.js";

/** One stored session event, as the loader returns it (already redacted). */
export interface RunEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  createdAt?: Date | string | null;
}

/** The run row, with the context its session carries. */
export interface RunRecord {
  taskId: string;
  sessionId: string;
  contextId: string;
  messageId: string;
  /** `claw_tasks.status`. */
  status: string;
  prompt: string | null;
  failureReason: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

export type PendingInput =
  | {
    kind: "approval";
    actionId: string;
    tool: string;
    input: unknown;
    summary: string;
    timeoutMs: number | null;
  }
  | {
    kind: "question";
    actionId: string;
    questions: unknown[];
  };

/** Chunks of assistant text join the way Brain joins them into `final_text`. */
export const TEXT_CHUNK_SEPARATOR = "\n";

export function textArtifactId(taskId: string): string {
  return `${taskId}-text`;
}

export function toolArtifactId(taskId: string): string {
  return `${taskId}-tools`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function iso(v: Date | string | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The text an assistant event carries, or "". */
export function assistantTextOf(data: Record<string, unknown>): string {
  const arr = (data.data as Record<string, unknown> | undefined)?.content as
    Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(arr) ? arr[0] : undefined;
  return str(first?.text) || str(data.content);
}

const ASSISTANT_EVENTS = new Set(["AssistantMessage", "chat", "chatDelta"]);

export function isAssistantEvent(type: string): boolean {
  return ASSISTANT_EVENTS.has(type);
}

/** `[Tool: x] description`, the line a successful tool call leaves in the tool log. */
export function toolLogLine(data: Record<string, unknown>): string | null {
  if (str(data.status) !== "success") return null;
  return `[Tool: ${str(data.tool)}] ${str(data.description).slice(0, 500)}`;
}

export function accumulatedText(events: RunEvent[]): string {
  const chunks: string[] = [];
  for (const e of events) {
    if (!isAssistantEvent(e.event)) continue;
    const text = assistantTextOf(e.data);
    if (text) chunks.push(text);
  }
  return chunks.join(TEXT_CHUNK_SEPARATOR);
}

export function toolLog(events: RunEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.event !== "toolUsed") continue;
    const line = toolLogLine(e.data);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The request the run is waiting on, if any.
 *
 * A request opens with `permissionRequest` (a held tool call) or `userQuestion`
 * and closes with the event that says it was answered, refused or timed out:
 * `decisionResult` for the first, the question tool's own result for the
 * second. The newest open one is the one the caller has to answer; Brain asks
 * one at a time.
 */
export function pendingInputOf(events: RunEvent[]): PendingInput | null {
  const open = new Map<string, PendingInput>();
  for (const e of events) {
    const d = e.data;
    const actionId = str(d.actionId) || str(d.tool_use_id);
    if (!actionId) continue;
    if (e.event === "permissionRequest") {
      open.set(actionId, {
        kind: "approval",
        actionId,
        tool: str(d.tool),
        input: d.input ?? {},
        summary: str(d.summary) || str(d.description) || `Approval needed for ${str(d.tool)}`,
        timeoutMs: typeof d.timeout_ms === "number" ? d.timeout_ms : null,
      });
    } else if (e.event === "userQuestion") {
      open.set(actionId, {
        kind: "question",
        actionId,
        questions: Array.isArray(d.questions) ? d.questions : [],
      });
    } else if (e.event === "decisionResult") {
      open.delete(actionId);
    } else if (e.event === "toolUsed" && str(d.tool) === "ask_user_question" && str(d.status) !== "start") {
      open.delete(actionId);
    }
  }
  let last: PendingInput | null = null;
  for (const p of open.values()) last = p;
  return last;
}

/** Brain announces it has a sandbox and is starting: the run is no longer merely submitted. */
export function runStarted(events: RunEvent[]): boolean {
  return events.some((e) => e.event === "statusUpdate" && str(e.data.agentStatus) === "running");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The A2A state of a run.
 *
 * The row decides every terminal answer. `cancelling` already reads as
 * CANCELED: the caller asked for the stop, and a state that goes back to
 * WORKING while the worker winds down would be a task that un-cancels itself.
 */
export function stateOfRun(run: Pick<RunRecord, "status">, events: RunEvent[]): TaskState {
  switch (run.status) {
    case "completed": return TaskState.COMPLETED;
    case "failed": return TaskState.FAILED;
    case "cancelled":
    case "cancelling": return TaskState.CANCELED;
    case "queued":
    case "preparing":
    case "running":
      if (pendingInputOf(events)) return TaskState.INPUT_REQUIRED;
      return runStarted(events) || run.status === "running" ? TaskState.WORKING : TaskState.SUBMITTED;
    default:
      return TaskState.SUBMITTED;
  }
}

export function isTerminalRun(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "cancelling";
}

// ---------------------------------------------------------------------------
// Messages and tasks
// ---------------------------------------------------------------------------

export function inputRequiredMessage(
  run: Pick<RunRecord, "taskId" | "contextId">,
  pending: PendingInput,
): Message {
  const parts: Part[] = [];
  if (pending.kind === "approval") {
    parts.push({ text: pending.summary });
    parts.push({
      mediaType: "application/json",
      data: {
        kind: "approval",
        actionId: pending.actionId,
        tool: pending.tool,
        input: pending.input,
        options: ["allow", "deny"],
        ...(pending.timeoutMs !== null ? { timeoutMs: pending.timeoutMs } : {}),
      },
    });
  } else {
    parts.push({ text: questionsAsText(pending.questions) });
    parts.push({
      mediaType: "application/json",
      data: { kind: "question", actionId: pending.actionId, questions: pending.questions },
    });
  }
  return {
    messageId: `input-required-${pending.actionId}`,
    taskId: run.taskId,
    contextId: run.contextId,
    role: Role.AGENT,
    parts,
  };
}

export function questionsAsText(questions: unknown[]): string {
  const lines: string[] = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>)
        .map((o) => `${str(o.id)}: ${str(o.label)}`).join("; ")
      : "";
    lines.push(`${str(q.question)}${options ? ` (${options})` : ""}`);
  }
  return lines.join("\n") || "The agent is asking a question.";
}

function failureMessage(run: RunRecord, events: RunEvent[]): Message | undefined {
  const complete = [...events].reverse().find((e) => e.event === "exec_complete");
  const text = str(run.errorMessage) || str(complete?.data.final_text) || str(run.failureReason);
  if (!text) return undefined;
  return {
    messageId: `failure-${run.taskId}`,
    taskId: run.taskId,
    contextId: run.contextId,
    role: Role.AGENT,
    parts: [{ text: text.slice(0, 2000) }],
  };
}

export function artifactsOf(taskId: string, events: RunEvent[]): Artifact[] {
  const artifacts: Artifact[] = [];
  const text = accumulatedText(events);
  if (text) {
    artifacts.push({
      artifactId: textArtifactId(taskId),
      name: "response",
      parts: [{ text, mediaType: "text/plain" }],
    });
  }
  const tools = toolLog(events);
  if (tools.length) {
    artifacts.push({
      artifactId: toolArtifactId(taskId),
      name: "tool-calls",
      parts: [{ text: tools.join("\n"), mediaType: "text/plain" }],
    });
  }
  return artifacts;
}

export interface TaskViewOptions {
  /** Cap on history messages; 0 omits them. Default: all. */
  historyLength?: number;
  includeArtifacts?: boolean;
}

/** The A2A `Task` for a run, as of the events given. */
export function taskOf(run: RunRecord, events: RunEvent[], opts: TaskViewOptions = {}): Task {
  const state = stateOfRun(run, events);
  const pending = state === TaskState.INPUT_REQUIRED ? pendingInputOf(events) : null;
  const lastEventAt = iso(events.length ? events[events.length - 1].createdAt : undefined);
  const status: Task["status"] = {
    state,
    timestamp: (isTerminalRun(run.status) ? iso(run.completedAt) : undefined)
      ?? lastEventAt ?? iso(run.createdAt),
  };
  if (pending) status.message = inputRequiredMessage(run, pending);
  else if (state === TaskState.FAILED) status.message = failureMessage(run, events);

  const task: Task = { id: run.taskId, contextId: run.contextId, status };
  if (opts.includeArtifacts !== false) {
    const artifacts = artifactsOf(run.taskId, events);
    if (artifacts.length) task.artifacts = artifacts;
  }
  if (opts.historyLength !== 0 && run.prompt) {
    const history: Message[] = [{
      messageId: run.messageId || `prompt-${run.taskId}`,
      taskId: run.taskId,
      contextId: run.contextId,
      role: Role.USER,
      parts: [{ text: run.prompt }],
    }];
    const cap = opts.historyLength;
    task.history = cap !== undefined && cap > 0 ? history.slice(-cap) : history;
  }
  return task;
}

// ---------------------------------------------------------------------------
// Live events -> stream events
// ---------------------------------------------------------------------------

export interface StreamState {
  textChunks: number;
  toolChunks: number;
  working: boolean;
}

export function newStreamState(): StreamState {
  return { textChunks: 0, toolChunks: 0, working: false };
}

export interface MappedEvent {
  responses: StreamResponse[];
  /** The stream ends after these: the task is terminal or waiting for the caller. */
  end: "none" | "interrupted" | "terminal";
}

export function statusUpdateEvent(
  run: Pick<RunRecord, "taskId" | "contextId">,
  state: TaskState,
  message?: Message,
): StreamResponse {
  return {
    statusUpdate: {
      taskId: run.taskId,
      contextId: run.contextId,
      status: { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() },
    },
  };
}

/**
 * One live event as the A2A events it becomes.
 *
 * `exec_complete` is not mapped here: it is the moment the run ends, and the
 * state the caller is told comes from the settled run row, which the stream
 * reads once the consumer has closed it (see `closeStream`).
 */
export function mapLiveEvent(
  run: Pick<RunRecord, "taskId" | "contextId" | "messageId">,
  event: Record<string, unknown>,
  s: StreamState,
): MappedEvent | null {
  const type = str(event.type);
  const messageId = str(event.message_id);
  // Brain stamps some events with the turn they belong to. One from another
  // turn is not this task's.
  if (messageId && run.messageId && messageId !== run.messageId) return null;
  if (isAssistantEvent(type)) {
    const text = assistantTextOf(event);
    if (!text) return null;
    const chunk = s.textChunks === 0 ? text : `${TEXT_CHUNK_SEPARATOR}${text}`;
    s.textChunks += 1;
    return {
      responses: [{
        artifactUpdate: {
          taskId: run.taskId,
          contextId: run.contextId,
          artifact: { artifactId: textArtifactId(run.taskId), name: "response", parts: [{ text: chunk, mediaType: "text/plain" }] },
          append: s.textChunks > 1,
          lastChunk: false,
        },
      }],
      end: "none",
    };
  }
  switch (type) {
    case "toolUsed": {
      const responses: StreamResponse[] = [];
      // The question tool's own result is the answer arriving: the run is
      // working again.
      if (str(event.tool) === "ask_user_question" && str(event.status) !== "start") {
        responses.push(statusUpdateEvent(run, TaskState.WORKING));
      }
      const line = toolLogLine(event);
      if (line) {
        const chunk = s.toolChunks === 0 ? line : `\n${line}`;
        s.toolChunks += 1;
        responses.push({
          artifactUpdate: {
            taskId: run.taskId,
            contextId: run.contextId,
            artifact: { artifactId: toolArtifactId(run.taskId), name: "tool-calls", parts: [{ text: chunk, mediaType: "text/plain" }] },
            append: s.toolChunks > 1,
            lastChunk: false,
          },
        });
      }
      return responses.length ? { responses, end: "none" } : null;
    }
    case "decisionResult":
      // The held call was decided, by the caller or by the timeout.
      return { responses: [statusUpdateEvent(run, TaskState.WORKING)], end: "none" };
    case "statusUpdate":
      if (str(event.agentStatus) === "running" && !s.working) {
        s.working = true;
        return { responses: [statusUpdateEvent(run, TaskState.WORKING)], end: "none" };
      }
      return null;
    case "permissionRequest":
    case "userQuestion": {
      const pending = pendingInputOf([{ id: 0, event: type, data: event }]);
      if (!pending) return null;
      return {
        responses: [statusUpdateEvent(run, TaskState.INPUT_REQUIRED, inputRequiredMessage(run, pending))],
        end: "interrupted",
      };
    }
    default:
      return null;
  }
}

/** The artifact closers and the final status a stream sends once the run row is settled. */
export function closingEvents(
  run: Pick<RunRecord, "taskId" | "contextId">,
  state: TaskState,
  s: StreamState,
  message?: Message,
): StreamResponse[] {
  const out: StreamResponse[] = [];
  const closer = (artifactId: string, name: string): StreamResponse => ({
    artifactUpdate: {
      taskId: run.taskId,
      contextId: run.contextId,
      artifact: { artifactId, name, parts: [{ text: "" }] },
      append: true,
      lastChunk: true,
    },
  });
  if (s.textChunks > 0) out.push(closer(textArtifactId(run.taskId), "response"));
  if (s.toolChunks > 0) out.push(closer(toolArtifactId(run.taskId), "tool-calls"));
  out.push(statusUpdateEvent(run, state, message));
  return out;
}

/** Whether a live event is the end of the run. */
export function isRunEnd(event: Record<string, unknown>, messageId: string): boolean {
  if (str(event.type) !== "exec_complete") return false;
  const m = str(event.message_id);
  return !m || !messageId || m === messageId;
}

// ---------------------------------------------------------------------------
// The answer to an INPUT_REQUIRED task
// ---------------------------------------------------------------------------

export type ParsedAnswer =
  | { ok: true; kind: "approval"; actionId: string; decision: "allow" | "deny"; reason: string }
  | { ok: true; kind: "question"; actionId: string; answers: Record<string, unknown> }
  | { ok: false; error: string };

const ALLOW_WORDS = new Set(["allow", "approve", "approved", "yes", "y", "ok", "true"]);
const DENY_WORDS = new Set(["deny", "denied", "reject", "rejected", "no", "n", "false"]);

function dataParts(parts: Part[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if (p.data && typeof p.data === "object" && !Array.isArray(p.data)) out.push(p.data as Record<string, unknown>);
  }
  return out;
}

function textOf(parts: Part[]): string {
  return parts.map((p) => p.text ?? "").filter(Boolean).join("\n").trim();
}

/**
 * What the caller's message says to the request the task is waiting on.
 *
 * An approval is answered by a data part `{actionId?, decision: "allow"|"deny",
 * reason?}`; a bare "allow" / "deny" text is accepted for a client that can only
 * send text. Nothing else is read as a decision, and `edit` and `remember` are
 * not offered: an approval is allow or deny. A question is answered by a data
 * part `{actionId?, answers}` or by text.
 */
export function parseAnswer(pending: PendingInput, parts: Part[]): ParsedAnswer {
  const data = dataParts(parts);
  const named = data.find((d) => typeof d.actionId === "string");
  if (named && named.actionId !== pending.actionId) {
    return { ok: false, error: "actionId does not name the request this task is waiting on" };
  }
  if (pending.kind === "approval") {
    const fromData = data.map((d) => str(d.decision).toLowerCase()).find(Boolean);
    const word = (fromData ?? textOf(parts)).toLowerCase();
    const reason = str(data.find((d) => typeof d.reason === "string")?.reason);
    if (ALLOW_WORDS.has(word)) return { ok: true, kind: "approval", actionId: pending.actionId, decision: "allow", reason };
    if (DENY_WORDS.has(word)) return { ok: true, kind: "approval", actionId: pending.actionId, decision: "deny", reason };
    return { ok: false, error: 'an approval is answered with a data part {"decision": "allow"|"deny"}' };
  }
  const withAnswers = data.find((d) => d.answers && typeof d.answers === "object");
  if (withAnswers) {
    return { ok: true, kind: "question", actionId: pending.actionId, answers: withAnswers.answers as Record<string, unknown> };
  }
  const text = textOf(parts);
  if (!text) return { ok: false, error: "a question is answered with text or a data part {\"answers\": {...}}" };
  const only = pending.questions.length === 1 ? pending.questions[0] as Record<string, unknown> : null;
  const key = only && str(only.id) ? str(only.id) : "answer";
  return { ok: true, kind: "question", actionId: pending.actionId, answers: { [key]: text } };
}
