// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `richTextActivity`: an xml message when the answer converts, the markdown unchanged when it does not. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LogFields, Logger } from "@primusclaw/personal-agent";
import { richTextActivity, unescapeMarkdown } from "../../src/richtext/index.js";

function recordingLogger(lines: [string, string, LogFields | undefined][]): Logger {
  const logger: Logger = {
    debug: (message, fields) => lines.push(["debug", message, fields]),
    info: (message, fields) => lines.push(["info", message, fields]),
    warn: (message, fields) => lines.push(["warn", message, fields]),
    error: (message, fields) => lines.push(["error", message, fields]),
    child: () => logger,
  };
  return logger;
}

test("a convertible answer goes as an xml message", () => {
  assert.deepEqual(richTextActivity("**Done**\n- a"), {
    type: "message",
    text: '<b><span style="font-size:16px">Done</span></b><br>• a',
    textFormat: "xml",
  });
  assert.deepEqual(richTextActivity("**Done**", { lead: false }), {
    type: "message",
    text: '<b><span style="font-size:15px">Done</span></b>',
    textFormat: "xml",
  });
});

test("an answer that cannot convert goes as markdown and only the error kind is logged", () => {
  const lines: [string, string, LogFields | undefined][] = [];
  const secret = "x".repeat(20_001);
  assert.deepEqual(richTextActivity(secret, {}, recordingLogger(lines)), {
    type: "message",
    text: secret,
    textFormat: "markdown",
  });
  assert.deepEqual(lines, [
    ["warn", "rich answer conversion failed; sending the markdown", { errorName: "RichTextError" }],
  ]);
});

test("unescape markdown resolves backslash escapes only", () => {
  assert.equal(unescapeMarkdown("\\- a \\* b \\\\ c \\é \\q"), "- a * b \\ c \\é \\q");
});
