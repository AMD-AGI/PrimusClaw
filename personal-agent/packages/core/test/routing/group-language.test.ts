// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A group chat's own language: set by any member (`@bot /lang zh|en|auto`, a sentence that names the group, or a pick on the card
 * its first @mention gets), announced in the chat with who set it, and then the language of everything the bot says there and of
 * the answers it is asked for, whatever any member chose for themselves. One test per rule, in both languages.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutMessage } from "../../src/ports/surface.js";
import { ALICE, BOB } from "./fixtures.js";
import { clickOf, link, message, said, world, type World } from "./world.js";

const CONV = "g-1";

function gmsg(text: string, options: { user?: typeof ALICE; conversation?: string } = {}) {
  return {
    ...message(text, {
      kind: "group",
      conversation: options.conversation ?? CONV,
      ...(options.user ? { user: options.user } : {}),
    }),
    mentioned: true,
  };
}

/** What the group was sent, as `said` reads it. */
function inGroup(w: World, conversation = CONV): string[] {
  return w.surface.of(conversation).flatMap((r) => {
    if (r.op !== "send" && r.op !== "update") return [];
    const body = r.message.body;
    if (body.type === "text") return [body.text];
    if (body.type === "rich") return [body.markdown];
    return [`<view:${body.view.name}>`];
  });
}

/** The language cards the group was sent. */
function cards(w: World, conversation = CONV): OutMessage[] {
  return w.surface
    .of(conversation)
    .flatMap((r) =>
      r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "note" ? [r.message] : [],
    );
}

/** A world where the group was already asked (the card is the subject of its own tests). */
function asked(): World {
  const w = world();
  w.store.groupLanguage.markGroupLanguageAsked(CONV);
  return w;
}

const ZH_EN = "已改为英文回复，由 Alice 设置。\nI answer in English in this group from now on (set by Alice).";
const ZH_ZH = "已改为中文回复，由 Bob 设置。\nI answer in Chinese in this group from now on (set by Bob).";

// --- 1. each group has its own setting; any member sets it; it is announced with who set it ---------------------------------

test("rule 1: @bot /lang en|zh|auto sets the group's language, anyone may change it, and the chat is told who did", async () => {
  const w = asked();
  await w.router.handle(gmsg("/lang en"));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "en");
  assert.equal(inGroup(w).at(-1), ZH_EN);
  await w.router.handle(gmsg("/lang zh", { user: BOB })); // (Bob has no key: a group's language needs none)
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "zh");
  assert.equal(inGroup(w).at(-1), ZH_ZH);
  await w.router.handle(gmsg("/lang auto"));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "auto");
  assert.equal(
    inGroup(w).at(-1),
    "已改为跟随提问者的语言回复，由 Alice 设置。\nI answer in the language of each question in this group from now on (set by Alice).",
  );
  assert.deepEqual(w.turns.calls, []); // (none of it went to the agent)
  assert.equal(w.store.prefs.getPrefs(ALICE.id).langSet, false); // (her own language is not touched)
  // Another group has its own.
  assert.equal(w.store.groupLanguage.groupLanguage("g-2"), null);
});

test("rule 1: the sentences that name the group set it, in Chinese and in English", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["这个群用英文", "en"],
    ["以后本群都用中文回复吧", "zh"],
    ["群里用英语", "en"],
    ["把这个群的语言改成中文", "zh"],
    ["这个群跟随提问者的语言", "auto"],
    ["Use English in this group.", "en"],
    ["please reply in Chinese in this group from now on", "zh"],
    ["In this group, use English", "en"],
    ["set the group language to Chinese", "zh"],
    ["follow the asker in this group", "auto"],
    ["/lang English", "en"],
    ["/lang 中文", "zh"],
  ];
  for (const [text, lang] of cases) {
    const w = asked();
    await w.router.handle(gmsg(text));
    assert.equal(w.store.groupLanguage.groupLanguage(CONV), lang, text);
    assert.ok(inGroup(w).at(-1)?.startsWith("已改为"), text);
    assert.deepEqual(w.turns.calls, [], text);
  }
});

test("rule 1: a pick on the assistant's choice card that reads like a setting is an answer, not the group's language", async () => {
  const w = asked();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle({ ...gmsg("这个群用英文"), choice: true });
  await w.router.settled();
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "");
  assert.deepEqual(w.turns.calls, [["create", "ak-alice", "这个群用英文"]]);
});

test("rule 1: /lang alone says which it is, and a malformed one how to write it, in the group's language", async () => {
  const w = asked();
  await w.router.handle(gmsg("/lang"));
  assert.match(inGroup(w).at(-1) ?? "", /^This group has no language set/u);
  await w.router.handle(gmsg("/lang fr"));
  assert.equal(inGroup(w).at(-1), "Usage: @Clawy /lang zh | en | auto (follow the asker).");
  await w.router.handle(gmsg("/lang zh"));
  await w.router.handle(gmsg("/lang"));
  assert.equal(inGroup(w).at(-1), "这个群用中文回复。@Clawy /lang en 或 /lang auto 可改。");
  await w.router.handle(gmsg("/lang klingon"));
  assert.equal(inGroup(w).at(-1), "用法：@Clawy /lang zh | en | auto（跟随提问者）。");
  await w.router.handle(gmsg("/lang en"));
  await w.router.handle(gmsg("/lang"));
  assert.equal(inGroup(w).at(-1), "This group is answered in English. @Clawy /lang zh or /lang auto changes it.");
});

// --- 2. in a group the group's setting decides, the answer and the fixed texts; a person's own choice does not ---------------

test("rule 2: a group set to English asks for English answers and says its own texts in English, whatever she chose", async () => {
  const w = asked();
  link(w, ALICE.id, "ak-alice");
  w.store.prefs.setLang(ALICE.id, "zh"); // (/lang zh in her 1:1 chat)
  w.store.groupLanguage.setGroupLanguage(CONV, "en");
  await w.router.handle(gmsg("帮我看看这个 PR"));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => [r.replyLang, r.lang]),
    [["en", "en"]],
  );
  assert.deepEqual(w.turns.calls, [["create", "ak-alice", "帮我看看这个 PR"]]);
  await w.router.handle(gmsg("/new"));
  assert.equal(inGroup(w).at(-1), "Started a new session. What would you like to do?");
});

test("rule 2: a group set to Chinese asks for Chinese answers and says its own texts in Chinese, whatever he chose", async () => {
  const w = asked();
  link(w, BOB.id, "ak-bob");
  w.store.prefs.setLang(BOB.id, "en");
  w.store.groupLanguage.setGroupLanguage(CONV, "zh");
  await w.router.handle(gmsg("please check this PR", { user: BOB }));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => [r.replyLang, r.lang]),
    [["zh", "zh"]],
  );
  await w.router.handle(gmsg("/new", { user: BOB }));
  assert.equal(inGroup(w).at(-1), "已开始新会话。要做什么？");
  await w.router.handle(gmsg("/help", { user: BOB }));
  assert.ok(hasChinese(inGroup(w).at(-1) ?? ""), "help in the group's language");
  await w.router.handle(gmsg("/timezone Asia/Shanghai", { user: BOB })); // (a 1:1 chat's command)
  assert.ok((inGroup(w).at(-1) ?? "").includes("1:1"));
});

// --- 3. with no setting (or "follow the asker"), the language of the @-message --------------------------------------------------

test("rule 3: with no setting, each message is answered in its own language, sent as the line; nobody's choice is sent", async () => {
  for (const setting of [undefined, "auto"] as const) {
    const w = asked();
    link(w, ALICE.id, "ak-alice");
    w.store.prefs.setLang(ALICE.id, "en"); // (she chose English for herself: not read in a group)
    if (setting !== undefined) w.store.groupLanguage.setGroupLanguage(CONV, setting);
    await w.router.handle(gmsg("帮我看看这个 PR"));
    await w.router.settled();
    await w.router.handle(gmsg("please check the build again"));
    await w.router.settled();
    assert.deepEqual(
      w.turns.runs.map((r) => [r.replyLang, r.lang]),
      [
        ["zh", "zh"],
        ["en", "en"],
      ],
      String(setting),
    );
    // (the words go as they are; the engine puts `[Reply language: …]` after them, engine.unit.test.ts)
    assert.deepEqual(
      w.turns.calls.map((c) => c.at(-1)),
      ["帮我看看这个 PR", "please check the build again"],
    );
  }
});

test("rule 3: after /lang auto in a group that talked English, the first Chinese question is answered in Chinese", async () => {
  const w = asked();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  w.store.groupLanguage.setGroupLanguage(CONV, "en");
  await w.router.handle(gmsg("what changed in the build this week", { user: BOB }));
  await w.router.settled();
  await w.router.handle(gmsg("/lang auto"));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "auto");
  await w.router.handle(gmsg("推荐一种适合夏天喝的饮料，一句话回答。"));
  await w.router.settled();
  await w.router.handle(gmsg("Recommend one cold drink for summer, in one sentence.", { user: BOB }));
  await w.router.settled();
  // (the group's session holds the English history: the line, not the history, decides)
  assert.deepEqual(
    w.turns.runs.map((r) => r.replyLang),
    ["en", "zh", "en"],
  );
});

test("rule 3: a message with no words of its own follows the asker's last one in this group, else carries no line", async () => {
  for (const setting of [undefined, "auto"] as const) {
    const w = asked();
    link(w, ALICE.id, "ak-alice");
    link(w, BOB.id, "ak-bob");
    if (setting !== undefined) w.store.groupLanguage.setGroupLanguage(CONV, setting);
    await w.router.handle(gmsg("ok #3", { user: BOB })); // (Bob has asked nothing here yet)
    await w.router.settled();
    await w.router.handle(gmsg("帮我看看这个 PR"));
    await w.router.settled();
    await w.router.handle(gmsg("please check the build again", { user: BOB }));
    await w.router.settled();
    await w.router.handle(gmsg("ok #3")); // (Alice's last here was Chinese; Bob's English is not hers)
    await w.router.settled();
    await w.router.handle(gmsg("ok", { user: BOB }));
    await w.router.settled();
    await w.router.handle(gmsg("ok", { conversation: "g-2" })); // (another group: nothing of hers there)
    await w.router.settled();
    assert.deepEqual(
      w.turns.runs.map((r) => r.replyLang),
      [undefined, "zh", "en", "zh", "en", undefined],
      String(setting),
    );
  }
});

test("rule 3: a group's own language still wins over the words of the message", async () => {
  for (const [setting, text, want] of [
    ["en", "推荐一种适合夏天喝的饮料", "en"],
    ["zh", "please check the build again", "zh"],
    ["en", "ok", "en"],
  ] as const) {
    const w = asked();
    link(w, ALICE.id, "ak-alice");
    w.store.groupLanguage.setGroupLanguage(CONV, setting);
    await w.router.handle(gmsg(text));
    await w.router.settled();
    assert.deepEqual(
      w.turns.runs.map((r) => r.replyLang),
      [want],
      text,
    );
  }
});

test("rule 3: a 1:1 chat's command said in a group is refused in the language it was written in, or the group's", async () => {
  const w = asked();
  await w.router.handle(gmsg("/timezone Asia/Shanghai 请帮我设置"));
  assert.equal(inGroup(w).at(-1), "`/timezone` 只能在 1:1 聊天里用，请在和我的 1:1 聊天里操作。");
  await w.router.handle(gmsg("/timezone Asia/Shanghai"));
  assert.equal(inGroup(w).at(-1), "`/timezone` works only in a 1:1 chat. Please do this in a 1:1 chat with me.");
  w.store.groupLanguage.setGroupLanguage(CONV, "en");
  await w.router.handle(gmsg("/timezone Asia/Shanghai 请帮我设置"));
  assert.equal(inGroup(w).at(-1), "`/timezone` works only in a 1:1 chat. Please do this in a 1:1 chat with me.");
});

// --- 4. the first @mention with no setting puts the card once; a pick by anyone stores it -----------------------------------

test("rule 4: the first @mention puts the language card once, and a pick by any member sets it and is announced", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(gmsg("帮我看看这个 PR"));
  await w.router.settled();
  const [card] = cards(w);
  assert.ok(card?.body.type === "view" && card.body.view.name === "note");
  const model = card.body.view.model as {
    title?: string;
    text: string;
    buttons?: readonly { title: string; verb?: string; data?: Record<string, unknown> }[];
  };
  assert.equal(model.title, "这个群用哪种语言回复？/ Which language should I use in this group?");
  assert.deepEqual(
    model.buttons?.map((b) => [b.title, b.verb, b.data]),
    [
      ["中文", "primusclaw.group_lang", { primusclaw: "group_lang", lang: "zh" }],
      ["English", "primusclaw.group_lang", { primusclaw: "group_lang", lang: "en" }],
      ["跟随提问者 (Follow the asker)", "primusclaw.group_lang", { primusclaw: "group_lang", lang: "auto" }],
    ],
  );
  assert.deepEqual(w.turns.calls, [["create", "ak-alice", "帮我看看这个 PR"]]); // (the question is answered as well)
  // Asked once: the next mention, by anyone, gets none.
  await w.router.handle(gmsg("check this", { user: BOB }));
  await w.router.handle(gmsg("帮我再看看"));
  await w.router.settled();
  assert.equal(cards(w).length, 1);
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "");
  // Bob (no key) picks English: it is set, the card says so, and so does the chat.
  await w.router.handle(clickOf("group_lang", { primusclaw: "group_lang", lang: "en" }, { user: BOB, group: true }));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "en");
  const announced = "已改为英文回复，由 Bob 设置。\nI answer in English in this group from now on (set by Bob).";
  const edit = w.surface.of(CONV).at(-2);
  assert.ok(edit?.op === "update" && edit.id === "card-1");
  assert.equal(inGroup(w).at(-1), announced);
  // Alice picks Chinese on the same card: anyone may change it again.
  await w.router.handle(clickOf("group_lang", { primusclaw: "group_lang", lang: "zh" }, { group: true }));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "zh");
  assert.equal(
    inGroup(w).at(-1),
    "已改为中文回复，由 Alice 设置。\nI answer in Chinese in this group from now on (set by Alice).",
  );
  // Never asked again in this group; another group is asked its own.
  await w.router.handle(gmsg("hello there everyone"));
  await w.router.settled();
  assert.equal(cards(w).length, 1);
  await w.router.handle(gmsg("hello there everyone", { conversation: "g-2" }));
  assert.equal(cards(w, "g-2").length, 1);
});

test("rule 4: following the asker is a choice too, and a mention that sets the language first gets no card", async () => {
  const w = world();
  await w.router.handle(gmsg("use English in this group"));
  assert.deepEqual(cards(w), []);
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "en");
  await w.router.handle(gmsg("/help"));
  assert.deepEqual(cards(w), []);
  for (const first of ["/lang", "/lang fr"]) {
    const asking = world(); // (a first mention that only asks about the language gets its answer and the card)
    await asking.router.handle(gmsg(first));
    assert.equal(cards(asking).length, 1, first);
    assert.equal(asking.store.groupLanguage.groupLanguage(CONV), "", first);
  }
  const other = world();
  await other.router.handle(gmsg("/help"));
  assert.equal(cards(other).length, 1); // (any first mention: help too)
  await other.router.handle(clickOf("group_lang", { primusclaw: "group_lang", lang: "auto" }, { group: true }));
  assert.equal(other.store.groupLanguage.groupLanguage(CONV), "auto");
  assert.ok(inGroup(other).at(-1)?.startsWith("已改为跟随提问者的语言回复，由 Alice 设置。"));
  // A pick that names no language changes nothing.
  await other.router.handle(clickOf("group_lang", { primusclaw: "group_lang", lang: "fr" }, { group: true }));
  assert.equal(other.store.groupLanguage.groupLanguage(CONV), "auto");
});

test("rule 4: a card that could not be posted is asked again at the next mention", async () => {
  const w = world();
  const record = w.surface.record.bind(w.surface);
  let refuse = true;
  w.surface.record = (entry) => {
    if (refuse && entry.op === "send" && entry.message.body.type === "view") throw new Error("throttled");
    record(entry);
  };
  await w.router.handle(gmsg("/help"));
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), null);
  refuse = false;
  await w.router.handle(gmsg("/help"));
  assert.equal(cards(w).length, 1);
  assert.equal(w.store.groupLanguage.groupLanguage(CONV), "");
});

// --- 5. what a message asks for in a named language is not the group's setting -------------------------------------------------

test("rule 5: asking for one answer in a language is no setting: it goes to the agent beside the group's language", async () => {
  for (const [setting, text] of [
    ["zh", "用英文回复：这个 PR 改了什么"],
    ["en", "answer in Chinese please: what changed in this PR"],
    ["zh", "用英文回复"],
    ["en", "answer in Chinese"],
    ["zh", "把这段翻译成英文：构建失败了"],
    ["en", "translate this into Chinese: the build failed"],
  ] as const) {
    const w = asked();
    link(w, ALICE.id, "ak-alice");
    w.store.groupLanguage.setGroupLanguage(CONV, setting);
    await w.router.handle(gmsg(text));
    await w.router.settled();
    assert.equal(w.store.groupLanguage.groupLanguage(CONV), setting, text);
    // (the words go as they are, with the group's language after them (`[Reply language: …]`, engine.unit.test.ts); Claw's
    // guideline has what a message asks for in a language it names written in that language)
    assert.equal(w.turns.calls[0]?.[2], text, text);
    assert.equal(w.turns.runs[0]?.replyLang, setting, text);
  }
});

// --- 6. what is said to one person alone keeps their own language ---------------------------------------------------------------

test("rule 6: what goes to one person alone keeps their own language, in a group set to another", async () => {
  for (const [own, group, starts] of [
    ["zh", "en", "你在群聊里给我发了一条只有我能看到的消息"],
    ["en", "zh", "You sent me a private message in a group chat."],
  ] as const) {
    const w = world({ reachable: [ALICE.id] });
    w.store.prefs.setLang(ALICE.id, own);
    w.store.groupLanguage.setGroupLanguage(CONV, group);
    await w.router.handle({ ...gmsg("a private question"), mentioned: false, targeted: true });
    assert.deepEqual(inGroup(w), []);
    const [line = ""] = inGroup(w, `personal:${ALICE.id}`);
    assert.ok(line.startsWith(starts), line);
  }
});

test("rule 6: her 1:1 chat keeps her own language while her group is set to another", async () => {
  const w = asked();
  link(w, ALICE.id, "ak-alice");
  w.store.prefs.setLang(ALICE.id, "zh");
  w.store.groupLanguage.setGroupLanguage(CONV, "en");
  await w.router.handle(message("check the build"));
  await w.router.settled();
  await w.router.handle(gmsg("看看构建"));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => r.replyLang),
    ["zh", "en"],
  );
  await w.router.handle(message("/new"));
  assert.equal(said(w).at(-1), "已开始新会话。要做什么？");
});

function hasChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}
