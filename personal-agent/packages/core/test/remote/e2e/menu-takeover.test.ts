// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Taking over a conversation that already exists, the agent's `resumable` (teams/tests/test_remote_menu.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";
import {
  ATTACH_AGENT,
  CAPS,
  type Json,
  STATUS_TITLES,
  Watching,
  agentsCard,
  attachCaps,
  buttonsIn,
  dataOf,
  insides,
  inputsIn,
  lastStatus,
  press,
  pressData,
  shown,
  starts,
  textsIn,
  titles,
} from "./menu.js";

const WATCH_ONLY = "Watch only (the terminal keeps working)";
const nowOf = (w: RemoteWorld): number => w.test.clock.epochMs() / 1000;
const resumable = (caps: Record<string, Json>): Json[] => (caps["claude-attach"]?.["resumable"] ?? []) as Json[];

test("an agent that takes over conversations lists them and offers the ones that may be taken over", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", [...ATTACH_AGENT, ...TWO_AGENTS.slice(0, 1)], {
      caps: { ...attachCaps(nowOf(w)), codex: CAPS["codex"] ?? {} },
    });
    const card = await agentsCard(w);
    const text = textsIn(card).join(" | ");
    // the agent of kind `attach` starts no conversation of its own: no folder, no New session; the other agent keeps both
    assert.deepEqual(Object.keys(inputsIn(card)), ["root1", "dir1"]);
    assert.equal(titles(card).filter((t) => t === "New session").length, 1);
    // one this connector already holds is a session of this chat: listed under "Your sessions", not here
    assert.ok(text.includes("Fix the parser") && text.includes("/home/me/work/parser · 10 min ago"), text);
    assert.ok(!text.includes("Held by this connector"));
    const resumes = (title: string, of: Json) =>
      buttonsIn(of)
        .filter((b) => b["title"] === title)
        .map((b) => dataOf(b)["resume"]);
    assert.deepEqual(resumes("Take over", card), ["r-idle"]);
    // a terminal's conversation first; then, each group labelled, the ones no process runs and the ones it cannot tell
    const order = textsIn(card).filter(
      (t) =>
        ["Open in a terminal", "Fix the parser", "Cannot tell"].includes(t) ||
        t.endsWith("go on here):") ||
        t === "Not sure whether still open:",
    );
    assert.deepEqual(order, [
      "Open in a terminal",
      "Earlier conversations (no process runs them; take one over to go on here):",
      "Fix the parser",
      "Not sure whether still open:",
      "Cannot tell",
    ]);
    assert.ok(text.includes("Open in a terminal: this machine's connector cannot type into a terminal yet"), text);
    assert.ok(text.includes("Cannot tell whether it is open in a terminal."), text);
    assert.ok(
      buttonsIn(card)
        .filter((b) => ["Take over", WATCH_ONLY].includes(String(b["title"])))
        .every((b) => dataOf(b)["connector_id"] && dataOf(b)["agent_id"] === "claude-attach"),
    );
    // the one a terminal has open is offered to watch, read-only, never to take over
    assert.deepEqual(resumes(WATCH_ONLY, card), ["r-live"]);
    // ... and only by a connector that says it can (`watch_live`): an older one would refuse it
    const agent = w.server.connector(cid).agents[0];
    if (agent) agent.capabilities = attachCaps(nowOf(w), { watch: false })["claude-attach"] ?? {};
    const older = await agentsCard(w);
    assert.ok(!titles(older).includes(WATCH_ONLY));
    assert.ok(textsIn(older).join(" | ").includes("Still open in a terminal - exit it first."));
  }));

test("take over starts the session with the conversations own ref and folder and becomes the action row", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Script().hook;
    const card = await agentsCard(w);
    await press(w, card, "Take over");
    assert.deepEqual(starts(w), [
      { connector_id: cid, agent_id: "claude-attach", cwd: "/home/me/work/parser", resume_ref: "r-idle" },
    ]);
    const state = w.test.store.remoteState.attachedRemote(AAD);
    const done = shown(w);
    assert.equal(state?.cwd, "/home/me/work/parser");
    assert.deepEqual(titles(done), STATUS_TITLES);
    // the status card names the conversation it continues, and where it runs under it
    assert.equal(textsIn(done)[0], "🔌 In your existing conversation “Fix the parser”");
    assert.ok(textsIn(done)[1]?.startsWith("dev-pod · "), textsIn(done).join(" | "));
    assert.ok(textsIn(done).join(" ").includes("/home/me/work/parser"));
    assert.equal(state.conversation, "Fix the parser");
    assert.ok(!JSON.stringify(card).includes("r-held")); // (one this connector already holds is this chat's: not offered here)
  }));

const CHECKED: readonly (readonly [string, (caps: Record<string, Json>) => void, Json, string])[] = [
  ["the conversation is gone from the list", (caps) => resumable(caps).shift(), {}, "not on the agent's list any more"],
  ["a ref the agent never reported", () => undefined, { resume: "forged" }, "not on the agent's list any more"],
  [
    "open in a terminal, and the connector cannot watch it",
    (caps) => {
      caps["claude-attach"] = Object.fromEntries(
        Object.entries(caps["claude-attach"] ?? {}).filter(([key]) => key !== "watch_live"),
      );
    },
    { resume: "r-live" },
    "still open in a terminal",
  ],
  ["the ref of one whose state cannot be told", () => undefined, { resume: "r-unknown" }, "cannot tell whether"],
  ["an empty ref", () => undefined, { resume: "" }, "not on the agent's list any more"],
];

for (const [label, change, data, expected] of CHECKED) {
  test(`take over is checked against the agents list as it is now: ${label}`, () =>
    remoteWorld(async (w) => {
      const caps = attachCaps(nowOf(w));
      const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps });
      const card = await agentsCard(w);
      change(caps);
      const agent = w.server.connector(cid).agents[0];
      if (agent) agent.capabilities = caps["claude-attach"] ?? {};
      const done = await press(w, card, "Take over", { typed: data });
      assert.deepEqual(starts(w), [], label);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
      assert.ok(textsIn(done).slice(0, 2).join(" ").includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
    }));
}

test("going back to a taken over conversation still names it", () =>
  remoteWorld(async (w) => {
    const caps = attachCaps(nowOf(w));
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps });
    w.server.onCommand = new Script().hook;
    await press(w, await agentsCard(w), "Take over");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    await w.say("/agent detach");
    // the connector now lists the conversation as the one it holds
    const first = resumable(caps)[0];
    if (first) first["state"] = "attached";
    const agent = w.server.connector(cid).agents[0];
    if (agent) agent.capabilities = caps["claude-attach"] ?? {};
    await pressData(w, { op: "attach", session_id: sid }); // ("Go back to it")
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.equal(state?.sessionId, sid);
    assert.equal(state.conversation, "Fix the parser");
    assert.equal(state.conversationRef, "r-idle");
  }));

test("a watched conversation can be taken over from its status card after confirming", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    w.server.onCommand = new Watching().hook;
    await w.say("/agent attach r-live"); // (typed: a conversation a terminal has open is watched first)
    await w.idle();
    const watch = w.test.store.remoteState.attachedRemote(AAD);
    assert.equal(insides(w).state.phase(AAD), "watching");
    assert.equal(watch?.conversationRef, "r-live");
    const status = lastStatus(w); // (as the chat shows it now)
    assert.ok(textsIn(status).join(" ").includes("(read-only)"));
    assert.ok(titles(status).includes("Take over…"));
    // where it runs is said once (the title says it)
    assert.equal(textsIn(status).filter((t) => t.includes("dev-pod · ")).length, 1);
    await w.say("please run the tests");
    assert.ok(w.last().startsWith("It is in use in a terminal, so you can only watch;"), w.last());
    assert.ok(w.last().includes("Take over… on the status card also works, but it ends"), w.last());
    assert.deepEqual(w.server.commandsOf("prompt"), []);
    const confirm = await press(w, status, "Take over…");
    assert.equal(starts(w).length, 1, "the first tap only asks");
    w.server.onCommand = new Script().hook;
    await press(w, confirm, "Take over");
    assert.deepEqual(starts(w)[1], {
      connector_id: cid,
      agent_id: "claude-attach",
      cwd: "/home/me/work/term",
      resume_ref: "r-live",
      takeover: true,
    });
    // the watch it replaces is closed
    assert.deepEqual(
      w.server.commandsOf("close").map((c) => c.session_id),
      [watch.sessionId],
    );
    const now = w.test.store.remoteState.attachedRemote(AAD);
    assert.notEqual(now?.sessionId, watch.sessionId);
    assert.equal(now?.conversation, "Open in a terminal");
  }));

test("after a worker restart the watching card still offers the takeover and the tap checks the connector", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    w.server.onCommand = new Watching().hook;
    await w.say("/agent attach r-live");
    await w.idle();
    insides(w).chats.agentTakeover.clear(); // (as after a restart: the worker keeps this in memory)
    const state = w.test.store.remoteState.attachedRemote(AAD);
    const message = insides(w).board.statusOf(AAD, state, "watching").message;
    const card = w.renderedCards([{ op: "send", conversation: "", message }])[0] ?? {};
    assert.ok(titles(card).includes("Take over…"));
    const confirm = await press(w, card, "Take over…");
    assert.deepEqual(titles(confirm), ["Take over", "Cancel"]);
  }));

test("the watching card offers no takeover where the connector cannot do it", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Watching().hook;
    await w.say("/agent attach r-live");
    await w.idle();
    const status = lastStatus(w);
    assert.ok(textsIn(status).join(" ").includes("(read-only)"));
    assert.ok(!titles(status).includes("Take over…"));
    await w.say("please run the tests");
    assert.ok(!w.last().includes("Take over"), "a connector that cannot take it over is not offered");
  }));
