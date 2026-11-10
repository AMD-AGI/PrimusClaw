// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The words of a message, read exactly as the Python worker reads them: every input of the golden file (capability
 * examples, every phrase with the decorations people add, times, durations, zones, languages, repositories, agent
 * switches, menu words) gives the same command here as `menu_command`, `natural_command`, `switch_command`,
 * `session_control` and `clock_of` gave there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { z } from "zod";

import { clockOf, naturalCommand, sessionControl, switchCommand } from "../src/capabilities/natural.js";
import {
  menuCommand,
  parseClock,
  parseCommand,
  parseDurationSeconds,
  parseLinkCode,
  parseQuietWindow,
  parseTimezone,
} from "../src/commands/parse.js";
import { parseRepo } from "../src/commands/repo.js";

const Row = z.object({
  t: z.string(),
  menu: z.string().optional(),
  menu_group: z.string().optional(),
  natural: z.string().optional(),
  natural_group: z.string().optional(),
  switch: z.string().optional(),
  clock: z.string().optional(),
  control: z.literal(true).optional(),
  off: z.record(z.string(), z.string()).optional(),
});
const ParseRow = z.object({
  text: z.string(),
  clock: z.string().nullable(),
  quiet: z.array(z.string()).nullable(),
  duration: z.number().nullable(),
  link: z.string().nullable(),
  timezone: z.tuple([z.boolean(), z.string().nullable()]),
  repo: z.tuple([z.string(), z.string()]).nullable(),
  command: z.string().nullable(),
});
const Golden = z.object({ words: z.array(Row), parse: z.array(ParseRow) });

const golden = Golden.parse(
  JSON.parse(readFileSync(new URL("../../../test-support/data/routing/routing-words.json", import.meta.url), "utf8")),
);

test("every message is read as the Python worker reads it", () => {
  assert.ok(golden.words.length > 2000);
  const differences: string[] = [];
  for (const row of golden.words) {
    const want = {
      menu: row.menu ?? row.t,
      menuGroup: row.menu_group ?? row.t,
      natural: row.natural ?? row.t,
      naturalGroup: row.natural_group ?? row.t,
      switch: row.switch ?? null,
      clock: row.clock ?? null,
      control: row.control ?? false,
    };
    const got = {
      menu: menuCommand(row.t),
      menuGroup: menuCommand(row.t, true),
      natural: naturalCommand(row.t),
      naturalGroup: naturalCommand(row.t, true),
      switch: switchCommand(row.t),
      clock: clockOf(row.t),
      control: sessionControl(row.t),
    };
    if (JSON.stringify(got) !== JSON.stringify(want)) differences.push(`${row.t}: ${JSON.stringify(got)}`);
    for (const [off, command] of Object.entries(row.off ?? {})) {
      const read = naturalCommand(row.t, false, new Set(off.split(",")));
      if (read !== command) differences.push(`${row.t} (off ${off}): ${read}`);
    }
  }
  assert.deepEqual(differences, []);
});

test("every argument is parsed as the Python worker parses it", () => {
  for (const row of golden.parse) {
    const timezone = parseTimezone(row.text);
    const repo = parseRepo(row.text);
    const quiet = parseQuietWindow(row.text);
    assert.deepEqual(
      {
        clock: parseClock(row.text),
        quiet: quiet === null ? null : [...quiet],
        duration: parseDurationSeconds(row.text),
        link: parseLinkCode(row.text),
        timezone: [timezone.isTimezone, timezone.arg],
        repo: repo === null ? null : [repo.repo, repo.branch],
        command: parseCommand(row.text),
      },
      {
        clock: row.clock,
        quiet: row.quiet,
        duration: row.duration,
        link: row.link,
        timezone: row.timezone,
        repo: row.repo,
        command: row.command,
      },
      row.text,
    );
  }
});
