// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The Teams cards link no web page of a session (teams/tests/test_remote_own_window.py): a phone, where the cards are used,
// cannot open the console's session pages, so nothing in a card points at them. Through the worker, attaching, the sessions
// card and the agents card.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  type RemoteWorld,
  Script,
  isStatusCard,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";

const AGENTS = [
  ["claude", "claude-code", "Claude Code"],
  ["codex", "codex", "Codex"],
] as const;
const CAPS = { claude: { roots: ["/home/me/work"] }, codex: { roots: ["/home/me/work"] } };

/** A machine with a claude and a codex session, both started. */
async function machineWithSessions(w: RemoteWorld): Promise<void> {
  const cid = w.server.addConnector(ALICE, "rohan-dev-pod", AGENTS, { caps: CAPS });
  for (const [agent, cwd] of [
    ["claude", "/home/me/work"],
    ["codex", "/home/me/other"],
  ] as const) {
    await w.server.started(w.server.addSession(ALICE, cid, agent, { cwd }));
  }
  w.server.onCommand = new Script().hook;
}

/** What `say` sent as messages of their own (not edits), each as Teams is sent it. */
async function sends(w: RemoteWorld, typed: string): Promise<{ card: string; status: boolean }[]> {
  const before = w.operations().length;
  await w.say(typed);
  return w
    .operations()
    .slice(before)
    .filter((o) => o.op === "send" || o.op === "post")
    .map((o) => ({
      card: JSON.stringify(o.card ?? null) + o.text,
      status: o.card !== undefined && isStatusCard({ attachments: [{ content: o.card }] }),
    }));
}

const linksNoPage = (card: string): boolean =>
  !card.includes("agent-sessions") && !card.includes("单独窗口") && !card.includes("own window");

test("attaching sends the status card with no link to a web page", () =>
  remoteWorld(async (w) => {
    await machineWithSessions(w);
    const sent = await sends(w, "切到 rohan-dev-pod 的 claude");
    assert.equal(sent.length, 1, JSON.stringify(sent));
    const [only] = sent;
    assert.ok(only?.status, JSON.stringify(sent));
    assert.ok(linksNoPage(only.card), only.card);
  }));

test("the sessions and agents cards link no web page", () =>
  remoteWorld(async (w) => {
    await machineWithSessions(w);
    for (const command of ["/agent sessions", "/agents"]) {
      const sent = await sends(w, command);
      assert.ok(sent.length > 0, command);
      for (const m of sent) assert.ok(linksNoPage(m.card), `${command}: ${m.card}`);
    }
  }));
