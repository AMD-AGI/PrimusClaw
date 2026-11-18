// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The on-demand list's share for the user's personal skills (`listProgressiveSkills`): of the list's 8000 characters
 * and 50 entries, personal skills have the first 3000 characters (and 20 entries) to themselves; the platform's,
 * plugins' and repository's skills fit in what that leaves; personal skills that did not fit their share then take
 * what the others left.
 *
 *   L1 with no personal skill the list is what it always was: a prefix that stops at the first that does not fit
 *   L2 many platform skills do not push a few personal ones out
 *   L3 many personal skills do not push the platform's out, and take the room the platform's leave
 *   L4 both many: personal ones keep their share and no more, the others fill the rest
 *   L5 the 50-entry cap is shared the same way
 *   L6 which of the others fit does not depend on how many personal skills there are beyond their share
 *   L7 the hint: personal ones under their own heading after the platform's, what they replace, how many were left out
 */
import test from "node:test";
import assert from "node:assert/strict";

const { listProgressiveSkills, buildProgressiveSkillHint } = await import("../src/agent/prompt.js");

type S = { name: string; description: string; source?: string; user?: { shadows?: "platform" | "repository"; imported?: boolean } };
const platform = (n: number, len = 150): S[] => Array.from({ length: n }, (_, i) => ({ name: `plat-${String(i).padStart(2, "0")}`, description: "p".repeat(len) }));
const mine = (n: number, len = 150): S[] => Array.from({ length: n }, (_, i) => ({ name: `mine-${String(i).padStart(2, "0")}`, description: "m".repeat(len), source: "user" }));
const lineLen = (s: S) => `\n  - ${s.name}: ${s.description}`.length;
const sum = (xs: S[]) => xs.reduce((a, s) => a + lineLen(s), 0);

test("L1 with no personal skill the list is a prefix that stops at the first that does not fit, as before", () => {
  const skills = [...platform(10), { name: "huge", description: "h".repeat(7000) }, ...platform(3, 10).map((s) => ({ ...s, name: `${s.name}-after` }))];
  const r = listProgressiveSkills(skills, "/workspace");
  assert.deepEqual(r.listed.map((s) => s.name), platform(10).map((s) => s.name), "stops at the first that does not fit");
  assert.equal(r.omitted, 4);
  assert.deepEqual(r.personal, { listed: [], omitted: 0, lines: "" });
  const all = listProgressiveSkills(platform(60, 100), "/workspace");
  assert.equal(all.listed.length, 50, "50 entries at most");
});

test("L2 many platform skills do not push a few personal ones out", () => {
  const r = listProgressiveSkills([...platform(60), ...mine(5)], "/workspace");
  assert.equal(r.personal.listed.length, 5, "all personal ones listed");
  assert.equal(r.personal.omitted, 0);
  assert.ok(sum(r.listed as S[]) + sum(r.personal.listed as S[]) <= 8000);
  assert.ok(r.listed.length > 0 && r.omitted > 0, "the platform's fill the rest");
  assert.ok(sum(r.listed as S[]) > 8000 - 3000, "the personal share they did not use went to the platform's");
});

test("L3 many personal skills do not push the platform's out, and take the room the platform's leave", () => {
  const r = listProgressiveSkills([...platform(2), ...mine(40, 250)], "/workspace");
  assert.equal(r.listed.length, 2, "both platform skills listed");
  assert.ok(sum(r.personal.listed as S[]) > 3000, "personal ones beyond their share, into what the platform's left");
  assert.ok(sum(r.listed as S[]) + sum(r.personal.listed as S[]) <= 8000);
  assert.deepEqual(r.personal.listed.map((s) => s.name), mine(40, 250).slice(0, r.personal.listed.length).map((s) => s.name), "a prefix: most recently used first");
  assert.equal(r.personal.omitted, 40 - r.personal.listed.length);
});

test("L4 both many: personal ones keep their share and no more; the others fill the rest", () => {
  const r = listProgressiveSkills([...platform(60), ...mine(40)], "/workspace");
  const p = sum(r.personal.listed as S[]);
  assert.ok(p <= 3000 && p > 3000 - lineLen(mine(1)[0]), `personal ones fill their share (${p})`);
  assert.ok(sum(r.listed as S[]) <= 8000 - p && sum(r.listed as S[]) > 8000 - p - lineLen(platform(1)[0]), "the others fill the rest");
});

test("L5 the 50-entry cap is shared the same way", () => {
  const r = listProgressiveSkills([...platform(40, 5), ...mine(30, 5)], "/workspace");
  assert.equal(r.personal.listed.length, 20, "personal ones: their 20 entries");
  assert.equal(r.listed.length, 30, "the others: the rest of the 50");
  const few = listProgressiveSkills([...platform(5, 5), ...mine(60, 5)], "/workspace");
  assert.equal(few.listed.length, 5);
  assert.equal(few.personal.listed.length, 45, "personal ones take the entries the others left");
});

test("L6 which of the others fit does not depend on how many personal skills there are beyond their share", () => {
  const others = platform(60);
  const a = listProgressiveSkills([...others, ...mine(25)], "/workspace").listed.map((s) => s.name);
  const b = listProgressiveSkills([...others, ...mine(45)], "/workspace").listed.map((s) => s.name);
  assert.deepEqual(a, b);
});

test("L7 the hint: personal ones after the platform's under their own heading, what they replace, how many were left out", () => {
  const skills: S[] = [...platform(2, 20), { name: "weekly", description: "Weekly report", source: "user", user: { shadows: "platform" } },
    { name: "ext", description: "From elsewhere", source: "user", user: { imported: true } }, ...mine(60, 250)];
  const hint = buildProgressiveSkillHint(skills, "/workspace");
  assert.ok(hint.indexOf("Platform Skills (load on demand)") < hint.indexOf("Personal Skills (the user's own"));
  assert.match(hint, /\n  - weekly: Weekly report/);
  assert.match(hint, /\n  - ext \(imported\): From elsewhere/);
  assert.match(hint, /personal skill 'weekly' replaces the platform skill of the same name/);
  assert.match(hint, /\(\d+ more of the user's personal skills not listed; when the user names one, load it with load_skill by that name\)/);
  assert.match(hint, /a personal skill's from \/workspace\/\.skills\/\.personal-skills\/<name>\//);
  const noLoad = buildProgressiveSkillHint(skills, "/workspace", false);
  assert.match(noLoad, /- weekly: Weekly report   \[read \/workspace\/\.skills\/\.personal-skills\/weekly\/SKILL\.md\]/, "without load_skill: the path in the sandbox");
  assert.match(noLoad, /when the user names one, read \/workspace\/\.skills\/\.personal-skills\/<name>\/SKILL\.md\)/);
  assert.equal(buildProgressiveSkillHint(platform(2, 20), "/workspace").includes("Personal Skills"), false, "none: no heading");
});

test("L8 the emptying fallback, with a real shell: every file under the directory, at any depth, is emptied through write", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { tmpDir } = await import("../../utils/test/tmp-dirs.js");
  const { emptySandboxFiles } = await import("../src/agent/platform-defaults.js");
  const root = path.join(tmpDir("personal-empty-"), "it's .personal-skills");
  const files = ["a/SKILL.md", "a/scripts/run.sh", "b c/SKILL.md"].map((f) => path.join(root, f));
  for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "SECRET-TEXT"); }
  const outside = path.join(path.dirname(root), "keep.md");
  fs.writeFileSync(outside, "KEEP");
  const hands = {
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === "bash") return spawnSync("bash", ["-c", String(args.command)], { encoding: "utf8" }).stdout;
      if (name === "write") { fs.writeFileSync(String(args.path), String(args.contents)); return `Written to ${String(args.path)}`; }
      return "";
    },
  };
  const failed = await emptySandboxFiles(hands as never, root, []);
  assert.equal(failed, 0);
  for (const f of files) assert.equal(fs.readFileSync(f, "utf8"), "", `${f} emptied`);
  assert.equal(fs.readFileSync(outside, "utf8"), "KEEP", "nothing outside the directory");
});
