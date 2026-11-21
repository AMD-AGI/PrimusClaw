// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A group bound to one of the sender's sessions while the session card is the window (REMOTE_WINDOW_DEFAULT=card): the router in
// front of the real remote agents, the real Claw client and the fake remote-agents server. The binder talks to the session with an
// @-message or with the card's own box and Send; another member's press changes nothing; Back to assistant unbinds it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { INPUT_ID } from "../../../src/remote/window/view.js";
import { ALICE as CLAW_ALICE, Script, USER_B } from "../../../../../test-support/remote-world.js";
import { cardWords, windowCards } from "../../remote/e2e/window-helpers.js";
import { clickOf, message } from "../world.js";
import { type Routed, TWO_AGENTS, routed } from "./remote-routed.js";

const GROUP_KEY = "aad-a#g-1";
const CARD = { remote: { windowDefault: "card" } } as const;

const prompts = (w: Routed): unknown[] => w.rw.server.commandsOf("prompt").map((c) => c.body["text"]);
const cardOf = (w: Routed, key = GROUP_KEY): string => w.rw.test.store.remoteState.getRemote(key)?.statusCard ?? "";
const boundTo = (w: Routed, key = GROUP_KEY): string | null =>
  w.rw.test.store.remoteState.attachedRemote(key)?.sessionId ?? null;

/** Alice's claude session on dev-pod, started in her 1:1 chat and left there; then the group is switched to it. */
async function boundGroup(w: Routed): Promise<string> {
  w.rw.server.addConnector(CLAW_ALICE, "dev-pod", TWO_AGENTS);
  const script = new Script();
  script.onPrompt = async (srv, sid) => {
    await srv.say(sid, "Done: GROUP-ANSWER-7.");
    await srv.end(sid);
  };
  w.rw.server.onCommand = script.hook;
  await w.say("/agent new claude /home/me/repo");
  await w.say("/agent detach");
  await w.say("切到 dev-pod 上的 claude 会话", { group: true });
  const sid = boundTo(w);
  assert.ok(sid, w.rw.said().join("\n"));
  assert.equal(w.rw.test.store.remoteState.attachedRemote(GROUP_KEY)?.window, "card");
  assert.ok(cardOf(w));
  return sid;
}

/** A press on a group session card, as Teams sends it. */
async function press(
  w: Routed,
  data: Record<string, unknown>,
  card: string,
  user = undefined as typeof USER_B | undefined,
) {
  await w.r.router.handle(
    clickOf("remote", { primusclaw: "remote", ...data }, { group: true, card, ...(user ? { user } : {}) }),
  );
  await w.rw.idle();
}

test("test_a_bound_groups_next_mention_goes_to_the_session_while_the_card_is_the_window", () =>
  routed(async (w) => {
    await boundGroup(w);
    await w.say("run the tests", { group: true });
    assert.deepEqual(prompts(w), ["run the tests"]);
    assert.deepEqual(w.r.turns.calls, [], "nothing went to the assistant");
    await w.rw.until(() => cardWords(windowCards(w.rw).at(-1)?.card).includes("GROUP-ANSWER-7"));
    const words = cardWords(windowCards(w.rw).at(-1)?.card);
    assert.ok(words.includes("In this group, what you say to @PrimusClaw Assistant goes to this session"), words);
    assert.ok(words.includes('say "@PrimusClaw Assistant back to the assistant"'), words);
    // (another member's mention is still the assistant's)
    await w.say("what is the weather", { group: true, user: USER_B });
    assert.deepEqual(prompts(w), ["run the tests"]);
    assert.deepEqual(w.r.turns.calls, [["create", "ak-bob", "what is the weather"]]);
  }, CARD));

test("test_send_on_a_groups_session_card_reaches_the_session", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    await press(w, { op: "send", session_id: sid, [INPUT_ID]: "fix the README" }, cardOf(w));
    assert.deepEqual(prompts(w), ["fix the README"]);
    assert.ok(!w.rw.said().includes("That button is not active any more."), w.rw.said().join("\n"));
    await w.rw.until(() => cardWords(windowCards(w.rw).at(-1)?.card).includes("GROUP-ANSWER-7"));
    assert.ok(cardWords(windowCards(w.rw).at(-1)?.card).includes("You sent from the card: fix the README"));
    assert.deepEqual(w.r.turns.calls, []);
  }, CARD));

test("test_a_tap_on_a_groups_session_card_carries_the_key_the_binders_mentions_carry", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    // (what the follower reads with is another credential: the tap must act as the account the group was bound with)
    w.rw.credential = () => Promise.resolve("ak-bob");
    await press(w, { op: "send", session_id: sid, [INPUT_ID]: "fix the README" }, cardOf(w));
    assert.deepEqual(prompts(w), ["fix the README"]);
    const sent = w.rw.server.calls.filter(([method, path]) => method === "POST" && path.includes(sid));
    assert.ok(sent.length > 0 && sent.every((c) => c[2] === CLAW_ALICE), JSON.stringify(sent));
  }, CARD));

test("test_a_tap_on_a_groups_session_card_after_unlinking_sends_nothing", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    w.r.store.links.unlink("aad-a");
    await press(w, { op: "send", session_id: sid, [INPUT_ID]: "again" }, cardOf(w));
    assert.deepEqual(prompts(w), []);
    assert.ok(!w.rw.said().includes("That button is not active any more."), w.rw.said().join("\n"));
  }, CARD));

test("test_another_member_pressing_a_groups_session_card_changes_nothing", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    const card = cardOf(w);
    const before = w.rw.operations().length;
    for (const op of ["send", "stop", "detach"])
      await press(w, { op, session_id: sid, [INPUT_ID]: "rm -rf build" }, card, USER_B);
    assert.deepEqual(prompts(w), []);
    assert.equal(boundTo(w), sid, "still bound");
    assert.equal(w.rw.last(), "Only the person who switched this group to the session can use its card.");
    // (the card is put back as Alice's window, never closed down to a note)
    const edits = w.rw
      .operations()
      .slice(before)
      .filter((o) => o.op === "update" && o.id === card);
    assert.equal(edits.length, 3);
    assert.ok(
      edits.every((o) => JSON.stringify(o.card ?? null).includes("window_tail")),
      JSON.stringify(edits),
    );
  }, CARD));

test("test_back_to_assistant_on_a_groups_session_card_unbinds_it_and_its_card_binds_it_again", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    const card = cardOf(w);
    await press(w, { op: "detach", session_id: sid }, card);
    assert.equal(boundTo(w), null);
    assert.equal(w.rw.server.sessions.get(sid)?.status, "active", "the session goes on on the machine");
    await w.say("hello again", { group: true });
    assert.deepEqual(prompts(w), []);
    assert.deepEqual(w.r.turns.calls, [["create", "ak-alice", "hello again"]]);
    // "Back to this session" on the card it left
    await press(w, { op: "attach", session_id: sid }, cardOf(w));
    assert.equal(boundTo(w), sid, w.rw.said().join("\n"));
    await w.say("and now", { group: true });
    assert.deepEqual(prompts(w), ["and now"]);
  }, CARD));

test("test_a_groups_session_card_never_shows_the_lists", () =>
  routed(async (w) => {
    const sid = await boundGroup(w);
    const window = windowCards(w.rw).at(-1)?.card;
    assert.ok(!cardWords(window).includes("Switch") && !JSON.stringify(window).includes('"op":"switch"'));
    for (const op of ["switch", "list", "new", "pair"]) {
      const before = w.rw.operations().length;
      await press(w, { op, session_id: sid }, cardOf(w));
      assert.match(w.rw.last(), /^In a group, the session card acts only on its session\./u, op);
      const later = w.rw.operations().slice(before);
      assert.ok(
        !later.some(
          (o) => JSON.stringify(o.card ?? null).includes("dev-pod") && !JSON.stringify(o.card).includes("window_tail"),
        ),
        op,
      );
    }
    assert.equal(boundTo(w), sid);
    assert.deepEqual(w.rw.server.commandsOf("prompt"), []);
    // (a tap the card may make that cannot be done ends with its line, never with the binder's lists in front of the group)
    await press(w, { op: "detach", session_id: sid }, cardOf(w));
    const before = w.rw.operations().length;
    await press(w, { op: "attach", session_id: "no-such-session" }, cardOf(w));
    assert.equal(boundTo(w), null);
    const later = w.rw.operations().slice(before);
    assert.deepEqual(
      later.filter((o) => o.op === "post"),
      [],
      JSON.stringify(later),
    );
    assert.ok(
      later.every((o) => !JSON.stringify(o.card ?? null).includes('"primusclaw":"remote"')),
      JSON.stringify(later),
    );
  }, CARD));

test("test_a_groups_session_card_speaks_the_groups_language_never_the_binders_own", () =>
  routed(async (w) => {
    w.rw.setLang("aad-a", "zh"); // (the binder writes Chinese in her 1:1 chat)
    await boundGroup(w);
    await w.say("run the tests", { group: true });
    await w.rw.until(() => cardWords(windowCards(w.rw).at(-1)?.card).includes("GROUP-ANSWER-7"));
    let words = cardWords(windowCards(w.rw).at(-1)?.card);
    assert.ok(words.includes("In this group, what you say to @PrimusClaw Assistant goes to this session"), words);
    assert.ok(!words.includes("在这个群里"), words);
    // (the group sets Chinese: the card follows the group)
    w.rw.test.store.groupLanguage.setGroupLanguage("g-1", "zh");
    await w.say("run them again", { group: true });
    await w.rw.until(() => cardWords(windowCards(w.rw).at(-1)?.card).includes("在这个群里"));
    words = cardWords(windowCards(w.rw).at(-1)?.card);
    assert.ok(words.includes("在这个群里你 @PrimusClaw Assistant 说的话都发给这个会话"), words);
    // (and her 1:1 English does not pull a Chinese group back)
    w.rw.setLang("aad-a", "en");
    await w.say("and once more", { group: true });
    await w.rw.until(() => prompts(w).length === 3);
    await w.rw.idle();
    assert.ok(cardWords(windowCards(w.rw).at(-1)?.card).includes("在这个群里"));
  }, CARD));

/** The approval card a group binding sends to the binder's 1:1 chat, the row it keeps, and the group's notice that it waits. */
async function askedFromTheGroup(w: Routed): Promise<{ sid: string; words: string; notice: string }> {
  const sid = await boundGroup(w);
  const script = new Script();
  script.onPrompt = async (srv, s) => {
    await srv.ask(s, "act-1", "Edit", [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }]);
  };
  w.rw.server.onCommand = script.hook;
  await w.r.router.handle(message("add a line to the README", { kind: "group" })); // (the turn now waits for the answer)
  const noticeOf = (): string => w.rw.said().find((t) => t.includes("your approval") || t.includes("在等你批准")) ?? "";
  await w.rw.until(() => w.rw.permissionCards().length > 0 && noticeOf() !== "");
  const words = cardWords(w.rw.permissionCards().at(-1));
  const notice = noticeOf();
  return { sid, words, notice };
}

test("test_a_groups_approval_card_in_the_binders_1on1_chat_speaks_her_language_not_the_groups", () =>
  routed(async (w) => {
    w.rw.setLang("aad-a", "zh"); // (her 1:1 chat is Chinese; the group never set a language, so it is English)
    const { sid, words, notice } = await askedFromTheGroup(w);
    assert.ok(words.includes("需要你批准"), words);
    assert.ok(!words.includes("Approval needed"), words);
    assert.equal(w.rw.test.store.remotePermissions.getRemotePermission(sid, "act-1")?.lang, "zh");
    // (the group is told in its own language that the card went to her 1:1 chat)
    assert.ok(notice.includes("is waiting for your approval"), notice);
    // (her click in the 1:1 chat is answered, and the card settled, in her language too)
    const actions = (w.rw.permissionCards().at(-1)?.["actions"] ?? []) as Record<string, unknown>[];
    const allow = actions.find((a) => (a["data"] as Record<string, unknown>)["option_id"] === "allow_once") ?? {};
    const data = allow["data"] as Record<string, unknown>;
    await w.r.router.handle(clickOf(String(data["primusclaw"]), data, { card: "card-9" }));
    await w.rw.until(() => w.rw.server.commandsOf("decision").length === 1);
    const settledOf = (): string => [...w.rw.cards().map((c) => cardWords(c)), ...w.rw.said()].join("\n");
    await w.rw.until(() => settledOf().includes("已允许一次") || settledOf().includes("Allowed once"));
    const settled = settledOf();
    assert.ok(settled.includes("已允许一次"), settled);
    assert.ok(!settled.includes("Allowed once"), settled);
  }, CARD));

test("test_a_chinese_groups_approval_card_stays_in_an_english_binders_own_language", () =>
  routed(async (w) => {
    w.rw.setLang("aad-a", "en");
    w.rw.test.store.groupLanguage.setGroupLanguage("g-1", "zh");
    const { sid, words, notice } = await askedFromTheGroup(w);
    assert.ok(words.includes("Approval needed"), words);
    assert.ok(!words.includes("需要你批准"), words);
    assert.equal(w.rw.test.store.remotePermissions.getRemotePermission(sid, "act-1")?.lang, "en");
    assert.ok(notice.includes("在等你批准"), notice);
    // (the turn waiting on the card is answered, so the world goes quiet)
    const actions = (w.rw.permissionCards().at(-1)?.["actions"] ?? []) as Record<string, unknown>[];
    const data = (actions[0]?.["data"] ?? {}) as Record<string, unknown>;
    await w.r.router.handle(clickOf(String(data["primusclaw"]), data, { card: "card-9" }));
    await w.rw.until(() => w.rw.server.commandsOf("decision").length === 1);
  }, CARD));
