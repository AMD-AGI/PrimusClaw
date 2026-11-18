// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What the session-window tests share (teams/tests/test_session_window.py): a chat attached in `card` mode, its session cards, and
// a Send from a card.
import assert from "node:assert/strict";

import { INPUT_ID } from "../../../src/remote/window/view.js";
import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, type Operation, type RemoteWorld, Script, USER_A } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";

export type Json = Record<string, unknown>;

/** Alice starts a Codex session on dev-pod; its session id. */
export async function windowed(w: RemoteWorld, script = new Script()): Promise<string> {
  w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
  w.server.onCommand = script.hook;
  await w.say("/agent new codex /home/me/repo");
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  assert.equal(state.window, w.settings.windowDefault, w.said().join("\n"));
  return state.sessionId ?? "";
}

const isWindowCard = (o: Operation): boolean =>
  (o.op === "send" || o.op === "post" || o.op === "update") && JSON.stringify(o.card ?? null).includes("window_tail");

/** Every session card sent or edited: its operation and content (from `since`, an index into the operations). */
export function windowCards(w: RemoteWorld, since = 0): { op: string; id: string; card: Json }[] {
  return w
    .operations()
    .slice(since)
    .filter(isWindowCard)
    .map((o) => ({ op: o.op, id: o.id, card: o.card ?? {} }));
}

/** The last session card sent or edited. */
export function lastWindow(w: RemoteWorld): Json {
  const card = windowCards(w).at(-1)?.card;
  assert.ok(card, "no session card");
  return card;
}

/** Every text of a card, wherever it is. */
export function cardWords(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) for (const v of n) walk(v);
    else if (typeof n === "object" && n !== null) {
      const o = n as Json;
      if (o["type"] === "TextBlock") out.push(typeof o["text"] === "string" ? o["text"] : "");
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(node);
  return out.join(" ");
}

/** The card carries the text box the session reads. */
export const hasBox = (card: unknown): boolean => JSON.stringify(card ?? null).includes(`"id":"${INPUT_ID}"`);

export const prompts = (w: RemoteWorld): unknown[] => w.server.commandsOf("prompt").map((c) => c.body["text"]);

export const statusCardId = (w: RemoteWorld): string => w.test.store.remoteState.getRemote(AAD)?.statusCard ?? "";

/** A Send from the session card (`cardId`: the chat's status card when not given). */
export async function sendFromCard(w: RemoteWorld, sid: string, text: string, cardId?: string): Promise<void> {
  await w.click(
    { primusclaw: "remote", op: "send", session_id: sid, [INPUT_ID]: text },
    USER_A,
    cardId ?? statusCardId(w),
  );
}

/** The operations on one message (from `since`). */
export const opsOn = (w: RemoteWorld, id: string, since = 0): string[] =>
  w
    .operations()
    .slice(since)
    .filter((o) => o.id === id)
    .map((o) => o.op);

/** An agent that answers `text` and ends its turn. */
export const answering = (text = "Done.") => {
  const script = new Script();
  script.onPrompt = async (srv: FakeRemote, sid: string) => {
    await srv.say(sid, text);
    await srv.end(sid);
  };
  return script;
};

/** The approval buttons inside a card's containers. */
export function approvalButtons(card: Json): Json[] {
  return ((card["body"] ?? []) as Json[])
    .filter((s) => s["type"] === "Container")
    .flatMap((s) => (s["items"] ?? []) as Json[])
    .filter((i) => i["type"] === "ActionSet")
    .flatMap((i) => i["actions"] as Json[]);
}
