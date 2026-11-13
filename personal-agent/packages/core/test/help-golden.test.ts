// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Help, the actions a chat declares and the data statement, byte for byte as the Python worker renders them: for every
 * chat shape of the golden file (language, group, assistant, understanding, the parts that are on, the settings shown,
 * a lead, another bot name).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { z } from "zod";

import { renderHelp } from "../src/capabilities/help.js";
import { LEGACY_BOT_NAME } from "../src/legacy-names.js";
import type { Part } from "../src/capabilities/registry.js";
import { agentActionAllowed, channelActions } from "../src/capabilities/visibility.js";
import { dataStatement } from "../src/locales/transparency.js";

const PartName = z.enum(["github", "remote", "brief", "schedule", "watch_job"]);
const HelpRow = z.object({
  lang: z.string(),
  group: z.boolean().optional(),
  assistant: z.boolean().optional(),
  understanding: z.boolean().optional(),
  parts: z.array(PartName),
  values: z.record(z.string(), z.string()).optional(),
  lead: z.string().optional(),
  bot: z.string().optional(),
  text: z.string().optional(),
  sha256: z.string().optional(),
});
const Golden = z.object({
  help: z.array(HelpRow),
  actions: z.array(
    z.object({
      parts: z.array(PartName),
      actions: z.array(z.object({ name: z.string(), usage: z.string(), summary: z.string() })),
    }),
  ),
  allowed: z.array(z.tuple([z.string(), z.boolean()])),
  statement: z.array(z.object({ lang: z.string(), remote: z.boolean(), text: z.string() })),
});

const golden = Golden.parse(
  JSON.parse(readFileSync(new URL("../../../test-support/data/routing/help.json", import.meta.url), "utf8")),
);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("help is rendered byte for byte as the Python worker renders it", () => {
  assert.ok(golden.help.length > 400 && golden.help.filter((row) => row.text !== undefined).length >= 6);
  const differences: string[] = [];
  for (const row of golden.help) {
    const text = renderHelp(row.lang, {
      group: row.group ?? false,
      assistant: row.assistant ?? false,
      understanding: row.understanding ?? false,
      parts: new Set<Part>(row.parts),
      values: row.values ?? {},
      lead: row.lead ?? "",
      bot: row.bot ?? LEGACY_BOT_NAME, // (the Python worker rendered them under the bot's earlier default name)
      channel: "Microsoft Teams", // (the goldens are the Teams worker's)
    });
    if (row.text !== undefined) assert.equal(text, row.text);
    else if (sha256(text) !== row.sha256) differences.push(JSON.stringify({ ...row, sha256: undefined }));
  }
  assert.deepEqual(differences, []);
});

test("the actions a chat declares are the Python worker's", () => {
  for (const row of golden.actions) assert.deepEqual(channelActions(new Set<Part>(row.parts)), row.actions);
  for (const [args, allowed] of golden.allowed) assert.equal(agentActionAllowed(args), allowed, args);
});

test("the data statement is the Python worker's", () => {
  for (const row of golden.statement) {
    assert.equal(dataStatement(row.lang, row.remote, undefined, "Microsoft Teams"), row.text);
  }
});
