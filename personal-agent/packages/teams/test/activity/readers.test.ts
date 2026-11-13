// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The inbound readers one by one; expectations marked "measured" are what the Python worker's functions returned. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addressedToBot,
  answerAction,
  bindAction,
  cardAction,
  cardLinks,
  cardVerb,
  clientPlatform,
  conversationId,
  conversationKind,
  cutReplies,
  findTags,
  htmlLinks,
  isBotQuote,
  isCardClick,
  isGroup,
  isMentioned,
  isMobile,
  isPersonal,
  isTargeted,
  kindsOf,
  linksOf,
  mentionsOf,
  messageText,
  quotedIds,
  senderOf,
  tenantOf,
  thumbAction,
  webUrl,
  written,
  type Activity,
  type Quote,
} from "../../src/activity/inbound/index.js";
import { caseless } from "../../src/activity/inbound/patterns.js";
import { BOT, dm, grp } from "./fixtures.js";

test("the sender: an entra id, the name, and an email only when it looks like one (measured)", () => {
  assert.deepEqual(senderOf({ from: { aadObjectId: "x", email: " a@b ", name: "N" } }), {
    aadId: "x",
    name: "N",
    email: "a@b",
  });
  assert.deepEqual(senderOf({ from: { aadObjectId: "x", userPrincipalName: "nobody" } }), {
    aadId: "x",
    name: "",
    email: "",
  });
  assert.equal(senderOf({ from: { aadObjectId: 5 } }), undefined);
  assert.equal(senderOf({}), undefined);
});

test("the conversation: its kind, id and tenant (measured)", () => {
  assert.ok(isPersonal(dm("x")) && !isGroup(dm("x")));
  assert.ok(isGroup(grp("x")) && !isPersonal(grp("x")));
  assert.equal(conversationKind(dm("x")), "personal");
  assert.equal(conversationKind(grp("x")), "group");
  assert.equal(conversationKind({ conversation: { conversationType: "channel" } }), "channel");
  assert.equal(conversationKind({}), "channel");
  assert.equal(conversationId(grp("x")), "19:group@thread.v2");
  assert.equal(conversationId({ conversation: null }), "");
  assert.equal(tenantOf({ channelData: { tenant: { id: "t2" } } }), "t2");
  assert.equal(tenantOf({ conversation: { tenantId: "t1" }, channelData: { tenant: { id: "t2" } } }), "t1");
  assert.equal(tenantOf({ channelData: "x" }), "");
});

test("the client platform is letters and digits, at most sixteen (measured)", () => {
  const platform = (p: unknown): string => clientPlatform({ entities: [{ type: "clientInfo", platform: p }] });
  assert.equal(platform("Win dows-11!ÄÄÄÄÄÄÄÄÄÄÄÄ"), "Windows11ÄÄÄÄÄÄÄ");
  assert.equal(platform(5), "");
  assert.equal(clientPlatform({ entities: ["x", { type: "other" }] }), "");
  assert.ok(isMobile("iOS") && isMobile("ANDROID") && isMobile("iPadOS") && !isMobile("Windows") && !isMobile(""));
});

test("the bot's mention, and a mention of another person", () => {
  assert.ok(isMentioned(grp("<at>PrimusClaw Assistant</at> hi")));
  assert.ok(!isMentioned(grp("<at>PrimusClaw Assistant</at> hi", { mention: false })));
  assert.ok(
    !isMentioned({ ...grp("<at>PrimusClaw Assistant</at> hi"), recipient: {} }),
    "no bot id: no mention of the bot",
  );
  assert.ok(!isMentioned({ entities: [{ type: "mention", mentioned: "x" }], recipient: { id: BOT } }));
  assert.ok(isTargeted({ recipient: { is_targeted: true } }) && !isTargeted({ recipient: { isTargeted: "true" } }));
});

test("a message that starts by naming the bot (measured)", () => {
  const cases: readonly [string, string, boolean][] = [
    ["Robin", "@Robin hi", true],
    ["Robin", "@ROBIN", true],
    ["Robin", "@robin-bot", false],
    ["Robin", "@Robinx", false],
    ["Robin", "@Robin_", false],
    ["Robin", "@Robiné", false],
    ["Robin", "@Robin, hi", true],
    ["Robin", "<p>&nbsp;<at>Robin</at> hi", true],
    ["Robin", "<P class='x'>\x1c<AT> @ Robin </at>", true],
    ["Robin", "@ Robin", true],
    ["Robin", "hi @Robin", false],
    ["Robin", "<pre>@Robin", false],
    ["Robin", "\ufeff@Robin", false],
    ["Robin", "&NBSP;@Robin", true],
    ["Kiss", "@Kıſſ", true],
    ["Kiss", "@KİSS", true],
    ["Kiss", "@kiss", true],
    ["Robin", "<at>Robin</at>", true],
  ];
  for (const [name, text, expected] of cases)
    assert.equal(addressedToBot({ text }, name), expected, `${name}: ${text}`);
  assert.equal(addressedToBot({ text: "@PrimusClaw Assistant" }), true, "the default name");
  assert.equal(addressedToBot({ text: "<at>PrimusClaw Assistant</at> hi" }), true, "the default name, mentioned");
  assert.equal(addressedToBot({ text: "@Clawy" }), false, "the earlier name is a deployment's to give");
});

test("python's ignorecase letters only: caseless spells the folds python matches", () => {
  const pattern = new RegExp(`^${caseless("i.k-S")}$`, "u");
  for (const text of ["i.k-s", "I.K-S", "İ.K-ſ", "ı.k-s"]) assert.ok(pattern.test(text), text);
  assert.ok(!pattern.test("ixk-s"));
  assert.ok(new RegExp(`^${caseless("é")}$`, "u").test("É"));
});

test("message text: every mention goes when the bot's id is unknown, a mention without a person goes too", () => {
  const entities = [
    { type: "mention", text: "<at>Dana</at>", mentioned: { id: "29:d" } },
    { type: "mention", text: "<at>Nobody</at>", mentioned: {} },
  ];
  assert.equal(messageText({ text: "<at>Dana</at> and <at>Nobody</at> hi", entities }), "and  hi");
  assert.equal(
    messageText({ text: "<at>Dana</at> and <at>Nobody</at> hi", entities, recipient: { id: BOT } }),
    "Dana and  hi",
  );
});

test("the mentions of a message, with where their words stand", () => {
  const dana = { type: "mention", text: "<at>Dana</at>", mentioned: { id: "29:d", name: "Dana" } };
  const a = grp("  <at>PrimusClaw Assistant</at> \u{1F600} Dana or <at>Dana</at>?", { entities: [dana, dana] });
  assert.equal(messageText(a), "\u{1F600} Dana or Dana?");
  assert.deepEqual(
    mentionsOf(a).map((m) => [m.shown, m.offset]),
    [
      ["Dana", 10],
      ["Dana", 10],
    ].slice(0, 1),
  );
  assert.deepEqual(mentionsOf({ ...a, recipient: {} }), [], "no bot id: every mention is gone from the text");
  const empty = { type: "mention", text: "<at></at>", mentioned: { id: "29:e" } };
  assert.deepEqual(mentionsOf(grp("<at>PrimusClaw Assistant</at> hi <at></at>", { entities: [empty] })), []);
  const held = grp("<at>PrimusClaw Assistant</at> \ue000 <at>Dana</at>", { entities: [dana] });
  assert.deepEqual(
    mentionsOf(held).map((m) => [m.shown, m.offset]),
    [["Dana", 2]],
    "a text holding the placeholder characters is read by where the words first stand",
  );
});

test("card presses: each reader takes its own kind (Action.Execute and Action.Submit)", () => {
  const execute: Activity = {
    type: "invoke",
    name: "adaptiveCard/action",
    value: { action: { verb: "x".repeat(50), data: { primusclaw: "decision", n: 1 } } },
  };
  assert.deepEqual(cardAction(execute), { primusclaw: "decision", n: 1 });
  assert.equal(answerAction(execute), undefined);
  assert.ok(isCardClick(execute) && !isCardClick({ type: "invoke", name: "other" }));
  assert.equal(cardVerb(execute), "x".repeat(40));
  assert.equal(cardVerb({ value: [] }), "unknown");
  const submit: Activity = { type: "message", value: { primusclaw: "thumb", up: true } };
  assert.deepEqual(thumbAction(submit), { primusclaw: "thumb", up: true });
  assert.equal(bindAction({ value: { action: "x" } }), undefined);
  assert.equal(bindAction({ value: { action: { data: [] } } }), undefined);
});

test("tag finders match python's patterns (measured)", () => {
  assert.deepEqual(quotedIds(`<quoted messageId="a"/><quoted messageId='b'/><QUOTED MESSAGEID = c >`), ["a", "b", "c"]);
  assert.deepEqual(quotedIds("<quoted x messageId=a<quoted messageId=b>"), ["a<quoted"]);
  assert.deepEqual(quotedIds("messageId=a<quoted-messageId=b"), ["b"]);
  assert.deepEqual(quotedIds("<quoted>messageId=a"), []);
  assert.deepEqual(quotedIds("<quotedx messageId=a>"), []);
  assert.deepEqual(quotedIds("<quoted data-messageId=a>"), ["a"]);
  assert.deepEqual(quotedIds("<quoted xmessageId=a>"), []);
  assert.deepEqual(quotedIds('<quoted messageId="">'), []);
  assert.deepEqual(quotedIds("<quoted messageId=ſ>"), ["ſ"]);
  assert.deepEqual(quotedIds("<quoted meſsageId=z>"), ["z"]);
  assert.deepEqual(quotedIds("<quoted \u{1F600}messageId=z>"), ["z"]);
  assert.deepEqual(
    cutReplies(
      'a<blockquote itemtype="http://schema.skype.com/Reply">x<blockquote>y</blockquote>z</blockquote>b<blockquote>c</blockquote>',
    ),
    {
      kept: "ab<blockquote>c</blockquote>",
      cut: [[' itemtype="http://schema.skype.com/Reply"', "x<blockquote>y</blockquote>z"]],
    },
  );
  assert.equal(
    written({
      text: '<p>hi</p><blockquote itemtype="HTTP://SCHEMA.SKYPE.COM/reply">q</blockquote><div class=x>there<br/></div><quoted messageId="1"/>',
    }),
    " hi  there  ",
  );
  assert.deepEqual(
    findTags("<p<p>", ["p"], false).map((t) => [t.start, t.end, t.attrs]),
    [[0, 5, "<p"]],
  );
});

test("the tag finders stay linear on markup built to make a backtracking pattern quadratic", () => {
  const n = 50_000;
  assert.deepEqual(quotedIds("<quoted ".repeat(n)), []);
  assert.deepEqual(quotedIds("<quoted " + "messageId=-".repeat(n)), ["-" + "messageId=-".repeat(n - 1)]);
  assert.deepEqual(findTags("<blockquote".repeat(n), ["blockquote"], true), []);
  assert.equal(written({ text: "<quoted".repeat(n) }), "<quoted".repeat(n));
  assert.equal(addressedToBot({ text: "<at>" + " ".repeat(n) }), false);
  assert.equal(addressedToBot({ text: "<p>".repeat(n) + "<p" }), false);
});

test("a web address is http or https, nothing else, at most 2000 characters", () => {
  assert.equal(webUrl("  https://e.test/x  "), "https://e.test/x");
  assert.equal(webUrl("HTTP://e.test"), "HTTP://e.test");
  assert.equal(webUrl("https://e.test/a\x85b"), "");
  assert.equal(webUrl("https://e.test/a\ufeffb"), "https://e.test/a\ufeffb");
  assert.equal(webUrl("https://" + "\u{1F600}".repeat(1992)), "https://" + "\u{1F600}".repeat(1992));
  assert.equal(webUrl("https://" + "e".repeat(1993)), "");
  assert.equal(webUrl(5), "");
});

test("links of html and cards: a self closed anchor, a card's own title, an attachment's contentUrl", () => {
  assert.deepEqual(htmlLinks('<a href="https://e.test/a"/>x'), [{ url: "https://e.test/a", label: "" }]);
  assert.deepEqual(htmlLinks('<a href="https://e.test/a">https://e.test/a</a><a>y</a>'), [
    { url: "https://e.test/a", label: "" },
  ]);
  assert.deepEqual(
    cardLinks({ title: "  A  card ", href: "https://e.test/h", type: "Media", url: "https://e.test/m" }),
    [],
  );
  assert.deepEqual(cardLinks({ title: "  A  card ", items: [{ href: "https://e.test/h" }] }), [
    { url: "https://e.test/h", label: "A card" },
  ]);
  const a = dm("x", {
    attachments: [
      { contentType: "application/vnd.microsoft.card.hero", contentUrl: "https://e.test/c", name: "Card", content: {} },
    ],
  });
  assert.deepEqual(linksOf(a), [{ url: "https://e.test/c", label: "" }]);
});

test("a quote by the bot: by id, by the part after the prefix, by name only without an id", () => {
  const quote = (senderId: string, sender = ""): Quote => ({
    messageId: "",
    senderId,
    sender,
    time: "",
    text: "",
    deleted: false,
    source: "entity",
  });
  assert.ok(isBotQuote(quote("28:BOT"), { id: "28:bot" }));
  assert.ok(isBotQuote(quote("bot"), { id: "28:bot" }));
  assert.ok(!isBotQuote(quote("28:"), { id: "29:" }));
  assert.ok(isBotQuote(quote("", "robin"), { id: "28:bot", name: " Robin " }));
  assert.ok(!isBotQuote(quote("", ""), { name: "" }));
  assert.ok(!isBotQuote(quote("29:x", "Robin"), { name: "Robin" }));
});

test("the kinds of a list for a log line (measured)", () => {
  assert.deepEqual(kindsOf([{ type: "a b/c.d-e_f!" }, "x", { type: null }, { type: "x".repeat(50) }], "type"), [
    "ab/c.d-e_f",
    "",
    "x".repeat(40),
  ]);
  assert.deepEqual(kindsOf("x", "type"), []);
});
