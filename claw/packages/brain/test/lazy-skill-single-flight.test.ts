// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reads emitted in one turn run together, and each first touch of `.skills`
 * writes the skill it names. Two of them naming the same skill must share one
 * upload: a second upload rewrites files the first already placed, and the
 * read behind either can see one mid-rewrite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { LazyDefaultSkills } = await import("../src/agent/platform-defaults.js");
type DefaultSkill = import("../src/agent/platform-defaults.js").DefaultSkill;

function skillDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lazy-skill-${name}-`));
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${name}\n---\nbody\n`);
  return dir;
}

/** A sandbox whose writes wait until released, so two callers overlap for certain. */
function heldHands(answer = "ok") {
  const writes: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return {
    writes,
    release: () => release(),
    hands: {
      async callTool(name: string, args: Record<string, unknown>) {
        if (name === "write") writes.push(String(args.path));
        await held;
        return answer;
      },
    },
  };
}

test("two calls needing the same skill share one upload, and neither returns before it is written", async () => {
  const skill: DefaultSkill = { name: "fleet-ops", description: "d", toolId: 1, localDir: skillDir("fleet-ops") };
  const writer = new LazyDefaultSkills([skill]);
  const h = heldHands();
  const settled: string[] = [];
  const a = writer.ensure(h.hands as never, ".skills/fleet-ops").then(() => settled.push("a"));
  const b = writer.ensure(h.hands as never, ".skills/fleet-ops/SKILL.md").then(() => settled.push("b"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(settled, [], "the second call waits for the upload instead of returning early");
  h.release();
  await Promise.all([a, b]);
  assert.deepEqual(h.writes, [".skills/fleet-ops/SKILL.md"], "one upload, not one per caller");
  await writer.ensure(h.hands as never, ".skills/fleet-ops");
  assert.equal(h.writes.length, 1, "and once written it is not written again");
});

test("a plugin skill whose shared write failed fails every call that waited on it, and the next call retries", async () => {
  const skill: DefaultSkill = { name: "plug", description: "d", toolId: 2, localDir: skillDir("plug"), source: "plugin" };
  const writer = new LazyDefaultSkills([skill]);
  const bad = heldHands("Error writing .skills/plug/SKILL.md: disk full");
  const a = writer.ensure(bad.hands as never, ".skills/plug");
  const b = writer.ensure(bad.hands as never, ".skills/plug/SKILL.md");
  bad.release();
  const results = await Promise.allSettled([a, b]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(bad.writes.length, 1, "the failed upload was shared too");
  const good = heldHands();
  good.release();
  await writer.ensure(good.hands as never, ".skills/plug");
  assert.equal(good.writes.length, 1, "nothing in flight is left behind to block the retry");
});
