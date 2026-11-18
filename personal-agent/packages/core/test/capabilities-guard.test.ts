// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ported from teams/tests/test_capabilities.py (the guard): what the router offers a person, derived from the router's
 * own code (its command lists, the command words its source reads, the routes a message can take, the menu and the agent
 * verbs), is covered by an entry of the capability registry, and removing any entry that covers something only it covers
 * turns the guard red. (The review service's verbs, the card kinds and the stored settings are derived by their lines.)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { CAPABILITIES, type Capability } from "../src/capabilities/registry.js";
import { AGENT_SUBCOMMANDS } from "../src/commands/agent-args.js";
import { ARGUMENT_COMMANDS, COMMANDS, GROUP_COMMANDS, PERSONAL_ONLY_COMMANDS } from "../src/commands/names.js";
import { MENU_COMMANDS } from "../src/commands/parse.js";

const ROUTING = new URL("../src/routing/", import.meta.url);

/** What a message can be routed to, as the router's calls that do it. */
const ROUTE_CALLS: Readonly<Record<string, string>> = {
  "starter.start(": "route:turn",
  ".enqueue(": "route:queue",
  ".quoteBlock(": "route:quote",
  ".withLinks(": "route:links",
  "remote.prompt(": "route:remote_prompt",
  "assistant.route(": "route:assistant",
  "this.text.understand(": "route:understanding",
  ".noteAssistantMessage(": "route:channel_action",
  "this.stopReviews(": "route:review_stop_group",
  "this.offerGithub(": "route:github_connect",
};

/** The command methods of the router, by the command they carry out. */
const COMMAND_METHODS: Readonly<Record<string, string>> = {
  "settings.quiet(": "command:quiet",
  "settings.pause(": "command:pause",
  "settings.timezone(": "command:timezone",
  "settings.resume(": "command:resume",
  "account.memorySwitch(": "command:memory_switch",
  "account.memory(": "command:memory",
  "account.whoami(": "command:whoami",
  "account.help(": "command:help",
  "account.lang(": "command:lang",
  "sessions.repo(": "command:repo",
  "sessions.sessions(": "command:sessions",
  "sessions.new(": "command:new",
  "sessions.stop(": "command:stop",
  "link.unlink(": "command:unlink",
  "link.link(": "command:link",
};

function source(): string {
  return readdirSync(ROUTING)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, ROUTING), "utf8"))
    .join("\n");
}

function derived(): Set<string> {
  const code = source();
  const found = new Set<string>();
  for (const c of [...COMMANDS, ...PERSONAL_ONLY_COMMANDS, ...ARGUMENT_COMMANDS, ...GROUP_COMMANDS])
    found.add(`command:${c}`);
  for (const m of code.matchAll(/commandArgs\([^,]+, "([a-z_]+)"\)/gu)) found.add(`command:${m[1] ?? ""}`);
  for (const [call, key] of Object.entries({ ...ROUTE_CALLS, ...COMMAND_METHODS }))
    if (code.includes(call)) found.add(key);
  for (const command of Object.values(MENU_COMMANDS)) {
    const [word = "", sub] = command.slice(1).split(" ");
    found.add(sub === undefined ? `command:${word}` : `agent:${sub}`);
  }
  for (const sub of AGENT_SUBCOMMANDS) found.add(`agent:${sub}`);
  found.add("command:github"); // (the review service's command, read before the account check: as the Python guard adds it)
  return found;
}

/** The kinds this line derives (the others are derived by the lines that own them). */
const KINDS = /^(command|agent|route):/u;
const OTHERS =
  /^route:(group_review|review_direct|review_mode_words|review_any_wording|review_by_name|review_model|review_notice|review_stop|review_many|deliveries)$/u;

function uncovered(registry: readonly Capability[]): { missing: string[]; stale: string[] } {
  const code = derived();
  const covered = new Set(registry.flatMap((c) => c.covers).filter((k) => KINDS.test(k) && !OTHERS.test(k)));
  return {
    missing: [...code].filter((k) => !covered.has(k)).sort(),
    stale: [...covered].filter((k) => !code.has(k)).sort(),
  };
}

test("test_every_capability_of_the_code_is_in_the_registry_and_nothing_else_is (the router's commands, verbs and routes)", () => {
  const { missing, stale } = uncovered(CAPABILITIES);
  assert.deepEqual(missing, [], "the router offers these and help does not say so");
  assert.deepEqual(stale, [], "help covers what the router no longer has");
});

test("test_the_derived_sets_are_not_empty", () => {
  const code = derived();
  for (const [kind, sample] of [
    ["command:", "command:quiet"],
    ["agent:", "agent:detach"],
    ["route:", "route:turn"],
  ] as const) {
    assert.ok(code.has(sample) && [...code].filter((k) => k.startsWith(kind)).length >= 2, kind);
  }
});

test("test_every_route_is_in_the_code", () => {
  const code = source();
  for (const call of Object.keys(ROUTE_CALLS)) assert.ok(code.includes(call), call);
});

test("test_removing_an_entry_turns_the_guard_red", () => {
  for (const c of CAPABILITIES.filter((x) => x.covers.some((k) => KINDS.test(k) && !OTHERS.test(k)))) {
    const onlyIt = c.covers.filter(
      (k) => KINDS.test(k) && !OTHERS.test(k) && !CAPABILITIES.some((o) => o !== c && o.covers.includes(k)),
    );
    if (onlyIt.length === 0) continue;
    assert.ok(uncovered(CAPABILITIES.filter((x) => x !== c)).missing.length > 0, c.key);
  }
});
