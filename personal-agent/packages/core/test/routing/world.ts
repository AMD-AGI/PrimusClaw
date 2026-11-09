// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router with a real store and recording fakes around it (the Python tests' `world`: Agent, FakeClaw, FakeOutbox,
 * Store). The turn engine is a recording one: it "creates" a session `sess-<key>` or "sends" into the one it is given,
 * reports it, and answers with what the test scripted (or holds the turn until released).
 */
import {
  ClawError,
  integrationRegistry,
  noRouteHandlers,
  textMessage,
  type ClawPort,
  type ConversationRef,
  type InboundAction,
  type InboundMessage,
  type KeyOwner,
  type Logger,
  type LogValue,
  type MetricsPort,
  type RouteHandlers,
  type UserRef,
} from "@primusclaw/personal-agent";

import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import type { RouterConfig, RouterDeps, RouterLimits } from "../../src/routing/deps.js";
import type { AssistantChat, RemoteChat } from "../../src/routing/features.js";
import { Router } from "../../src/routing/router.js";
import type { TurnHooks, TurnOutcome, TurnRun, TurnRunner } from "../../src/routing/turn-runner.js";
import { ALICE, FakeExchange, note } from "./fixtures.js";

export const PUBLIC = "https://claw.example.com";

export const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

/** Claw as the router reads it: every call recorded, answers as the test sets them. */
export class FakeClaw {
  readonly calls: (string | number | boolean)[][] = [];
  /** session -> running (Claw is busy on it); a number: reading it fails with that status. */
  readonly busy = new Map<string, boolean | number>();
  /** key -> the person's memory; a number: reading it fails with that status. */
  memory: Map<string, { enabled: boolean; available: boolean; items: string[] }> | number = new Map();
  memoryWrites: boolean[] = [];
  interruptFails: number | undefined;
  github: { readsWith: string; login: string; missing: string; bindingReads: boolean } | null | number = null;

  port(): ClawPort {
    const sessions = {
      turn: (key: string, sessionId: string) => {
        this.calls.push(["turn", key, sessionId]);
        const busy = this.busy.get(sessionId);
        if (typeof busy === "number") return Promise.reject(new ClawError(busy));
        return Promise.resolve({ running: busy === true, messageId: busy === true ? "claw-1" : null });
      },
      interrupt: (key: string, sessionId: string) => {
        this.calls.push(["interrupt", key, sessionId]);
        return this.interruptFails === undefined
          ? Promise.resolve()
          : Promise.reject(new ClawError(this.interruptFails));
      },
    };
    const settings = {
      memory: (key: string) => {
        this.calls.push(["memory", key]);
        if (typeof this.memory === "number") return Promise.reject(new ClawError(this.memory));
        return Promise.resolve(this.memory.get(key) ?? { enabled: false, available: true, items: [] });
      },
      setMemory: (key: string, enabled: boolean) => {
        this.calls.push(["set_memory", key, enabled]);
        this.memoryWrites.push(enabled);
        return Promise.resolve({ enabled, available: true });
      },
      githubConnection: (key: string) => {
        this.calls.push(["github_connection", key]);
        return typeof this.github === "number"
          ? Promise.reject(new ClawError(this.github))
          : Promise.resolve(this.github);
      },
    };
    const workItems = { list: () => Promise.resolve([]) };
    return { baseUrl: PUBLIC, sessions, settings, workItems } as unknown as ClawPort;
  }
}

/** The turn engine, recorded: what each run sent where, and its answer. */
export class FakeTurns implements TurnRunner {
  readonly runs: TurnRun[] = [];
  readonly calls: string[][] = [];
  /** The answers, one per run in order ("ok" when none is left). */
  answers: string[] = [];
  /** A run holds until released when set. */
  hold: Promise<void> | undefined;
  /** A run holds before Claw takes its message (no session yet, not running) until released when set. */
  holdBeforeRunning: Promise<void> | undefined;
  fail = false;

  async run(run: TurnRun, hooks: TurnHooks): Promise<TurnOutcome> {
    this.runs.push(run);
    if (this.holdBeforeRunning !== undefined) await this.holdBeforeRunning;
    const sessionId = run.sessionId ?? `sess-${run.credential}`;
    if (run.sessionId === null) this.calls.push(["create", run.credential, run.text]);
    else this.calls.push(["send", run.credential, run.sessionId, run.text]);
    hooks.onSession(sessionId, run.model);
    hooks.onTurn(sessionId, "started", "claw-1");
    hooks.onRunning();
    if (this.hold !== undefined) await this.hold;
    if (this.fail) throw new Error("the stream broke");
    const answer = hooks.stopRequested() ? "Stopped." : (this.answers.shift() ?? "ok");
    await run.conversation.send(textMessage(answer));
    hooks.onTurn(sessionId, "delivered", "claw-1");
    return { finalAnswer: answer };
  }
}

const OFF_ASSISTANT: AssistantChat = {
  on: () => false,
  understands: () => false,
  reachable: () => false,
  hiddenCommand: () => undefined,
  board: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  forget: () => undefined,
  route: () => Promise.resolve(false),
  understand: () => Promise.resolve(false),
  filesOnly: (lang) => (lang === "zh" ? "（只有文件）" : "(files only)"),
};

const OFF_REMOTE: RemoteChat = {
  enabled: false,
  attached: () => false,
  direct: () => false,
  windowMode: () => "chat",
  quotesWindow: () => false,
  running: () => false,
  chatContext: () => Promise.resolve(null),
  attachment: () => undefined,
  prompt: () => Promise.resolve(),
  stop: () => Promise.resolve(false),
  agents: () => Promise.resolve(),
  agent: () => Promise.resolve(),
  forgetPerson: () => undefined,
  groupChatKey: (userId, scope) => `${userId}|${scope}`,
};

export interface WorldOptions {
  readonly config?: Partial<RouterConfig>;
  readonly assistant?: Partial<AssistantChat>;
  readonly remote?: Partial<RemoteChat>;
  readonly handlers?: Partial<RouteHandlers>;
  readonly limits?: Partial<RouterLimits>;
  readonly reachable?: readonly string[];
}

function configOf(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    publicBaseUrl: PUBLIC,
    botName: "Clawy",
    pluginId: "",
    model: "",
    reviewModel: "",
    fallbackModel: "",
    exchangeForChat: false,
    briefEnabled: false,
    schedulesEnabled: false,
    jobWatchEnabled: false,
    ownThumbsMobile: true,
    ...overrides,
  };
}

export function world(options: WorldOptions = {}) {
  const { store, clock } = openTestStore();
  const surface = new FakeSurface({ reachable: options.reachable ?? [] });
  const claw = new FakeClaw();
  const turns = new FakeTurns();
  const exchange = new FakeExchange();
  exchange.enabled = options.config?.exchangeForChat ?? false;
  const owners = new Map<string, KeyOwner>();
  const events: Record<string, LogValue>[] = [];
  const limited: string[] = [];
  const revoked: string[] = [];
  const config = configOf(options.config);
  const limits: RouterLimits = {
    maxConcurrentTasks: 3,
    assistantPendingSeconds: 90,
    checkMessage: () => ({ allowed: true }),
    rateNotice: (lang, wait) => `${lang}: wait ${String(wait)}`,
    concurrencyNotice: (lang, running, what) => `${lang}: ${String(running)} running${what}`,
    ...options.limits,
  };
  const deps: RouterDeps = {
    config,
    surface,
    channel: { refOf: (stored) => refOf(stored) },
    store,
    claw: claw.port(),
    clock,
    random: new SeededRandom(3),
    logger: silent,
    metrics: {
      limited: (reason: string) => limited.push(reason),
      filesDropped: () => undefined,
    } as unknown as MetricsPort,
    securityEvent: (name, fields) => events.push({ event: name, ...fields }),
    identity: { ownerOfKey: (key) => Promise.resolve(owners.get(key)) },
    keyRevoker: {
      revoke: (key) => {
        revoked.push(key);
        return Promise.resolve(true);
      },
    },
    exchange,
    limits,
    assistant: { ...OFF_ASSISTANT, ...options.assistant },
    remote: { ...OFF_REMOTE, ...options.remote },
    turns,
    proactive: { muted: () => null, release: () => Promise.resolve() },
    observing: { forward: () => Promise.resolve(), mayTurnOn: () => false, board: () => Promise.resolve() },
    github: undefined,
    subscriptions: undefined,
    reviewStop: undefined,
    handoffs: [],
    channelContext: () => ({ context: {}, actions: [], people: [] }),
    connectionsText: (c) => `Connections: ${c.owner?.name ?? "?"}`,
    messageText: {
      quoteBlock: () => "",
      withLinks: (text) => text,
      withQuote: (text, quote) => (quote ? `${quote}\n\n${text}` : text),
      unreadable: () => undefined,
    },
    reportView: () => undefined,
    note,
    handlers: { ...noRouteHandlers, ...options.handlers },
    integrations: integrationRegistry(),
  };
  const router = new Router(deps);
  return { router, store, clock, surface, claw, turns, exchange, owners, events, limited, revoked, deps };
}

export type World = ReturnType<typeof world>;

function refOf(stored: Readonly<Record<string, unknown>>): ConversationRef | undefined {
  const conversation = stored["conversation"];
  if (typeof conversation !== "object" || conversation === null) return undefined;
  const id = (conversation as Record<string, unknown>)["id"];
  return typeof id === "string" ? { id, kind: "group", tenantId: "t1", wire: stored } : undefined;
}

let next = 0;

/** A 1:1 message (Python conftest `message`). */
export function message(
  text: string,
  options: { user?: UserRef; id?: string; kind?: ConversationRef["kind"]; conversation?: string; locale?: string } = {},
): InboundMessage {
  const user = options.user ?? ALICE;
  const kind = options.kind ?? "personal";
  const id = options.conversation ?? (kind === "personal" ? `dm-${user.id}` : "g-1");
  next += 1;
  return {
    type: "message",
    id: options.id ?? `act-${String(next)}`,
    sender: user,
    conversation: {
      id,
      kind,
      tenantId: "t1",
      wire: { conversation: { id, conversationType: kind === "group" ? "groupChat" : kind } },
    },
    locale: options.locale ?? "",
    clientPlatform: "",
    text,
    mentioned: kind !== "personal",
    targeted: false,
    namesBotFirst: false,
    conversationName: "",
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    provenance: "typed",
  };
}

export function clickOf(
  verb: string,
  data: Record<string, unknown>,
  options: { user?: UserRef; group?: boolean; card?: string } = {},
): InboundAction {
  const user = options.user ?? ALICE;
  const id = options.group === true ? "g-1" : `dm-${user.id}`;
  next += 1;
  return {
    type: "action",
    id: `click-${String(next)}`,
    sender: user,
    conversation: {
      id,
      kind: options.group === true ? "group" : "personal",
      tenantId: "t1",
      wire: { conversation: { id } },
    },
    locale: "",
    clientPlatform: "",
    verb,
    data,
    cardMessageId: options.card ?? "card-1",
  };
}

/** What was said, in order: each text message's text, and "<view:name>" for a view. */
export function said(w: World): string[] {
  return w.surface.outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "update") return [];
    const body = r.message.body;
    if (body.type === "text") return [body.text];
    if (body.type === "rich") return [body.markdown];
    return [`<view:${body.view.name}>`];
  });
}

/** Link `userId` to `key` the way the console and `/link` do. */
export function link(w: World, userId: string, key: string): void {
  if (w.store.links.redeemPending(userId, "Someone", w.store.links.stashPending(key)) !== "ok")
    throw new Error("link failed");
}
