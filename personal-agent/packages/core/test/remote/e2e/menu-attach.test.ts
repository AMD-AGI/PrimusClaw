// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Attach, Detach, Close and Refresh from the cards (teams/tests/test_remote_menu.py, "Attach, Detach, Close").
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, attached, idleTurn, promptScript, turnsOf } from "./helpers.js";
import {
  CAPS,
  agentsCard,
  buttonsIn,
  dataOf,
  edits,
  press,
  pressData,
  replaced,
  shown,
  tap,
  textsIn,
  titles,
} from "./menu.js";

const STATUS_TITLES = ["Switch", "Back to assistant", "Stop", "Mode"];
const STOP_FIRST = "A task is still running. Send /stop first.";

test("attach goes back to the session the tapped card becomes the status card and one line says so", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    w.server.onCommand = new Script().hook;
    await w.server.started(sid, { mode: "plan", modes: ["default", "plan", "acceptEdits"] });
    const card = await agentsCard(w);
    const before = w.operations().length;
    await press(w, card, "Attach");
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.equal(state?.sessionId, sid);
    assert.deepEqual([state.mode, state.modes], ["plan", ["default", "plan", "acceptEdits"]]);
    const done = shown(w);
    assert.deepEqual(titles(done), STATUS_TITLES);
    assert.equal(textsIn(done)[0], "🔌 Connected to dev-pod · ⬛ Codex");
    assert.ok(textsIn(done).includes("/home/me/a · mode plan"), textsIn(done).join(" | "));
    assert.ok(!["", "card-1"].includes(state.statusCard));
    const after = w.operations().slice(before);
    const sends = after.filter((o) => o.op === "send" || o.op === "post");
    assert.deepEqual(
      sends.map((o) => o.text || null),
      ["—— Now: dev-pod · ⬛ Codex ——", null],
    );
    assert.equal(w.statusCards().length, 1);
    assert.equal(sends[1]?.id, state.statusCard, "the line, then the status card under it");
    assert.deepEqual(
      after.filter((o) => o.id === "card-1").map((o) => o.op),
      ["delete"],
    );
    assert.deepEqual(
      w.server.commandsOf("resume").map((c) => c.type),
      ["resume"],
    ); // the agent's own session is brought back
  }));

test("attach to a session that is at work says so and the action row is the one under the tap", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    await w.server.started(sid);
    await w.server.say(sid, "working on it");
    const card = await agentsCard(w);
    await w.click(tap(card, "Attach"));
    // on the status card
    await w.until(() => edits(w).length > 0 && textsIn(replaced(w)).join(" ").includes("It is working right now"));
    assert.ok(textsIn(replaced(w)).includes("Status: working"), textsIn(replaced(w)).join(" | "));
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false); // (no turn of this chat's is open)
    assert.equal(w.remote.running(AAD), false);
    await w.server.say(sid, " Done.");
    await w.server.end(sid);
    // what it says next reaches the chat by itself
    await w.until(() => w.said().some((t) => t.includes("Done.") && t.includes("on its own")));
    assert.equal(w.statusCards().length, 1); // the status card that replaced the Attach card, and none under what the agent said
  }));

const REFUSED_ATTACH: readonly (readonly [
  string,
  (w: RemoteWorld, cid: string, sid: string) => string | undefined,
  string,
  string,
])[] = [
  [
    "someone elses session",
    (w) => w.server.addSession(BOB, w.server.addConnector(BOB, "b", TWO_AGENTS), "codex", { cwd: "/x" }),
    "forged",
    "could not find that session",
  ],
  [
    "a session that has ended",
    (w, _cid, sid) => {
      w.server.session(sid).status = "closed";
      return undefined;
    },
    "own",
    "That session has ended",
  ],
  [
    "a task is still running",
    (w) => {
      turnsOf(w).set(AAD, idleTurn());
      return undefined;
    },
    "own",
    STOP_FIRST,
  ],
  [
    "its machine was disconnected",
    (w, cid) => {
      w.server.connector(cid).revoked = true;
      return undefined;
    },
    "own",
    "machine is no longer connected",
  ],
];

for (const [label, setup, data, expected] of REFUSED_ATTACH) {
  test(`attach checks the session against the users own list and changes nothing when it refuses: ${label}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
      const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
      const other = setup(w, cid, sid);
      const done = await pressData(
        w,
        { op: "attach", session_id: data === "forged" ? (other ?? "") : sid },
        { settle: false },
      );
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
      assert.deepEqual(w.server.commandsOf("resume"), [], label);
      assert.ok(textsIn(done).slice(0, 2).join(" ").includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
      turnsOf(w).delete(AAD);
    }));
}

test("detach from the row goes back to claw and the card becomes the list with the session to attach again", () =>
  remoteWorld(async (w) => {
    const { sid } = await attached(w, promptScript());
    await w.say("hello");
    const rows = w.statusCards();
    assert.equal(rows.length, 1);
    const done = await press(w, rows[0] ?? {}, "Back to assistant");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.equal(textsIn(done)[0], "🔌 Back to the assistant");
    assert.equal(w.last(), "—— Back to the assistant ——");
    assert.ok(
      buttonsIn(done).some((b) => b["title"] === "Go back to it" && dataOf(b)["session_id"] === sid),
      JSON.stringify(buttonsIn(done)),
    );
  }));

for (const [label, make, expected] of [
  ["a row from an earlier session", "other", "That card is for another session"],
  ["a row when the chat is not attached", "none", "You are not attached to a remote session"],
] as const) {
  test(`a row that is not this chats attachment is refused and the attachment stays: ${label}`, () =>
    remoteWorld(async (w) => {
      const { sid } = await attached(w);
      let stale = { op: "detach", session_id: "some-earlier-session" };
      if (make === "none") {
        await w.say("/agent detach");
        stale = { op: "detach", session_id: sid };
      }
      const done = await pressData(w, stale);
      assert.ok(textsIn(done)[1]?.includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD) !== null, make === "other");
    }));
}

test("detach and the other row buttons wait for a running task", () =>
  remoteWorld(async (w) => {
    // Close and Mode wait for a running task; Back to the assistant does not: the chat lets go, nothing is sent to the machine,
    // and the turn goes on there
    const { sid } = await attached(w);
    turnsOf(w).set(AAD, idleTurn());
    for (const op of ["close", "set_mode"]) {
      const done = await pressData(w, { op, session_id: sid, mode: "plan" }, { settle: false });
      assert.ok(textsIn(done).join(" ").includes(STOP_FIRST), op);
      assert.deepEqual(titles(done).slice(0, 1), ["Switch"], op); // the status card comes back: the chat is still attached
    }
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commandsOf("close"), []);
    const before = w.server.commands.length;
    const done = await pressData(w, { op: "detach", session_id: sid }, { settle: false });
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commands.slice(before), []);
    assert.ok(!textsIn(done).join(" ").includes(STOP_FIRST));
    assert.ok(
      w.operations().some((o) => o.text.includes("That turn goes on on the machine, uninterrupted")),
      w.said().join(" | "),
    );
    turnsOf(w).delete(AAD);
  }));

test("close from the list closes one session only and the list comes back without it", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const keep = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/keep" });
    const drop = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/drop" });
    w.server.session(drop).updated_at = "2026-10-29T08:00:00.000Z";
    const card = await agentsCard(w);
    const done = await press(w, card, "Close"); // the first Close is the newest session's
    assert.deepEqual(
      w.server.commandsOf("close").map((c) => c.session_id),
      [drop],
    );
    assert.equal(w.server.session(keep).status, "active");
    assert.ok(textsIn(done)[1]?.includes("Closed session 1 in /home/me/drop."), textsIn(done).join(" | "));
    assert.ok(JSON.stringify(done).includes(keep) && !JSON.stringify(done).includes(drop));
  }));

test("close session on a phone is said in a new message", () =>
  remoteWorld(async (w) => {
    // the whole list comes back as a NEW message with the outcome on its first line, and the tapped card is deleted
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const drop = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/drop" });
    const card = await agentsCard(w);
    const before = w.operations().length;
    await press(w, card, "Close");
    assert.deepEqual(
      w.server.commandsOf("close").map((c) => c.session_id),
      [drop],
    );
    const after = w.operations().slice(before);
    assert.deepEqual(
      after.filter((o) => o.op === "update" && o.id === "card-1"),
      [],
    );
    assert.deepEqual(
      after.filter((o) => (o.op === "send" || o.op === "post") && !o.card && o.text),
      [],
    );
    const cards = after.filter((o) => (o.op === "send" || o.op === "post") && o.card).map((o) => o.card ?? {});
    assert.equal(cards.length, 1);
    assert.equal(textsIn(cards[0] ?? {})[1], "Closed session 1 in /home/me/drop.");
    assert.ok(titles(cards[0] ?? {}).includes("Refresh"));
    assert.deepEqual(
      after.filter((o) => o.op === "delete").map((o) => o.id),
      ["card-1"],
    );
  }));

test("close of the attached session ends the attachment and says so", () =>
  remoteWorld(async (w) => {
    const { sid } = await attached(w, promptScript());
    await w.say("hello");
    await w.say("/agent sessions");
    const done = await press(w, w.cards().at(-1) ?? {}, "Close");
    assert.equal(w.server.session(sid).status, "closed");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.ok(
      textsIn(done)[1]?.includes("Closed session 1 in /home/me/repo. Your messages go to PrimusClaw again."),
      textsIn(done).join(" | "),
    );
    // the status card says it, in place
    assert.ok(
      w.statusEdits().at(-1)?.[1].includes("The session has ended; back to the assistant"),
      w.statusEdits().at(-1)?.[1] ?? "",
    );
  }));

test("close of a session that is not the users does nothing", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    const theirs = w.server.addSession(BOB, bobs, "codex", { cwd: "/home/bob/secret" });
    await w.say("/agents");
    const done = await pressData(w, { op: "close", session_id: theirs });
    assert.deepEqual(w.server.commandsOf("close"), []);
    assert.equal(w.server.session(theirs).status, "active");
    assert.ok(textsIn(done)[1]?.includes("could not find that session"));
  }));

test("refresh gives the list again and buttons that are off or unknown say so", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const card = await agentsCard(w);
    w.server.addConnector(ALICE, "laptop", [["cursor", "cursor", "Cursor"]]);
    const done = await press(w, card, "Refresh");
    assert.ok(textsIn(done).join(" ").includes("**laptop** (online)"));
    assert.ok(textsIn(await pressData(w, { op: "frobnicate" }))[0]?.includes("no longer valid"));
    assert.ok(textsIn(await pressData(w, { op: "" }))[0]?.includes("no longer valid"));
    w.settings.enabled = false;
    assert.ok(textsIn(await pressData(w, { op: "list" }))[0]?.includes("not active any more"));
  }));
