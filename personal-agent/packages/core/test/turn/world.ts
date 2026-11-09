// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn's world for tests (the Python tests' `Bus`, `ScriptedClaw` and `TurnContext` set-up): a conversation that
 * records every outbound operation with the virtual time it arrived, a Claw that replays a script on that time, and a
 * context builder with the worker's defaults.
 */

import { ClawError } from "../../src/claw/errors.js";
import type { SseEvent } from "../../src/claw/model.js";
import type { JsonObject } from "../../src/json.js";
import type { LogFields, Logger } from "../../src/ports/logger.js";
import type { NewSession, SendOptions, UploadFile } from "../../src/ports/claw/sessions.js";
import type { Envelope, LiveStream, OutMessage, StreamRefused } from "../../src/ports/surface.js";
import { noModelRefusalPolicy, type ModelRefusalPolicy } from "../../src/plugins/model-refusal-policy.js";
import type { PublicErrors, WithheldIds } from "../../src/public-error/public-errors.js";
import { err, ok, type Result } from "../../src/result.js";
import {
  type TurnContext,
  type TurnHooks,
  type TurnRequest,
  type TurnStyle,
  newRecord,
} from "../../src/turn/engine/context.js";
import type { TurnClaw, TurnSurface } from "../../src/turn/ports.js";
import type { Timeline } from "./timeline.js";

export const PUBLIC = "https://x.test";

/** One event of a session's stream, as the Python tests' `ev` builds it. */
let evSeq = 0;
export function ev(name: string, messageId: string | null = "m1", data: Record<string, unknown> = {}): SseEvent {
  evSeq += 1;
  return {
    id: `${name}-${String(evSeq)}`,
    name,
    data: { ...(messageId === null ? {} : { message_id: messageId }), ...data },
  };
}

export function said(text: string, messageId = "m1"): SseEvent {
  return ev("AssistantMessage", messageId, { data: { content: [{ type: "text", text }] } });
}

export function tool(name: string, status: string, extra: Record<string, unknown> = {}, messageId = "m1"): SseEvent {
  return ev("toolUsed", messageId, { tool: name, status, ...extra });
}

export function result(text: string, messageId = "m1"): SseEvent {
  return ev("ResultMessage", messageId, { final_text: text, data: { subtype: "success" } });
}

/** No final_text: the answer is the last visible text. */
export function end(messageId = "m1"): SseEvent {
  return ev("ResultMessage", messageId, { data: { subtype: "success" } });
}

// --- the conversation -----------------------------------------------------------------------------------------------

/** What reached the chat, as the Python tests' outbox envelopes: an operation and its activity. */
export interface Sent {
  readonly operation: "send" | "update" | "delete";
  readonly kind: "message" | "typing";
  readonly message?: OutMessage;
  readonly activityId?: string;
  readonly ack?: boolean;
}

/** The text a message shows (its markdown, or a view's fallback). */
export function textOf(message: OutMessage | undefined): string {
  if (!message) return "";
  const body = message.body;
  return body.type === "text" ? body.text : body.type === "rich" ? body.markdown : body.fallbackText;
}

export interface StreamOp {
  readonly op: "open" | "inform" | "emit" | "finish";
  readonly text: string;
  readonly message?: OutMessage;
  readonly at: number;
}

export interface BusOptions {
  /** A publish that raises (the queue is down). */
  readonly fail?: (sent: Sent) => boolean;
  /** Seconds an envelope is held before it arrives (the publish returns at once, as a queue does). */
  readonly delay?: (sent: Sent) => number;
  /** How long `post` waits for the message's id. */
  readonly ackTimeout?: number;
  /** A live stream: refuse one of its requests by returning a status. */
  readonly stream?: { readonly refuse?: (op: StreamOp) => number | undefined };
}

/**
 * The outbound side and the chat behind it. `sent` is what reached the chat, in arrival order, with the time it arrived;
 * `chat` is the messages the user sees (posts, edited in place, minus the deleted ones).
 */
export class Bus implements TurnSurface {
  readonly sent: Sent[] = [];
  readonly at: number[] = [];
  readonly shown = new Map<string, string>();
  chat: Array<{ id: string; message: OutMessage }> = [];
  readonly streamOps: StreamOp[] = [];
  private readonly acks = new Map<Sent, (id: string) => void>();
  /** The signal of each edit's sender. */
  private readonly withdrawn = new Map<Sent, AbortSignal | undefined>();
  /** Every publish attempt, sent or not (a test that slows the queue wraps `publish`). */
  publish: (sent: Sent) => Promise<string | undefined>;

  constructor(
    readonly clock: Timeline,
    readonly options: BusOptions = {},
  ) {
    this.publish = (sent) => this.defaultPublish(sent);
  }

  private defaultPublish(sent: Sent): Promise<string | undefined> {
    if (this.options.fail?.(sent)) return Promise.reject(new Error("the queue is down"));
    const held = this.options.delay?.(sent) ?? 0;
    if (held) {
      void this.clock.sleep(held * 1000).then(() => this.arrive(sent));
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.arrive(sent));
  }

  private arrive(sent: Sent): string {
    if (this.withdrawn.get(sent)?.aborted) return "";
    this.sent.push(sent);
    this.at.push(this.clock.elapsed);
    const id = `teams-${String(this.sent.length)}`;
    if (sent.operation === "update" && sent.activityId) {
      this.shown.set(sent.activityId, textOf(sent.message));
      for (const m of this.chat) if (m.id === sent.activityId && sent.message) m.message = sent.message;
    } else if (sent.operation === "delete") {
      this.chat = this.chat.filter((m) => m.id !== sent.activityId);
    } else if (sent.kind === "message" && sent.message) {
      this.chat.push({ id, message: sent.message });
    }
    if (sent.ack) this.acks.get(sent)?.(id);
    return id;
  }

  typing(): Promise<void> {
    return this.publish({ operation: "send", kind: "typing" }).then(() => undefined);
  }

  send(message: OutMessage): Promise<void> {
    return this.publish({ operation: "send", kind: "message", message }).then(() => undefined);
  }

  async post(message: OutMessage): Promise<string | undefined> {
    const sent: Sent = { operation: "send", kind: "message", message, ack: true };
    const arrived = new Promise<string>((resolve) => this.acks.set(sent, resolve));
    try {
      const direct = await this.publish(sent);
      if (direct) return direct;
      const waited = new AbortController();
      const timeout = this.clock.sleep((this.options.ackTimeout ?? 5) * 1000, waited.signal).then(
        () => undefined,
        () => undefined,
      );
      const id = await Promise.race([arrived, timeout]);
      waited.abort();
      return id;
    } finally {
      this.acks.delete(sent);
    }
  }

  /** An edit whose sender is cancelled before the queue took it is withdrawn, as a cancelled publish is. */
  async update(id: string, message: OutMessage, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const sent: Sent = { operation: "update", kind: "message", message, activityId: id };
    this.withdrawn.set(sent, options.signal);
    try {
      await this.publish(sent);
    } finally {
      this.withdrawn.delete(sent); // (once the queue took it, it arrives whatever happens to its sender)
    }
  }

  async delete(id: string): Promise<Result<void, { kind: "delete_unsupported"; reason: string }>> {
    await this.publish({ operation: "delete", kind: "message", activityId: id });
    return ok(undefined);
  }

  outgoing(message: OutMessage): Envelope {
    return { operation: "send", message: JSON.parse(JSON.stringify(message)) as JsonObject };
  }

  deliver(envelope: Envelope): Promise<void> {
    return this.send(envelope["message"] as unknown as OutMessage);
  }

  openStream(_replyTo: string, status: string): Promise<Result<LiveStream, StreamRefused>> {
    const refused = this.streamRequest({ op: "open", text: status, at: this.clock.elapsed });
    return Promise.resolve(refused ? err(refused) : ok(this.liveStream()));
  }

  private streamRequest(op: StreamOp): StreamRefused | undefined {
    const status = this.options.stream?.refuse?.(op);
    if (status !== undefined) return { kind: "stream_refused", reason: `refused ${op.op}`, status, code: "" };
    this.streamOps.push(op);
    return undefined;
  }

  private liveStream(): LiveStream {
    const answer = (op: StreamOp): Promise<Result<void, StreamRefused>> => {
      const refused = this.streamRequest(op);
      return Promise.resolve(refused ? err(refused) : ok(undefined));
    };
    return {
      inform: (text) => answer({ op: "inform", text, at: this.clock.elapsed }),
      emit: (text) => answer({ op: "emit", text, at: this.clock.elapsed }),
      finish: (message) => answer({ op: "finish", text: textOf(message), message, at: this.clock.elapsed }),
    };
  }

  // --- what the tests read --------------------------------------------------------------------------------------------

  /** (seconds since the start, text) of every edit. */
  get updates(): Array<readonly [number, string]> {
    return this.sent.flatMap((s, i) =>
      s.operation === "update" ? [[this.at[i] ?? 0, textOf(s.message)] as const] : [],
    );
  }

  /** What the user is left reading, message by message. */
  get texts(): string[] {
    return this.chat.map((m) => textOf(m.message));
  }

  everything(): string {
    return JSON.stringify([this.sent, this.streamOps]);
  }
}

// --- Claw ------------------------------------------------------------------------------------------------------------

export type Script = ReadonlyArray<readonly [number, SseEvent]>;

/** A Claw that records which key every call used and replays (seconds since the start, event) pairs on the virtual clock. */
export class ScriptedClaw implements TurnClaw {
  readonly calls: unknown[][] = [];
  failSendWith: number | Error | undefined;
  failCreateWith: number | undefined;
  failModelWith: number | Error | undefined;
  queueSends = false;
  busy: boolean | number = false;
  gate: string | null = "claw-1";
  lastEvent: string | null | Error = null;
  changesReply: unknown = undefined;
  rows: JsonObject[] | Error = [];
  created: Array<{ key: string } & NewSession> = [];
  uploads: Array<{ sessionId: string; folder: string; files: readonly UploadFile[] }> = [];
  /** Each connection replays this script (a function: the script of connection n). */
  scripts: (attempt: number, after: string | undefined) => Script | Error;
  /** After the script, the stream stays open. */
  hang = false;
  connections = 0;

  constructor(
    readonly clock: Timeline,
    script: Script = [],
  ) {
    this.scripts = () => script;
  }

  create(key: string, session: NewSession): Promise<{ sessionId: string; messageId: string }> {
    this.calls.push(["create", key, session.text]);
    if (this.failCreateWith) return Promise.reject(new ClawError(this.failCreateWith));
    const earlier = this.created.filter((c) => c.key === key).length;
    this.created.push({ key, ...session });
    const sessionId = earlier ? `sess-${key}-${String(earlier + 1)}` : `sess-${key}`;
    return Promise.resolve({ sessionId, messageId: session.withMessage === false ? "" : "m1" });
  }

  sendMessage(key: string, sessionId: string, text: string, options?: SendOptions): Promise<string | null> {
    this.calls.push(["send", key, sessionId, text, options ?? {}]);
    const fail = this.failSendWith;
    if (fail instanceof Error) return Promise.reject(fail);
    if (fail) return Promise.reject(new ClawError(fail));
    return Promise.resolve(this.queueSends ? null : "m2");
  }

  setModel(key: string, sessionId: string, model: string): Promise<void> {
    this.calls.push(["set_model", key, sessionId, model]);
    const fail = this.failModelWith;
    if (fail instanceof Error) return Promise.reject(fail);
    if (fail) return Promise.reject(new ClawError(fail));
    return Promise.resolve();
  }

  lastEventId(key: string, sessionId: string): Promise<string | null> {
    this.calls.push(["last_event_id", key, sessionId]);
    return this.lastEvent instanceof Error ? Promise.reject(this.lastEvent) : Promise.resolve(this.lastEvent);
  }

  turn(key: string, sessionId: string): Promise<{ running: boolean; messageId: string | null }> {
    this.calls.push(["turn", key, sessionId]);
    if (typeof this.busy === "number") return Promise.reject(new ClawError(this.busy));
    return Promise.resolve({ running: this.busy, messageId: this.busy ? this.gate : null });
  }

  async *stream(key: string, sessionId: string, after?: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    this.calls.push(["stream", key, sessionId, after ?? null]);
    const script = this.scripts(this.connections++, after);
    if (script instanceof Error) throw script;
    for (const [at, event] of script) {
      await this.clock.sleepUntil(this.clock.start + at, signal);
      yield event;
    }
    if (this.hang) await this.clock.sleepUntil(Number.POSITIVE_INFINITY, signal);
  }

  uploadFiles(
    key: string,
    sessionId: string,
    folder: string,
    files: readonly UploadFile[],
  ): Promise<{ paths: string[]; refused: string[] }> {
    this.calls.push(["upload", key, sessionId, folder, files.map((f) => f.name)]);
    this.uploads.push({ sessionId, folder, files });
    return Promise.resolve({ paths: files.map((f) => `/workspace/.uploads/${folder}/${f.name}`), refused: [] });
  }

  events(key: string, sessionId: string, options?: { tail?: number; maxBytes?: number }): Promise<JsonObject[]> {
    this.calls.push(["events", key, sessionId, options?.tail ?? null, options?.maxBytes ?? null]);
    return this.rows instanceof Error ? Promise.reject(this.rows) : Promise.resolve(this.rows);
  }

  deliveryLink(sessionId: string, deliveryId: string): string | null {
    return `https://claw.test/v1/sessions/${sessionId}/deliveries/${deliveryId}`;
  }

  changes(key: string, sessionId: string, timeoutMs: number): Promise<unknown> {
    this.calls.push(["changes", key, sessionId, timeoutMs]);
    if (this.changesReply instanceof Error) return Promise.reject(this.changesReply);
    if (this.changesReply === undefined) {
      return Promise.reject(new ClawError(409, '{"ok":false,"error":"sandbox_not_running"}'));
    }
    return Promise.resolve(this.changesReply);
  }
}

// --- logs and withheld errors ------------------------------------------------------------------------------------------

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields: LogFields }> = [];
  debug(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "debug", message, fields });
  }
  info(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "error", message, fields });
  }
  child(): Logger {
    return this;
  }
  text(): string {
    return this.lines.map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields)}`).join("\n");
  }
}

export class RecordingErrors implements PublicErrors {
  readonly withheld: Array<{ ref: string; where: string; detail: unknown; ids: WithheldIds }> = [];
  withhold(where: string, detail: unknown = "", ids: WithheldIds = {}): string {
    const ref = `ref${String(this.withheld.length + 1)}`;
    this.withheld.push({ ref, where, detail, ids });
    return ref;
  }
  publicReason(reason: unknown): string {
    return typeof reason === "string" ? reason : "";
  }
}

// --- the turn ------------------------------------------------------------------------------------------------------------

export interface WorldOptions {
  readonly request?: Partial<TurnRequest>;
  readonly hooks?: TurnHooks;
  readonly style?: Partial<TurnStyle>;
  readonly refusals?: ModelRefusalPolicy;
  readonly sessionId?: string;
  readonly sessionModel?: string;
}

export interface World {
  readonly ctx: TurnContext;
  readonly clock: Timeline;
  readonly bus: Bus;
  readonly claw: ScriptedClaw;
  readonly log: RecordingLogger;
  readonly errors: RecordingErrors;
  /** What `onTurn` was told, in order. */
  readonly told: string[];
}

export function world(clock: Timeline, bus: Bus, claw: ScriptedClaw, options: WorldOptions = {}): World {
  const told: string[] = [];
  const log = new RecordingLogger();
  const errors = new RecordingErrors();
  const ctx: TurnContext = {
    request: { key: "ak", text: "go", idempotencyKey: "idem", publicBaseUrl: PUBLIC, ...options.request },
    hooks: { onTurn: (_session, what) => told.push(what), ...options.hooks },
    deps: {
      claw,
      surface: bus,
      clock,
      log,
      refusals: options.refusals ?? noModelRefusalPolicy,
      errors,
      style: { streamText: false, suggestedReplies: true, ...options.style },
    },
    record: newRecord(options.sessionId, options.sessionModel ?? ""),
  };
  return { ctx, clock, bus, claw, log, errors, told };
}
