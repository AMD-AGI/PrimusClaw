// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { markedText, MARK_CLOSE, MARK_OPEN, type InboundAction, type InboundMessage } from "@primusclaw/personal-agent";

import { toInboundEvent, wireReferenceOf } from "../../src/activity/inbound/index.js";
import { BOT, CONV, dm, grp, htmlAttachment, replyEntity, replyHtml, USER_A, WHEN_MS } from "./fixtures.js";

function message(raw: unknown, botName?: string): InboundMessage {
  const event = toInboundEvent(raw, botName === undefined ? {} : { botName });
  assert.ok(event.ok && event.value?.type === "message");
  return event.value;
}

function action(raw: unknown): InboundAction {
  const event = toInboundEvent(raw);
  assert.ok(event.ok && event.value?.type === "action");
  return event.value;
}

const DANA = {
  type: "mention",
  text: "<at>Dana</at>",
  mentioned: { id: "29:dana", name: "Dana", aadObjectId: "aad-d" },
};

test("a group message: who, where, the words, the mentions, the links and the quotes", () => {
  const raw = {
    ...grp('<quoted messageId="m-100"/> <at>Clawy</at> Dana, ask <at>Dana</at> about fix it', {
      entities: [replyEntity(), DANA, { type: "clientInfo", platform: "Windows", locale: "zh-CN" }],
      attachments: [htmlAttachment('<p><a href="https://example.test/pr/1">fix it</a></p>')],
    }),
    locale: "zh-CN",
    conversation: { id: CONV, conversationType: "groupChat", tenantId: "t-1", name: "Release room" },
  };
  const event = message(raw);
  assert.equal(event.id, "g1");
  assert.deepEqual(event.sender, { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" });
  assert.equal(event.conversation.id, CONV);
  assert.equal(event.conversation.kind, "group");
  assert.equal(event.conversation.tenantId, "t-1");
  assert.equal(event.locale, "zh-CN");
  assert.equal(event.clientPlatform, "Windows");
  assert.equal(event.text, "Dana, ask Dana about fix it");
  assert.equal(event.conversationName, "Release room");
  // The bot's mention comes first once the quote's placeholder is set aside.
  assert.deepEqual([event.mentioned, event.targeted, event.namesBotFirst], [true, false, true]);
  assert.deepEqual(event.mentions, [
    { channelUserId: "29:dana", userId: "aad-d", name: "Dana", shown: "Dana", offset: 10 },
  ]);
  assert.deepEqual(event.links, [{ url: "https://example.test/pr/1", title: "fix it" }]);
  assert.deepEqual(event.quotes, [
    {
      author: "Bob",
      text: "The deploy failed on node 3",
      fromBot: false,
      sentAt: WHEN_MS,
      messageId: "m-100",
      deleted: false,
      source: "entity",
    },
  ]);
  assert.deepEqual(event.files, []);
  assert.equal(event.provenance, "typed");
  assert.equal(markedText(event.text, event.mentions).text, `Dana, ask ${MARK_OPEN}0${MARK_CLOSE} about fix it`);
});

test("the message id of a quote comes from the entity and from the html", () => {
  const html = message(dm("hi", { attachments: [htmlAttachment(replyHtml({ messageId: "m-7", senderId: BOT }))] }));
  const [first] = html.quotes;
  assert.ok(first);
  assert.deepEqual([first.messageId, first.source, first.fromBot], ["m-7", "html", true]);
  const entity = message(
    dm("hi", { entities: [replyEntity("x", "Bob", "29:b", "m-8", null, { isReplyDeleted: true })] }),
  );
  assert.deepEqual([entity.quotes[0]?.messageId, entity.quotes[0]?.deleted], ["m-8", true]);
  const placeholder = message(dm('<quoted messageId="m-9"/> hi'));
  assert.deepEqual([placeholder.quotes[0]?.messageId, placeholder.quotes[0]?.source], ["m-9", "placeholder"]);
});

test("a one to one message has no conversation name and is not a mention", () => {
  const event = message({ ...dm("hi"), conversation: { id: "c", conversationType: "personal", name: "x" } });
  assert.equal(event.conversation.kind, "personal");
  assert.equal(event.conversationName, "");
  assert.deepEqual([event.mentioned, event.targeted, event.namesBotFirst], [false, false, false]);
});

test("a targeted message and a message that names the bot first", () => {
  const targeted = message({ ...grp("hi", { mention: false }), recipient: { id: BOT, isTargeted: true } });
  assert.deepEqual([targeted.mentioned, targeted.targeted], [false, true]);
  assert.equal(message(dm("@Clawy what now")).namesBotFirst, true);
  assert.equal(message(dm("@Robin what now")).namesBotFirst, false);
  assert.equal(message(dm("@Robin what now"), "Robin").namesBotFirst, true);
});

test("the wire reference keeps python's keys in python's order", () => {
  const raw = { ...dm("hi"), locale: "en-US", extra: 1 };
  const event = message(raw);
  assert.equal(
    JSON.stringify(event.conversation.wire),
    JSON.stringify({
      serviceUrl: "https://smba.test/",
      conversation: { id: "conv-aad-a", conversationType: "personal" },
      bot: { id: BOT, name: "Clawy" },
      user: USER_A,
      activityId: "act-1",
      channelId: "msteams",
      locale: "en-US",
    }),
  );
  assert.equal(
    JSON.stringify(wireReferenceOf({ conversation: { b: 1, a: 2 }, channelId: "", locale: null })),
    '{"serviceUrl":null,"conversation":{"b":1,"a":2},"bot":null,"user":null,"activityId":null}',
  );
});

test("a card press is an action: execute invoke and submit message", () => {
  const invoke = action({
    ...dm(""),
    type: "invoke",
    name: "adaptiveCard/action",
    replyToId: "card-1",
    value: { action: { verb: "approve", data: { primusclaw: "decision", choice: "yes" } } },
  });
  assert.deepEqual(
    [invoke.verb, invoke.data, invoke.cardMessageId, invoke.invoke, invoke.clickVerb],
    ["decision", { primusclaw: "decision", choice: "yes" }, "card-1", true, "approve"],
  );
  const submit = action({ ...dm(""), value: { primusclaw: "answer", text: "ok" } });
  assert.deepEqual(
    [submit.verb, submit.invoke, submit.clickVerb, submit.cardMessageId],
    ["answer", false, "unknown", ""],
  );
  const unknown = action({ ...dm(""), type: "invoke", name: "adaptiveCard/action", value: "x" });
  assert.deepEqual([unknown.verb, unknown.data], ["", {}]);
});

test("a message whose value is not a card press is a message", () => {
  assert.equal(message({ ...dm("hi"), value: { primusclaw: 5 } }).text, "hi");
});

test("what is not a message or a card press is no event", () => {
  const typing = toInboundEvent({ ...dm(""), type: "typing" });
  assert.ok(typing.ok && typing.value === undefined);
  const invoke = toInboundEvent({ ...dm(""), type: "invoke", name: "message/submitAction" });
  assert.ok(invoke.ok && invoke.value === undefined);
});

test("no sender identity and invalid input are refused", () => {
  const nobody = toInboundEvent({ ...dm("hi"), from: { id: "29:x" } });
  assert.deepEqual(nobody, { ok: false, error: { kind: "no_sender" } });
  const bad = toInboundEvent({ ...dm("hi"), from: "someone", entities: {} });
  assert.ok(!bad.ok && bad.error.kind === "invalid_input");
  assert.deepEqual([...bad.error.paths].sort(), ["entities", "from"]);
  const notAnObject = toInboundEvent("x");
  assert.ok(!notAnObject.ok && notAnObject.error.kind === "invalid_input");
});

test("unknown fields are kept", () => {
  const event = message({ ...dm("hi"), conversation: { id: "c", conversationType: "personal", custom: [1] } });
  assert.deepEqual(event.conversation.wire["conversation"], { id: "c", conversationType: "personal", custom: [1] });
});

test("the files of a message: what can be fetched, and the names of what cannot", () => {
  const event = message({
    type: "message",
    id: "m-f",
    text: "see these",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:a", aadObjectId: "aad-a", name: "Lin Mei" },
    recipient: { id: "28:bot" },
    conversation: { id: "a:1", conversationType: "personal" },
    attachments: [
      { contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/amer/v3/attachments/1/views/original" },
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: "plan.md",
        content: { downloadUrl: "https://x.sharepoint.example/d", fileType: "md" },
      },
      { contentType: "application/vnd.microsoft.teams.file.download.info", name: "no-link.pdf", content: {} },
      { contentType: "text/html", content: "<p>see these</p>" },
    ],
  });
  assert.deepEqual(
    event.files.map((f) => [f.name, f.type]),
    [
      ["", ""],
      ["plan.md", "md"],
    ],
  );
  assert.deepEqual(event.unreadableFiles, ["no-link.pdf"]);
});

test("teams' own thumbs on the desktop become a vote on the answer they were given on", () => {
  const thumb = (reaction: string, feedback: unknown) => ({
    type: "invoke",
    name: "message/submitAction",
    id: "inv-1",
    replyToId: "answer-7",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:a", aadObjectId: "aad-a", name: "Lin Mei" },
    recipient: { id: "28:bot" },
    conversation: { id: "a:1", conversationType: "personal" },
    value: { actionName: "feedback", actionValue: { reaction, feedback } },
  });
  const liked = toInboundEvent(thumb("like", JSON.stringify({ feedbackText: " spot on " })));
  assert.ok(liked.ok && liked.value?.type === "vote");
  assert.deepEqual(
    [
      liked.value.messageId,
      liked.value.reaction,
      liked.value.comment,
      liked.value.sender.id,
      liked.value.conversation.id,
    ],
    ["answer-7", "like", "spot on", "aad-a", "a:1"],
  );
  const disliked = toInboundEvent(thumb("dislike", "wrong repo"));
  assert.ok(disliked.ok && disliked.value?.type === "vote" && disliked.value.comment === "wrong repo");
  const numeric = toInboundEvent({ ...thumb("like", ""), replyToId: 7 });
  assert.ok(numeric.ok && numeric.value?.type === "vote" && numeric.value.messageId === ""); // (Python: (7, None))
  const other = toInboundEvent(thumb("meh", ""));
  assert.ok(other.ok && other.value === undefined);
});
