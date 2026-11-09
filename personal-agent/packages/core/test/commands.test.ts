import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseAgentCommand } from "../src/commands/agent-args.js";
import { commandArgs, menuCommand, parseClock, parseCommand, parseDurationSeconds, parseLinkCode, parseQuietWindow, parseTimezone } from "../src/commands/parse.js";
import { parseRepo, repoLabel, repoUrl, validBranch } from "../src/commands/repo.js";

describe("commands", () => {
  test("parse_command", () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ["/new", "new"],
      ["/memory", "memory"],
      ["/STOP", "stop"],
      ["  /help ", "help"],
      ["/unlink", "unlink"],
      ["/new please", null],
      ["new", null],
      ["/deploy", null],
      ["hello", null],
      ["", null],
    ];
    for (const [text, expected] of cases) assert.equal(parseCommand(text), expected, text);
  });

  test("command_args reads the argument of exactly that command", () => {
    assert.equal(commandArgs("/quiet 22:00-08:00", "quiet"), "22:00-08:00");
    assert.equal(commandArgs("  /Quiet  ", "quiet"), "");
    assert.equal(commandArgs("/quieter", "quiet"), null);
    assert.equal(commandArgs("/agent new codex /home/me/my repo", "agent"), "new codex /home/me/my repo");
  });

  test("menu_command reads the menu's words and a link code, and nothing else", () => {
    assert.equal(menuCommand("Help"), "/help");
    assert.equal(menuCommand("  agent   detach "), "/agent detach");
    assert.equal(menuCommand("sessions"), "/agent sessions");
    assert.equal(menuCommand("help me"), "help me");
    assert.equal(menuCommand("link 7KQ3M9XP"), "/link 7KQ3M9XP");
    assert.equal(menuCommand("link database"), "link database");
    assert.equal(menuCommand("link backends"), "link backends");
    assert.equal(menuCommand("link 7kq3m9xp"), "/link 7kq3m9xp");
    assert.equal(menuCommand("agents", true), "agents");
    assert.equal(menuCommand("whoami", true), "/whoami");
    assert.equal(menuCommand("link 7KQ3M9XP", true), "link 7KQ3M9XP");
  });

  test("the small parsers", () => {
    assert.equal(parseLinkCode("/link ABC"), "ABC");
    assert.equal(parseLinkCode("/link"), null);
    assert.deepEqual(parseTimezone("/timezone"), { isTimezone: true, arg: null });
    assert.deepEqual(parseTimezone("/timezone Asia/Tokyo"), { isTimezone: true, arg: "Asia/Tokyo" });
    assert.deepEqual(parseTimezone("/timezone a b"), { isTimezone: true, arg: "" });
    assert.deepEqual(parseTimezone("timezone"), { isTimezone: false, arg: null });
    assert.equal(parseClock("8:30"), "08:30");
    assert.equal(parseClock("24:00"), null);
    assert.equal(parseClock("８:３０"), "08:３０");
    assert.deepEqual(parseQuietWindow("22:00 - 8:00"), ["22:00", "08:00"]);
    assert.equal(parseQuietWindow("8:00-8:00"), null);
    assert.equal(parseDurationSeconds("2H"), 7200);
    assert.equal(parseDurationSeconds("31d"), null);
    assert.equal(parseDurationSeconds("0m"), null);
  });

  test("repo and branch names are what GitHub and git allow", () => {
    assert.deepEqual(parseRepo("AMD-AGI/PrimusClaw main"), { repo: "AMD-AGI/PrimusClaw", branch: "main" });
    const pick = parseRepo("a/b");
    assert.ok(pick !== null && repoUrl(pick) === "https://github.com/a/b" && repoLabel(pick) === "a/b");
    for (const bad of ["a", "-a/b", "a--b/c", "a/b.git", "a/..", "https://github.com/a/b", "a/b c d", "a/b ../x"]) {
      assert.equal(parseRepo(bad), null, bad);
    }
    for (const bad of ["-x", "a..b", "a/", "/a", "a//b", "a/.b", "a.lock", "a."]) assert.equal(validBranch(bad), false, bad);
    assert.equal(validBranch("feature/x-1.2"), true);
  });

  test("parse_agent_command", () => {
    assert.deepEqual(parseAgentCommand("New codex /home/me/my repo"), { verb: "new", rest: "codex /home/me/my repo" });
    assert.deepEqual(parseAgentCommand("detach"), { verb: "detach", rest: "" });
    assert.equal(parseAgentCommand(""), null);
    assert.equal(parseAgentCommand("list"), null);
  });
});
