// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router in front of the real remote agents (Python `remote_world`, where `w.say` goes through `Agent.handle`): the
 * remote-agent feature and the real Claw client against the fake remote-agents server over HTTP, the router's world around
 * them, one outbox for both.
 */
import assert from "node:assert/strict";

import type { InboundMessage, InboundQuote, UserRef } from "@primusclaw/personal-agent";

import { quoteBlock, withQuote } from "../../../src/inbound-text/quote-block.js";
import type { RouterLimits } from "../../../src/routing/deps.js";
import type { AssistantChat } from "../../../src/routing/features.js";
import {
  ALICE as CLAW_ALICE,
  KEY_OF,
  type RemoteWorld,
  Script,
  type WorldOptions,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";
import { link, message, world, type World } from "../world.js";

export interface Routed {
  readonly rw: RemoteWorld;
  readonly r: World;
  /** One message through the router, then until the remote agents are quiet. */
  say(text: string, options?: { user?: UserRef; group?: boolean; quotes?: readonly InboundQuote[] }): Promise<void>;
  /** The sender's chat as the remote agents key it. */
  attachedSession(user?: UserRef): string | null;
}

/** A routed world for one test: Alice and Bob linked with the keys the fake server knows them by. */
export function routed<T>(
  test: (w: Routed) => Promise<T>,
  options: { assistant?: Partial<AssistantChat>; limits?: Partial<RouterLimits>; remote?: WorldOptions } = {},
): Promise<T> {
  return remoteWorld(async (rw) => {
    const r = world({
      surface: rw.surface,
      testStore: rw.test,
      remoteChat: rw.remote,
      messageText: { quoteBlock: (m, group) => quoteBlock(m.quotes, { group }), withQuote },
      handlers: { clicks: [rw.remote.clickHandler] }, // (as the worker registers the remote agents' buttons)
      ...(options.assistant ? { assistant: options.assistant } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    });
    for (const [userId, key] of Object.entries(KEY_OF)) link(r, userId, key);
    const say: Routed["say"] = async (text, o = {}) => {
      const base = message(text, { ...(o.user ? { user: o.user } : {}), ...(o.group ? { kind: "group" } : {}) });
      const m: InboundMessage = o.quotes ? { ...base, quotes: o.quotes } : base;
      await r.router.handle(m);
      await rw.idle();
    };
    const attachedSession = (user?: UserRef) =>
      rw.test.store.remoteState.attachedRemote(user?.id ?? "aad-a")?.sessionId ?? null;
    return test({ rw, r, say, attachedSession });
  }, options.remote);
}

export const TWO_AGENTS: readonly (readonly [string, string, string])[] = [
  ["codex", "codex", "Codex"],
  ["claude", "claude", "Claude Code"],
];

/** Alice's chat attached to a new codex session on dev-pod, through the router's `/agent new`. */
export async function attachedThroughRouter(w: Routed, script = new Script()): Promise<string> {
  w.rw.server.addConnector(CLAW_ALICE, "dev-pod", TWO_AGENTS);
  w.rw.server.onCommand = script.hook;
  await w.say("/agent new codex /home/me/repo");
  const sid = w.attachedSession();
  assert.ok(sid, w.rw.said().join("\n"));
  return sid;
}
