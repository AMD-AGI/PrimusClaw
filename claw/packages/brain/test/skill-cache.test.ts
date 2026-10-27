// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SkillCache decides whether a skill is downloaded; these pin the decision.
 *
 * Each row is one rule the cache has to keep, and each fails if that rule is
 * removed: a held copy is served only for the fingerprint it was taken at, an
 * identical download in flight is shared and a different one is not, the bytes
 * held stay under the bound (least recently used out first), nothing is held
 * that could not be told apart or was not a usable skill, and every caller gets
 * a copy of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillCache, type SkillDownload } from "../src/tools/skill-cache.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "claw-skill-cache-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
const freshDir = () => path.join(ROOT, `d${++seq}`);

/** Every file under `dir` as rel -> bytes, so two staged copies compare in one assertion. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full).toString("latin1");
    }
  };
  walk(dir);
  return out;
}

/** A download that writes `files`, counts its runs, and can be held open or told to report unusable. */
function download(files: Record<string, string | Buffer>, o: { gate?: Promise<void>; usable?: boolean; fail?: () => boolean } = {}) {
  let calls = 0;
  const fn = (async (dir: string) => {
    calls++;
    if (o.gate) await o.gate;
    if (o.fail?.()) throw new Error("download failed");
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return o.usable ?? true;
  }) as SkillDownload & { readonly calls: number };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn;
}

const skill = { "SKILL.md": "# skill\n", "scripts/run.py": "print(1)\n", "references/deep/notes.md": "notes\n" };
const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00, 0x7f]);

test("a second request for the same fingerprint is served from memory, byte for byte", async () => {
  const rows: Array<{ name: string; files: Record<string, string | Buffer> }> = [
    { name: "one file", files: { "SKILL.md": "# only\n" } },
    { name: "nested files", files: skill },
    { name: "binary content", files: { "SKILL.md": "# b\n", "assets/blob.bin": bytes } },
  ];
  for (const row of rows) {
    const cache = new SkillCache(1 << 20);
    const dl = download(row.files);
    const a = freshDir();
    const b = freshDir();
    assert.equal(await cache.stage("k", "fp1", a, dl), "downloaded", row.name);
    assert.equal(await cache.stage("k", "fp1", b, dl), "hit", row.name);
    assert.equal(dl.calls, 1, `${row.name}: downloaded once`);
    assert.deepEqual(tree(b), tree(a), `${row.name}: the held copy is the downloaded one`);
  }
});

test("a changed fingerprint is downloaded again, and an old one is not served after a newer one", async () => {
  const cache = new SkillCache(1 << 20);
  const v1 = download({ "SKILL.md": "one\n" });
  const v2 = download({ "SKILL.md": "two\n" });
  const d1 = freshDir();
  const d2 = freshDir();
  const d3 = freshDir();
  const d4 = freshDir();
  assert.equal(await cache.stage("k", "fp1", d1, v1), "downloaded");
  assert.equal(await cache.stage("k", "fp2", d2, v2), "downloaded", "new fingerprint -> new download");
  assert.equal(fs.readFileSync(path.join(d2, "SKILL.md"), "utf-8"), "two\n");
  // Back to the first fingerprint: the entry was replaced, so this is a download, not a stale hit.
  assert.equal(await cache.stage("k", "fp1", d3, v1), "downloaded");
  assert.equal(await cache.stage("k", "fp1", d4, v1), "hit");
  assert.equal(v1.calls, 2);
  assert.equal(v2.calls, 1);
});

test("different keys never share a copy", async () => {
  const cache = new SkillCache(1 << 20);
  const a = download({ "SKILL.md": "a\n" });
  const b = download({ "SKILL.md": "b\n" });
  await cache.stage("tool-1", "same", freshDir(), a);
  const d = freshDir();
  assert.equal(await cache.stage("tool-2", "same", d, b), "downloaded");
  assert.equal(fs.readFileSync(path.join(d, "SKILL.md"), "utf-8"), "b\n");
});

test("what cannot be told apart, or is not a usable skill, is downloaded every time and never held", async () => {
  const rows: Array<{ name: string; fingerprint: string | null; usable: boolean }> = [
    { name: "no fingerprint (null)", fingerprint: null, usable: true },
    { name: "empty fingerprint", fingerprint: "", usable: true },
    { name: "download reports unusable (no SKILL.md)", fingerprint: "fp", usable: false },
  ];
  for (const row of rows) {
    const cache = new SkillCache(1 << 20);
    const dl = download({ "SKILL.md": "x\n" }, { usable: row.usable });
    assert.equal(await cache.stage("k", row.fingerprint, freshDir(), dl), "downloaded", row.name);
    assert.equal(await cache.stage("k", row.fingerprint, freshDir(), dl), "downloaded", row.name);
    assert.equal(dl.calls, 2, `${row.name}: downloaded both times`);
    assert.equal(cache.size, 0, `${row.name}: nothing held`);
  }
});

test("a cache of size 0 downloads as it did before the cache", async () => {
  const cache = new SkillCache(0);
  const dl = download(skill);
  assert.equal(cache.enabled, false);
  await cache.stage("k", "fp", freshDir(), dl);
  assert.equal(await cache.stage("k", "fp", freshDir(), dl), "downloaded");
  assert.equal(dl.calls, 2);
  assert.equal(cache.size, 0);
});

test("concurrent requests for one fingerprint share a single download", async () => {
  const cache = new SkillCache(1 << 20);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const dl = download(skill, { gate });
  const dirs = Array.from({ length: 6 }, freshDir);
  const running = dirs.map((d) => cache.stage("k", "fp", d, dl));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dl.calls, 1, "one download while the others wait");
  open();
  const outcomes = await Promise.all(running);
  assert.deepEqual([...outcomes].sort(), ["downloaded", "joined", "joined", "joined", "joined", "joined"]);
  assert.equal(dl.calls, 1);
  for (const d of dirs) assert.deepEqual(tree(d), tree(dirs[0]), "every caller has the full skill");
  assert.equal(Object.keys(tree(dirs[0])).length, 3);
});

test("a request that has read a newer fingerprint does not take the bytes of an older download in flight", async () => {
  const cache = new SkillCache(1 << 20);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const old = download({ "SKILL.md": "old\n" }, { gate });
  const fresh = download({ "SKILL.md": "new\n" });
  const dOld = freshDir();
  const dNew = freshDir();
  const first = cache.stage("k", "fp-old", dOld, old);
  const second = cache.stage("k", "fp-new", dNew, fresh);
  // Released on a timer, so a cache that wrongly made `second` wait for `first`
  // fails the assertions below instead of hanging the run.
  const timer = setTimeout(open, 100);
  assert.equal(await second, "downloaded", "the newer request ran its own download");
  clearTimeout(timer);
  assert.equal(fs.readFileSync(path.join(dNew, "SKILL.md"), "utf-8"), "new\n");
  open();
  await first;
  assert.equal(fs.readFileSync(path.join(dOld, "SKILL.md"), "utf-8"), "old\n");
  assert.equal(old.calls, 1);
  assert.equal(fresh.calls, 1);
});

test("a failed download is not held, rejects its caller, and the callers waiting on it download for themselves", async () => {
  const cache = new SkillCache(1 << 20);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let failing = true;
  const dl = download(skill, { gate, fail: () => { const f = failing; failing = false; return f; } });
  const leader = cache.stage("k", "fp", freshDir(), dl);
  const waiters = [cache.stage("k", "fp", freshDir(), dl), cache.stage("k", "fp", freshDir(), dl)];
  const leaderResult = leader.then(() => "ok", (e: Error) => e.message);
  await new Promise((r) => setTimeout(r, 20));
  open();
  assert.equal(await leaderResult, "download failed");
  assert.deepEqual(await Promise.all(waiters), ["downloaded", "downloaded"]);
  assert.equal(dl.calls, 3, "the failed one plus one per waiter");
  assert.equal(cache.size, 0, "the waiters were not cacheable either: their dirs came from separate downloads");
});

test("the bytes held stay under the bound, and the least recently used skill goes first", async () => {
  const body = (n: number) => ({ "SKILL.md": String(n).padStart(250, "x") });
  const cache = new SkillCache(1000);
  const dls = Array.from({ length: 5 }, (_, i) => download(body(i)));
  for (let i = 0; i < 4; i++) await cache.stage(`k${i}`, "fp", freshDir(), dls[i]);
  assert.equal(cache.size, 1000);
  // k0 is used again, so k1 is now the oldest.
  assert.equal(await cache.stage("k0", "fp", freshDir(), dls[0]), "hit");
  await cache.stage("k4", "fp", freshDir(), dls[4]);
  assert.ok(cache.size <= 1000, `held ${cache.size} > 1000`);
  for (const k of ["k0", "k2", "k3", "k4"]) {
    assert.equal(await cache.stage(k, "fp", freshDir(), dls[Number(k[1])]), "hit", `${k} is still held`);
  }
  assert.equal(await cache.stage("k1", "fp", freshDir(), dls[1]), "downloaded", "k1 was the least recently used");
  assert.ok(cache.size <= 1000);
});

test("replacing a skill's entry does not count its old bytes twice", async () => {
  const cache = new SkillCache(1000);
  for (let v = 0; v < 20; v++) {
    await cache.stage("k", `fp${v}`, freshDir(), download({ "SKILL.md": "y".repeat(200) }));
  }
  assert.equal(cache.size, 200);
});

test("a skill over a quarter of the bound is served to its caller but never held", async () => {
  const cache = new SkillCache(1000);
  const big = download({ "SKILL.md": "z".repeat(251) });
  const d = freshDir();
  assert.equal(await cache.stage("k", "fp", d, big), "downloaded");
  assert.equal(fs.readFileSync(path.join(d, "SKILL.md"), "utf-8").length, 251, "the caller still has all of it");
  assert.equal(cache.size, 0);
  assert.equal(await cache.stage("k", "fp", freshDir(), big), "downloaded");
  assert.equal(big.calls, 2);
  // The boundary itself is held.
  const edge = download({ "SKILL.md": "z".repeat(250) });
  await cache.stage("e", "fp", freshDir(), edge);
  assert.equal(await cache.stage("e", "fp", freshDir(), edge), "hit");
});

test("a directory that already holds files is neither served from nor added to the cache", async () => {
  const cache = new SkillCache(1 << 20);
  const dl = download({ "SKILL.md": "b\n", "b-only.txt": "b\n" });
  const occupied = freshDir();
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "a-only.txt"), "another tool's file\n");
  assert.equal(await cache.stage("k", "fp", occupied, dl), "downloaded");
  assert.equal(cache.size, 0, "a snapshot of that directory would not be this skill");
  const clean = freshDir();
  assert.equal(await cache.stage("k", "fp", clean, dl), "downloaded", "so nothing mixed was held for the next caller");
  assert.deepEqual(Object.keys(tree(clean)).sort(), ["SKILL.md", "b-only.txt"]);
});

test("every caller gets a copy of its own: changing one never changes the next", async () => {
  const cache = new SkillCache(1 << 20);
  const dl = download(skill);
  const a = freshDir();
  await cache.stage("k", "fp", a, dl);
  fs.writeFileSync(path.join(a, "SKILL.md"), "overwritten by the first session\n");
  const b = freshDir();
  await cache.stage("k", "fp", b, dl);
  fs.writeFileSync(path.join(b, "scripts/run.py"), "overwritten by the second\n");
  fs.rmSync(path.join(b, "references"), { recursive: true });
  const c = freshDir();
  assert.equal(await cache.stage("k", "fp", c, dl), "hit");
  assert.equal(fs.readFileSync(path.join(c, "SKILL.md"), "utf-8"), skill["SKILL.md"]);
  assert.deepEqual(Object.keys(tree(c)).sort(), Object.keys(skill).sort());
  assert.equal(fs.readFileSync(path.join(c, "scripts/run.py"), "utf-8"), skill["scripts/run.py"]);
});
