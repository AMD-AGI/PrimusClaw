// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Every button of every card the remote agents post reaches their click handler as Teams sends the press: the Teams adapter's
// `toInboundEvent` makes the verb the router dispatches on, and it is one the handler registered. (A test that calls the handler
// with a verb of its own would not see a card whose verb nobody registered: its buttons would do nothing in production.)
import assert from "node:assert/strict";
import { test } from "node:test";

import { buttonsOf } from "../../../../../test-support/adaptive-card.js";
import { CODEX_OPTIONS } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";
import { ATTACH_AGENT, CAPS, type Json, attachCaps, openTakeover, pressData } from "./menu.js";
import { sendFromCard, windowed } from "./window-helpers.js";

/** Every Action.Execute of every card the chat was sent or shown, by the card's first words. */
function presses(w: RemoteWorld): { card: string; data: Json }[] {
  return w.operations().flatMap((o) =>
    o.card === undefined
      ? []
      : buttonsOf(o.card)
          .filter((b) => b["type"] === "Action.Execute")
          .map((b) => ({ card: JSON.stringify(o.card).slice(0, 80), data: (b["data"] ?? {}) as Json })),
  );
}

/** What the router would do with each: every verb the adapter reads is one the remote agents' handler registered. */
function assertAllRouted(w: RemoteWorld): Set<string> {
  const verbs = w.remote.clickHandler.verbs;
  const seen = new Set<string>();
  for (const { card, data } of presses(w)) {
    const action = w.asTeamsSendsIt(data, USER_A, "card-x");
    assert.ok(verbs.includes(action.verb), `${action.verb} (of ${card}) is no verb of the remote agents'`);
    assert.deepEqual(action.data, data);
    seen.add(`${action.verb}:${typeof data["op"] === "string" ? data["op"] : ""}`);
  }
  return seen;
}

test("every button of the agents, sessions, machine and takeover cards reaches the remote agents", () =>
  remoteWorld(async (w) => {
    const now = w.test.clock.epochMs() / 1000;
    const cid = w.server.addConnector(ALICE, "dev-pod", [...ATTACH_AGENT, ...TWO_AGENTS], {
      caps: { ...attachCaps(now, { change: { takeover: true } }), ...CAPS },
    });
    w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    w.server.onCommand = new Script().hook;
    await w.say("/agents");
    await w.say("/agent sessions");
    await w.say("/agent new dev-pod /home/me/work"); // (the machine's agents to choose from)
    await openTakeover(w, cid);
    await pressData(w, { op: "hidden", connector_id: cid });
    await w.say("/agent off dev-pod");
    const seen = assertAllRouted(w);
    for (const want of ["remote:new", "remote:attach", "remote:close", "remote:pair", "remote:list", "remote_off:"]) {
      assert.ok(seen.has(want), `${want} not among ${[...seen].join(", ")}`);
    }
    assert.deepEqual(w.unhandled, []);
  }));

test("every button of the status card, the mode picker and a permission card reaches the remote agents", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.ask(sid, "act-1", "Run: make", CODEX_OPTIONS, { kind: "execute" });
    };
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    w.server.onCommand = script.hook;
    await w.say("/agent new codex /home/me/repo");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    await pressData(w, { op: "mode", session_id: sid });
    await w.send("make it");
    await w.until(() => w.permissionCards().length > 0);
    const seen = assertAllRouted(w);
    for (const want of ["remote:detach", "remote:stop", "remote:mode", "remote:set_mode", "remote_decision:"]) {
      assert.ok(seen.has(want), `${want} not among ${[...seen].join(", ")}`);
    }
    assert.deepEqual(w.unhandled, []);
  }));

test("every button of the session card and an approval on it reaches the remote agents", () =>
  remoteWorld(
    async (w) => {
      const script = new Script();
      script.onPrompt = async (srv, sid) => {
        await srv.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
      };
      const sid = await windowed(w, script);
      await sendFromCard(w, sid, "edit the readme");
      await w.until(() => w.operations().some((o) => JSON.stringify(o.card ?? null).includes("allow_once")));
      const seen = assertAllRouted(w);
      for (const want of ["remote:send", "remote:switch", "remote:detach", "remote_decision:"]) {
        assert.ok(seen.has(want), `${want} not among ${[...seen].join(", ")}`);
      }
      assert.deepEqual(w.unhandled, []);
    },
    { windowDefault: "card" },
  ));
