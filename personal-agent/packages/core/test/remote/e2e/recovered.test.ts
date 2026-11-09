// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The connector on the person's machine restarted and an attached session is back (teams/tests/test_remote_recovered.py): the
// connector posts `session_recovered` once per restart, ends a turn the restart cut off with `connector_restarted`, or carries on
// a turn that was waiting for a person (which then asks again). The chat says it once, in the user's language.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CODEX_OPTIONS } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";

async function attachedClaude(w: RemoteWorld, script = new Script()): Promise<string> {
  w.server.addConnector(ALICE, "dev-pod", [["claude", "claude", "Claude Code"]]);
  w.server.onCommand = script.hook;
  await w.say("/agent new claude /home/me/repo");
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  return state.sessionId ?? "";
}

const recovered = (w: RemoteWorld): string[] => w.said().filter((t) => t.includes("Recovered") || t.includes("已恢复"));

test("an idle chat is told once that its session is back after the connector restarted", () =>
  remoteWorld(async (w) => {
    const sid = await attachedClaude(w);
    await w.server.emit(sid, "session_recovered", {
      reason: "connector_restart",
      interrupted: false,
      continuing: false,
    });
    await w.until(() => recovered(w).length > 0);
    const lines = recovered(w);
    assert.equal(lines.length, 1, lines.join(" | "));
    assert.ok(lines[0]?.includes("dev-pod") && lines[0].includes("keep writing"), lines[0] ?? "");
  }));

test("a turn the restart cut off ends with the recovered line once not as a failure", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, session) => {
      await srv.say(session, "Working on it, half way");
      await srv.emit(session, "session_recovered", {
        reason: "connector_restart",
        interrupted: true,
        continuing: false,
      });
      await srv.emit(session, "turn_end", { stopReason: "error", error: "connector_restarted" });
    };
    await attachedClaude(w, script);
    await w.say("refactor the parser");
    await w.until(() => recovered(w).length > 0);
    const said = w.said().join("\n");
    assert.equal(recovered(w).length, 1, recovered(w).join(" | "));
    assert.ok(said.includes("cut the last turn short") && said.includes("continue"), said);
    assert.ok(!said.includes("failed (ref") && !said.includes("The turn ended (error)"), said);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
  }));

test("a turn that was waiting for an approval goes on and its new card is shown", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, session) => {
      await srv.ask(session, "act-1", "Run: make", CODEX_OPTIONS, { kind: "execute" });
      await srv.emit(session, "permission_resolved", {
        actionId: "act-1",
        optionId: null,
        outcome: "cancelled",
        by: "connector_restart",
      });
      await srv.emit(session, "session_recovered", {
        reason: "connector_restart",
        interrupted: true,
        continuing: true,
      });
      await srv.ask(session, "act-2", "Run: make", CODEX_OPTIONS, { kind: "execute" });
      await srv.say(session, "Built.");
      await srv.end(session);
    };
    await attachedClaude(w, script);
    await w.say("build it");
    await w.until(() => w.answer().includes("Built."));
    assert.equal(recovered(w).length, 1, recovered(w).join(" | "));
    assert.ok(recovered(w)[0]?.includes("new card"), recovered(w)[0] ?? "");
    assert.equal(w.permissionCards().length, 2);
  }));

test("the line is in chinese for a chinese chat", () =>
  remoteWorld(async (w) => {
    const sid = await attachedClaude(w);
    w.setLang(AAD, "zh"); // (the reader asks for the language when it speaks)
    await w.server.emit(sid, "session_recovered", {
      reason: "connector_restart",
      interrupted: false,
      continuing: false,
    });
    await w.until(() => recovered(w).length > 0);
    assert.ok(recovered(w)[0]?.startsWith("✅ 已恢复：dev-pod 上的"), recovered(w)[0] ?? "");
  }));
