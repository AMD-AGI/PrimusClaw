// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A stored conversation reference, as the Python worker stored them, back as core's ConversationRef. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { referenceOf } from "../../src/activity/outbound.js";
import { restoreConversationRef } from "../../src/activity/reference.js";

/** What `activity.reference_of` stored for a 1:1 message (the shape of the `conversation_refs` rows). */
const PERSONAL = {
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  conversation: { conversationType: "personal", tenantId: "tenant-1", id: "a:1Xyz-personal" },
  bot: { id: "28:bot-app-id", name: "PrimusClaw Assistant" },
  user: { id: "29:1user", name: "Lin Mei", aadObjectId: "aad-lin" },
  activityId: "1731100000000",
  channelId: "msteams",
  locale: "zh-CN",
};

/** A group chat's reference. */
const GROUP = {
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversation: {
    isGroup: true,
    conversationType: "groupChat",
    tenantId: "tenant-1",
    id: "19:abc@thread.v2",
    name: "Ops",
  },
  bot: { id: "28:bot-app-id", name: "PrimusClaw Assistant" },
  user: { id: "29:2user", name: "Robin", aadObjectId: "aad-robin" },
  activityId: "1731100000001",
  channelId: "msteams",
};

/** The 1:1 reference the worker made after opening a chat with a reviewer (no activityId). */
const OPENED = {
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  bot: { id: "28:bot-app-id" },
  user: { id: "29:3user", aadObjectId: "aad-3" },
  conversation: { id: "a:opened", conversationType: "personal", tenantId: "tenant-1" },
};

test("a reference the python worker stored comes back as the conversation it names, its wire unchanged", () => {
  assert.deepEqual(restoreConversationRef(PERSONAL), {
    id: "a:1Xyz-personal",
    kind: "personal",
    tenantId: "tenant-1",
    wire: PERSONAL,
  });
  assert.deepEqual(restoreConversationRef(GROUP), {
    id: "19:abc@thread.v2",
    kind: "group",
    tenantId: "tenant-1",
    wire: GROUP,
  });
  const opened = restoreConversationRef(OPENED);
  assert.ok(opened);
  assert.equal(opened.kind, "personal");
  assert.equal(JSON.stringify(opened.wire), JSON.stringify(OPENED)); // (byte for byte when stored again)
});

test("a channel or an unsaid kind is neither 1:1 nor group, and a missing tenant is empty", () => {
  const channel = { serviceUrl: "https://s/", conversation: { id: "19:c", conversationType: "channel" } };
  assert.deepEqual(restoreConversationRef(channel), { id: "19:c", kind: "channel", tenantId: "", wire: channel });
  const unsaid = restoreConversationRef({ serviceUrl: "https://s/", conversation: { id: "x" } });
  assert.ok(unsaid);
  assert.equal(unsaid.kind, "channel");
});

test("what is not a reference is undefined, never an error", () => {
  for (const bad of [
    {},
    { serviceUrl: "https://s/" },
    { serviceUrl: "", conversation: { id: "x" } },
    { serviceUrl: "https://s/", conversation: { id: "" } },
    { serviceUrl: "https://s/", conversation: "x" },
    { serviceUrl: 3, conversation: { id: "x" } },
    { serviceUrl: "https://s/", conversation: { id: 7 } },
  ]) {
    assert.equal(restoreConversationRef(bad), undefined, JSON.stringify(bad));
  }
});

test("what reference_of builds from an activity restores to the same conversation", () => {
  const wire = referenceOf({
    id: "m",
    serviceUrl: "https://s/",
    conversation: { id: "a:1", conversationType: "personal", tenantId: "t" },
    from: { id: "29:a" },
    recipient: { id: "28:b" },
  });
  assert.deepEqual(restoreConversationRef(wire), { id: "a:1", kind: "personal", tenantId: "t", wire });
});
