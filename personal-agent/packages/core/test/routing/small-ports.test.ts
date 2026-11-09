// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Single tests other Python modules hold for the router and the command words. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderHelp } from "../../src/capabilities/help.js";
import { naturalCommand, switchCommand } from "../../src/capabilities/natural.js";
import type { Part } from "../../src/capabilities/registry.js";
import { parseAgentCommand } from "../../src/commands/agent-args.js";
import { GROUP_COMMANDS, isKnownCommand } from "../../src/commands/names.js";
import { AGENT_USAGE } from "../../src/locales/commands.js";
import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

test("test_agent_commands_parse_to_a_subcommand_and_its_rest", () => {
  const cases: Readonly<Record<string, readonly [string, string] | null>> = {
    "new codex /a b/c": ["new", "codex /a b/c"],
    "NEW codex /x": ["new", "codex /x"],
    "attach 2": ["attach", "2"],
    detach: ["detach", ""],
    mode: ["mode", ""],
    "mode plan": ["mode", "plan"],
    sessions: ["sessions", ""],
    close: ["close", ""],
    "off dev-pod": ["off", "dev-pod"],
    "  off  ": ["off", ""],
    "": null,
    frobnicate: null,
    newcodex: null,
    "/new": null,
  };
  for (const [text, want] of Object.entries(cases)) {
    const got = parseAgentCommand(text);
    assert.deepEqual(got === null ? null : [got.verb, got.rest], want, text);
  }
});

test("test_the_commands_are_known_help_names_them_and_the_group_list_is_unchanged", () => {
  assert.ok(isKnownCommand("agent") && isKnownCommand("agents") && !isKnownCommand("agentx"));
  assert.ok(renderHelp("en", { parts: new Set<Part>(["remote"]) }).includes("show my agents"));
  assert.ok(!renderHelp("en").includes("show my agents"));
  assert.deepEqual(new Set(GROUP_COMMANDS), new Set(["help", "new", "stop", "whoami", "feedback"]));
  for (const sub of ["new", "attach", "detach", "mode", "sessions", "close", "off"])
    assert.ok(AGENT_USAGE.includes(`/agent ${sub}`));
});

test("test_the_plain_sentences_of_switching", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["切到 robin-dev-pod 的 claude", "/agent attach robin-dev-pod/claude"],
    ["切到robin-dev-pod上的codex", "/agent attach robin-dev-pod/codex"],
    ["帮我连到 robin-dev-pod 上的 claude code", "/agent attach robin-dev-pod/claude"],
    ["切到 claude", "/agent attach claude"],
    ["switch to claude on robin-dev-pod", "/agent attach robin-dev-pod/claude"],
    ["switch to robin-dev-pod/codex", "/agent attach robin-dev-pod/codex"],
    ["回到助理", "/agent detach"],
    ["back to the assistant", "/agent detach"],
    ["会话列表", "/agent sessions"],
    ["切到 AMD-AGI/PrimusClaw", "/repo AMD-AGI/PrimusClaw"], // (a repository stays a repository)
    ["切到我的开发机的 claude", "切到我的开发机的 claude"], // (no host name: the assistant reads it)
    ["让 robin-dev-pod 上的 claude 跑 make test", "让 robin-dev-pod 上的 claude 跑 make test"], // (an instruction)
  ];
  for (const [said_, command] of cases) {
    assert.equal(naturalCommand(said_), command, said_);
    assert.equal(switchCommand(said_) !== null, command.startsWith("/agent attach"), said_);
  }
});

test("test_the_lockout_answer_names_the_configured_window", async () => {
  const w = world({ linkLimits: { perUser: 1, global: 100, windowSeconds: 1800 } });
  await w.router.handle(message("/link WRONG222", { id: "w1" }));
  await w.router.handle(message("/link WRONG333", { id: "w2" }));
  assert.equal(said(w).at(-1), "Too many wrong codes. Wait 30 minutes and try again.");
});

test("test_link_from_teams_logs_the_activity_and_answers_the_global_limit (the chat's part)", async () => {
  const w = world({ linkLimits: { perUser: 5, global: 1, windowSeconds: 600 } });
  const code = w.store.links.stashPending("ak-alice");
  await w.router.handle(message("/link", { id: "act-none" })); // (no code: counted too)
  await w.router.handle(message(`/link ${code}`, { id: "act-right" }));
  assert.equal(w.store.links.getKey(ALICE.id), null);
  assert.ok(said(w).at(-1)?.includes("Linking is paused") && !said(w).join("").includes(code));
});

test("test_a_message_after_the_deadline_starts_a_turn_again", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.turns.answers = ["The task is still running in PrimusClaw; I stopped following it here after 30 minutes."];
  await w.router.handle(message("long job"));
  await w.router.settled();
  await w.router.handle(message("and now?"));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak", "long job"],
    ["send", "ak", "sess-ak", "and now?"],
  ]);
});
