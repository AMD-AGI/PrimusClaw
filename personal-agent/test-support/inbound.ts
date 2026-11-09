// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { InboundAction, InboundMessage, InboundVote, UserRef } from "@primusclaw/personal-agent";
import { testConversation } from "./surface.js";

/** A person for tests. */
export function testUser(id = "u1", name = "Ada Lovelace"): UserRef {
  return { id, channelUserId: `29:${id}`, name, email: `${id}@example.com` };
}

const base = {
  id: "in-1",
  sender: testUser(),
  conversation: testConversation(),
  locale: "en-US",
  clientPlatform: "Web",
} as const;

/**
 * An inbound message as a channel adapter delivers it: every field set, plain 1:1 defaults (typed text, nothing
 * mentioned, quoted or attached), with `fields` in their place.
 */
export function inboundMessage(fields: Partial<InboundMessage> = {}): InboundMessage {
  return {
    ...base,
    type: "message",
    text: "hello",
    mentioned: false,
    targeted: false,
    namesBotFirst: false,
    conversationName: "",
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    unreadableFiles: [],
    provenance: "typed",
    ...fields,
  };
}

/** A card click (an Action.Execute invoke by default), with `fields` in their place. */
export function inboundAction(fields: Partial<InboundAction> = {}): InboundAction {
  return {
    ...base,
    type: "action",
    verb: "decision",
    invoke: true,
    clickVerb: "decision",
    data: {},
    cardMessageId: "m1",
    ...fields,
  };
}

/** A thumbs up on message "m1", with `fields` in their place. */
export function inboundVote(fields: Partial<InboundVote> = {}): InboundVote {
  return { ...base, type: "vote", messageId: "m1", reaction: "like", comment: "", ...fields };
}
