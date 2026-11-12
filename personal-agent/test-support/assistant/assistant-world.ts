// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Python tests' `assistant_world`, in process: a real store, the in-memory assistant Claw and its notification subscriptions,
 * the subscription keeper, and the assistant's chat, wired as the router would drive them. `say` does what the router does with a
 * 1:1 message before it is routed (the Claw user id filled in, the subscription made or mended) and records the texts that were
 * not taken by the assistant (`started`: they would start a session's turn, as before).
 */
import type { JsonObject } from "@primusclaw/personal-agent";
import { own } from "@primusclaw/personal-agent";

import { AssistantChat } from "../../packages/core/src/assistant/chat.js";
import type { MessageFiles } from "../../packages/core/src/assistant/files.js";
import { Receipts } from "../../packages/core/src/assistant/receipts.js";
import { DirectChat } from "../../packages/core/src/direct-chat/direct-chat.js";
import { silentLogger } from "../../packages/core/src/ports/logger.js";
import type { Conversation, InboundFile, SurfaceCaps } from "../../packages/core/src/ports/surface.js";
import { Subscriptions } from "../../packages/core/src/subscriptions/subscriptions.js";
import { FakeClawSubscriptions } from "./subscription-fakes.js";
import { FakeClock } from "../clock.js";
import { SeededRandom } from "../random.js";
import { advanceSeconds, openTestStore } from "../store.js";
import { FakeSurface, type Recorded } from "../surface.js";
import { FakeAssistantClaw } from "./claw.js";
import { LiveFeed } from "./live-feed.js";

export const ALICE = "aad-a";
export const BOB = "aad-b";
export const CAROL = "aad-c";
export const DAVE = "aad-d";
export const BASE = "http://agent.example.svc/claw-events";
/** Each person's linked key and the Claw user id that key is of. */
export const KEYS: Readonly<Record<string, string>> = {
  [ALICE]: "ak-alice",
  [BOB]: "ak-bob",
  [CAROL]: "ak-carol",
  [DAVE]: "ak-dave",
};
export const CLAW_IDS = new Map([
  ["ak-alice", "u-alice"],
  ["ak-bob", "u-bob"],
  ["ak-carol", "u-carol"],
  ["ak-dave", "u-dave"],
]);
/** The event types a Claw from before the assistant knows (it knows no work items' source either). */
const OLD_TYPES = ["run.completed", "run.failed", "approval.requested"];

export interface AssistantWorldOptions {
  /** ASSISTANT_ENABLED (default on). */
  readonly assistant?: boolean;
  /** ASSISTANT_USERS, lower case (empty: everybody). */
  readonly users?: readonly string[];
  /** TEAMS_ASSISTANT_UNDERSTANDING_USERS, lower case. */
  readonly understanding?: readonly string[];
  readonly pluginId?: number;
  /** Alice is linked (with her Claw user id) before the test starts (default yes). */
  readonly link?: boolean;
  /** Claw does not know the assistant's event types yet. */
  readonly oldClaw?: boolean;
  /** Claw knows the work items' approval source (default yes). */
  readonly itemApprovals?: boolean;
  /** PROACTIVE_ENABLED: no subscriptions at all when false (default true). */
  readonly notifications?: boolean;
  readonly files?: MessageFiles;
  readonly progress?: boolean;
  readonly streamSay?: boolean;
  /** What the channel is and can do (default: `FakeSurface`'s). */
  readonly caps?: Partial<SurfaceCaps>;
}

/** The step labels of an assistant's lookups the Python tests read (step_labels.lookup_label, zh). */
export function stepLabel(tool: string): string {
  const labels: Record<string, string> = {
    mcp__safe__node_list: "查询 SaFE 节点",
    mcp__safe__workload_list: "查询 SaFE 工作负载",
    mcp__assistant__work_create: "创建任务",
  };
  return own(labels, tool) ?? tool;
}

export class AssistantWorld {
  readonly clock = new FakeClock(1_800_000_000_000);
  readonly store = openTestStore({ clock: this.clock }).store;
  readonly claw = new FakeAssistantClaw();
  readonly subsClaw = new FakeClawSubscriptions();
  readonly feed = new LiveFeed();
  readonly surface: FakeSurface;
  readonly receipts = new Receipts(this.clock, silentLogger);
  /** The texts the assistant did not take, in order. */
  readonly started: string[] = [];
  /** The Claw user id each key is of, as SaFE answers it (undefined: it cannot say). */
  readonly clawIds = new Map(CLAW_IDS);
  readonly legacy = new Set<string>();
  /** (path, how many) of each message's files that did not reach Claw. */
  readonly dropped: [string, number][] = [];
  /** Every file put in a session, with its bytes. */
  readonly uploaded: { sessionId: string; folder: string; name: string; bytes: Uint8Array }[] = [];
  subs: Subscriptions | undefined;
  chat!: AssistantChat;
  private assistant: boolean;
  /** One source of route tokens across rebuilds (a fresh seed would give the same route again). */
  private readonly routes = new SeededRandom(11);
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly options: AssistantWorldOptions = {}) {
    this.surface = new FakeSurface(options.caps ? { caps: options.caps } : {});
    this.assistant = options.assistant ?? true;
    if (options.oldClaw) this.subsClaw.knownTypes = new Set(OLD_TYPES);
    if (options.oldClaw || options.itemApprovals === false) this.subsClaw.knownSources.delete("assistant_item");
    this.build();
  }

  static async start(options: AssistantWorldOptions = {}): Promise<AssistantWorld> {
    const w = new AssistantWorld(options);
    if (options.link ?? true) await w.link(ALICE);
    return w;
  }

  /** The switch is turned on (or off) after the worker started: the keeper and the chat are built again with it. */
  turn(on: boolean): void {
    this.assistant = on;
    this.build();
  }

  private build(): void {
    const users = new Set(this.options.users ?? []);
    const forUser = (aadId: string) => users.size === 0 || users.has(aadId.toLowerCase());
    const understanding = new Set(this.options.understanding ?? []);
    const subs =
      this.options.notifications === false
        ? undefined
        : new Subscriptions({
            store: this.store,
            claw: this.subsClaw,
            random: this.routes,
            logger: silentLogger,
            baseUrl: BASE,
            assistant: this.assistant,
            understood: (aadId) => understanding.has(aadId.toLowerCase()) && forUser(aadId),
            assistantFor: forUser,
            userIdOf: (key) => Promise.resolve(this.clawIds.get(key)),
          });
    this.subs = subs;
    this.chat = new AssistantChat({
      store: this.store,
      claw: {
        assistant: this.claw.assistant,
        sessions: {
          ...this.claw.sessions,
          stream: this.feed.stream,
          uploadFiles: (key, sessionId, folder, files) => {
            for (const f of files) this.uploaded.push({ sessionId, folder, name: f.name, bytes: f.content });
            return this.claw.sessions.uploadFiles(key, sessionId, folder, files);
          },
        },
      },
      hasAssistantTypes: subs ? (aadId) => subs.hasAssistantTypes(aadId) : undefined,
      receipts: this.receipts,
      directChat: new DirectChat(false),
      clock: this.clock,
      random: new SeededRandom(3),
      logger: silentLogger,
      stepLabel,
      style: () => ({
        assistantProgress: this.options.progress ?? true,
        assistantStreamSay: this.options.streamSay ?? true,
      }),
      enabled: this.assistant,
      users,
      understanding,
      pluginId: this.options.pluginId,
      legacyTurn: (aadId) => this.legacy.has(aadId),
      files: this.options.files,
      onFilesDropped: (path, count) => this.dropped.push([path, count]),
      board: { show: () => Promise.resolve() },
      commands: {
        parse: (t) => /^\/(\w+)/.exec(t)?.[1],
        args: (t, name) => (new RegExp(`^/${name}(\\s|$)`).test(t) ? t.slice(name.length + 1).trim() : undefined),
      },
    });
  }

  /** The person's 1:1 chat (each message in it answers activity `act-1`). */
  conversation(aadId = ALICE): Conversation {
    let found = this.conversations.get(aadId);
    if (found === undefined) {
      const id = `c-${aadId}`;
      found = this.surface.conversation({
        id,
        kind: "personal",
        tenantId: "tenant-1",
        wire: { conversation: { id }, activityId: "act-1" },
      });
      this.conversations.set(aadId, found);
    }
    return found;
  }

  reference(aadId = ALICE): JsonObject {
    return { serviceUrl: "https://smba.test/", conversation: { id: `c-${aadId}` }, bot: { id: "28:bot" } };
  }

  /** `/link` with the person's key: their Claw user id is recorded when SaFE says it, and their subscription is made. */
  async link(aadId: string): Promise<void> {
    const key = own(KEYS, aadId) ?? `ak-${aadId}`;
    this.store.links.redeemPending(aadId, aadId, this.store.links.stashPending(key));
    const id = this.clawIds.get(key);
    if (id !== undefined) this.store.links.setClawUserId(aadId, id);
    this.store.references.saveReference(aadId, this.reference(aadId));
    await this.subs?.ensure(aadId);
  }

  /** A 1:1 message that is not a command, as the router handles it. True when the assistant took it. */
  async say(text: string, aadId = ALICE, files: readonly InboundFile[] = []): Promise<boolean> {
    const key = this.store.links.getKey(aadId);
    if (this.subs && key !== null) {
      await this.subs.fillUserId(aadId);
      await this.subs.ensure(aadId);
    }
    const taken = await this.chat.route({
      userId: aadId,
      credential: key ?? "",
      prompt: text,
      conversation: this.conversation(aadId),
      files,
    });
    if (!taken) this.started.push(text);
    return taken;
  }

  /** What the assistant heard, in order. */
  heard(): string[] {
    return this.claw.heard.map((h) => h.text);
  }

  /** The texts said in the chats (messages, and a stream's final as text). */
  texts(): string[] {
    return this.surface.outbox.flatMap((r: Recorded) => {
      if ((r.op === "send" || r.op === "post" || r.op === "stream.finish") && r.message.body.type === "text")
        return [r.message.body.text];
      if ((r.op === "send" || r.op === "post" || r.op === "stream.finish") && r.message.body.type === "rich")
        return [r.message.body.markdown];
      return [];
    });
  }

  /** Calls of one kind to Claw's subscriptions ("create", "list", "patch", "delete"). */
  subCalls(kind: string): number {
    return this.subsClaw.calls.filter((c) => c.startsWith(`${kind} `)).length;
  }

  advance(seconds: number): void {
    advanceSeconds(this.clock, seconds);
  }
}
