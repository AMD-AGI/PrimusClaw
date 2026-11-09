// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What the remote menu tests share (teams/tests/test_remote_menu.py's helpers): reading a card the way a client does, and
// pressing its buttons the way Teams sends a press.
import assert from "node:assert/strict";

import { assertValidCard, buttonsOf, elements } from "../../../../../test-support/adaptive-card.js";
import { ALICE, type RemoteWorld, Script, USER_A } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";

export type Json = Record<string, unknown>;

export const ROOTS = ["/home/me/work", "/data/exp"];
export const CAPS: Record<string, Json> = {
  codex: { roots: ROOTS, modes: ["read-only"], ask_mode: "read-only" },
  claude: { roots: ["/home/me/work"], modes: ["default", "plan", "acceptEdits"], ask_mode: "default" },
};
export const ASKING_BY_DEFAULT: Record<string, Json> = {
  claude: {
    roots: ["/home/me/work"],
    modes: ["default", "plan"],
    ask_mode: "default",
    unattended: false,
    unattended_allowed: true,
  },
};
export const UNATTENDED_BY_DEFAULT: Record<string, Json> = {
  claude: {
    roots: ["/home/me/work"],
    modes: ["default", "plan", "bypassPermissions"],
    ask_mode: "bypassPermissions",
    unattended: true,
    unattended_allowed: true,
  },
};
export const ASKING_FIXED: Record<string, Json> = {
  claude: {
    roots: ["/home/me/work"],
    modes: ["default", "plan"],
    ask_mode: "default",
    unattended: false,
    unattended_allowed: false,
  },
};
export const UNATTENDED_FIXED: Record<string, Json> = {
  claude: {
    roots: ["/home/me/work"],
    modes: ["bypassPermissions"],
    ask_mode: "bypassPermissions",
    unattended: true,
    unattended_allowed: false,
  },
};

export const buttonsIn = (card: Json): Json[] => buttonsOf(card);

export function inputsIn(card: Json): Record<string, Json> {
  return Object.fromEntries(
    [...elements(card["body"])].filter((i) => String(i["type"]).startsWith("Input.")).map((i) => [String(i["id"]), i]),
  );
}

export const textsIn = (card: Json): string[] =>
  [...elements(card["body"])].filter((i) => i["type"] === "TextBlock").map((i) => String(i["text"]));

export const titles = (card: Json): string[] => buttonsIn(card).map((b) => String(b["title"]));

export const dataOf = (button: Json | undefined): Json => (button?.["data"] ?? {}) as Json;

/**
 * The data of a press of the `nth` button called `title`: its own data, over the value every input of the card holds (what Teams
 * sends: the untouched ones as they were shown), over what the user typed or chose.
 */
export function tap(card: Json, title: string, nth = 0, typed: Json = {}): Json {
  const button = buttonsIn(card).filter((b) => b["title"] === title)[nth];
  assert.ok(button, `no button ${title} (${String(nth)}) among ${titles(card).join(", ")}`);
  const shown = Object.fromEntries(Object.entries(inputsIn(card)).map(([id, el]) => [id, el["value"] ?? ""]));
  return { ...shown, ...dataOf(button), ...typed };
}

/**
 * What replaced the tapped card, in order: each edit of it, and for a list the worker re-posts (a new message, then the tapped one
 * deleted, because a phone does not redraw an edit) the card it sent.
 */
export function edits(w: RemoteWorld, cardId = "card-1"): Json[] {
  const out: Json[] = [];
  let card: Json | undefined;
  for (const o of w.operations()) {
    if ((o.op === "send" || o.op === "post") && o.card) card = o.card;
    else if (o.id === cardId && o.op === "update" && o.card) out.push(o.card);
    else if (o.id === cardId && o.op === "delete" && card) out.push(card);
  }
  return out;
}

/** The chat's status card as it is now: the last content sent or edited of the message the worker keeps as its status card. */
export function shown(w: RemoteWorld, aad = AAD): Json {
  const cardId = w.test.store.remoteState.getRemote(aad)?.statusCard ?? "";
  const found = w.operations().filter((o) => (o.op === "post" || o.op === "update") && o.id === cardId && o.card);
  const card = found.at(-1)?.card;
  assert.ok(card, `no status card ${cardId}`);
  assertValidCard(card);
  return card;
}

/** The card the last tap left on screen. */
export function replaced(w: RemoteWorld): Json {
  const card = edits(w).at(-1);
  assert.ok(card, "nothing replaced the tapped card");
  assertValidCard(card);
  return card;
}

export async function agentsCard(w: RemoteWorld): Promise<Json> {
  await w.say("/agents");
  const card = w.cards().at(-1);
  assert.ok(card);
  assertValidCard(card);
  return card;
}

/** A press of a button of `card`; `settle: false` when a test has put a turn in the worker's books that never ends. */
export async function press(
  w: RemoteWorld,
  card: Json,
  title: string,
  options: { nth?: number; user?: typeof USER_A; settle?: boolean; typed?: Json } = {},
): Promise<Json> {
  await w.click(tap(card, title, options.nth ?? 0, options.typed ?? {}), options.user ?? USER_A);
  if (options.settle !== false) await w.idle();
  return replaced(w);
}

/** A press of a button the card never had (a stale or forged one). */
export async function pressData(
  w: RemoteWorld,
  data: Json,
  options: { user?: typeof USER_A; settle?: boolean } = {},
): Promise<Json> {
  await w.click({ primusclaw: "remote", ...data }, options.user ?? USER_A);
  if (options.settle !== false) await w.idle();
  return replaced(w);
}

/** The commands' bodies that started a session. */
export const starts = (w: RemoteWorld): Json[] => w.server.commandsOf("session.new").map((c) => c.body);

/** A world whose user has started a session on dev-pod by typing, and has been told it is ready. */
export async function attachedWith(
  w: RemoteWorld,
  options: { agent?: string; cwd?: string; script?: Script; caps?: Record<string, Json>; online?: boolean } = {},
): Promise<{ cid: string; sid: string }> {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, {
    online: options.online ?? true,
    ...(options.caps ? { caps: options.caps } : {}),
  });
  w.server.onCommand = (options.script ?? new Script()).hook;
  await w.say(`/agent new ${options.agent ?? "codex"} ${options.cwd ?? "/home/me/repo"}`);
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  return { cid, sid: state.sessionId ?? "" };
}

export const STATUS_TITLES = ["Switch", "Back to assistant", "Stop", "Mode"];
export const MODES = ["default", "plan", "bypassPermissions"];
export const FLAGS: Readonly<Record<string, boolean>> = { default: false, plan: false, bypassPermissions: true };
