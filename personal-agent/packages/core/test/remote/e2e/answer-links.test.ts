// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A remote agent's link reaches the chat as its words and its host, in the stream and in the answer, through the worker.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { attached } from "./helpers.js";

// (an address or a link the rich text or a client would make clickable, outside a code span)
const CLICKABLE = /:\/\/|\bwww\.|\]\(|<[a-z!/]|\b[\w.+-]+@[\w-]+\.[\w.-]+/i;
const outsideCode = (text: string): string => text.replace(/`[^`\n]*`/g, "");

test("an agents link reaches the chat as words in the stream and in the answer", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "Done: [open the dashboard](https://evil.example/login?next=x) or https://plain.example/a.");
      await srv.end(sid);
    };
    await attached(w, script);
    await w.say("where is it?");
    const everything = [...w.said(), ...w.progressTexts()].join("\n").replace(/<code>(.*?)<\/code>/g, "`$1`");
    assert.ok(everything.includes("open the dashboard (`evil.example`)"), everything);
    assert.ok(everything.includes("`plain.example`"), everything);
    assert.doesNotMatch(outsideCode(everything), CLICKABLE, everything);
  }));
