// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A plugin's skills are fetched from the object store once per version, not
 * once per turn. Through the real `resolvePluginToolsFromMessage`; only the
 * object store is fake (it counts what it is asked for and, like a real one,
 * gives an object a new ETag when its bytes change).
 *
 * Before: every turn listed each skill's prefix and read every object under it,
 * and announced a `download_skill` running/success pair per skill, so a plugin
 * with a dozen skills paid 12 listings, one read per file and 24 events on every
 * turn. Now a turn that finds a skill unchanged costs one listing, reads nothing
 * and announces nothing.
 *
 * Each table row below is a rule that can be broken on its own:
 *  - unchanged skill: no object read, no event, identical files (supporting too)
 *  - in-place upsert (same key, same version string): refetched, whatever
 *    changed -- same-size rewrite, a supporting file, a file added or removed
 *  - a new version (new s3_key) is fetched; the old one stays held
 *  - concurrent turns of a cold skill read it once
 *  - a listing that fails, or that carries no ETag, is "cannot tell", not "same"
 *  - a skill without SKILL.md keeps reporting itself every turn
 *  - two tools of one skill name never leak files into each other
 *  - the bytes held stay bounded and an oversize skill is not held
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPluginWorld, skillRow } from "./support/plugin-world.js";

// An 8000-byte budget makes a skill over 2000 bytes "oversize" (a quarter of it).
process.env.SKILL_CACHE_MAX_BYTES = "8000";
const pw = await startPluginWorld();
const { resolvePluginToolsFromMessage } = await import("../src/tasks/plugin-from-message.js");
const { skillCache } = await import("../src/tools/skill-cache.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claw-plugin-skill-cache-"));
test.after(async () => { fs.rmSync(TMP, { recursive: true, force: true }); await pw.close(); });
test.beforeEach(() => { skillCache.clear(); pw.failListings = false; pw.omitEtags = false; });

type Ev = Record<string, unknown>;
let n = 0;
async function run(rows: unknown[]) {
  const events: Ev[] = [];
  const result = await resolvePluginToolsFromMessage(
    { plugin_id: 9, plugin_tools: rows, session_id: `psc-${process.pid}-${++n}` } as never,
    async (e: unknown) => { events.push(e as Ev); },
    path.join(TMP, `work-${n}`),
  );
  return { result, events };
}
/** One turn, with the object store's counters read for just this turn. */
async function turn(rows: unknown[]) {
  pw.resetCounts();
  const { result, events } = await run(rows);
  return { result, events, gets: [...pw.counts.gets].sort(), lists: pw.counts.lists, downloads: events.filter((e) => e.tool === "download_skill") };
}

/** rel -> contents of every file under a staged skill directory. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, "utf-8");
    }
  };
  walk(dir);
  return out;
}

const skillMd = (name: string, marker: string) => `---\nname: ${name}\ndescription: ${name}\n---\n${marker}\n`;
/** The three files of a prefix skill, by path relative to the skill. */
const filesOf = (name: string, marker: string): Record<string, string> => ({
  "SKILL.md": skillMd(name, marker),
  "scripts/run.py": `print('${marker}')\n`,
  "references/notes.md": `notes ${marker}\n`,
});
function seed(prefix: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) pw.put(`${prefix}/${rel}`, body);
}
const prefixRow = (id: number, name: string, prefix: string) => ({ id, type: "skill", name, config: { s3_key: `${prefix}/`, is_prefix: true } });
const soloRow = (id: number, name: string, key: string) => ({ id, type: "skill", name, config: { s3_key: key, is_prefix: false } });

test("a skill that has not changed is not read again: one listing, no object reads, no download events, same files", async () => {
  seed("t1/pfx", filesOf("pfx", "P1"));
  pw.put("t1/solo/SKILL.md", skillMd("solo", "S1"));
  const rows: Array<{ name: string; row: unknown; skill: string; objects: string[] }> = [
    { name: "prefix skill with supporting files", row: prefixRow(11, "pfx", "t1/pfx"), skill: "pfx", objects: ["t1/pfx/SKILL.md", "t1/pfx/references/notes.md", "t1/pfx/scripts/run.py"] },
    { name: "single-object skill", row: soloRow(12, "solo", "t1/solo/SKILL.md"), skill: "solo", objects: ["t1/solo/SKILL.md"] },
  ];
  for (const r of rows) {
    const first = await turn([r.row]);
    assert.deepEqual(first.gets, r.objects, `${r.name}: the first turn reads every object`);
    assert.equal(first.downloads.length, 2, `${r.name}: and announces its download (running, success)`);
    const second = await turn([r.row]);
    assert.deepEqual(second.gets, [], `${r.name}: nothing is read on the next turn`);
    assert.equal(second.downloads.length, 0, `${r.name}: nothing is announced`);
    assert.ok(second.lists >= 1, `${r.name}: but the store is asked whether it changed`);
    assert.equal(second.result.skillContents[r.skill], first.result.skillContents[r.skill], `${r.name}: same prompt text`);
    assert.deepEqual(tree(second.result.skillDirs[r.skill]), tree(first.result.skillDirs[r.skill]), `${r.name}: same files, supporting ones included`);
    assert.equal(second.result.skillToolIds[r.skill], first.result.skillToolIds[r.skill]);
  }
});

test("a dozen skills: the second turn reads no object and announces nothing", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    seed(`t2/s${i}`, filesOf(`s${i}`, `M${i}`));
    return prefixRow(200 + i, `s${i}`, `t2/s${i}`);
  });
  const first = await turn(rows);
  assert.equal(first.gets.length, 36);
  assert.equal(first.downloads.length, 24);
  const second = await turn(rows);
  assert.equal(second.gets.length, 0);
  assert.equal(second.downloads.length, 0);
  assert.equal(Object.keys(second.result.skillContents).length, 12);
});

test("an in-place upsert (same key, same version string) is fetched again, whatever it changed", async () => {
  const base = filesOf("up", "OLD1");
  const rows: Array<{ name: string; change: (prefix: string) => void; expect: (prefix: string) => Record<string, string> }> = [
    {
      name: "SKILL.md rewritten to a body of the same size (only the ETag differs)",
      change: (p) => pw.put(`${p}/SKILL.md`, skillMd("up", "NEW1")),
      expect: () => ({ ...base, "SKILL.md": skillMd("up", "NEW1") }),
    },
    {
      name: "SKILL.md rewritten longer",
      change: (p) => pw.put(`${p}/SKILL.md`, skillMd("up", "a much longer body than before")),
      expect: () => ({ ...base, "SKILL.md": skillMd("up", "a much longer body than before") }),
    },
    {
      name: "only a supporting file changed",
      change: (p) => pw.put(`${p}/scripts/run.py`, "print('changed')\n"),
      expect: () => ({ ...base, "scripts/run.py": "print('changed')\n" }),
    },
    {
      name: "a file was added",
      change: (p) => pw.put(`${p}/scripts/extra.sh`, "echo hi\n"),
      expect: () => ({ ...base, "scripts/extra.sh": "echo hi\n" }),
    },
    {
      name: "a file was removed",
      change: (p) => pw.remove(`${p}/references/notes.md`),
      expect: () => { const { "references/notes.md": _gone, ...rest } = base; return rest; },
    },
  ];
  let id = 300;
  for (const r of rows) {
    const prefix = `t3/up${id}`;
    seed(prefix, base);
    const row = prefixRow(id++, "up", prefix);
    await turn([row]);
    assert.equal((await turn([row])).gets.length, 0, `${r.name}: held before the upsert`);
    r.change(prefix);
    const after = await turn([row]);
    const want = r.expect(prefix);
    assert.deepEqual(tree(after.result.skillDirs.up), want, `${r.name}: the turn after the upsert has the new files, and only them`);
    assert.equal(after.result.skillContents.up, want["SKILL.md"], `${r.name}: and the new prompt text`);
    assert.equal(after.gets.length, Object.keys(want).length, `${r.name}: every object of the skill was read again`);
    assert.equal(after.downloads.length, 2, `${r.name}: and announced`);
    assert.equal((await turn([row])).gets.length, 0, `${r.name}: the new copy is held in turn`);
  }
});

test("a single-object skill rewritten in place is fetched again", async () => {
  pw.put("t3b/solo/SKILL.md", skillMd("solo", "AAAA"));
  const row = soloRow(350, "solo", "t3b/solo/SKILL.md");
  await turn([row]);
  assert.equal((await turn([row])).gets.length, 0);
  pw.put("t3b/solo/SKILL.md", skillMd("solo", "BBBB"));
  const after = await turn([row]);
  assert.equal(after.result.skillContents.solo, skillMd("solo", "BBBB"));
  assert.equal(after.gets.length, 1);
});

test("a new version is fetched, and the old one stays held", async () => {
  seed("t4/v1", filesOf("ver", "V1"));
  seed("t4/v2", filesOf("ver", "V2"));
  const v1 = prefixRow(400, "ver", "t4/v1");
  const v2 = prefixRow(400, "ver", "t4/v2");
  await turn([v1]);
  const second = await turn([v2]);
  assert.equal(second.gets.length, 3, "version 2 is read");
  assert.equal(second.result.skillContents.ver, skillMd("ver", "V2"));
  assert.equal((await turn([v1])).gets.length, 0, "version 1 was not displaced");
  assert.equal((await turn([v2])).gets.length, 0);
});

test("a skill is not shared between tools of different ids", async () => {
  seed("t4b/shared", filesOf("sh", "SH"));
  await turn([prefixRow(410, "sh", "t4b/shared")]);
  const other = await turn([prefixRow(411, "sh", "t4b/shared")]);
  assert.equal(other.gets.length, 3);
});

test("concurrent turns for a skill nobody holds read it once", async () => {
  seed("t5/cold", filesOf("cold", "C"));
  const row = prefixRow(500, "cold", "t5/cold");
  pw.resetCounts();
  const runs = await Promise.all(Array.from({ length: 6 }, () => run([row])));
  assert.equal(pw.counts.gets.length, 3, `the three objects were read once, not six times (${pw.counts.gets.length} reads)`);
  for (const { result } of runs) {
    assert.deepEqual(tree(result.skillDirs.cold), filesOf("cold", "C"), "every turn has the whole skill");
  }
  const announced = runs.flatMap((r) => r.events).filter((e) => e.tool === "download_skill" && e.status === "running");
  assert.equal(announced.length, 1, "one download was announced");
  assert.equal((await turn([row])).gets.length, 0);
});

test("a listing that fails is read as 'cannot tell', never as 'unchanged'", async () => {
  // A prefix skill is listed again by its own download, so with the listing down
  // it fails outright -- visibly, and without serving the held copy. A
  // single-object skill needs no listing to download: it gets the new bytes.
  seed("t6/lf", filesOf("lf", "OLD1"));
  pw.put("t6/solo/SKILL.md", skillMd("lfsolo", "OLD2"));
  const prefix = prefixRow(600, "lf", "t6/lf");
  const solo = soloRow(601, "lfsolo", "t6/solo/SKILL.md");
  await turn([prefix, solo]);
  assert.equal((await turn([prefix, solo])).gets.length, 0, "both held");
  seed("t6/lf", filesOf("lf", "NEW1"));
  pw.put("t6/solo/SKILL.md", skillMd("lfsolo", "NEW2"));
  pw.failListings = true;
  const blind = await turn([prefix, solo]);
  assert.equal(blind.result.skillContents.lfsolo, skillMd("lfsolo", "NEW2"), "single object: downloaded, new bytes");
  assert.notEqual(blind.result.skillContents.lf, skillMd("lf", "OLD1"), "prefix: the held copy is not served on a blind listing");
  assert.ok(blind.events.some((e) => e.tool === "download_skill" && e.status === "error" && String(e.brief).includes("lf")), "and the failure is reported");
  // Still blind, and the store moves again: a failed check must not have left
  // anything behind that a second failed check could match.
  pw.put("t6/solo/SKILL.md", skillMd("lfsolo", "NEW3"));
  const blindAgain = await turn([prefix, solo]);
  assert.equal(blindAgain.result.skillContents.lfsolo, skillMd("lfsolo", "NEW3"), "a second blind turn does not reuse the first blind turn's copy");
  pw.failListings = false;
  const healed = await turn([prefix, solo]);
  assert.equal(healed.result.skillContents.lf, skillMd("lf", "NEW1"), "the next turn with a working listing has the new copy");
});

test("a store that reports no ETag is never cached", async () => {
  seed("t7/ne", filesOf("ne", "X"));
  const row = prefixRow(700, "ne", "t7/ne");
  pw.omitEtags = true;
  assert.equal((await turn([row])).gets.length, 3);
  assert.equal((await turn([row])).gets.length, 3, "nothing could be told apart, so nothing was held");
  pw.omitEtags = false;
  assert.equal((await turn([row])).gets.length, 3);
  assert.equal((await turn([row])).gets.length, 0, "once it does report them, it is");
});

test("a skill without SKILL.md is not held and reports itself on every turn", async () => {
  pw.put("t8/broken/readme.txt", "no skill here\n");
  const row = prefixRow(800, "broken", "t8/broken");
  for (let i = 0; i < 2; i++) {
    const t = await turn([row]);
    assert.equal(t.gets.length, 1, `turn ${i + 1}: read again`);
    assert.deepEqual(t.result.skillContents, {}, `turn ${i + 1}: no skill`);
    assert.ok(t.events.some((e) => e.tool === "download_skill" && e.status === "error" && String(e.brief).includes("missing SKILL.md")), `turn ${i + 1}: error event`);
  }
});

test("two tools with one skill name do not leak files into each other through the cache", async () => {
  pw.put("t9/a/SKILL.md", skillMd("dup", "A"));
  pw.put("t9/a/a-only.txt", "a\n");
  pw.put("t9/b/SKILL.md", skillMd("dup", "B"));
  pw.put("t9/b/b-only.txt", "b\n");
  const a = prefixRow(900, "dup", "t9/a");
  const b = prefixRow(901, "dup", "t9/b");
  await turn([a, b]);
  const alone = await turn([b]);
  assert.deepEqual(Object.keys(tree(alone.result.skillDirs.dup)).sort(), ["SKILL.md", "b-only.txt"], "tool b's skill has none of tool a's files");
  assert.equal(alone.result.skillContents.dup, skillMd("dup", "B"));
});

test("each turn gets files of its own: changing them does not change the next turn's", async () => {
  seed("t10/own", filesOf("own", "O"));
  const row = prefixRow(1000, "own", "t10/own");
  const first = await turn([row]);
  fs.writeFileSync(path.join(first.result.skillDirs.own, "SKILL.md"), "scribbled by a tool\n");
  fs.rmSync(path.join(first.result.skillDirs.own, "scripts"), { recursive: true });
  const second = await turn([row]);
  assert.equal(second.gets.length, 0);
  assert.deepEqual(tree(second.result.skillDirs.own), filesOf("own", "O"));
});

test("the bytes held stay under the bound, and a skill over a quarter of it is never held", async () => {
  const small = Array.from({ length: 12 }, (_, i) => {
    pw.put(`t11/s${i}/SKILL.md`, skillMd(`s${i}`, "p".repeat(850)));
    return prefixRow(1100 + i, `s${i}`, `t11/s${i}`);
  });
  pw.put("t11/big/SKILL.md", skillMd("big", "q".repeat(2500)));
  const big = prefixRow(1200, "big", "t11/big");
  const first = await turn([...small, big]);
  assert.equal(Object.keys(first.result.skillContents).length, 13, "every skill still arrives");
  assert.ok(skillCache.size > 0 && skillCache.size <= 8000, `held ${skillCache.size} bytes against a bound of 8000`);
  assert.equal((await turn([small[11]])).gets.length, 0, "the most recent small skill is held");
  assert.equal((await turn([big])).gets.length, 1, "the oversize one is read every time");
  assert.equal((await turn([big])).gets.length, 1);
  assert.ok(skillCache.size <= 8000);
});
