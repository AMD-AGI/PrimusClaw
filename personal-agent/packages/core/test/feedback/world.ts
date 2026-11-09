// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A world for feedback's service and flow tests: the worker's real SQLite store (`openTestStore`), a fake Claw that
 * keeps one session's stored events, an in-memory issue tracker that can fail the ways GitHub does, the recording
 * surface, and routes built the way the router hands them over. Mirrors the Python tests' `linked_world`.
 */
import {
  ClawError,
  FeedbackFlow,
  FeedbackReporting,
  FeedbackService,
  FeedbackThumbs,
  err,
  ok,
  pyStr,
  type ClickRoute,
  type ConversationRef,
  type FeedbackSink,
  type IdentityLookup,
  type InboundAction,
  type InboundMessage,
  type IssueRef,
  type JsonObject,
  type KeyOwner,
  type LogFields,
  type Logger,
  type LogLevel,
  type MessageRoute,
  type OutMessage,
  type Result,
  type SettleOptions,
  type SinkError,
  type SseEvent,
  type UserRef,
} from "@primusclaw/personal-agent";
import { createHash } from "node:crypto";

import { FakeSurface, openTestStore } from "../../../../test-support/index.js";
import { redactText } from "../../src/security/redact.js";

export const SECRET = "ghp_" + "S".repeat(36);
export const QUESTION_MARK = "QUESTION-MARK-31337";
export const ANSWER_MARK = "ANSWER-MARK-31337";
export const ERROR_TEXT_MARK = "ERROR-TEXT-MARK-31337";
export const PUBLIC = "https://claw.example.com";
export const REPO_URL = "https://github.test/example-org/example-repo/issues";
export const CONV = "19:group@thread.v2";

export const USER_A: UserRef = { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" };
export const USER_B: UserRef = { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "" };

export interface LogLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every line. */
export class RecordingLogger implements Logger {
  constructor(
    readonly lines: LogLine[] = [],
    private readonly base: LogFields = {},
  ) {}
  private add(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields: { ...this.base, ...fields } });
  }
  debug(message: string, fields?: LogFields): void {
    this.add("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.add("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.add("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.add("error", message, fields);
  }
  child(fields: LogFields): Logger {
    return new RecordingLogger(this.lines, { ...this.base, ...fields });
  }
}

/** The issue tracker, in memory, with GitHub's ways of failing. */
export class FakeIssues implements FeedbackSink {
  readonly issues: { number: number; title: string; body: string; labels: readonly string[] }[] = [];
  readonly comments: [number, string][] = [];
  readonly deleted = new Set<number>();
  calls = 0;
  /** The next issue is refused with this. */
  issueFailure: SinkError | undefined;
  /** Every comment is refused with this status. */
  commentStatus: number | undefined;
  /** The next issue or comment is stored, and then its answer is lost (a timeout). */
  commitThenFail = false;

  everything(): string {
    return JSON.stringify({ issues: this.issues, comments: this.comments });
  }

  private lost<T>(value: T): Result<T, SinkError> {
    if (!this.commitThenFail) return ok(value);
    this.commitThenFail = false;
    return err({ kind: "sink_failed", status: 0, code: "transport_ReadTimeout" });
  }

  createIssue(title: string, body: string, labels: readonly string[]): Promise<Result<IssueRef, SinkError>> {
    this.calls += 1;
    if (this.issueFailure) return Promise.resolve(err(this.issueFailure));
    const number = this.issues.length + this.deleted.size + 1;
    this.issues.push({ number, title, body, labels });
    return Promise.resolve(this.lost({ number, url: `${REPO_URL}/${String(number)}` }));
  }

  findIssue(marker: string): Promise<Result<IssueRef | undefined, SinkError>> {
    this.calls += 1;
    const found = [...this.issues].reverse().find((i) => i.body.includes(marker));
    return Promise.resolve(ok(found && { number: found.number, url: `${REPO_URL}/${String(found.number)}` }));
  }

  hasComment(issue: number, marker: string): Promise<Result<boolean, SinkError>> {
    this.calls += 1;
    return Promise.resolve(ok(this.comments.some(([n, body]) => n === issue && body.includes(marker))));
  }

  comment(issue: number, body: string): Promise<Result<void, SinkError>> {
    this.calls += 1;
    if (this.commentStatus) {
      return Promise.resolve(err({ kind: "sink_failed", status: this.commentStatus, code: "github_comment" }));
    }
    if (this.deleted.has(issue) || !this.issues.some((i) => i.number === issue)) {
      return Promise.resolve(err({ kind: "sink_failed", status: 404, code: "github_404" }));
    }
    this.comments.push([issue, body]);
    return Promise.resolve(this.lost(undefined));
  }

  /** The issues are gone from the tracker. */
  deleteAll(): void {
    for (const i of this.issues) this.deleted.add(i.number);
    this.issues.length = 0;
  }
}

/** Claw's session as feedback reads it: the stored events (JSON replay), the stream's history, the turn, the votes. */
export class FakeClaw {
  rows: JsonObject[] = [];
  events: SseEvent[] = [];
  replayError: number | undefined;
  readonly owners = new Map<string, string>();
  readonly replayAsks: { tail: number | undefined; maxBytes: number | undefined }[] = [];
  readonly votes: [string, string, string, string, string | undefined][] = [];
  readonly calls: string[] = [];
  voteRefusal: number | undefined;
  /** A stream that never ends its history (to run into the deadline). */
  hang = false;

  private owns(key: string, sessionId: string): boolean {
    return (this.owners.get(sessionId) ?? key) === key;
  }

  readonly sessions = {
    events: (key: string, sessionId: string, options: { tail?: number; maxBytes?: number } = {}) => {
      this.calls.push("replay");
      this.replayAsks.push({ tail: options.tail, maxBytes: options.maxBytes });
      if (!this.owns(key, sessionId)) return Promise.reject(new ClawError(404));
      if (this.replayError !== undefined) return Promise.reject(new ClawError(this.replayError));
      return Promise.resolve([...this.rows]);
    },
    stream: (key: string, sessionId: string, _after?: string, signal?: AbortSignal): AsyncIterable<SseEvent> =>
      this.stream(key, sessionId, signal),
    turn: () => Promise.resolve({ running: false, messageId: null }),
    vote: (key: string, sessionId: string, messageId: string, vote: "up" | "down", reason?: string) => {
      this.calls.push("vote");
      if (this.voteRefusal !== undefined) return Promise.reject(new ClawError(this.voteRefusal));
      this.votes.push([key, sessionId, messageId, vote, reason]);
      return Promise.resolve();
    },
  };

  readonly assistant = {
    session: (key: string) => {
      this.calls.push(`assistant_session ${key}`);
      return Promise.resolve({ sessionId: "sess-assistant", created: false });
    },
  };

  private async *stream(key: string, sessionId: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    this.calls.push("stream");
    if (!this.owns(key, sessionId)) throw new ClawError(404);
    for (const event of this.events) yield event;
    if (this.hang) {
      await new Promise<void>((_, reject) =>
        signal?.addEventListener("abort", () => {
          reject(signal.reason as Error);
        }),
      );
    }
    yield { id: "", name: "historyComplete", data: {} };
  }
}

export interface SettleCall {
  readonly card: OutMessage | string;
  readonly options: SettleOptions;
}

export interface WorldOptions {
  /** No sink: reports are only recorded. */
  readonly unconfigured?: boolean;
  /** What the platform says of a key: an owner, nothing, a failure, or no answer at all. */
  readonly lookup?: KeyOwner | "fail" | "never" | undefined;
  readonly assistantOn?: boolean;
}

export type World = ReturnType<typeof makeWorld>;

export function makeWorld(options: WorldOptions = {}) {
  const { store, clock } = openTestStore();
  const issues = new FakeIssues();
  const claw = new FakeClaw();
  const surface = new FakeSurface();
  const log = new RecordingLogger();
  const lookups: string[] = [];
  const identity: IdentityLookup = {
    ownerOfKey: (key) => {
      lookups.push(key);
      if (options.lookup === "fail") return Promise.reject(new Error("the platform is down"));
      if (options.lookup === "never") return new Promise<undefined>(() => undefined);
      return Promise.resolve(options.lookup);
    },
  };
  const mask = (text: string): string => redactText(text).text;
  const service = new FeedbackService({
    reports: store.feedback,
    links: store.links,
    sessions: claw.sessions,
    sink: options.unconfigured ? undefined : issues,
    clock,
    log,
    mask,
    turnText: {
      withoutRule: (text) => text,
      answerOf: (_turnId, events) =>
        events.map((e) => (e.name === "ResultMessage" ? pyStr(e.data["final_text"]) : "")).join(""),
    },
    wording: { botName: "Clawy", channelName: "Teams" },
    publicBaseUrl: PUBLIC,
    worker: { pluginId: "2", version: "1.0.0", workerImage: "abc1234", apiImage: "", brainImage: "" },
  });
  const credential = (sender: UserRef): Promise<string | undefined> =>
    Promise.resolve(store.links.getKey(sender.id) ?? undefined);
  const reporting = new FeedbackReporting({
    service,
    sessions: store.sessions,
    credential,
    identity,
    clock,
    log,
  });
  const flow = new FeedbackFlow({ reports: store.feedback, reporting, service, log });
  const thumbs = new FeedbackThumbs({
    reporting,
    sessions: store.sessions,
    claw,
    credential,
    assistantOn: () => options.assistantOn ?? false,
    sha256Hex: (text) => createHash("sha256").update(text).digest("hex"),
    mask,
    log,
  });
  const settled: SettleCall[] = [];
  return { store, clock, issues, claw, surface, log, lookups, service, reporting, flow, thumbs, settled };
}

export function link(world: World, user: UserRef, key: string, clawUserId?: string): void {
  const code = world.store.links.stashPending(key);
  world.store.links.redeemPending(user.id, user.name, code);
  if (clawUserId) world.store.links.setClawUserId(user.id, clawUserId);
}

function conversationRef(user: UserRef, scope: string): ConversationRef {
  return scope
    ? { id: scope, kind: "group", tenantId: "t", wire: { conversation: { id: scope } } }
    : { id: `conv-${user.id}`, kind: "personal", tenantId: "t", wire: { conversation: { id: `conv-${user.id}` } } };
}

let seq = 0;

function inbound(
  user: UserRef,
  scope: string,
): Pick<InboundMessage, "id" | "sender" | "conversation" | "locale" | "clientPlatform"> {
  seq += 1;
  return {
    id: `a${String(seq)}`,
    sender: user,
    conversation: conversationRef(user, scope),
    locale: "",
    clientPlatform: "",
  };
}

export function messageRoute(world: World, text: string, user: UserRef = USER_A, scope = ""): MessageRoute {
  const message: InboundMessage = {
    ...inbound(user, scope),
    type: "message",
    text,
    mentioned: Boolean(scope),
    targeted: false,
    namesBotFirst: false,
    conversationName: scope ? "Infra on-call" : "",
    unreadableFiles: [],
    links: [],
    quotes: [],
    files: [],
    mentions: [],
    provenance: "typed",
  };
  return {
    sender: user,
    conversation: world.surface.conversation(message.conversation),
    scope,
    lang: () => "en",
    message,
    text,
  };
}

export function clickRoute(
  world: World,
  data: JsonObject,
  user: UserRef = USER_A,
  scope = "",
  cardMessageId = "card-9",
): ClickRoute {
  const action: InboundAction = {
    ...inbound(user, scope),
    type: "action",
    verb: `primusclaw.${pyStr(data["primusclaw"])}`,
    data,
    cardMessageId,
    invoke: true,
    clickVerb: `primusclaw.${pyStr(data["primusclaw"])}`,
  };
  return {
    sender: user,
    conversation: world.surface.conversation(action.conversation),
    scope,
    lang: () => "en",
    action,
    settle: (card, options = {}) => {
      world.settled.push({ card, options });
      return Promise.resolve(true);
    },
  };
}

/** Says `text` as `user`; true when feedback took the message. */
export function say(world: World, text: string, user: UserRef = USER_A, scope = ""): Promise<boolean> {
  return world.flow.entry(messageRoute(world, text, user, scope));
}

/** The texts said, in order (views by their fallback). */
export function texts(world: World): string[] {
  return world.surface.outbox.flatMap((r) => {
    if (r.op !== "send") return [];
    const body = r.message.body;
    return [body.type === "text" ? body.text : body.type === "rich" ? body.markdown : body.fallbackText];
  });
}

/** The offer view sent last: its id and issue number. */
export function offerOf(world: World): { offerId: string; issueNumber: number } | undefined {
  for (const r of [...world.surface.outbox].reverse()) {
    if (r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "feedbackOffer") {
      return r.message.body.view.model;
    }
  }
  return undefined;
}

/** Every report row as stored (text, scene, state), for "nothing of it is kept" checks. */
export function storedReports(world: World): string {
  const rows = [];
  for (let id = 1; ; id += 1) {
    const row = world.store.feedback.getFeedbackReport(id);
    if (row === null) break;
    rows.push(row);
  }
  return JSON.stringify(rows);
}

export function userRow(mid: string, text: string, at: number): JsonObject {
  return {
    event_id: mid,
    event_type: "UserMessage",
    created_at: new Date(at * 1000).toISOString(),
    data: { type: "UserMessage", message_id: mid, role: "user", data: { content: [{ type: "text", text }] } },
  };
}

export function toolRow(mid: string, name: string, status: string, at: number, n = 0): JsonObject {
  return {
    event_id: `${mid}-t${String(n)}`,
    event_type: "toolUsed",
    created_at: new Date(at * 1000).toISOString(),
    data: { type: "toolUsed", message_id: mid, tool: name, status },
  };
}

export function resultRow(mid: string, text: string, at: number, subtype = "success"): JsonObject {
  return {
    event_id: `${mid}-r`,
    event_type: "ResultMessage",
    created_at: new Date(at * 1000).toISOString(),
    data: { type: "ResultMessage", message_id: mid, final_text: text, data: { subtype } },
  };
}

export function errorRow(mid: string, at: number, code = "rate_limited"): JsonObject {
  return {
    event_id: `${mid}-e`,
    event_type: "error",
    created_at: new Date(at * 1000).toISOString(),
    data: { type: "error", message_id: mid, code, message: ERROR_TEXT_MARK },
  };
}

export function nowSeconds(world: World): number {
  return world.clock.epochMs() / 1000;
}

/** Alice linked (key ak-alice, platform user u-1) with session sess-1, and that session's last turn. */
export function linkedWorld(options: WorldOptions = {}, rows = true): World {
  const world = makeWorld(options);
  link(world, USER_A, "ak-alice", "u-1");
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-1" });
  if (rows) {
    const now = nowSeconds(world);
    world.claw.rows = [
      userRow("m1", `${QUESTION_MARK} please run it`, now - 120),
      toolRow("m1", "bash", "start", now - 110),
      toolRow("m1", "bash", "success", now - 100, 1),
      toolRow("m1", "mcp__board__list", "error", now - 95, 2),
      resultRow("m1", `${ANSWER_MARK} done`, now - 90),
    ];
  }
  return world;
}

export function advance(world: World, seconds: number): void {
  world.clock.setEpochMs(world.clock.epochMs() + seconds * 1000);
}
