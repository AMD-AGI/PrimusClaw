// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The channel context a message to the assistant carries names the people the message @mentions from the surface's own
 * mentions (`InboundMessage.mentions`): a mention with the person's directory id is looked up by it, one with only the
 * channel's id by the member the store knows under it, and nothing in the worker is shaped like one surface's mention.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { inboundMessage } from "../../../../test-support/inbound.js";
import { channelContextBuilder } from "../../src/worker/features-text.js";

const LINKED = new Map([
  ["dir-ada", "claw-ada"],
  ["dir-bob", "claw-bob"],
]);

it("the people a message @mentions come from its own mentions, by directory id or by the channel's id", () => {
  const looked: string[] = [];
  const build = channelContextBuilder({
    members: {
      knownMembers: () => [],
      userForChannelId: (channelUserId) => (channelUserId === "U-BOB" ? "dir-bob" : null),
    },
    links: {
      clawUserIdOf: (userId) => {
        looked.push(userId);
        return LINKED.get(userId) ?? null;
      },
    },
  });
  const message = inboundMessage({
    text: "Ada and Bob, please look",
    mentions: [
      { channelUserId: "U-ADA", userId: "dir-ada", name: "Ada", shown: "Ada", offset: 0 },
      { channelUserId: "U-BOB", userId: "", name: "Bob", shown: "Bob", offset: 8 },
      { channelUserId: "U-CY", userId: "", name: "Cy", shown: "Cy", offset: 20 },
    ],
  });
  const built = build({
    channel: "slack",
    channelMessageId: "m-1",
    userId: "dir-me",
    message,
    parts: new Set(),
    handoffs: [],
    via: "",
  });
  assert.deepEqual(built.people, ["claw-ada", "claw-bob"]);
  assert.deepEqual(looked, ["dir-ada", "dir-bob"]);
  const people = (built.context["people"] ?? []) as readonly Record<string, unknown>[];
  assert.deepEqual(
    people.map((p) => [p["name"], p["user_id"] ?? null, p["source"]]),
    [
      ["Ada", "claw-ada", "mention"],
      ["Bob", "claw-bob", "mention"],
      ["Cy", null, "mention"],
    ],
  );
});
