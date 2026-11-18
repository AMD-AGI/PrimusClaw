// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router says about the chat app comes from the surface's caps, never from Teams' own words: the same flows on another
 * channel name that channel, its console page and its client.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeSurface, OTHER_CHANNEL } from "../../../../test-support/surface.js";
import type { JsonObject } from "../../src/json.js";
import { channelContext } from "../../src/understanding/context.js";
import { ALICE } from "./fixtures.js";
import { link, message, PUBLIC, said, world } from "./world.js";

const other = () => world({ surface: new FakeSurface({ caps: OTHER_CHANNEL }) });

test("an unconnected chat on another channel is sent to that channel's console page", async () => {
  const w = other();
  await w.router.handle(message("hi"));
  const [text = ""] = said(w);
  assert.ok(text.includes(`${PUBLIC}/primus-claw/chatapp-link`), text);
  assert.ok(text.includes("select Connect Chat App:"), text);
  assert.ok(!/teams/i.test(text), text);
});

test("help on another channel says the messages go through that channel", async () => {
  const w = other();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/help", { id: "h1" }));
  const [help = ""] = said(w).slice(-1);
  assert.ok(help.includes("Where it goes: through Chat App to PrimusClaw"), help);
  assert.ok(!/teams/i.test(help), help);
});

test("the language a person is answered in is said to follow their own channel's client", async () => {
  const w = other();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/lang", { id: "l1" }));
  const [text = ""] = said(w).slice(-1);
  assert.ok(text.includes("from your ChatApp client's language"), text);
});

test("on Teams the same flows say what they always said", async () => {
  const w = world();
  await w.router.handle(message("hi"));
  const [text = ""] = said(w);
  assert.ok(
    text.includes(`${PUBLIC}/primus-claw/teams-link`) && text.includes("select Connect Microsoft Teams:"),
    text,
  );
});

test("the assistant is told the message came through the conversation's own channel, first in its context", async () => {
  for (const [surface, channel] of [
    [new FakeSurface({ caps: OTHER_CHANNEL }), "chatapp"],
    [new FakeSurface(), "teams"],
  ] as const) {
    const w = world({ surface });
    link(w, ALICE.id, "ak");
    const heard: JsonObject[] = [];
    const deps = w.deps as unknown as { assistant: Record<string, unknown>; channelContext: unknown };
    // (a builder that does not pass the channel on, as an assembly from before the channel was the surface's)
    deps.channelContext = (request: { channelMessageId: string }) => ({
      context: channelContext({ channelMessageId: request.channelMessageId, people: [], pending: [], actions: [] }),
      actions: [],
      people: [],
    });
    deps.assistant = {
      ...deps.assistant,
      on: () => true,
      understands: () => true,
      reachable: () => false,
      understand: (request: { context: JsonObject }) => {
        heard.push(request.context);
        return Promise.resolve(true);
      },
    };
    await w.router.handle(message("what is running?", { id: "m1" }));
    await w.router.settled();
    assert.equal(heard.length, 1, channel);
    assert.deepEqual(Object.entries(heard[0] ?? {})[0], ["channel", channel]);
  }
});
