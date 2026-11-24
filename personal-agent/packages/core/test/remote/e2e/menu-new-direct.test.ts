// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A chat that is the agent's window itself (direct chat) asks for a new session: it is told what starts where at once, and that
// its messages go to the agent only once the agent has started. A start the connector refuses (a folder that is not there) says
// so with the folder, and that the messages still go to the bot, by the name this deployment gives it.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";
import { CAPS, agentsCard, starts, tap } from "./menu.js";

const OPTIONS = { direct: true, botName: "Clawy" } as const;

/** A connector that refuses every new session as one in a folder that is not on the machine. */
class NoSuchFolder extends Script {
  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    if (cmd.type === "session.new") await srv.emit(cmd.session_id, "session_closed", { reason: "cwd_not_found" });
    else await super.handle(srv, cmd);
  }
}

async function tapNewSession(w: RemoteWorld, script: Script, subfolder: string): Promise<string> {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
  w.server.onCommand = script.hook;
  const card = await agentsCard(w);
  await w.click(tap(card, "New session", 0, { dir0: subfolder }));
  await w.idle();
  return cid;
}

const entered = (w: RemoteWorld): string[] => w.said().filter((t) => t.startsWith("→ Your messages now go to"));

test("a new session in a folder that is not there is never said to be where messages go, and says which folder", () =>
  remoteWorld(async (w) => {
    const cid = await tapNewSession(w, new NoSuchFolder(), "clawy");
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/home/me/work/clawy" }]);
    const said = w.said();
    assert.ok(
      said.includes("Starting ⬛ Codex on dev-pod in `/home/me/work/clawy`… I will say here when it is running."),
      said.join(" | "),
    );
    assert.deepEqual(entered(w), [], said.join(" | "));
    assert.equal(
      w.last(),
      "The session could not start in `/home/me/work/clawy`: That folder does not exist on that machine: pick one that " +
        "exists there, or create it there first. Your messages still go to Clawy.",
    );
    assert.ok(!said.some((t) => t.includes("PrimusClaw")), said.join(" | "));
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }, OPTIONS));

test("a new session that starts says where messages go once, after it has started, by the bot's own name", () =>
  remoteWorld(async (w) => {
    await tapNewSession(w, new Script(), "");
    const said = w.said();
    const starting = said.findIndex((t) => t.startsWith("Starting ⬛ Codex on dev-pod in `/home/me/work`…"));
    assert.ok(starting >= 0, said.join(" | "));
    assert.equal(entered(w).length, 1, said.join(" | "));
    const line = entered(w)[0] ?? "";
    assert.ok(said.indexOf(line) > starting, said.join(" | "));
    assert.ok(line.includes("Start a message with @Clawy to talk to Clawy"), line);
    assert.ok(!said.some((t) => t.includes(" is ready on ")), said.join(" | ")); // (one line says it, not two)
    assert.ok(w.test.store.remoteState.attachedRemote(AAD));
  }, OPTIONS));

test("/agent new typed in a direct chat says it is starting, and where messages go only once it has", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.onCommand = new NoSuchFolder().hook;
    await w.say("/agent new codex /home/me/nope");
    assert.deepEqual(entered(w), [], w.said().join(" | "));
    assert.ok(
      w.said().some((t) => t.startsWith("Starting ⬛ Codex on dev-pod in `/home/me/nope`…")),
      w.said().join(" | "),
    );
    assert.ok(w.last().endsWith("Your messages still go to Clawy."), w.last());
    w.server.onCommand = new Script().hook;
    await w.say("/agent new codex /home/me/repo");
    assert.equal(entered(w).length, 1, w.said().join(" | "));
    assert.ok(w.last().startsWith("→ Your messages now go to dev-pod · ⬛ Codex (`/home/me/repo`"), w.last());
  }, OPTIONS));

test("the way back from a session is said by the bot's own name", () =>
  remoteWorld(
    async (w) => {
      w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
      w.server.onCommand = new Script().hook;
      await w.say("/agent new codex /home/me/repo");
      await w.say("/agent close");
      assert.ok(w.last().endsWith("Your messages go to Clawy again."), w.last());
      assert.ok(!w.said().some((t) => t.includes("PrimusClaw")), w.said().join(" | "));
    },
    { botName: "Clawy" },
  ));
