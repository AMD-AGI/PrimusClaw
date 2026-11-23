// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a chat attached to a session passes on of a forward and of the files sent with a message: the router in front of
// the real remote agents, the real Claw client and the fake remote-agents server.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InboundFile, InboundForward } from "@primusclaw/personal-agent";

import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import { Script } from "../../../../../test-support/remote-world.js";
import { attachedThroughRouter, routed } from "./remote-routed.js";

async function oneTurn(srv: FakeRemote, sid: string): Promise<void> {
  await srv.say(sid, "Done.");
  await srv.end(sid);
}

const texts = (srv: FakeRemote): unknown[] => srv.commandsOf("prompt").map((c) => c.body["text"]);

const LOG = "step 1 ok\nstep 2 FAILED: ```oom```\n";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const FORWARDS: readonly InboundForward[] = [
  { messageId: "1", author: "Bob", text: "The deploy failed on node 3", sentAt: "1793695000000", source: "html" },
  { messageId: "2", author: "Carol", text: "see the log [image-1]", sentAt: "", source: "reference" },
];

test("a forward to an attached chat reaches the session as context: who wrote each message, when, and what", () =>
  routed(async (w) => {
    const script = new Script();
    await attachedThroughRouter(w, script);
    script.onPrompt = oneTurn;
    await w.say("why did this fail?", { forwards: FORWARDS });
    assert.deepEqual(texts(w.rw.server), [
      "The person forwarded you these 2 messages, written by others:\n\n" +
        "Forwarded message 1 of 2 from Bob (2026-11-03 08:36 UTC):\n> The deploy failed on node 3\n\n" +
        "Forwarded message 2 of 2 from Carol:\n> see the log [image-1]\n\n" +
        "why did this fail?",
    ]);
  }));

test("a forward alone, with no words of the person's, still reaches the session", () =>
  routed(async (w) => {
    const script = new Script();
    await attachedThroughRouter(w, script);
    script.onPrompt = oneTurn;
    await w.say("", { forwards: FORWARDS.slice(0, 1) });
    assert.deepEqual(texts(w.rw.server), [
      "The person forwarded you this message, written by someone else:\n\n" +
        "Forwarded message from Bob (2026-11-03 08:36 UTC):\n> The deploy failed on node 3",
    ]);
  }));

test("a text file sent to an attached chat reaches the session inline; one that is not text is named back", () =>
  routed(
    async (w) => {
      const script = new Script();
      await attachedThroughRouter(w, script);
      script.onPrompt = oneTurn;
      const before = w.rw.said().length;
      const files: InboundFile[] = [
        { name: "build.log", type: "log", handle: {} },
        { name: "", type: "", handle: { kind: "pasted" } },
      ];
      await w.say("what broke?", { files });
      assert.deepEqual(texts(w.rw.server), [
        "what broke?\n\nThe file sent with this message:\n\n" +
          `File build.log (${String(bytes(LOG).length)} bytes):\n\`\`\`\`\n${LOG}\n\`\`\`\``,
      ]);
      const told = w.rw.said().slice(before).join("\n");
      assert.match(told, /These files were not passed on to the session: `image-2` \(a session takes text/u);
      assert.doesNotMatch(told, /only your words were sent/u);
    },
    { remote: { files: { "build.log": { mediaType: "text/plain", bytes: bytes(LOG) } } } },
  ));

test("files alone, with no words, go to the session as their text", () =>
  routed(
    async (w) => {
      const script = new Script();
      await attachedThroughRouter(w, script);
      script.onPrompt = oneTurn;
      await w.say("", { files: [{ name: "notes.md", type: "md", handle: {} }] });
      assert.deepEqual(texts(w.rw.server), [
        "The file sent with this message:\n\nFile notes.md (5 bytes):\n```\n# hi\n\n```",
      ]);
    },
    { remote: { files: { "notes.md": { mediaType: "text/markdown", bytes: bytes("# hi\n") } } } },
  ));
