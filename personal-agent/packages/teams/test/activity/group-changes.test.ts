// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A group chat's own activities and the recent messages kept of it: the bot removed drops the chat, a deleted message
 * goes, an edited one shows its new words; nothing is routed or answered for any of them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { InboundEvent } from "@primusclaw/personal-agent";

import { applyGroupChange, type GroupContextChanges } from "../../src/activity/inbound/index.js";
import { inboundHandler } from "../../src/assembly/inbound.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { FakeClock } from "../../../../test-support/index.js";
import { BOT, CONV, USER_A } from "./fixtures.js";

class Recorder implements GroupContextChanges {
  readonly calls: string[][] = [];
  forget(chatId: string): void {
    this.calls.push(["forget", chatId]);
  }
  remove(chatId: string, messageId: string): void {
    this.calls.push(["remove", chatId, messageId]);
  }
  edit(chatId: string, messageId: string, text: string): void {
    this.calls.push(["edit", chatId, messageId, text]);
  }
}

const GROUP = { id: CONV, conversationType: "groupChat" };

function handler(context: Recorder) {
  const routed: InboundEvent[] = [];
  const handle = inboundHandler({
    acks: new AckRegistry(new FakeClock()),
    route: (event) => {
      routed.push(event);
      return Promise.resolve();
    },
    botName: "PrimusClaw Assistant",
    groupContext: context,
  });
  return { handle, routed };
}

test("the app removed from a group chat, or the bot among the members removed, drops the chat", async () => {
  const context = new Recorder();
  const { handle, routed } = handler(context);
  await handle({ type: "installationUpdate", action: "remove", conversation: GROUP, recipient: { id: BOT } });
  await handle({
    type: "conversationUpdate",
    conversation: GROUP,
    recipient: { id: BOT },
    membersRemoved: [{ id: "29:someone" }, { id: BOT }],
  });
  await handle({
    type: "conversationUpdate",
    conversation: GROUP,
    recipient: { id: BOT },
    membersRemoved: [{ id: "29:x" }],
  });
  await handle({ type: "installationUpdate", action: "add", conversation: GROUP, recipient: { id: BOT } });
  assert.deepEqual(context.calls, [
    ["forget", CONV],
    ["forget", CONV],
  ]);
  assert.deepEqual(routed, []);
});

test("a deleted group message goes, as a messageDelete or a soft delete", async () => {
  const context = new Recorder();
  const { handle } = handler(context);
  await handle({
    type: "messageDelete",
    id: "m-1",
    conversation: GROUP,
    channelData: { eventType: "softDeleteMessage" },
  });
  await handle({
    type: "messageUpdate",
    id: "m-2",
    conversation: GROUP,
    channelData: { eventType: "softDeleteMessage" },
  });
  await handle({
    type: "messageUpdate",
    id: "m-3",
    conversation: GROUP,
    channelData: { eventType: "undeleteMessage" },
  });
  assert.deepEqual(context.calls, [
    ["remove", CONV, "m-1"],
    ["remove", CONV, "m-2"],
  ]);
});

test("an edited group message shows its new words, read as a message's are", async () => {
  const context = new Recorder();
  const { handle, routed } = handler(context);
  const edited = {
    type: "messageUpdate",
    id: "m-7",
    text: "the build is green now",
    from: USER_A,
    recipient: { id: BOT, name: "PrimusClaw Assistant" },
    conversation: GROUP,
    channelData: { eventType: "editMessage" },
  };
  await handle(edited);
  const anonymous = { ...edited, id: "m-8", from: { id: "29:a" } }; // (no person behind it: it is not shown any more)
  await handle(anonymous);
  assert.deepEqual(context.calls, [
    ["edit", CONV, "m-7", "the build is green now"],
    ["remove", CONV, "m-8"],
  ]);
  assert.deepEqual(routed, []);
});

test("nothing outside a group chat, and nothing that is not one of these, changes what is kept", () => {
  const context = new Recorder();
  const dmChat = { id: "conv-1", conversationType: "personal" };
  assert.equal(
    applyGroupChange({ type: "messageDelete", id: "m", conversation: dmChat }, context, () => ""),
    false,
  );
  assert.equal(
    applyGroupChange({ type: "typing", conversation: GROUP }, context, () => ""),
    false,
  );
  assert.equal(
    applyGroupChange(
      { type: "messageDelete", id: "m", conversation: { conversationType: "groupChat" } },
      context,
      () => "",
    ),
    false,
  );
  assert.equal(
    applyGroupChange("not an activity", context, () => ""),
    false,
  );
  assert.deepEqual(context.calls, []);
});
