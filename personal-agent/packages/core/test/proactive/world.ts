// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A delivery world for the proactive tests: a real store, a recording surface, and the services wired as the worker wires them. */
import { FakeClock } from "../../../../test-support/clock.js";
import { openTestStore } from "../../../../test-support/store.js";
import type { SqliteStore } from "@primusclaw/personal-agent-runtime";
import { FakeSurface, type Recorded } from "../../../../test-support/surface.js";
import { Receipts } from "../../src/assistant/receipts.js";
import { SayPlanner } from "../../src/assistant/say.js";
import { DirectChat } from "../../src/direct-chat/direct-chat.js";
import type { JsonObject } from "../../src/json.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { ConversationRef, OutMessage } from "../../src/ports/surface.js";
import type { ProactiveDeps, RunFollowUps } from "../../src/proactive/deps.js";
import { Proactive } from "../../src/proactive/proactive.js";
import { Release } from "../../src/proactive/release.js";
import { SaidMessages } from "../../src/proactive/said-memory.js";

export const ALICE = "aad-a";
export const PUBLIC = "https://claw.example.com";

/** Epoch seconds of 2026-10-<day> HH:MM in Shanghai (UTC+8). */
export function at(hour: number, minute = 0, day = 27): number {
  return Date.UTC(2026, 9, day, hour - 8, minute) / 1000;
}

export function event(kind = "run.completed", eventId = "ev-1", extra: JsonObject = {}): JsonObject {
  return {
    event_id: eventId,
    type: kind,
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: "u-alice",
    session_id: "s1",
    title: "Run completed: sweep",
    summary: "",
    link: "/primus-claw/sessions/s1",
    ...extra,
  };
}

export function world(
  options: Partial<ProactiveDeps> & {
    now?: number;
    messageIds?: boolean;
    direct?: DirectChat;
    on?: { store: SqliteStore; clock: FakeClock };
  } = {},
) {
  const clock = options.on?.clock ?? new FakeClock((options.now ?? at(12)) * 1000);
  const store = options.on?.store ?? openTestStore({ clock }).store;
  const surface = new FakeSurface();
  const reference: JsonObject = {
    serviceUrl: "https://smba.test/",
    conversation: { id: `c-${ALICE}` },
    bot: { id: "28:bot" },
  };
  store.references.saveReference(ALICE, reference);
  store.prefs.setQuiet(ALICE, null);
  const conversationFor = (wire: JsonObject) => {
    const conversation = wire["conversation"] as JsonObject;
    const id = conversation["id"];
    const ref: ConversationRef = { id: typeof id === "string" ? id : "", kind: "personal", tenantId: "", wire };
    return surface.conversation(ref);
  };
  const runs: RunFollowUps & { answers: Map<string, readonly string[]>; changes: string[] } = {
    answers: new Map(),
    changes: [],
    lostAnswer: (_key, sessionId, lead) => {
      const answer = runs.answers.get(sessionId);
      return Promise.resolve(answer ? [`${lead}\n\n${answer.join("\n\n")}`] : undefined);
    },
    offerChanges: (_key, sessionId) => {
      runs.changes.push(sessionId);
      return Promise.resolve();
    },
  };
  const receipts = new Receipts(clock, silentLogger);
  const deps: ProactiveDeps = {
    store,
    conversationFor,
    deliverStored: (envelope) => {
      const id = envelope["conversation"];
      return surface
        .conversation({ id: typeof id === "string" ? id : "", kind: "personal", tenantId: "", wire: {} })
        .deliver(envelope);
    },
    messageIds: options.messageIds ?? true,
    say: new SayPlanner({
      store,
      exactCommand: () => false,
      style: () => ({ citations: true, suggestedReplies: true }),
    }),
    receipts,
    directChat: options.direct ?? new DirectChat(false),
    said: new SaidMessages(),
    deliveryLink: undefined,
    claw: undefined,
    remote: {
      options: (raw): readonly unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []),
      askCard: (request) => ({
        body: { type: "text", text: `ask ${request.sessionId} ${String(request.ask["action_id"])}` },
      }),
      saidParts: (label, text) => [`${label}: ${text}`],
    },
    runs,
    publicBaseUrl: PUBLIC,
    replyWindowSeconds: 30 * 60,
    clock,
    logger: silentLogger,
    publicEvent: (e) => e,
    botName: "Clawy",
    ...withoutWorld(options),
  };
  const proactive = new Proactive(deps);
  return { clock, store, surface, proactive, release: new Release(deps, proactive), runs, receipts, reference, deps };
}

export function shown(outbox: readonly Recorded[]): string[] {
  return outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "post" && r.op !== "update" && r.op !== "stream.finish") return [];
    return [describe(r.op, r.message)];
  });
}

function describe(op: string, message: OutMessage): string {
  const body = message.body;
  const what = body.type === "view" ? `view:${body.view.name}` : body.type === "rich" ? body.markdown : body.text;
  return `${op} ${what}`;
}

function withoutWorld<T extends { now?: number; on?: unknown; direct?: unknown }>(
  options: T,
): Omit<T, "now" | "on" | "direct"> {
  const rest: Partial<T> = { ...options };
  delete rest.now;
  delete rest.on;
  delete rest.direct;
  return rest as Omit<T, "now" | "on" | "direct">;
}

/** Link the person with a key (so what needs their key can be read). */
export function link(store: SqliteStore, key = "ak-alice-0123456789abcdef"): void {
  store.links.redeemPending(ALICE, "Alice", store.links.stashPending(key));
}
