// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A marketplace `tool_ids` skill is downloaded once per version of its record,
 * not once per turn. Through the real `resolveToolIds`; only the Tools API is
 * fake (`fetch`): the by-id read that every turn makes, and the archive
 * download that only a changed record needs.
 *
 * A tool's record carries `updated_at`, which every in-place update bumps (an
 * upsert of the same version included), and `version`. The pair is what says a
 * held copy is still the skill: change either and the archive is fetched again,
 * and a record with no stamp is never trusted. The skill is still installed for
 * the turn each time (written under `<sessionDir>/.skills/<name>/` here, into
 * the sandbox when there is one) -- only the fetch and the unpacking are saved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { resolveToolIds } from "../src/tools/resolve.js";
import { skillCache } from "../src/tools/skill-cache.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claw-tool-skill-cache-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Tool { id: number; name: string; type: string; version?: string; updated_at?: string; files: Record<string, string>; plain?: string }
const tools = new Map<number, Tool>();
const downloads: number[] = [];
let failDownloads = false;

const archive = (files: Record<string, string>) => {
  const zip = new AdmZip();
  for (const [rel, body] of Object.entries(files)) zip.addFile(rel, Buffer.from(body));
  return zip.toBuffer();
};

const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = url.match(/\/tools\/(\d+)(\/download)?$/);
    const tool = m ? tools.get(Number(m[1])) : undefined;
    if (!m || !tool) return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    if (m[2]) {
      downloads.push(tool.id);
      if (failDownloads) return new Response("boom", { status: 500 });
      return tool.plain !== undefined
        ? new Response(tool.plain, { status: 200, headers: { "content-type": "text/markdown" } })
        : new Response(new Uint8Array(archive(tool.files)), { status: 200, headers: { "content-type": "application/zip" } });
    }
    const { files: _f, plain: _p, ...record } = tool;
    return new Response(JSON.stringify({ data: record }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { skillCache.clear(); tools.clear(); downloads.length = 0; failDownloads = false; });

let n = 0;
/** One turn: resolve `ids`, installing the skills under a session dir of its own. */
async function turn(ids: number[]) {
  const events: Array<Record<string, unknown>> = [];
  const sessionDir = path.join(TMP, `session-${++n}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  downloads.length = 0;
  const resolved = await resolveToolIds(ids, "key", async (e) => { events.push(e as never); }, sessionDir);
  return { resolved, events, downloads: [...downloads], sessionDir };
}
const skillFiles = (sessionDir: string, name: string) => {
  const root = path.join(sessionDir, ".skills", name);
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return out;
};
const files = (marker: string) => ({ "SKILL.md": `# ${marker}\n`, "references/guide.md": `guide ${marker}\n` });
const tool = (id: number, over: Partial<Tool> = {}): Tool => ({ id, name: `skill${id}`, type: "skill", version: "1.0.0", updated_at: "2026-10-27T10:00:00Z", files: files("one"), ...over });

test("an unchanged record is downloaded once; every turn still installs the whole skill", async () => {
  tools.set(1, tool(1));
  const first = await turn([1]);
  assert.deepEqual(first.downloads, [1]);
  for (let i = 0; i < 3; i++) {
    const t = await turn([1]);
    assert.deepEqual(t.downloads, [], `turn ${i + 2}: no download`);
    assert.equal(t.resolved.skillContents.skill1, "# one\n");
    assert.deepEqual(skillFiles(t.sessionDir, "skill1"), files("one"), `turn ${i + 2}: installed with its supporting files`);
  }
});

test("a record that changed is downloaded again", async () => {
  const rows: Array<{ name: string; change: (t: Tool) => Tool }> = [
    { name: "updated_at bumped by an in-place update of the same version", change: (t) => ({ ...t, updated_at: "2026-10-27T11:00:00Z", files: files("two") }) },
    { name: "a new version", change: (t) => ({ ...t, version: "1.1.0", files: files("two") }) },
  ];
  let id = 10;
  for (const r of rows) {
    const t0 = tool(id++);
    tools.set(t0.id, t0);
    await turn([t0.id]);
    assert.deepEqual((await turn([t0.id])).downloads, [], `${r.name}: held`);
    tools.set(t0.id, r.change(t0));
    const after = await turn([t0.id]);
    assert.deepEqual(after.downloads, [t0.id], `${r.name}: fetched again`);
    assert.equal(after.resolved.skillContents[t0.name], "# two\n", `${r.name}: new content`);
    assert.deepEqual(skillFiles(after.sessionDir, t0.name), files("two"));
    assert.deepEqual((await turn([t0.id])).downloads, [], `${r.name}: the new copy is held`);
  }
});

test("a record with no updated_at is never trusted", async () => {
  tools.set(20, tool(20, { updated_at: undefined }));
  assert.deepEqual((await turn([20])).downloads, [20]);
  assert.deepEqual((await turn([20])).downloads, [20]);
});

test("a skill served as plain markdown is held like an archive", async () => {
  tools.set(21, tool(21, { plain: "# plain\n", files: {} }));
  assert.deepEqual((await turn([21])).downloads, [21]);
  const again = await turn([21]);
  assert.deepEqual(again.downloads, []);
  assert.equal(again.resolved.skillContents.skill21, "# plain\n");
});

test("a failed download is reported, nothing is held, and the next turn tries again", async () => {
  tools.set(30, tool(30));
  failDownloads = true;
  const bad = await turn([30]);
  assert.deepEqual(bad.downloads, [30]);
  assert.deepEqual(bad.resolved.skillContents, {});
  assert.ok(bad.events.some((e) => e.tool === "download_skill" && e.status === "error"));
  failDownloads = false;
  assert.deepEqual((await turn([30])).downloads, [30]);
  assert.deepEqual((await turn([30])).downloads, []);
});

test("tools do not share copies, and a changed one does not disturb another", async () => {
  tools.set(40, tool(40));
  tools.set(41, tool(41, { files: files("other") }));
  assert.deepEqual((await turn([40, 41])).downloads.sort(), [40, 41]);
  tools.set(40, tool(40, { updated_at: "2026-10-27T12:00:00Z", files: files("two") }));
  const t = await turn([40, 41]);
  assert.deepEqual(t.downloads, [40]);
  assert.equal(t.resolved.skillContents.skill40, "# two\n");
  assert.equal(t.resolved.skillContents.skill41, "# other\n");
});

test("no scratch directory is left behind by a download that failed", async () => {
  tools.set(50, tool(50));
  failDownloads = true;
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("claw-skill-50-"));
  await turn([50]);
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("claw-skill-50-"));
  assert.equal(after.length, before.length);
});
