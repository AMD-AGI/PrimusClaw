// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Remote agents from the chat: disconnecting a machine, connecting a new one, whose key every call carries, and the answer of a
// turn as a message of its own, through the real Claw client.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, type RemoteWorld, Script, USER_B, remoteWorld } from "../../../../../test-support/remote-world.js";
import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import { AAD, BOB, TWO_AGENTS, attached, oneTurn } from "./helpers.js";

type Json = Record<string, unknown>;
const actionsOf = (card: Json | undefined): Json[] => (card?.["actions"] ?? []) as Json[];
const dataOf = (action: Json | undefined): Json => (action?.["data"] ?? {}) as Json;
const offCard = (cards: Json[]): Json | undefined =>
  cards.filter((c) => actionsOf(c).some((a) => a["verb"] === "primusclaw.remote_off")).at(-1);
const headerOf = (card: Json | undefined): unknown => {
  const first = ((card?.["body"] ?? []) as Json[])[0] ?? {};
  const columns = (first["columns"] ?? []) as Json[];
  return ((columns.at(-1)?.["items"] ?? []) as Json[])[0]?.["text"];
};

test("off asks first and disconnects only on yes", () =>
  remoteWorld(async (w) => {
    const { cid, sid } = await attached(w);
    await w.say("/agent off");
    const card = offCard(w.cards());
    assert.equal(headerOf(card), "🔌 Disconnect dev-pod?"); // (the card kit's header, with its emoji)
    const keep = actionsOf(card).find((a) => dataOf(a)["confirm"] === false);
    const yes = actionsOf(card).find((a) => dataOf(a)["confirm"] === true);
    assert.ok(keep && yes);
    assert.equal(yes["style"], "destructive");
    assert.equal(dataOf(yes)["connector_id"], cid);
    assert.equal(w.server.calls.filter(([m]) => m === "DELETE").length, 0);
    await w.click(dataOf(keep));
    assert.equal(w.last(), "OK. Nothing was disconnected.");
    assert.equal(w.server.connector(cid).revoked, false);
    await w.click(dataOf(yes));
    assert.ok(w.server.connector(cid).revoked && w.server.session(sid).status === "closed");
    assert.ok(w.last().startsWith("Disconnected dev-pod."), w.last());
    assert.ok(
      w
        .last()
        .includes(
          `run \`claw-connector login --server ${w.server.url} --identity-url ${w.server.url}\` on that machine`,
        ),
      w.last(),
    );
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    await w.click(dataOf(yes)); // pressed again
    assert.equal(w.last(), "That machine is already disconnected.");
  }));

test("off speaks the chat language", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    const { cid, sid } = await attached(w);
    await w.say("/agent off");
    const card = offCard(w.cards());
    assert.equal(headerOf(card), "🔌 断开 dev-pod？");
    assert.ok(
      JSON.stringify(card ?? {}).includes("发 `/agent pair`（或说“连接我的开发环境”）拿一行命令"),
      JSON.stringify(card),
    );
    assert.deepEqual(
      actionsOf(card)
        .map((a) => a["title"])
        .sort(),
      ["保留", "断开"],
    );
    const keep = actionsOf(card).find((a) => dataOf(a)["confirm"] === false);
    const yes = actionsOf(card).find((a) => dataOf(a)["confirm"] === true);
    await w.click(dataOf(keep));
    assert.equal(w.last(), "好的，没有断开任何机器。");
    assert.equal(w.server.connector(cid).revoked, false);
    await w.click(dataOf(yes));
    assert.ok(w.server.connector(cid).revoked && w.server.session(sid).status === "closed");
    assert.ok(w.last().startsWith("已断开 dev-pod。") && w.last().includes("发 `/agent pair`"), w.last());
    assert.ok(w.last().includes(`\`claw-connector login --server ${w.server.url} --identity-url ${w.server.url}\``));
    await w.click(dataOf(yes));
    assert.equal(w.last(), "这台机器已经断开了。");
  }));

test("off a paired machine points to a new pairing command not login", async () => {
  for (const [lang, ask, said, title] of [
    [
      "zh",
      "在这里说“连接我的开发环境”（或发 `/agent pair`），拿一行配对命令到那台机器上运行",
      "已断开 box。",
      "🔌 断开 box？",
    ],
    [
      "en",
      "ask here for a new pairing command (or send `/agent pair`) and run it on that machine",
      "Disconnected box.",
      "🔌 Disconnect box?",
    ],
  ] as const) {
    await remoteWorld(async (w) => {
      w.setLang(AAD, lang);
      const cid = w.server.addConnector(ALICE, "box", TWO_AGENTS, { paired: true });
      await w.say("/agent off box");
      const card = offCard(w.cards());
      const shown = JSON.stringify(card ?? {});
      assert.equal(headerOf(card), title);
      assert.ok(
        shown.includes(JSON.stringify(ask).slice(1, -1)) &&
          !shown.includes("claw-connector login") &&
          !shown.includes("--identity-url"),
      );
      const yes = actionsOf(card).find((a) => dataOf(a)["confirm"] === true);
      await w.click(dataOf(yes));
      assert.ok(w.server.connector(cid).revoked);
      assert.ok(
        w.last().startsWith(said) && w.last().includes(ask) && !w.last().includes("claw-connector login"),
        w.last(),
      );
    });
  }
});

test("the agents card connects a new machine with one tap", async () => {
  for (const [lang, title, lead] of [
    ["zh", "连接新机器", "连接新机器：命令在上面的消息里"],
    ["en", "Connect a new machine", "To connect a new machine: the command is in the message above"],
  ] as const) {
    await remoteWorld(async (w) => {
      w.setLang(AAD, lang);
      w.server.pairing = true;
      w.server.addConnector(ALICE, "routeguard-eval", TWO_AGENTS, { online: false });
      await w.say("/agents");
      const pair = actionsOf(w.cards().at(-1)).find((a) => dataOf(a)["op"] === "pair");
      assert.equal(pair?.["title"], title);
      await w.click(dataOf(pair));
      const said = w.said().filter((t) => t.includes("claw-connector pair ABCD-EFGH-0001"));
      assert.equal(said.length, 1, w.said().join(" | "));
      assert.ok(said[0]?.includes("--no-update-notifier"));
      const first = said[0] ?? "";
      assert.ok(first.startsWith("连接新机器：") || first.startsWith("To connect a new machine:"), first);
      assert.deepEqual(w.server.pairings, [ALICE]);
      assert.ok(JSON.stringify(w.cards().at(-1) ?? {}).includes(lead));
      assert.ok(
        actionsOf(w.cards().at(-1)).some((a) => dataOf(a)["op"] === "pair"),
        "the card comes back with the button",
      );
    });
  }
});

test("off names the machine when there are several and cannot touch anyone elses", () =>
  remoteWorld(async (w) => {
    const mine = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.addConnector(ALICE, "laptop", TWO_AGENTS);
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    await w.say("/agent off");
    assert.equal(w.last(), "Which machine? Use `/agent off NAME` with one of `dev-pod`, `laptop`.");
    await w.say("/agent off bobs-box");
    assert.ok(w.last().startsWith("Which machine?"));
    await w.say("/agent off dev-pod");
    assert.equal(dataOf(actionsOf(offCard(w.cards()))[0])["connector_id"], mine);
    await w.click({ primusclaw: "remote_off", connector_id: bobs, confirm: true });
    assert.equal(w.last(), "That machine is already disconnected.");
    assert.equal(w.server.connector(bobs).revoked, false);
    assert.equal(w.server.calls.filter(([m]) => m === "DELETE").length, 0);
  }));

test("everything a user does uses that users key only", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(BOB, "bobs-box", [["codex", "codex", "Codex"]]);
    const script = new Script();
    script.onPrompt = oneTurn;
    await attached(w, script);
    await w.say("go");
    await w.say("/agents");
    await w.say("/agent sessions");
    assert.deepEqual(new Set(w.server.keysSeen), new Set(["ak-alice"]));
    assert.deepEqual(new Set(w.server.calls.map(([, , u]) => u)), new Set([ALICE]));
    w.server.calls.length = 0;
    await w.say("/agents", USER_B);
    assert.ok(w.last().includes("bobs-box") && !w.last().includes("dev-pod"), w.last());
    assert.deepEqual(new Set(w.server.calls.map(([, , u]) => u)), new Set([BOB]));
  }));

/** A turn that runs a long step, `seconds` of the store's clock, then answers. */
function longTurn(w: RemoteWorld, seconds: number) {
  return async (srv: FakeRemote, sid: string): Promise<void> => {
    await srv.say(sid, "Working through the suite. ");
    await srv.tool(sid, "t1", "Run the whole test suite");
    w.test.clock.setEpochMs(w.test.clock.epochMs() + seconds * 1000);
    await srv.tool(sid, "t1", "Run the whole test suite", "completed");
    await srv.say(sid, "All 212 tests pass.");
    await srv.end(sid);
  };
}

test("the answer of a remote turn is a new message and never only an edit of the progress message", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    await attached(w, script);
    script.onPrompt = longTurn(w, 5);
    const before = w.surface.outbox.length;
    await w.say("run the tests");
    const turn = w.surface.outbox.slice(before);
    const textOf = (r: (typeof turn)[number]): string =>
      "message" in r && r.message.body.type !== "view" ? JSON.stringify(r.message.body) : "";
    const mine = turn.filter((r) => textOf(r).includes("All 212 tests pass.") && !textOf(r).includes("Working on it"));
    assert.deepEqual(
      mine.map((r) => r.op),
      ["send"],
    ); // exactly one message carries the answer, and it is a new one
    const progress = turn
      .filter((r) => r.op === "post" && textOf(r).includes("Working on it"))
      .map((r) => ("id" in r ? r.id : ""));
    const deletes = turn.filter((r) => r.op === "delete");
    assert.deepEqual(
      deletes.map((r) => ("id" in r ? r.id : "")),
      progress.slice(-1),
    ); // the progress message goes
    assert.ok(deletes[0] && mine[0] && turn.indexOf(deletes[0]) > turn.indexOf(mine[0])); // after the answer is posted
    assert.ok(!turn.some((r) => r.op === "update" && mine[0] !== undefined && textOf(r) === textOf(mine[0])));
  }));

test("a long remote turn ends in one new message not an answer and a notice", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    await attached(w, script);
    script.onPrompt = longTurn(w, 600);
    const before = w.surface.outbox.length;
    await w.say("the long one");
    const sends = w.surface.outbox
      .slice(before)
      .filter((r) => (r.op === "send" || r.op === "post") && r.message.body.type !== "view");
    assert.equal(sends.length, 2); // progress post, answer: no card under it
    assert.ok(
      !w.cards().some((c) => {
        const first = ((c["body"] ?? []) as Json[])[0]?.["text"];
        return typeof first === "string" && /(?:finished|stopped)$/u.test(first);
      }),
    );
  }));
