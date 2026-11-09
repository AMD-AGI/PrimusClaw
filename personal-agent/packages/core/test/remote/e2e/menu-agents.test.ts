// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The card /agents answers with (teams/tests/test_remote_menu.py, first part).
import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_BLOCKS_MAX } from "../../../src/remote-view/limits.js";
import { assertValidCard } from "../../../../../test-support/adaptive-card.js";
import { ALICE, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS } from "./helpers.js";
import { CAPS, ROOTS, agentsCard, buttonsIn, dataOf, inputsIn, textsIn, titles } from "./menu.js";

const sessionButtons = (card: Record<string, unknown>) =>
  buttonsIn(card)
    .filter((b) => ["attach", "close", "detach"].includes(String(dataOf(b)["op"])))
    .map((b) => [b["title"], dataOf(b)["session_id"]]);

test("agents answers with one card with a block per online agent and nothing for the others", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    w.server.addConnector(ALICE, "laptop", [["cursor", "cursor", "Cursor"]], { online: false });
    w.server.addConnector(BOB, "bobs-box", TWO_AGENTS, { caps: CAPS });
    await w.say("/agents");
    assert.equal(w.cards().length, 1);
    const card = w.cards()[0] ?? {};
    assertValidCard(card);
    const text = textsIn(card).join(" | ");
    assert.ok(text.includes("**dev-pod** (online)") && text.includes("**laptop** (offline)"), text);
    assert.ok(text.includes("Cursor (offline)") && !text.includes("bobs-box"), text);
    // per online agent: a choice among the folders it reported, a subfolder to type, one button; the offline agent has none
    const inputs = inputsIn(card);
    assert.deepEqual(Object.keys(inputs), ["root0", "dir0", "root1", "dir1"]);
    const choices = (id: string) =>
      ((inputs[id]?.["choices"] ?? []) as Record<string, unknown>[]).map((c) => c["value"]);
    assert.deepEqual(choices("root0"), ROOTS);
    assert.equal(inputs["root0"]?.["value"], ROOTS[0]);
    assert.equal(inputs["root0"]?.["style"], "compact");
    assert.deepEqual(choices("root1"), ["/home/me/work"]);
    assert.equal(inputs["dir0"]?.["type"], "Input.Text");
    assert.deepEqual(titles(card), ["New session", "New session", "Refresh", "Connect a new machine"]);
    const [first, second] = buttonsIn(card);
    assert.deepEqual(dataOf(first), { primusclaw: "remote", op: "new", connector_id: cid, agent_id: "codex", slot: 0 });
    assert.equal(dataOf(second)["agent_id"], "claude");
    assert.equal(dataOf(second)["slot"], 1);
    assert.ok(!Object.keys(inputs).some((i) => i.startsWith("appr"))); // nothing is said about unattended modes: nothing offered
    assert.deepEqual([...new Set(w.server.keysSeen)], ["ak-alice"]);
  }));

test("an agent that reports no folders gets one field for the whole folder", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS); // an older connector: capabilities is empty
    const card = await agentsCard(w);
    const inputs = inputsIn(card);
    assert.deepEqual(Object.keys(inputs), ["dir0", "dir1"]);
    assert.ok(Object.values(inputs).every((i) => i["type"] === "Input.Text"));
    assert.equal(inputs["dir0"]?.["label"], "Folder on the machine");
  }));

test("the sessions below are the users active ones newest first with the right buttons", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    const old = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    const recent = w.server.addSession(ALICE, cid, "claude", { cwd: "/home/me/b" });
    const gone = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/closed", status: "closed" });
    w.server.session(recent).updated_at = "2026-10-29T07:00:00.000Z";
    w.server.addSession(BOB, bobs, "codex", { cwd: "/home/bob/secret" });
    let card = await agentsCard(w);
    const lines = textsIn(card).filter((t) => ["1.", "2.", "3."].includes(t.slice(0, 2)));
    // each by its name (a session started elsewhere has none here: "New session"), its agent, the folder's last part, the machine
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.startsWith("1. 🟠 Claude Code · **New session** · b · dev-pod ("), lines[0] ?? "");
    assert.ok(lines[1]?.startsWith("2. ⬛ Codex · **New session** · a · dev-pod ("), lines[1] ?? "");
    assert.ok(!textsIn(card).join(" ").includes("/home/bob/secret"));
    assert.ok(!textsIn(card).join(" ").includes("closed"));
    assert.deepEqual(sessionButtons(card), [
      ["Attach", recent],
      ["Close", recent],
      ["Attach", old],
      ["Close", old],
    ]);
    assert.ok(!JSON.stringify(card).includes(gone));
    assert.deepEqual(w.test.store.remoteState.getRemote(AAD)?.listing, [recent, old]); // (`/agent attach 1` still works)
    // the one the chat is attached to offers Detach instead of Attach
    await w.say("/agent attach 2");
    card = await agentsCard(w);
    assert.deepEqual(sessionButtons(card), [
      ["Attach", recent],
      ["Close", recent],
      ["Detach", old],
      ["Close", old],
    ]);
  }));

test("agent alone shows the card as help and with no machine says how to connect one", () =>
  remoteWorld(async (w) => {
    for (const text of ["/agent", "/agent  ", "/AGENT"]) {
      await w.say(text);
      assert.ok(w.last().includes("claw-connector login --server "), w.last());
      assert.ok(w.last().includes("npm install -g @primusclaw/connector"), w.last());
    }
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    for (const text of ["/agent", "/agent  ", "/agents", "/agents frobnicate"]) {
      await w.say(text);
      const card = w.cards().at(-1) ?? {};
      assertValidCard(card);
      assert.equal(textsIn(card)[0], "🖥️ Your agents", text);
      assert.deepEqual(titles(card).slice(0, 1), ["New session"], text);
    }
    await w.say("/agent frobnicate"); // a subcommand that does not exist is still a mistake: the usage
    assert.ok(w.last().includes("`/agent new AGENT PATH`") && w.last().includes("`/agent off`"), w.last());
  }));

test("agent sessions lists every session of every machine on one card", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    await w.say("/agent sessions");
    let card = w.cards().at(-1) ?? {};
    assertValidCard(card);
    assert.equal(textsIn(card)[0], "🗂️ Your sessions");
    assert.deepEqual(titles(card), ["Refresh"]);
    assert.ok(textsIn(card).includes("no session"), textsIn(card).join(" | "));
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    await w.say("/agent sessions");
    card = w.cards().at(-1) ?? {};
    assertValidCard(card);
    assert.deepEqual(inputsIn(card), {});
    assert.ok(textsIn(card).join(" ").includes("dev-pod"));
    assert.deepEqual(titles(card), ["Switch to it", "Close", "Refresh"]);
    assert.equal(dataOf(buttonsIn(card)[0])["session_id"], sid);
    w.server.session(sid).status = "closed"; // a closed session is not one to switch to
    await w.say("/agent sessions");
    assert.deepEqual(titles(w.cards().at(-1) ?? {}), ["Refresh"]);
  }));

test("a button title and text that a machine chose cannot make markup or a link", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "evil [click](http://e.test) _x_", [["a", "codex", "Name [l](http://e.test) *b*"]], {
      caps: { a: { roots: ["/home/me/<b>my_repo_2</b>"] } },
    });
    const card = await agentsCard(w);
    // (no link of the worker's own either: the console page is not linked from a card any more, a phone cannot open it)
    const text = textsIn(card).join(" ");
    assert.ok(!text.includes("](") && !text.includes("<b>"), text);
    assert.ok(text.includes("\\_x\\_") && text.includes("\\*b\\*"), text);
    const choices = (inputsIn(card)["root0"]?.["choices"] ?? []) as Record<string, unknown>[];
    assert.deepEqual(
      choices.map((c) => c["title"]),
      ["/home/me/‹b›my_repo_2‹/b›"],
    );
    assert.equal(choices[0]?.["value"], "/home/me/<b>my_repo_2</b>"); // the value is the root itself
  }));

test("more online agents than a phone scrolls through are counted not listed", () =>
  remoteWorld(async (w) => {
    const many = Array.from(
      { length: AGENT_BLOCKS_MAX + 2 },
      (_, n) => [`a${String(n)}`, "codex", `Agent ${String(n)}`] as const,
    );
    w.server.addConnector(ALICE, "dev-pod", many, {
      caps: Object.fromEntries(many.map(([a]) => [a, { roots: ["/r"] }])),
    });
    const card = await agentsCard(w);
    assert.equal(titles(card).filter((t) => t === "New session").length, AGENT_BLOCKS_MAX);
    assert.ok(textsIn(card).join(" ").includes("2 more agents not shown"));
  }));
