// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// The A2A server's context/task model (CLAW_A2A_CONTEXT_TASKS).
//
//   contextId  one session (`claw_sessions`), owned by the authenticated caller
//   taskId     one run of it (`claw_tasks`, origin 'a2a')
//
// A message with a `contextId` and no `taskId` starts a new task in that
// context, with the context's history, and is refused while a task of the
// context is still running. A message with a `taskId` is only ever the answer
// to a task that is INPUT_REQUIRED: the approval of a held tool call, or the
// reply to a question the agent asked.
//
// The handlers take what they cannot own (the admission transaction and the
// NATS connection) as dependencies, so they are the same code in the server and
// in a suite that drives them with a fake connection.
// ---------------------------------------------------------------------------

import type { FastifyReply } from "fastify";
import pino from "pino";
import { applyTaskStatusTransition } from "../tasks/db.js";
import { buildDecisionMessage } from "../sessions/decision-message.js";
import { interruptSubject } from "@claw/protocol";
import { sanitizeSessionEvent } from "../events/store.js";
import {
  listRunsForCaller, loadRun, loadRunEvents, loadRunForCaller, settleRun,
} from "./a2a-store.js";
import {
  accumulatedText, closingEvents, isRunEnd, isTerminalRun, mapLiveEvent, newStreamState,
  parseAnswer, pendingInputOf, stateOfRun, taskOf, toolLog,
  type RunEvent, type RunRecord, type StreamState,
} from "./a2a-task-view.js";
import {
  type CancelTaskRequest, type GetTaskRequest, type JsonRpcResponse, type ListTasksRequest,
  type ListTasksResponse, type Message, type Part, type SendMessageRequest, type StreamResponse,
  type SubscribeToTaskRequest, type Task,
  JSON_RPC_INTERNAL_ERROR, JSON_RPC_INVALID_PARAMS,
  TaskState, TERMINAL_STATES,
  makeJsonRpcError, makeJsonRpcSuccess, makePushNotificationNotSupportedError,
  makeTaskNotCancelableError, makeTaskNotFoundError, makeUnsupportedOperationError,
} from "./a2a-types.js";

const logger = pino({ name: "a2a-v2" });

export interface NatsSub {
  unsubscribe(): void;
  [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }>;
}

export interface NatsPort {
  subscribe(subject: string): NatsSub;
  publish(subject: string, payload?: string): void;
  decode(data: Uint8Array): string;
}

/** What opening a run decided. The admission transaction lives in a2a.ts. */
export type ContextEntry =
  | { kind: "opened"; sessionId: string; contextId: string; taskId: string; messageId: string; internal: unknown }
  | { kind: "duplicate"; sessionId: string; contextId: string; taskId: string }
  | { kind: "busy"; taskId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "deferred" }
  | { kind: "error"; error: JsonRpcResponse };

export interface OpenRunInput<Auth> {
  message: Message;
  text: string;
  callerId: string;
  rpcId: string | number;
  auth: Auth;
  metadata?: Record<string, unknown>;
}

export interface A2aV2Deps<Auth extends { userId: string }> {
  nats: NatsPort;
  /** Session, parent attachment, gate and run row in one admission transaction. */
  openRun(input: OpenRunInput<Auth>): Promise<ContextEntry>;
  /** Publish the opened run for execution; a failure rolls the admission back and is rethrown. */
  publishRun(entry: Extract<ContextEntry, { kind: "opened" }>, text: string, auth: Auth): Promise<void>;
  admissionRejected(rpcId: string | number, reason: string): JsonRpcResponse;
  admissionDeferred(rpcId: string | number): JsonRpcResponse;
  /** How long a blocking send waits for the task to finish or need input. */
  blockingWaitMs?: number;
  pollMs?: number;
  keepaliveMs?: number;
  /** How long a stream waits for the run row to close after the run's last event. */
  settleMs?: number;
  /** How long an answer waits for the request it answers to be recorded. */
  inputGraceMs?: number;
}

function invalid(rpcId: string | number, message: string): JsonRpcResponse {
  return makeJsonRpcError(rpcId, JSON_RPC_INVALID_PARAMS, message);
}

function textOfParts(parts: Part[]): string {
  return parts
    .map((p) => p.text ?? (typeof p.data === "string" ? p.data : ""))
    .filter(Boolean)
    .join("\n");
}

function encodePageToken(at: Date, taskId: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), taskId }), "utf8").toString("base64url");
}

function decodePageToken(token: string): { at: Date; taskId: string } | null {
  try {
    const v = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { at?: unknown; taskId?: unknown };
    if (typeof v.at !== "string" || typeof v.taskId !== "string") return null;
    const at = new Date(v.at);
    return Number.isNaN(at.getTime()) ? null : { at, taskId: v.taskId };
  } catch {
    return null;
  }
}

/** The row statuses a state can have. SUBMITTED/WORKING/INPUT_REQUIRED are told apart by events. */
const LIVE_STATUSES = ["queued", "preparing", "running"];
function statusesOf(state: TaskState): string[] {
  switch (state) {
    case TaskState.COMPLETED: return ["completed"];
    case TaskState.FAILED: return ["failed"];
    case TaskState.CANCELED: return ["cancelled", "cancelling"];
    case TaskState.SUBMITTED:
    case TaskState.WORKING:
    case TaskState.INPUT_REQUIRED: return LIVE_STATUSES;
    default: return [];
  }
}

function sseWrite(raw: FastifyReply["raw"], rpcId: string | number, response: StreamResponse): void {
  raw.write(`data: ${JSON.stringify(makeJsonRpcSuccess(rpcId, response))}\n\n`);
}

function sseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** A stream that continues a run starts counting where the run's text already is. */
function streamStateOf(events: RunEvent[]): StreamState {
  const s = newStreamState();
  s.textChunks = events.filter((e) => accumulatedText([e])).length;
  s.toolChunks = toolLog(events).length;
  s.working = events.some((e) => e.event === "statusUpdate");
  return s;
}

export function createA2aV2<Auth extends { userId: string }>(deps: A2aV2Deps<Auth>) {
  const blockingWaitMs = deps.blockingWaitMs ?? 120_000;
  const pollMs = deps.pollMs ?? 250;
  const keepaliveMs = deps.keepaliveMs ?? 15_000;
  const settleMs = deps.settleMs ?? 5_000;
  const inputGraceMs = deps.inputGraceMs ?? 2_000;

  /** The task as the caller sees it now. */
  async function viewOf(run: RunRecord, historyLength?: number): Promise<Task> {
    return taskOf(run, await loadRunEvents(run), { historyLength });
  }

  /**
   * Block until the task is finished or waiting on the caller, for at most
   * `blockingWaitMs`. `answered` is the request the caller has just replied
   * to: the events that record the answer land a moment after the reply, and
   * until they do the old request would read as still open.
   */
  async function waitForTask(run: RunRecord, historyLength: number | undefined, answered?: string): Promise<Task> {
    const deadline = Date.now() + blockingWaitMs;
    let task = await viewOf(run, historyLength);
    for (;;) {
      const current = await loadRun(run.taskId) ?? run;
      const events = await loadRunEvents(current);
      task = taskOf(current, events, { historyLength });
      const state = task.status.state;
      if (TERMINAL_STATES.has(state)) return task;
      if (state === TaskState.INPUT_REQUIRED && pendingInputOf(events)?.actionId !== answered) return task;
      if (Date.now() >= deadline) return task;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // -------------------------------------------------------------------------
  // SendMessage
  // -------------------------------------------------------------------------

  /** The reply to a task that is waiting on the caller. Returns the decision it published. */
  /**
   * The state of a task a caller is about to answer. A caller that heard
   * INPUT_REQUIRED on a stream may answer before the consumer has stored the
   * event that made it so, so a live task that does not yet read as waiting is
   * given a moment before it is called not waiting.
   */
  async function settleInputState(run: RunRecord): Promise<{ state: TaskState; pending: ReturnType<typeof pendingInputOf> }> {
    const deadline = Date.now() + inputGraceMs;
    for (;;) {
      const current = await loadRun(run.taskId) ?? run;
      const events = await loadRunEvents(current);
      const state = stateOfRun(current, events);
      const pending = state === TaskState.INPUT_REQUIRED ? pendingInputOf(events) : null;
      if (pending || TERMINAL_STATES.has(state) || Date.now() >= deadline) return { state, pending };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function answer(
    message: Message,
    rpcId: string | number,
    callerId: string,
    auth: Auth,
  ): Promise<{ run: RunRecord; actionId: string } | { error: JsonRpcResponse }> {
    const run = await loadRunForCaller(message.taskId as string, callerId);
    if (!run) return { error: makeTaskNotFoundError(rpcId, message.taskId as string) };
    if (message.contextId && message.contextId !== run.contextId) {
      return { error: invalid(rpcId, "message.contextId does not match message.taskId") };
    }
    const { state, pending } = await settleInputState(run);
    if (TERMINAL_STATES.has(state)) {
      return { error: makeUnsupportedOperationError(rpcId, "Messages sent to terminal tasks cannot be accepted") };
    }
    if (!pending) {
      return { error: makeUnsupportedOperationError(
        rpcId,
        "The task is not waiting for input; send a new message with its contextId once it has finished",
      ) };
    }
    const parsed = parseAnswer(pending, message.parts ?? []);
    if (!parsed.ok) return { error: invalid(rpcId, parsed.error) };
    // The message Brain's decision dispatcher already reads; `user_id` is the
    // caller, as for a decision made in the web client.
    if (parsed.kind === "approval") {
      const built = buildDecisionMessage(run.sessionId, auth.userId, {
        extData: { tool_use_id: parsed.actionId, action: parsed.decision, reason: parsed.reason },
      });
      if (!built.ok) return { error: invalid(rpcId, built.error) };
      deps.nats.publish(`decision.${run.sessionId}`, JSON.stringify(built.message));
    } else {
      deps.nats.publish(`decision.${run.sessionId}`, JSON.stringify({
        type: "answer",
        session_id: run.sessionId,
        user_id: auth.userId,
        action_id: parsed.actionId,
        answers: parsed.answers,
        skipped: [],
      }));
    }
    logger.info({ taskId: run.taskId, actionId: parsed.actionId, kind: parsed.kind }, "a2a.AnswerTask");
    return { run, actionId: parsed.actionId };
  }

  function busyError(rpcId: string | number, taskId: string): JsonRpcResponse {
    return makeUnsupportedOperationError(
      rpcId,
      `context busy: task ${taskId} of this context is still running; wait for it or cancel it`,
    );
  }

  async function sendMessage(
    params: SendMessageRequest, rpcId: string | number, callerId: string, auth: Auth,
  ): Promise<JsonRpcResponse> {
    const { message, configuration, metadata } = params;
    if (configuration?.taskPushNotificationConfig !== undefined) return makePushNotificationNotSupportedError(rpcId);
    if (!message?.parts?.length) return invalid(rpcId, "message.parts is required and must be non-empty");

    if (message.taskId) {
      const answered = await answer(message, rpcId, callerId, auth);
      if ("error" in answered) return answered.error;
      if (configuration?.returnImmediately === true) {
        return makeJsonRpcSuccess(rpcId, { task: await viewOf(answered.run, configuration.historyLength) });
      }
      return makeJsonRpcSuccess(rpcId, {
        task: await waitForTask(answered.run, configuration?.historyLength, answered.actionId),
      });
    }

    const text = textOfParts(message.parts);
    if (!text) return invalid(rpcId, "No text content found in message parts");
    try {
      const entry = await deps.openRun({ message, text, callerId, rpcId, auth, metadata });
      if (entry.kind === "rejected") return deps.admissionRejected(rpcId, entry.reason);
      if (entry.kind === "deferred") return deps.admissionDeferred(rpcId);
      if (entry.kind === "error") return entry.error;
      if (entry.kind === "busy") return busyError(rpcId, entry.taskId);
      if (entry.kind === "opened") {
        await deps.publishRun(entry, text, auth);
      }
      logger.info({ taskId: entry.taskId, contextId: entry.contextId, duplicate: entry.kind === "duplicate" }, "a2a.SendMessage");
      const run = await loadRun(entry.taskId);
      if (!run) return makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task");
      if (configuration?.returnImmediately === true || entry.kind === "duplicate") {
        return makeJsonRpcSuccess(rpcId, { task: await viewOf(run, configuration?.historyLength) });
      }
      return makeJsonRpcSuccess(rpcId, { task: await waitForTask(run, configuration?.historyLength) });
    } catch (err: unknown) {
      logger.error({ err }, "a2a.SendMessage.failed");
      return makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task");
    }
  }

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  /**
   * Pump a run's live events to an SSE response until the run ends or needs the
   * caller. The caller has subscribed before anything it depends on happened,
   * because core NATS does not replay.
   */
  async function pump(args: {
    reply: FastifyReply;
    rpcId: string | number;
    run: RunRecord;
    sub: NatsSub;
    initial: Task;
    state: StreamState;
  }): Promise<void> {
    const { reply, rpcId, run, sub, initial, state } = args;
    sseHeaders(reply);
    sseWrite(reply.raw, rpcId, { task: initial });
    let closed = false;
    const keepalive = setInterval(() => { if (!closed) reply.raw.write(": keepalive\n\n"); }, keepaliveMs);
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      sub.unsubscribe();
      reply.raw.end();
    };
    reply.raw.on("close", () => {
      closed = true;
      clearInterval(keepalive);
      sub.unsubscribe();
    });
    try {
      for await (const msg of sub) {
        if (closed) break;
        let event: Record<string, unknown>;
        try {
          event = sanitizeSessionEvent(JSON.parse(deps.nats.decode(msg.data)) as Record<string, unknown>);
        } catch { continue; }
        if (isRunEnd(event, run.messageId)) {
          // The state a caller is told is the closed row's: one who sees
          // COMPLETED and asks GetTask must not read WORKING.
          let settled = await settleRun(run.taskId, settleMs) ?? run;
          if (!isTerminalRun(settled.status)) {
            settled = { ...settled, status: event.failed ? "failed" : event.interrupted ? "cancelled" : "completed" };
          }
          const view = taskOf(settled, await loadRunEvents(settled));
          for (const r of closingEvents(settled, view.status.state, state, view.status.message)) {
            sseWrite(reply.raw, rpcId, r);
          }
          break;
        }
        const mapped = mapLiveEvent(run, event, state);
        if (!mapped) continue;
        for (const r of mapped.responses) sseWrite(reply.raw, rpcId, r);
        if (mapped.end !== "none") break;
      }
    } catch (err) {
      logger.warn({ err, taskId: run.taskId }, "a2a.stream_error");
    } finally {
      finish();
    }
  }

  async function sendStreamingMessage(
    params: SendMessageRequest, rpcId: string | number, reply: FastifyReply, callerId: string, auth: Auth,
  ): Promise<void> {
    const { message, configuration, metadata } = params;
    if (configuration?.taskPushNotificationConfig !== undefined) {
      reply.send(makePushNotificationNotSupportedError(rpcId));
      return;
    }
    if (!message?.parts?.length) {
      reply.status(400).send(invalid(rpcId, "message.parts is required"));
      return;
    }

    if (message.taskId) {
      const run = await loadRunForCaller(message.taskId, callerId);
      if (!run) { reply.send(makeTaskNotFoundError(rpcId, message.taskId)); return; }
      // Subscribed before the answer is published: the run resumes the moment
      // it is heard.
      const sub = deps.nats.subscribe(`events.${run.sessionId}`);
      const answered = await answer(message, rpcId, callerId, auth);
      if ("error" in answered) { sub.unsubscribe(); reply.send(answered.error); return; }
      const events = await loadRunEvents(run);
      // The events that record the answer have not landed yet, so the task is
      // told to be working again rather than still waiting.
      const initial: Task = { ...taskOf(run, events, { historyLength: 0 }), status: { state: TaskState.WORKING, timestamp: new Date().toISOString() } };
      await pump({ reply, rpcId, run, sub, initial, state: streamStateOf(events) });
      return;
    }

    const text = textOfParts(message.parts);
    if (!text) { reply.status(400).send(invalid(rpcId, "No text content")); return; }
    let entry: ContextEntry;
    try {
      entry = await deps.openRun({ message, text, callerId, rpcId, auth, metadata });
    } catch (err: unknown) {
      logger.error({ err }, "a2a.SendStreamingMessage.open_failed");
      reply.status(500).send(makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task"));
      return;
    }
    // Before any SSE header: a stream opened to carry one refusal reads to an SSE
    // client as a task that finished.
    if (entry.kind === "rejected") { reply.send(deps.admissionRejected(rpcId, entry.reason)); return; }
    if (entry.kind === "deferred") { reply.send(deps.admissionDeferred(rpcId)); return; }
    if (entry.kind === "error") { reply.send(entry.error); return; }
    if (entry.kind === "busy") { reply.send(busyError(rpcId, entry.taskId)); return; }
    const run = await loadRun(entry.taskId);
    if (!run) { reply.status(500).send(makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task")); return; }
    if (entry.kind === "duplicate") {
      // A resend of a message this context already ran: the answer is that task.
      reply.send(makeJsonRpcSuccess(rpcId, { task: await viewOf(run, configuration?.historyLength) }));
      return;
    }
    const sub = deps.nats.subscribe(`events.${entry.sessionId}`);
    try {
      await deps.publishRun(entry, text, auth);
    } catch (err: unknown) {
      sub.unsubscribe();
      logger.error({ err }, "a2a.SendStreamingMessage.failed");
      reply.status(500).send(makeJsonRpcError(rpcId, JSON_RPC_INTERNAL_ERROR, "Failed to create task"));
      return;
    }
    logger.info({ taskId: entry.taskId, contextId: entry.contextId }, "a2a.SendStreamingMessage");
    const initial: Task = {
      id: run.taskId,
      contextId: run.contextId,
      status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
    };
    await pump({ reply, rpcId, run, sub, initial, state: newStreamState() });
  }

  async function subscribeToTask(
    params: SubscribeToTaskRequest, rpcId: string | number, reply: FastifyReply, callerId: string,
  ): Promise<void> {
    if (!params.id) { reply.status(400).send(invalid(rpcId, "id is required")); return; }
    const run = await loadRunForCaller(params.id, callerId);
    if (!run) { reply.status(404).send(makeTaskNotFoundError(rpcId, params.id)); return; }
    // Subscribed before the snapshot is read, so nothing that happens in
    // between is lost; the cost is that a chunk written in that instant can
    // be in both.
    const sub = deps.nats.subscribe(`events.${run.sessionId}`);
    const events = await loadRunEvents(run);
    const initial = taskOf(run, events);
    if (TERMINAL_STATES.has(initial.status.state)) {
      sub.unsubscribe();
      reply.send(makeUnsupportedOperationError(rpcId, "Task is already in a terminal state"));
      return;
    }
    await pump({ reply, rpcId, run, sub, initial, state: streamStateOf(events) });
  }

  // -------------------------------------------------------------------------
  // GetTask, ListTasks, CancelTask
  // -------------------------------------------------------------------------

  async function getTask(params: GetTaskRequest, rpcId: string | number, callerId: string): Promise<JsonRpcResponse> {
    if (!params.id) return invalid(rpcId, "id is required");
    if (params.historyLength !== undefined && (!Number.isInteger(params.historyLength) || params.historyLength < 0)) {
      return invalid(rpcId, "historyLength must be a non-negative integer");
    }
    const run = await loadRunForCaller(params.id, callerId);
    if (!run) return makeTaskNotFoundError(rpcId, params.id);
    return makeJsonRpcSuccess(rpcId, await viewOf(run, params.historyLength));
  }

  async function listTasks(params: ListTasksRequest, rpcId: string | number, callerId: string): Promise<JsonRpcResponse> {
    const pageSize = params.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return invalid(rpcId, "pageSize must be an integer between 1 and 100");
    }
    if (params.historyLength !== undefined && (!Number.isInteger(params.historyLength) || params.historyLength < 0)) {
      return invalid(rpcId, "historyLength must be a non-negative integer");
    }
    if (params.status !== undefined && !(Object.values(TaskState) as string[]).includes(params.status)) {
      return invalid(rpcId, "status must be a valid TaskState");
    }
    let after: Date | undefined;
    if (params.statusTimestampAfter) {
      after = new Date(params.statusTimestampAfter);
      if (Number.isNaN(after.getTime())) return invalid(rpcId, "statusTimestampAfter must be an ISO 8601 timestamp");
    }
    let cursor: { at: Date; taskId: string } | undefined;
    if (params.pageToken) {
      cursor = decodePageToken(params.pageToken) ?? undefined;
      if (!cursor) return invalid(rpcId, "pageToken is invalid");
    }

    const statuses = params.status !== undefined ? statusesOf(params.status) : undefined;
    const base = { callerId, contextId: params.contextId, statuses, after };
    // SUBMITTED, WORKING and INPUT_REQUIRED are one set of rows; the events tell them apart.
    const derived = params.status === TaskState.SUBMITTED || params.status === TaskState.WORKING
      || params.status === TaskState.INPUT_REQUIRED;
    const found: Array<{ task: Task; at: Date }> = [];
    let next = cursor;
    let totalSize = 0;
    for (let guard = 0; guard < 20 && found.length <= pageSize; guard += 1) {
      const page = await listRunsForCaller({ ...base, cursor: next, limit: pageSize + 1 });
      if (guard === 0) totalSize = page.total;
      for (const run of page.runs) {
        const task = taskOf(run, await loadRunEvents(run), {
          historyLength: params.historyLength, includeArtifacts: params.includeArtifacts === true,
        });
        if (!derived || task.status.state === params.status) found.push({ task, at: run.statusAt });
      }
      const last = page.runs[page.runs.length - 1];
      if (page.runs.length <= pageSize || !last) break;
      next = { at: last.statusAt, taskId: last.taskId };
    }
    if (derived) {
      // The count of a derived state is of the live rows, which are few.
      totalSize = 0;
      for (const run of (await listRunsForCaller({ ...base, limit: 500 })).runs) {
        if (stateOfRun(run, await loadRunEvents(run)) === params.status) totalSize += 1;
      }
    }
    const shown = found.slice(0, pageSize);
    const last = shown[shown.length - 1];
    const response: ListTasksResponse = {
      tasks: shown.map((f) => f.task),
      nextPageToken: found.length > pageSize && last ? encodePageToken(last.at, last.task.id) : "",
      pageSize,
      totalSize,
    };
    return makeJsonRpcSuccess(rpcId, response);
  }

  async function cancelTask(params: CancelTaskRequest, rpcId: string | number, callerId: string): Promise<JsonRpcResponse> {
    if (!params.id) return invalid(rpcId, "id is required");
    const run = await loadRunForCaller(params.id, callerId);
    if (!run) return makeTaskNotFoundError(rpcId, params.id);
    const state = stateOfRun(run, await loadRunEvents(run));
    if (TERMINAL_STATES.has(state)) return makeTaskNotCancelableError(rpcId, params.id, state);
    // The same two halves as a Stop in the web client: the interrupt Brain
    // listens for, and the durable cancellation. Held, the row parks at
    // `cancelling` and reads as CANCELED at once; the worker's own completion
    // then closes it as `cancelled`.
    deps.nats.publish(interruptSubject(run.sessionId));
    await applyTaskStatusTransition("cancelling", {
      where: "task_id = $1 AND origin = 'a2a' AND status IN ('queued','preparing','running')",
      params: [run.taskId],
    });
    logger.info({ taskId: run.taskId }, "a2a.CancelTask");
    const current = await loadRun(run.taskId) ?? run;
    return makeJsonRpcSuccess(rpcId, await viewOf(current));
  }

  return {
    sendMessage,
    sendStreamingMessage,
    subscribeToTask,
    getTask,
    listTasks,
    cancelTask,
  };
}

export type A2aV2<Auth extends { userId: string }> = ReturnType<typeof createA2aV2<Auth>>;
