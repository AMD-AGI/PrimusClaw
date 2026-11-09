// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The session card on a phone (teams/tests/test_session_window.py, after #409): a phone never loses what is typed into the card,
// always sees how a turn ended, and Back to the assistant lets go at any time without touching the terminal.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import type { WindowView } from "../../../src/remote/window/view.js";
import { INPUT_ID } from "../../../src/remote/window/view.js";
import type { PermissionOption } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS, idleTurn, turnsOf } from "./helpers.js";
import {
  answering,
  approvalButtons,
  cardWords,
  hasBox,
  lastWindow,
  opsOn,
  prompts,
  sendFromCard,
  statusCardId,
  windowCards,
  windowed,
} from "./window-helpers.js";

const CARD = { windowDefault: "card" } as const;
const UNNAMED_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", kind: "allow_once" },
  { optionId: "reject", kind: "reject_once" },
] as unknown as PermissionOption[];

const viewOf = (w: RemoteWorld): WindowView | undefined =>
  (w.remote as unknown as { state: { existingView(chatKey: string): WindowView | undefined } }).state.existingView(AAD);
const sentTexts = (w: RemoteWorld): string =>
  w
    .operations()
    .filter((o) => o.op === "send")
    .map((o) => o.text)
    .join(" ");
const detach = (w: RemoteWorld, sid: string) =>
  w.click({ primusclaw: "remote", op: "detach", session_id: sid }, USER_A, statusCardId(w));

test("a running turn never edits or removes a card with the text box", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      for (let i = 0; i < 4; i += 1) {
        await srv.say(sid, `step ${String(i)} ` + "z".repeat(150) + "\n");
        await sleep(50);
      }
      await srv.end(sid);
    };
    const sid = await windowed(w, script);
    const tapped = statusCardId(w);
    assert.ok(hasBox(lastWindow(w)), "an idle session's card takes input");
    const mark = w.operations().length;
    await sendFromCard(w, sid, "go");
    await w.idle();
    await sleep(200);
    const after = w.operations().slice(mark);
    const boxed = after.flatMap((o, k) => (o.op === "update" && hasBox(o.card) ? [k] : []));
    // only the tap itself is answered on the card with the box; the turn's edits have none
    assert.deepEqual(boxed, [0]);
    assert.deepEqual(
      after.filter((o) => o.op === "delete").map((o) => o.id),
      [tapped],
    ); // (the card the turn ran on, which had no box from the turn's start)
    const last = after.filter((o) => o.op === "post").at(-1);
    assert.ok(hasBox(last?.card) && cardWords(last?.card).includes("Status: idle"));
  }, CARD));

test("the agent speaking on its own leaves the card with the box alone until the person acts", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w, answering());
    const first = statusCardId(w);
    assert.ok(hasBox(lastWindow(w)));
    const mark = w.operations().length;
    await w.server.say(sid, "a background job finished: BG-DONE-9");
    await w.until(() => {
      const words = cardWords(windowCards(w).at(-1)?.card);
      return words.includes("BG-DONE-9") && words.includes("Status: idle");
    }, 10_000);
    await sleep(500);
    assert.deepEqual(opsOn(w, first, mark), [], "the card the person may be typing into is left as it is");
    assert.notEqual(statusCardId(w), first);
    assert.ok(viewOf(w)?.kept.includes(first));
    // the person sends from the older card: what they typed goes, and the older card goes with it
    await sendFromCard(w, sid, "typed into the older card", first);
    await w.idle();
    assert.deepEqual(prompts(w), ["typed into the older card"]);
    assert.ok(opsOn(w, first).includes("delete"));
    assert.deepEqual(viewOf(w)?.kept, []);
  }, CARD));

test("a tap brings back what the box held", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w, answering());
    await w.click(
      { primusclaw: "remote", op: "full", session_id: sid, [INPUT_ID]: "half a sentence" },
      USER_A,
      statusCardId(w),
    );
    await w.idle();
    const box = w
      .operations()
      .filter((o) => o.op !== "delete" && hasBox(o.card))
      .at(-1)?.card;
    assert.ok(JSON.stringify(box).includes('"value":"half a sentence"'), JSON.stringify(box).slice(0, 300));
    // and Send empties it
    await sendFromCard(w, sid, "now whole");
    await w.idle();
    assert.ok(!JSON.stringify(lastWindow(w)).includes('"value":"half a sentence"'));
  }, CARD));

test("a turn that ends with no new output still posts the card again", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.tool(sid, "t1", "Run make", "in_progress");
      await srv.tool(sid, "t1", "Run make", "completed");
      await srv.end(sid);
    };
    const sid = await windowed(w, script);
    const mark = w.operations().length;
    await sendFromCard(w, sid, "build it");
    await w.idle();
    await sleep(200);
    const posted = windowCards(w, mark).filter((c) => c.op === "post");
    assert.ok(posted.length > 0 && cardWords(posted.at(-1)?.card).includes("Status: idle"));
  }, CARD));

for (const how of ["quote", "chat"] as const) {
  test(`the card says what was sent whichever way it went: ${how}`, () =>
    remoteWorld(async (w) => {
      const sid = await windowed(w, answering());
      await sendFromCard(w, sid, "first, from the card");
      await w.idle();
      if (how === "quote") {
        await w.say("second, quoting", USER_A, [statusCardId(w)]);
      } else {
        await w.say("/agent mode chat");
        await w.say("second, quoting");
      }
      await w.idle();
      await sleep(100);
      const view = viewOf(w);
      assert.equal(view?.sent, "second, quoting");
      assert.equal(view.sentFrom, how);
      if (how === "quote") {
        const words = cardWords(lastWindow(w));
        assert.ok(
          words.includes("You replied quoting the card: second, quoting") && !words.includes("first, from the card"),
          words,
        );
      }
    }, CARD));
}

test("an approval answered on the card says so on the card in the chats language", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    // (options the agent gave no name: the buttons say the kind's words, in the chat's language)
    script.onPrompt = async (srv, sid) => {
      await srv.ask(sid, "act-1", "Edit README.md", UNNAMED_OPTIONS, { input: { path: "README.md" } });
    };
    script.onDecision = async (srv, sid) => {
      await sleep(300);
      await srv.say(sid, "改好了");
      await srv.end(sid);
    };
    const sid = await windowed(w, script);
    w.setLang(AAD, "zh");
    await sendFromCard(w, sid, "改一下 README");
    await w.until(() => windowCards(w).some((c) => cardWords(c.card).includes("需要你批准：Edit README.md")));
    const card = [...windowCards(w)].reverse().find((c) => cardWords(c.card).includes("需要你批准"))?.card ?? {};
    const titles = approvalButtons(card).map((a) => a["title"]);
    assert.ok(titles.includes("允许一次") && !titles.includes("Allow once"), titles.join(", "));
    const button = approvalButtons(card).find(
      (a) => (a["data"] as Record<string, unknown>)["option_id"] === "allow_once",
    );
    const tapped = statusCardId(w);
    const mark = w.operations().length;
    await w.click((button?.["data"] ?? {}) as Record<string, unknown>, USER_A, tapped);
    await sleep(100);
    const after = w.operations().slice(mark);
    const plain = after.filter((o) => o.op === "send" && !o.card).map((o) => o.text);
    assert.ok(!plain.some((t) => t.includes("Allowed once") || t.includes("已允许一次")), plain.join(" | "));
    const reposted = windowCards(w, mark).filter((c) => c.op === "post");
    assert.ok(reposted.length > 0 && cardWords(reposted[0]?.card).includes("已允许一次：Edit README.md"));
    assert.ok(opsOn(w, tapped, mark).includes("delete"));
    await w.idle();
  }, CARD));

test("an empty send says so on a new card at the bottom", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w);
    const tapped = statusCardId(w);
    const mark = w.operations().length;
    await sendFromCard(w, sid, "  ");
    await w.idle();
    const reposted = windowCards(w, mark).filter((c) => c.op === "post");
    assert.ok(reposted.length > 0 && cardWords(reposted.at(-1)?.card).includes("Write in the box first"));
    assert.ok(opsOn(w, tapped, mark).includes("delete"));
    assert.deepEqual(prompts(w), []);
  }, CARD));

// --- attaching from the agents card, and leaving while a turn runs ------------------------------------------------------------

test("attaching from the agents card posts the session card anew and deletes the tapped one", () =>
  remoteWorld(async (w) => {
    await windowed(w);
    const first = statusCardId(w);
    const cid = [...w.server.connectors.keys()][0] ?? "";
    const sidB = w.server.addSession(ALICE, cid, "claude", { cwd: "/home/me/other" });
    await w.say("/agents");
    const agents = "card-agents";
    const mark = w.operations().length;
    await w.click({ primusclaw: "remote", op: "attach", session_id: sidB }, USER_A, agents);
    await w.idle();
    const after = w.operations().slice(mark);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, sidB);
    assert.deepEqual(
      after.filter((o) => o.id === agents).map((o) => o.op),
      ["delete"],
      "the tapped card goes, never edited",
    );
    const line = after.findIndex((o) => o.op === "send" && o.text.includes("Now: dev-pod"));
    const card = after.findIndex((o) => o.op === "post" && JSON.stringify(o.card ?? null).includes("Updated "));
    assert.ok(line >= 0 && line < card, "the line, then the card under it");
    const now = statusCardId(w);
    assert.ok(![agents, first].includes(now));
    assert.ok(cardWords(after[card]?.card).includes("Session window"));
    const retired = after.filter((o) => o.id === first && o.op === "update");
    assert.ok(retired.length > 0 && cardWords(retired.at(-1)?.card).includes("see the status card below"));
  }, CARD));

for (const via of ["tap", "typed"] as const) {
  test(`back to the assistant while a turn runs sends nothing to the machine: ${via}`, () =>
    remoteWorld(async (w) => {
      const script = new Script();
      script.onPrompt = async (srv, sid) => {
        await srv.say(sid, "working on it");
      };
      const sid = await windowed(w, script);
      await sendFromCard(w, sid, "a long job");
      await w.until(() => w.remote.running(AAD));
      const before = w.server.commands.length;
      if (via === "tap") await detach(w, sid);
      else await w.send("/agent detach");
      await w.idle();
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
      assert.deepEqual(
        w.server.commands.slice(before).map((c) => c.type),
        [],
      );
      const said = sentTexts(w);
      assert.ok(
        said.includes("That turn goes on on the machine, uninterrupted") && !said.includes("Send /stop first"),
        said,
      );
    }, CARD));
}

for (const withdraw of [false, true]) {
  test(`back to the assistant with a message still waiting for the terminal: ${withdraw ? "a connector that can withdraw" : "an older connector"}`, () =>
    remoteWorld(async (w) => {
      const script = new Script();
      script.onPrompt = async (srv, sid) => {
        await srv.emit(sid, "terminal_input_queued", { reason: "the terminal is busy" });
      };
      let sid: string;
      if (withdraw) {
        // (the connector says it can take back a waiting message)
        w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: { codex: { withdraw: true } } });
        w.server.onCommand = script.hook;
        await w.say("/agent new codex /home/me/repo");
        sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
      } else {
        sid = await windowed(w, script);
      }
      await sendFromCard(w, sid, "queued one");
      await w.until(
        () => (turnsOf(w).get(AAD) as { waitsForTerminal?: boolean } | undefined)?.waitsForTerminal === true,
      );
      const before = w.server.commands.length;
      await detach(w, sid);
      await w.idle();
      const sent = w.server.commands.slice(before).map((c) => c.type);
      const said = sentTexts(w);
      assert.ok(!sent.includes("cancel"));
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
      if (withdraw) {
        assert.deepEqual(sent, ["withdraw"]);
        assert.ok(said.includes("it was taken back and will not be sent"), said);
      } else {
        assert.deepEqual(sent, []);
        assert.ok(said.includes("It will still be typed there when the terminal is free"), said);
      }
    }, CARD));
}

test("a message already typed into the terminal is not withdrawn on detach", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.emit(sid, "terminal_input_queued", { reason: "the terminal is busy" });
      await srv.emit(sid, "user_message_chunk", {
        sessionId: "acp-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "typed there" } },
      });
    };
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: { codex: { withdraw: true } } });
    w.server.onCommand = script.hook;
    await w.say("/agent new codex /home/me/repo");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    await sendFromCard(w, sid, "queued, then typed");
    await w.until(() => turnsOf(w).get(AAD) !== undefined, 10_000);
    await sleep(500); // (both events read)
    assert.equal((turnsOf(w).get(AAD) as { waitsForTerminal: boolean }).waitsForTerminal, false);
    const before = w.server.commands.length;
    await detach(w, sid);
    await w.idle();
    assert.deepEqual(w.server.commands.slice(before), []);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    const said = sentTexts(w);
    assert.ok(!said.includes("taken back") && said.includes("That turn goes on"), said);
  }, CARD));

test("a send that is refused keeps the words in the box", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w, answering());
    turnsOf(w).set(AAD, idleTurn()); // (a turn of the chat's is running: the session takes no message now)
    await sendFromCard(w, sid, "please keep these words");
    await sleep(200);
    assert.deepEqual(prompts(w), []);
    assert.equal(viewOf(w)?.draft, "please keep these words");
    turnsOf(w).delete(AAD);
    // (any tap: the idle card shows the box with the words in it)
    await w.click({ primusclaw: "remote", op: "full", session_id: sid }, USER_A, statusCardId(w));
    await sleep(200);
    assert.ok(JSON.stringify(lastWindow(w)).includes('"value":"please keep these words"'));
    await sendFromCard(w, sid, "please keep these words");
    await w.idle();
    assert.deepEqual(prompts(w), ["please keep these words"]);
    assert.equal(viewOf(w)?.draft, "");
  }, CARD));
