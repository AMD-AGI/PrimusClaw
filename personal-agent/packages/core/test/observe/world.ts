// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A world for observation tests: the real SQLite store, a fake of Claw's assistant routes observation uses (the
 * observer of a scope, its record, the person's assistant session and its messages), the recording surface, and the
 * routes the router hands over. Mirrors the Python tests' `assistant_world` for what observation reads and writes.
 */
import {
  ClawError,
  Observer,
  pyStr,
  type ClickRoute,
  type ConversationRef,
  type InboundMessage,
  type JsonObject,
  type MessageRoute,
  type OutMessage,
  type SettleOptions,
  type UserRef,
} from "@primusclaw/personal-agent";

import { FakeSurface, openTestStore } from "../../../../test-support/index.js";
import { RecordingLogger } from "../feedback/world.js";
import { BOT_NAME } from "../../src/branding.js";

export const CONV = "19:observed@thread.v2";
export const SCOPE = `group:teams:${CONV}`;
export const USER_A: UserRef = { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" };
export const USER_B: UserRef = { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "" };
export const USER_C: UserRef = { id: "aad-c", channelUserId: "29:c", name: "Carol", email: "" };

/** Claw's assistant routes, as observation calls them. */
export class FakeAssistant {
  readonly scopes = new Map<string, string>();
  readonly observed: { owner: string; scope: string; content: string; messageId: string }[] = [];
  readonly records = new Map<string, JsonObject[]>();
  readonly heard: string[] = [];
  readonly sends: { key: string; sessionId: string; text: string; plugin: number | undefined }[] = [];
  readonly calls: string[] = [];
  observeOn = true;
  /** The next `send` fails with this status. */
  sendFailure: number | undefined;

  observeScope(key: string, scope: string): Promise<JsonObject> {
    this.calls.push(`observeScope ${key}`);
    if (!this.observeOn) return Promise.reject(new ClawError(404));
    this.scopes.set(`${key} ${scope}`, "observe");
    return Promise.resolve({ ok: true });
  }

  observe(key: string, scope: string, content: string, messageId: string): Promise<JsonObject> {
    this.calls.push(`observe ${key}`);
    this.observed.push({ owner: key, scope, content, messageId });
    return Promise.resolve({ ok: true });
  }

  observations(key: string, scope: string): Promise<JsonObject[]> {
    this.calls.push(`observations ${key}`);
    return Promise.resolve(this.records.get(`${key} ${scope}`) ?? []);
  }

  session(key: string): Promise<{ sessionId: string; created: boolean }> {
    this.calls.push(`session ${key}`);
    return Promise.resolve({ sessionId: `assistant-${key}`, created: false });
  }

  send(key: string, sessionId: string, text: string, options: { plugin?: number } = {}): Promise<string | null> {
    this.calls.push(`send ${key}`);
    if (this.sendFailure !== undefined) return Promise.reject(new ClawError(this.sendFailure));
    this.heard.push(text);
    this.sends.push({ key, sessionId, text, plugin: options.plugin });
    return Promise.resolve("m-1");
  }
}

export interface ObserveWorldOptions {
  readonly users?: readonly string[];
}

export type ObserveWorld = ReturnType<typeof observeWorld>;

export function observeWorld(options: ObserveWorldOptions = {}) {
  const { store } = openTestStore();
  const assistant = new FakeAssistant();
  const surface = new FakeSurface();
  const log = new RecordingLogger();
  const failingGroups = new Set<string>();
  const observer = new Observer({
    observe: store.observe,
    links: store.links,
    assistant,
    users: options.users ?? [],
    conversationOf: (wire) => {
      const id = pyStr((wire["conversation"] as JsonObject | undefined)?.["id"]);
      if (failingGroups.has(id)) throw new Error("the outbound queue did not take it");
      return surface.conversation({ id, kind: "group", tenantId: "t", wire });
    },
    pluginId: 2,
    log,
    botName: BOT_NAME,
  });
  const settled: { card: OutMessage | string; options: SettleOptions }[] = [];
  return { store, assistant, surface, log, observer, settled, failingGroups };
}

export function link(world: ObserveWorld, user: UserRef, key: string): void {
  world.store.links.redeemPending(user.id, user.name, world.store.links.stashPending(key));
}

function groupRef(): ConversationRef {
  return {
    id: CONV,
    kind: "group",
    tenantId: "t",
    wire: { conversation: { id: CONV, conversationType: "groupChat" } },
  };
}

let seq = 0;

export function groupMessage(text: string, user: UserRef, id?: string): InboundMessage {
  seq += 1;
  return {
    type: "message",
    id: id ?? `g${String(seq)}`,
    sender: user,
    conversation: groupRef(),
    locale: "",
    clientPlatform: "",
    text,
    mentioned: true,
    targeted: false,
    namesBotFirst: false,
    conversationName: "Infra on-call",
    unreadableFiles: [],
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    provenance: "typed",
  };
}

/** `text` said to the bot in the group: true when observation took it (it was the command). */
export function inGroup(world: ObserveWorld, text: string, user: UserRef): Promise<boolean> {
  const message = groupMessage(text, user);
  const route: MessageRoute = {
    sender: user,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "en",
    message,
    text,
  };
  return world.observer.interceptor.intercept(route);
}

/** A message in the group that is not to the bot. */
export function overheard(world: ObserveWorld, text: string, user: UserRef, id?: string): Promise<void> {
  return world.observer.forward(groupMessage(text, user, id));
}

/** What was posted in the group, as text. */
export function groupTexts(world: ObserveWorld): string[] {
  return world.surface.outbox.flatMap((r) =>
    r.op === "send" && r.conversation === CONV && r.message.body.type === "text" ? [r.message.body.text] : [],
  );
}

/** What was said in Alice's 1:1 chat, as text. */
export function personalTexts(world: ObserveWorld): string[] {
  return world.surface.outbox.flatMap((r) =>
    r.op === "send" && r.conversation === "conv-aad-a" && r.message.body.type === "text" ? [r.message.body.text] : [],
  );
}

export function personal(world: ObserveWorld) {
  return world.surface.conversation({ id: "conv-aad-a", kind: "personal", tenantId: "t", wire: {} });
}

/** The suggestion cards sent to Alice. */
export function suggestions(world: ObserveWorld): { cardId: string; kind: string; what: string; message: string }[] {
  return world.surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "observeSuggestion"
      ? [r.message.body.view.model]
      : [],
  );
}

export function record(world: ObserveWorld, ...turns: [string, JsonObject[]][]): void {
  world.assistant.records.set(
    `ak-alice ${SCOPE}`,
    turns.map(([message, would], i) => ({
      run_id: `run-${String(i)}`,
      at: "2026-11-07T04:00:00Z",
      status: "completed",
      message,
      would,
    })),
  );
}

/** Alice presses `op` under the suggestion card `cardId`. */
export async function press(world: ObserveWorld, cardId: string, op: string, user: UserRef = USER_A): Promise<void> {
  const ref: ConversationRef = { id: `conv-${user.id}`, kind: "personal", tenantId: "t", wire: {} };
  const click: ClickRoute = {
    sender: user,
    conversation: world.surface.conversation(ref),
    scope: "",
    lang: () => "en",
    action: {
      type: "action",
      id: `click-${cardId}-${op}`,
      sender: user,
      conversation: ref,
      locale: "",
      clientPlatform: "",
      verb: `primusclaw.observe_${op}`,
      data: { primusclaw: "observe", card: cardId, op },
      cardMessageId: "card-1",
      invoke: true,
      clickVerb: `primusclaw.observe_${op}`,
    },
    settle: (card, options = {}) => {
      world.settled.push({ card, options });
      return Promise.resolve(true);
    },
  };
  await world.observer.clicks.withCredential?.(click, world.store.links.getKey(user.id) ?? "");
}

export function board(world: ObserveWorld, user: UserRef = USER_A): Promise<void> {
  return world.observer.board(user.id, world.store.links.getKey(user.id) ?? "", personal(world));
}
