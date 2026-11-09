// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// New session from the /agents card (teams/tests/test_remote_menu.py, "New session").
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteText } from "../../../src/locales/remote.js";
import type { Failure } from "../../../../../test-support/remote-fake-data.js";
import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, idleTurn, turnsOf } from "./helpers.js";
import {
  ASKING_BY_DEFAULT,
  ASKING_FIXED,
  CAPS,
  type Json,
  UNATTENDED_BY_DEFAULT,
  UNATTENDED_FIXED,
  agentsCard,
  buttonsIn,
  dataOf,
  inputsIn,
  press,
  pressData,
  shown,
  starts,
  textsIn,
  titles,
} from "./menu.js";

const STATUS_TITLES = ["Switch", "Back to assistant", "Stop", "Mode"];
const MODES = ["default", "plan", "bypassPermissions"];
const FLAGS = { default: false, plan: false, bypassPermissions: true };

test("a connector that says nothing about unattended shows and offers nothing and one that does is shown clearly", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "plain", [["codex", "codex", "Codex"]], { caps: CAPS });
    w.server.addConnector(ALICE, "careful", [["claude", "claude", "Claude Code"]], { caps: ASKING_BY_DEFAULT });
    w.server.addConnector(ALICE, "bold", [["claude", "claude", "Claude Code"]], { caps: UNATTENDED_BY_DEFAULT });
    w.server.addConnector(ALICE, "fixed", [["claude", "claude", "Claude Code"]], { caps: UNATTENDED_FIXED });
    w.server.addConnector(ALICE, "strict", [["claude", "claude", "Claude Code"]], { caps: ASKING_FIXED });
    const card = await agentsCard(w);
    const text = textsIn(card).join(" | ");
    // the agents whose sessions START unattended wear the badge: bold and fixed
    assert.equal(text.split(remoteText.in("en").unattendedNote).length - 1, 2, text);
    // the choice is offered where `unattended_allowed` says a client may switch (careful, bold): not where it is false or absent
    const inputs = inputsIn(card);
    assert.deepEqual(
      Object.keys(inputs).filter((i) => i.startsWith("appr")),
      ["appr1", "appr2"],
    );
    assert.deepEqual([inputs["appr1"]?.["value"], inputs["appr2"]?.["value"]], ["ask", "unattended"]); // as the owner configured it
    assert.deepEqual(
      ((inputs["appr1"]?.["choices"] ?? []) as Json[]).map((c) => c["value"]),
      ["ask", "unattended"],
    );
  }));

const WHERE: readonly (readonly [string, Json, string | null, string | null])[] = [
  ["the first folder, as shown", {}, "/home/me/work", null],
  ["another folder of the agent", { root0: "/data/exp" }, "/data/exp", null],
  ["a subfolder below it", { dir0: "src/app" }, "/home/me/work/src/app", null],
  ["a subfolder written with dots and backslashes", { dir0: ".\\src\\app/" }, "/home/me/work/src/app", null],
  ["a folder the agent never reported", { root0: "/etc" }, null, "not one of the agent's folders"],
  [
    "a folder that climbs out of one it reported",
    { root0: "/home/me/work/../../etc" },
    null,
    "not one of the agent's folders",
  ],
  ["no folder at all (a card that lost its inputs)", { root0: "" }, null, "not one of the agent's folders"],
  ["a subfolder that climbs out", { dir0: "../x" }, null, "A subfolder is a path inside the folder"],
  ["a subfolder that climbs out later", { dir0: "a/../../x" }, null, "A subfolder is a path inside the folder"],
  ["an absolute subfolder", { dir0: "/etc" }, null, "A subfolder is a path inside the folder"],
  ["a home subfolder", { dir0: "~/x" }, null, "A subfolder is a path inside the folder"],
  ["a drive", { dir0: "C:\\x" }, null, "A subfolder is a path inside the folder"],
  ["a control character", { dir0: "a\nb" }, null, "A subfolder is a path inside the folder"],
  ["a subfolder that is far too long", { dir0: "a".repeat(201) }, null, "A subfolder is a path inside the folder"],
];

async function startsWhereTheCardSays(
  w: RemoteWorld,
  label: string,
  typed: Json,
  cwd: string | null,
  refusal: string | null,
) {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
  w.server.onCommand = new Script().hook;
  const card = await agentsCard(w);
  let done = await press(w, card, "New session", { typed });
  if (refusal !== null) {
    assert.deepEqual(starts(w), [], label);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
    assert.equal(textsIn(done)[0], "🖥️ Your agents", label); // the list again, with the reason on top
    assert.ok(textsIn(done)[1]?.includes(refusal), `${label}: ${textsIn(done)[1] ?? ""}`);
    assert.deepEqual(titles(done).slice(0, 1), ["New session"]);
    return;
  }
  assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd }], label);
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.deepEqual([state?.agentLabel, state?.host, state?.cwd], ["⬛ Codex", "dev-pod", cwd], label);
  // the status card of the new session came as a new message (the tapped card deleted), edited when the agent was ready
  assert.deepEqual(
    w
      .operations()
      .filter((o) => o.id === "card-1")
      .map((o) => o.op),
    ["delete"],
    label,
  );
  done = shown(w);
  assert.equal(textsIn(done)[0], "🔌 Connected to dev-pod · ⬛ Codex", label);
  assert.ok(
    textsIn(done)
      .join(" ")
      .includes(cwd ?? ""),
    label,
  );
  assert.deepEqual(titles(done), STATUS_TITLES, label);
  assert.deepEqual([...new Set(buttonsIn(done).map((b) => dataOf(b)["session_id"]))], [state?.sessionId]);
  assert.ok(textsIn(done).includes("Status: idle; what you send goes to it"), textsIn(done).join(" | "));
  assert.ok(w.said().includes("—— Now: dev-pod · ⬛ Codex ——"), w.said().join(" | "));
}

for (const [label, typed, cwd, refusal] of WHERE) {
  test(`new session starts where the card says and refuses what the card could not have said: ${label}`, () =>
    remoteWorld((w) => startsWhereTheCardSays(w, label, typed, cwd, refusal)));
}

test("new session for the second agent reads its own fields", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    w.server.onCommand = new Script().hook;
    const card = await agentsCard(w);
    // (the first agent's fields are not this one's)
    await press(w, card, "New session", { nth: 1, typed: { root0: "/data/exp", dir0: "ignored", dir1: "docs" } });
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "claude", cwd: "/home/me/work/docs" }]);
  }));

test("an agent that reports no folders takes the typed folder and refuses an empty one", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.onCommand = new Script().hook;
    const card = await agentsCard(w);
    const done = await press(w, card, "New session", { typed: { dir0: "  " } });
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done)[1]?.includes("Type the folder on the machine first"));
    await press(w, card, "New session", { typed: { dir0: "/home/me/some folder" } });
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/home/me/some folder" }]);
  }));

const STALE: readonly (readonly [string, (w: RemoteWorld, cid: string) => void, string])[] = [
  [
    "the machine went offline",
    (w, cid) => {
      w.server.connector(cid).online = false;
    },
    "dev-pod is offline",
  ],
  [
    "the machine was disconnected",
    (w, cid) => {
      w.server.connector(cid).revoked = true;
    },
    "not available any more",
  ],
  [
    "the agent is gone",
    (w, cid) => {
      w.server.connector(cid).agents = [];
    },
    "not available any more",
  ],
  [
    "the agents folders changed",
    (w, cid) => {
      const agent = w.server.connector(cid).agents[0];
      if (agent) agent.capabilities = { ...agent.capabilities, roots: ["/else"] };
    },
    "not one of the agent's folders any more",
  ],
];

for (const [label, change, expected] of STALE) {
  test(`a card that went stale is refused and the list comes back as it is now: ${label}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
      const card = await agentsCard(w);
      change(w, cid);
      const done = await press(w, card, "New session");
      assert.deepEqual(starts(w), [], label);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
      assert.ok(textsIn(done).join(" ").includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
    }));
}

test("a button naming someone elses machine is not an agent of yours", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS, { caps: CAPS });
    await w.say("/agents");
    const done = await pressData(w, {
      op: "new",
      connector_id: bobs,
      agent_id: "codex",
      slot: 0,
      root0: "/home/me/work",
    });
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done)[1]?.includes("not available any more"));
    // Claw only ever answered for Alice
    assert.ok(w.server.calls.filter(([, p]) => p.endsWith("/connectors")).every(([, , u]) => u === ALICE));
  }));

const CANNOT_START: readonly (readonly [string, (w: RemoteWorld, cid: string) => void, string])[] = [
  [
    "a task is still running",
    (w) => {
      turnsOf(w).set(AAD, idleTurn());
    },
    "A task is still running. Send /stop first.",
  ],
  [
    "the session limit",
    (w, cid) => {
      for (let i = 0; i < 10; i += 1) w.server.addSession(ALICE, cid, "codex");
    },
    "maximum number of active remote sessions",
  ],
  [
    "the machine went offline between the list and the create",
    (w) => {
      w.server.failOn("POST", "/v1/remote-agents/sessions", [409, "connector_offline"] as Failure);
    },
    "That machine is offline",
  ],
  [
    "Claw limits the user",
    (w) => {
      w.server.failOn("POST", "/v1/remote-agents/sessions", 429);
    },
    "limiting remote agent requests",
  ],
];

for (const [label, setup, expected] of CANNOT_START) {
  test(`a new session that cannot start says why on the card and attaches nothing: ${label}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
      const card = await agentsCard(w);
      setup(w, cid);
      const done = await press(w, card, "New session", { settle: false });
      assert.deepEqual(starts(w), [], label);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
      assert.ok(textsIn(done).slice(0, 2).join(" ").includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
      turnsOf(w).delete(AAD);
    }));
}

/** A connector whose agent starts in its `ask_mode` and says whether the session asks and which modes do not. */
function flagged(caps: Record<string, Json>): Script {
  const claude = Object.values(caps)[0] ?? {};
  const unattended = claude["unattended"];
  return new Script({
    mode: String(claude["ask_mode"]),
    modes: MODES,
    unattended: typeof unattended === "boolean" ? unattended : null,
    flags: FLAGS,
  });
}

const APPROVAL: readonly (readonly [string, Record<string, Json>, Json, string | null, string | null])[] = [
  ["asks by default, left as it was", ASKING_BY_DEFAULT, {}, null, null],
  ["asks by default, ask chosen", ASKING_BY_DEFAULT, { appr0: "ask" }, null, null],
  [
    "asks by default, unattended chosen",
    ASKING_BY_DEFAULT,
    { appr0: "unattended" },
    "bypassPermissions",
    "Switched to `bypassPermissions`.",
  ],
  ["a mode id forged into the choice", ASKING_BY_DEFAULT, { appr0: "bypassPermissions" }, null, null],
  ["a word that is none of the two", ASKING_BY_DEFAULT, { appr0: "yes" }, null, null],
  ["unattended by default, left as it was", UNATTENDED_BY_DEFAULT, {}, null, null],
  [
    "unattended by default, asking chosen",
    UNATTENDED_BY_DEFAULT,
    { appr0: "ask" },
    "default",
    "Switched to `default`.",
  ],
  ["unattended by default, unattended chosen", UNATTENDED_BY_DEFAULT, { appr0: "unattended" }, null, null],
  [
    "the connector refuses a switch: no choice on the card, a forged one is ignored",
    ASKING_FIXED,
    { appr0: "unattended" },
    null,
    null,
  ],
  ["unattended and fixed: a forged choice is ignored", UNATTENDED_FIXED, { appr0: "ask" }, null, null],
];

for (const [label, caps, picked, to, said] of APPROVAL) {
  test(`the approval choice switches the started session to a mode the session itself says does what was asked: ${label}`, () =>
    remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", [["claude", "claude", "Claude Code"]], { caps });
      w.server.onCommand = flagged(caps).hook;
      const card = await agentsCard(w);
      await press(w, card, "New session", { typed: picked });
      const bodies = starts(w);
      assert.equal(bodies.length, 1, label);
      assert.ok(!("mode" in (bodies[0] ?? {})), label); // a mode id is never made up: the session starts as its agent starts
      assert.deepEqual(
        w.server.commandsOf("set_mode").map((c) => c.body["mode_id"]),
        to === null ? [] : [to],
        label,
      );
      if (said === null) assert.ok(!w.last().includes("Switched to"), `${label}: ${w.last()}`);
      else assert.ok(w.last().includes(said), `${label}: ${w.last()}`);
      if (to !== null) {
        // (the status card says the mode it runs in now)
        assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.unattended, to === "bypassPermissions", label);
        assert.ok(textsIn(shown(w)).join(" ").includes(`mode ${to}`), label);
      }
    }));
}

test("a connector that does not say which modes ask is not switched and one that refuses the switch is told", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", [["claude", "claude", "Claude Code"]], { caps: ASKING_BY_DEFAULT });
    // `unattended` on the session, none on the modes
    w.server.onCommand = new Script({ mode: "default", modes: MODES, unattended: false }).hook;
    const card = await agentsCard(w);
    await press(w, card, "New session", { typed: { appr0: "unattended" } });
    assert.deepEqual(w.server.commandsOf("set_mode"), []);
    assert.ok(w.last().includes("does not say which of its modes do not ask, so I left its mode as it is."), w.last());
    w.server.sessions.clear();
    w.server.commands.length = 0;
    w.test.store.remoteState.detachRemote(AAD);
    w.server.onCommand = flagged(ASKING_BY_DEFAULT).hook;
    w.server.failOn("POST", "/commands", 503); // (the session starts through /sessions: only the switch is refused)
    await press(w, card, "New session", { typed: { appr0: "unattended" } });
    assert.ok(w.last().includes("I could not switch its mode just now. Tap Mode to try again."), w.last());
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.unattended, false);
  }));
