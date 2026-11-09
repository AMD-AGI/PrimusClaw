// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What the remote-agent end-to-end tests share: a chat attached to a session on dev-pod, one plain turn, a time seen ago.
import assert from "node:assert/strict";

import { remoteAgentText } from "../../../src/locales/remote-agents.js";
import { newTurn } from "../../../src/remote/chats.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, USER_A } from "../../../../../test-support/remote-world.js";

export const BOB = "u-bob";
export const TWO_AGENTS: readonly (readonly [string, string, string])[] = [
  ["codex", "codex", "Codex"],
  ["claude", "claude", "Claude Code"],
];
export const en = remoteAgentText.in("en");
export const AAD = USER_A.id;

/** A world whose user has started a session on dev-pod and has been told it is ready. */
export async function attached(
  w: RemoteWorld,
  script = new Script(),
  cwd = "/home/me/repo",
  agent = "codex",
  online = true,
) {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { online });
  w.server.onCommand = script.hook;
  await w.say(`/agent new ${agent} ${cwd}`);
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  return { cid, sid: state.sessionId ?? "" };
}

export async function oneTurn(srv: FakeRemote, sid: string, _cmd: FakeCommand, text = "Done."): Promise<void> {
  await srv.say(sid, text);
  await srv.end(sid);
}

/** A time `secondsAgo` before now, as Claw writes it. */
export const seen = (secondsAgo: number): string => new Date(Date.now() - secondsAgo * 1000).toISOString();

/** The worker's own books of the turns it watches, for a test that puts one there that never ends. */
export function turnsOf(w: RemoteWorld): Map<string, unknown> {
  return (w.remote as unknown as { chats: { turns: Map<string, unknown> } }).chats.turns;
}

/** A turn in the worker's books that nothing runs. */
export const idleTurn = (): unknown => newTurn();

/** An agent that answers each prompt with `text`, `chunks` times, and ends its turn. */
export function promptScript(chunks = 1, text = "Done."): Script {
  const script = new Script();
  script.onPrompt = async (srv, sid) => {
    for (let i = 0; i < chunks; i += 1) await srv.say(sid, text);
    await srv.end(sid);
  };
  return script;
}
