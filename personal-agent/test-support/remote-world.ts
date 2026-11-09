// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Remote agents wired to a real HTTP Claw remote-agents server (`remote-fake.ts`): the remote-agent domain, the real Claw client,
 * a real store in memory, a recording channel, and the Teams rendering of what was posted, so a test reads what a person was left
 * reading (`said`). A message is routed the way the router routes it for remote agents: `/agents`, `/agent ...`, `/stop`, and a
 * plain message of an attached chat to its session. The live view's throttle runs on a virtual clock; the follower on real time
 * with short timings, as the Python worker's tests did.
 */
import {
  type Clock,
  type Conversation,
  type InboundMessage,
  type OutMessage,
  type ConversationRef,
  type JsonObject,
  silentLogger,
} from "@primusclaw/personal-agent";
import { createClawClient, systemClock } from "@primusclaw/personal-agent-runtime";
import type { ClawRemoteAgentsPort } from "../packages/core/src/ports/claw/remote-agents.js";
import { createHash } from "node:crypto";

import { DirectChat } from "../packages/core/src/direct-chat/direct-chat.js";
import { Guardrails } from "../packages/core/src/guardrails/guardrails.js";
import { ConnectorSetup, setupFrom } from "../packages/core/src/remote/connector/setup.js";
import type { RemoteContext, RemoteErrors, RemoteGuard, RemoteSettings } from "../packages/core/src/remote/context.js";
import type { FollowTimings } from "../packages/core/src/remote/follow/timings.js";
import { RemoteAgents } from "../packages/core/src/remote/remote-agents.js";
import { RENDERERS } from "../packages/teams/src/views/index.js";
import { DEFAULT_STYLE } from "../packages/teams/src/config/style.js";
import { activityOf } from "../packages/teams/src/messenger/render.js";
import { FakeClock } from "./clock.js";
import { SeededRandom } from "./random.js";
import { type FakeCommand, FakeRemote, KEYS } from "./remote-fake.js";
import { type Recorded, FakeSurface } from "./surface.js";
import { parseAgentCommand } from "../packages/core/src/commands/agent-args.js";
import { commandArgs, menuCommand } from "../packages/core/src/commands/parse.js";
import { naturalCommand } from "../packages/core/src/capabilities/natural.js";
import { openTestStore } from "./store.js";

export const USER_A = { id: "aad-a", channelUserId: "29:aad-a", name: "Alice", email: "" };
export const USER_B = { id: "aad-b", channelUserId: "29:aad-b", name: "Bob", email: "" };
/** Which key each test user linked (`remote-fake.ts` KEYS). */
export const KEY_OF: Readonly<Record<string, string>> = { "aad-a": "ak-alice", "aad-b": "ak-bob" };
export const ALICE = KEYS["ak-alice"] ?? "u-alice";

/** Short timings: real seconds, no virtual clock here (the follower). */
export const TEST_TIMINGS: FollowTimings = {
  quietMs: 250,
  toolQuietMs: 1000,
  gapMs: 0,
  maxAgeMs: 3000,
  reconnectMs: 50,
};

/** The live view's clock: a sleep moves it, and nothing really waits. */
export class VirtualClock implements Clock {
  now = 1000_000;
  /** Every wait, in seconds, in order; and what a test runs at each (a machine that comes back while the worker waits). */
  readonly waited: number[] = [];
  onSleep: ((seconds: number) => void) | null = null;
  epochMs(): number {
    return systemClock.epochMs();
  }
  monotonicMs(): number {
    return this.now;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason as Error;
    this.now += ms;
    this.waited.push(ms / 1000);
    this.onSleep?.(ms / 1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const WORLD_ERRORS: RemoteErrors = {
  looksInternal: (text) => /gateway|brain/u.test(text),
  withhold: () => "0123abcd",
  publicReason: (reason) => (typeof reason === "string" ? reason : ""),
  splitErrorTail: (text) => ({ kept: text, tail: "" }),
  newRef: () => "0123abcd",
};

type Json = Record<string, unknown>;

/** The words of a card's blocks, in order, those inside containers included (the Python worker's `FakeOutbox._words`). */
export function* wordsOf(blocks: unknown): Generator<string> {
  for (const block of (Array.isArray(blocks) ? blocks : []) as Json[]) {
    if (block["text"] !== "\u2503") yield typeof block["text"] === "string" ? block["text"] : "";
    for (const fact of (block["facts"] ?? []) as Json[]) yield `${String(fact["title"])}: ${String(fact["value"])}`;
    yield* wordsOf(block["items"]);
    for (const column of (block["columns"] ?? []) as Json[]) yield* wordsOf(column["items"]);
  }
}

/** One operation on a message, as `RemoteWorld.operations` lists it. */
export interface Operation {
  readonly op: Recorded["op"];
  readonly id: string;
  readonly card: Json | undefined;
  /** The message's own text ("" for none). */
  readonly text: string;
  /** The conversation it went to. */
  readonly conversation: string;
}

export interface WorldOptions {
  readonly enabled?: boolean;
  readonly watchSeconds?: { readonly start: number; readonly mode: number };
  readonly windowDefault?: "card" | "chat";
  readonly direct?: boolean;
  /** The follower's timings (TEST_TIMINGS when not given). */
  readonly timings?: FollowTimings;
}

export class RemoteWorld {
  readonly surface = new FakeSurface({ caps: { streaming: false } });
  readonly virtual = new VirtualClock();
  /** The store, on a wall clock a test can move (`advanceSeconds`); it starts at the real time. */
  readonly test = openTestStore({ clock: new FakeClock(Date.now()) });
  readonly remote: RemoteAgents;
  /** Claw's remote-agents port as the agent calls it. */
  readonly claw: ClawRemoteAgentsPort;
  /** A message the channel refuses to post (Teams said no), when this says so. */
  refuse: ((message: OutMessage) => boolean) | null = null;
  /** Whether the chat may be told something now (false: muted hours, as a test says). */
  reachable = true;
  /** The worker's settings, which a test may change (remote agents turned off under a card). */
  readonly settings: { -readonly [K in keyof RemoteSettings]: RemoteSettings[K] };
  private n = 0;
  private langs = new Map<string, "zh" | "en">();

  constructor(
    readonly server: FakeRemote,
    options: WorldOptions,
  ) {
    const store = this.test.store;
    const claw = createClawClient({ baseUrl: server.url, clock: systemClock });
    this.claw = claw.remoteAgents;
    this.settings = {
      enabled: options.enabled ?? true,
      follow: true,
      windowDefault: options.windowDefault ?? "chat",
      timings: TEST_TIMINGS,
      watchTimings: TEST_TIMINGS,
      botName: "Clawy",
      streaming: false,
      ...(options.watchSeconds ? { watchSeconds: options.watchSeconds } : {}),
    };
    const ctx: RemoteContext = {
      settings: this.settings,
      claw: claw.remoteAgents,
      clawBaseUrl: server.url,
      setup: new ConnectorSetup(setupFrom(null, server.url)),
      remoteState: store.remoteState,
      sessionNames: store.remoteSessionNames,
      permissions: store.remotePermissions,
      prefs: store.prefs,
      references: store.references,
      conversationFor: (reference) => this.wrap(this.surface.conversation(refOf(reference))),
      credentialFor: (person) => Promise.resolve(KEY_OF[person] ?? null),
      reach: { reachable: () => this.reachable, muted: () => null, holdRemote: () => undefined },
      guard: guardOf(new Guardrails(systemClock, () => undefined)),
      audit: () => undefined,
      errors: WORLD_ERRORS,
      // (wall time is the store's, which a test moves; waits and durations are real)
      clock: {
        epochMs: () => this.test.clock.epochMs(),
        monotonicMs: () => systemClock.monotonicMs(),
        sleep: (ms, signal) => systemClock.sleep(ms, signal),
      },
      paceClock: this.virtual,
      random: new SeededRandom(11),
      logger: silentLogger,
      digestHex: (algorithm, text) => createHash(algorithm).update(text).digest("hex"),
      langOf: (person) => this.langs.get(person) ?? "en",
      directChat: new DirectChat(options.direct ?? false),
    };
    this.remote = new RemoteAgents(ctx);
  }

  setLang(person: string, lang: "zh" | "en"): void {
    this.langs.set(person, lang);
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}-${String(this.n)}`;
  }

  /** The 1:1 conversation of a user, and its stored reference (what the follower posts to). */
  conversationOf(user = USER_A): Conversation {
    const ref: ConversationRef = {
      id: `conv-${user.id}`,
      kind: "personal",
      tenantId: "",
      wire: { conversation: { id: `conv-${user.id}` } },
    };
    this.test.store.references.saveReference(user.id, { conversation: { id: ref.id, conversationType: "personal" } });
    return this.wrap(this.surface.conversation(ref));
  }

  /** The conversation as the channel posts to it, refusing what a test says Teams refuses. */
  private wrap(to: Conversation): Conversation {
    const refused = (message: OutMessage): Promise<never> | null =>
      this.refuse?.(message) === true ? Promise.reject(new Error("Teams said no")) : null;
    return {
      ref: to.ref,
      edited: to.edited,
      typing: () => to.typing(),
      send: (message) => refused(message) ?? to.send(message),
      post: (message) => refused(message) ?? to.post(message),
      update: (id, message, options) => refused(message) ?? to.update(id, message, options),
      delete: (id) => to.delete(id),
      outgoing: (message) => to.outgoing(message),
      deliver: (envelope) => to.deliver(envelope),
      openStream: (replyTo, status) => to.openStream(replyTo, status),
      markSettled: (id) => {
        to.markSettled(id);
      },
    };
  }

  /** One message from the user, routed as the router routes it for remote agents, then until the worker is quiet. */
  async say(text: string, user = USER_A): Promise<void> {
    await this.send(text, user);
    await this.idle();
  }

  /** One message from the user, without waiting for the turn it starts. */
  async send(typed: string, user = USER_A): Promise<void> {
    const to = this.conversationOf(user);
    const key = KEY_OF[user.id] ?? "";
    const sender = user;
    const text = this.asTheRouterReadsIt(typed, user.id);
    // (as the router reads it: `/agents` alone or with words that are no subcommand is the list; `/agents new` is `/agent new`)
    const agents = commandArgs(text, "agents");
    if (agents !== null && parseAgentCommand(agents) === null) return this.remote.agents(sender, key, to);
    const args = agents ?? commandArgs(text, "agent");
    if (args !== null) {
      return this.remote.agent({
        chat: sender,
        credential: key,
        args,
        conversation: to,
        message: undefined,
        provider: undefined,
      });
    }
    if (commandArgs(text, "stop") !== null) {
      await this.remote.stop(sender, key, to);
      return;
    }
    if (this.remote.attached(user.id)) {
      const message = { id: this.id("act"), text, quotes: [] } as unknown as InboundMessage;
      await this.remote.prompt({
        message,
        chat: sender,
        credential: key,
        prompt: text,
        conversation: to,
        provider: undefined,
      });
    }
  }

  /**
   * What a 1:1 message says as the router reads it (routing/personal-text.ts): a menu word or a sentence that is a command is that
   * command, with the words that are not commands here left as words (no assistant, no GitHub in this world).
   */
  private asTheRouterReadsIt(text: string, userId: string): string {
    const attached = this.remote.attached(userId);
    const off = new Set(["github", "board", "brief", "brief now"]);
    if (!this.settings.enabled) for (const word of ["agents", "agent"]) off.add(word);
    if (!attached) for (const word of ["agent detach", "stop it"]) off.add(word);
    return naturalCommand(menuCommand(text, false), false, off);
  }

  /** A tap on a card's button. */
  async click(data: Json, user = USER_A, cardId = "card-1"): Promise<void> {
    const to = this.conversationOf(user);
    const key = KEY_OF[user.id] ?? "";
    const sender = user;
    const action = { type: "action", id: this.id("click"), verb: "", data, cardMessageId: cardId, sender } as unknown;
    const settle = async (
      card: OutMessage | string,
      options: { fallback?: string; announce?: boolean } = {},
    ): Promise<boolean> => {
      const message = typeof card === "string" ? noteOf(card) : card;
      const fallback = typeof card === "string" ? (options.fallback ?? card) : options.fallback;
      let replaced = false;
      if (cardId) {
        await to.update(cardId, message);
        replaced = true;
      }
      if (fallback && (options.announce !== false || !replaced))
        await to.send({ body: { type: "text", text: fallback } });
      return replaced;
    };
    const handler = this.remote.clickHandler;
    await handler.withCredential?.(
      { action, conversation: to, sender, scope: "", lang: () => "en", settle } as never,
      key,
    );
    await new Promise((resolve) => setTimeout(resolve, 50)); // (the turn a click answers may well go on)
  }

  /** Wait until the worker is quiet: no turn being read, no short watch running. */
  async idle(timeoutMs = 25_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (this.remote.busyChats().length > 0) {
      if (Date.now() > end) throw new Error(`the worker did not go quiet: ${this.remote.busyChats().join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > end) throw new Error("the condition never became true");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Each recorded message as Teams is sent it. */
  private activities(): { op: Recorded["op"]; id: string; activity: Json }[] {
    return this.surface.outbox.flatMap((r) => {
      if (r.op === "send" || r.op === "post" || r.op === "update" || r.op === "stream.finish") {
        const id = r.op === "update" || r.op === "post" ? r.id : "";
        return [
          {
            op: r.op,
            id,
            activity: activityOf(r.message, { style: DEFAULT_STYLE, renderers: RENDERERS, masker: undefined }),
          },
        ];
      }
      return [];
    });
  }

  /**
   * Every operation on a message, in order, as Teams is sent it: `id` the message an update or delete changes, or the id a post was
   * given ("" for a plain send); `card` the card it carries, if any.
   */
  operations(): Operation[] {
    return this.surface.outbox.flatMap((r): Operation[] => {
      if (r.op === "delete") return [{ op: r.op, id: r.id, card: undefined, text: "", conversation: r.conversation }];
      if (r.op !== "send" && r.op !== "post" && r.op !== "update") return [];
      const activity = activityOf(r.message, { style: DEFAULT_STYLE, renderers: RENDERERS, masker: undefined }) as Json;
      const text = typeof activity["text"] === "string" ? activity["text"] : "";
      const id = r.op === "send" ? "" : r.id;
      return [{ op: r.op, id, card: cardsOf(activity)[0], text, conversation: r.conversation }];
    });
  }

  /** What the user was left reading, one entry per message sent or edited, without the in-place edits of the status card. */
  said(): string[] {
    return this.activities().flatMap(({ op, activity }) => {
      if (op === "update" && isStatusCard(activity)) return [];
      const text = textOf(activity);
      return text ? [text] : [];
    });
  }

  last(): string {
    return this.said().at(-1) ?? "";
  }

  /** The cards of some recorded operations, as Teams is sent them. */
  renderedCards(records: readonly Recorded[]): Json[] {
    return records.flatMap((r) =>
      "message" in r
        ? cardsOf(activityOf(r.message, { style: DEFAULT_STYLE, renderers: RENDERERS, masker: undefined }) as Json)
        : [],
    );
  }

  /** Every Adaptive Card sent or edited in, as its content, in order. */
  cards(): Json[] {
    return this.activities().flatMap(({ activity }) => cardsOf(activity));
  }

  /** The status cards sent as messages of their own. */
  statusCards(): Json[] {
    return this.activities().flatMap(({ op, activity }) =>
      op !== "update" && isStatusCard(activity) ? cardsOf(activity) : [],
    );
  }

  /** Every in-place edit of a status card: the message it edits, and the card's words. */
  statusEdits(): [string, string][] {
    return this.activities().flatMap(({ op, id, activity }): [string, string][] =>
      op === "update" && isStatusCard(activity) ? [[id, [...wordsOf(cardsOf(activity)[0]?.["body"])].join(" ")]] : [],
    );
  }

  permissionCards(): Json[] {
    return this.cards().filter((c) =>
      ((c["actions"] ?? []) as Json[]).some((a) => a["verb"] === "primusclaw.remote_decision"),
    );
  }

  /** The texts of the live "Working on it" message and its edits. */
  progressTexts(): string[] {
    return this.activities().flatMap(({ activity }) => {
      const text = activity["text"];
      return typeof text === "string" && text.startsWith("Working on it") ? [text] : [];
    });
  }

  /** The last text edit or message that is not live progress. */
  answer(): string {
    const texts = this.activities().flatMap(({ activity }) => {
      const text = activity["text"];
      return typeof text === "string" && text && !text.startsWith("Working on it") ? [text] : [];
    });
    return texts.at(-1) ?? "";
  }

  async close(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.remote.shutdown();
    this.remote.cancelAll();
    // A cancelled turn hands its chat back to a reader as it ends (Python's loop dies with the test; here the reader would not):
    // once the turns are gone, the readers they started go too.
    for (let i = 0; i < 40 && this.remote.busyChats().length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.remote.shutdown();
    await this.server.stop();
  }
}

/** The per-person limits as the remote agents use them. */
function guardOf(guard: Guardrails): RemoteGuard {
  return {
    take: (person, operation, ticket, ids) => guard.take(person, operation, ticket, ids ?? {}),
    giveBack: (person, operation, ticket) => {
      guard.giveBack(person, operation, ticket ?? undefined);
    },
  };
}

function refOf(reference: JsonObject): ConversationRef {
  const conversation = (reference["conversation"] ?? {}) as Json;
  const id = typeof conversation["id"] === "string" ? conversation["id"] : "conv";
  return { id, kind: "personal", tenantId: "", wire: reference };
}

function noteOf(text: string): OutMessage {
  return { body: { type: "view", view: { name: "note", model: { text } }, fallbackText: text } };
}

function cardsOf(activity: Json): Json[] {
  return ((activity["attachments"] ?? []) as Json[]).map((a) => a["content"] as Json);
}

function textOf(activity: Json): string {
  const words = [typeof activity["text"] === "string" ? activity["text"] : ""];
  for (const card of cardsOf(activity)) words.push(...wordsOf(card["body"]));
  return words.filter(Boolean).join(" ");
}

const STAMP = /^(?:Updated|更新于) \d\d:\d\d:\d\dZ$/u;

/** The activity is the chat's status card (it says when it was last true). */
export function isStatusCard(activity: Json): boolean {
  return cardsOf(activity).some((card) => [...wordsOf(card["body"])].some((w) => STAMP.test(w)));
}

/** A world for one test: its server started, its user linked. */
export async function remoteWorld<T>(test: (w: RemoteWorld) => Promise<T>, options: WorldOptions = {}): Promise<T> {
  const server = new FakeRemote();
  await server.start();
  const world = new RemoteWorld(server, options);
  try {
    return await test(world);
  } finally {
    await world.close();
  }
}

/**
 * What the connector does for each command, as a test says it: `onPrompt` and `onDecision` are the test's; the rest is the plain
 * behaviour of a connector (a session starts and says its modes, a cancel ends the turn as cancelled, a mode change is confirmed).
 */
export class Script {
  onPrompt: ((srv: FakeRemote, sid: string, cmd: FakeCommand) => Promise<void>) | null = null;
  onDecision: ((srv: FakeRemote, sid: string, cmd: FakeCommand) => Promise<void>) | null = null;

  constructor(
    readonly options: {
      readonly started?: boolean;
      readonly cancelEnds?: boolean;
      readonly flags?: Readonly<Record<string, boolean>> | null;
      readonly unattended?: boolean | null;
      readonly mode?: string;
      readonly modes?: readonly string[];
    } = {},
  ) {}

  /** The hook the fake server runs for every command. */
  readonly hook = async (srv: FakeRemote, cmd: FakeCommand): Promise<void> => {
    await this.handle(srv, cmd);
  };

  protected async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    const sid = cmd.session_id;
    if (cmd.type === "session.new") await this.start(srv, sid);
    else if (cmd.type === "prompt") await this.onPrompt?.(srv, sid, cmd);
    else if (cmd.type === "decision") await this.onDecision?.(srv, sid, cmd);
    else if (cmd.type === "cancel" && (this.options.cancelEnds ?? true)) await srv.end(sid, "cancelled");
    else if (cmd.type === "set_mode") await this.modeSet(srv, sid, String(cmd.body["mode_id"]));
  }

  private async start(srv: FakeRemote, sid: string): Promise<void> {
    const o = this.options;
    if (!(o.started ?? true)) return;
    const modes = o.modes ?? ["default", "plan", "acceptEdits"];
    await srv.started(sid, {
      mode: o.mode ?? "default",
      modes,
      unattended: o.unattended ?? null,
      flags: o.flags ?? null,
    });
  }

  private async modeSet(srv: FakeRemote, sid: string, mode: string): Promise<void> {
    const flag = this.options.flags?.[mode];
    await srv.emit(sid, "mode_update", { currentModeId: mode, ...(flag === undefined ? {} : { unattended: flag }) });
  }
}
