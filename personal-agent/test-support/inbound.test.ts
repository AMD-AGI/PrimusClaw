// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { inboundAction, inboundMessage, inboundVote, testUser } from "./index.js";

test("the inbound builders give complete events with plain defaults", () => {
  const message = inboundMessage();
  assert.equal(message.type, "message");
  assert.deepEqual(message.unreadableFiles, []);
  assert.equal(message.provenance, "typed");
  assert.equal(message.sender.channelUserId, "29:u1");
  const action = inboundAction();
  assert.equal(action.invoke, true);
  assert.equal(action.verb, action.data["primusclaw"], "verb is the data's primusclaw kind");
  assert.equal(action.clickVerb, "decision");
  assert.equal(inboundVote().reaction, "like");
});

test("fields given to a builder replace its defaults", () => {
  const message = inboundMessage({ text: "see attached", unreadableFiles: ["design.docx"], sender: testUser("u2") });
  assert.equal(message.text, "see attached");
  assert.deepEqual(message.unreadableFiles, ["design.docx"]);
  assert.equal(message.sender.id, "u2");
  const submit = inboundAction({ invoke: false, clickVerb: "unknown" });
  assert.equal(submit.invoke, false);
  assert.equal(submit.clickVerb, "unknown");
  assert.equal(inboundVote({ reaction: "dislike", comment: "wrong" }).comment, "wrong");
});
