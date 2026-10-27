// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Staging lifecycle, archive layout and lookup of platform-default skills.
 *
 * - a staged directory a chat holds is never deleted under it (new version,
 *   unversioned TTL) and is re-staged if it is gone anyway;
 * - the SKILL.md lands at the advertised `.skills/<name>/SKILL.md` for a flat
 *   archive and for one wrapped in a top-level folder;
 * - defaults are found by id, so more than 100 visible tools cannot push them
 *   out; an unresolvable default is loud (event + counter), never fatal, and a
 *   hanging marketplace is bounded by a deadline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startWorld, skillZip, fakeHands } from "./support/platform-defaults-world.js";

const defaults = { skills: [{ tool_id: 11 }] };
const world = await startWorld(defaults);
const pd = await import("../src/agent/platform-defaults.js");
const { loadPlatformDefaults, resolveDefaultSkills, LazyDefaultSkills } = pd;
const defs = () => loadPlatformDefaults()!;
const events: Array<Record<string, unknown>> = [];
const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };

test.after(() => world.close());
test.beforeEach(() => { pd.resetStagedIndexForTest(); events.length = 0; world.downloads.length = 0; world.byIdCalls.length = 0; world.listCalls = 0; });

const writePaths = (h: ReturnType<typeof fakeHands>) =>
  h.calls.filter((c) => c.name === "write").map((c) => String(c.args.path)).sort();

for (const [label, wrap] of [["flat", ""], ["wrapped in a top-level folder", "my-skill"]] as const) {
  test(`layout (${label}): SKILL.md is uploaded at the advertised path`, async () => {
    world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "BODY", "Operate the fleet", wrap) }]);
    const [skill] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
    assert.equal(skill.description, "Operate the fleet");
    const h = fakeHands();
    await new LazyDefaultSkills([skill]).ensure(h as never, ".skills/fleet-ops");
    assert.deepEqual(writePaths(h), [".skills/fleet-ops/SKILL.md", ".skills/fleet-ops/references/extra.md"]);
  });
}

test("a nested SKILL.md under references/ never wins over the root one", async () => {
  const { default: AdmZip } = await import("adm-zip");
  const z = new AdmZip();
  z.addFile("a-dir/SKILL.md", Buffer.from("---\ndescription: WRONG\n---\n"));
  z.addFile("SKILL.md", Buffer.from("---\ndescription: RIGHT\n---\n"));
  world.setTools([{ id: 11, name: "fleet-ops", zip: z.toBuffer() }]);
  const [skill] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.equal(skill.description, "RIGHT");
});

test("a new published version does not delete the directory an earlier chat holds", async () => {
  world.setTools([{ id: 11, name: "fleet-ops", version: "v1", zip: skillZip("fleet-ops", "V1", "d1") }]);
  const [a] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  world.setTools([{ id: 11, name: "fleet-ops", version: "v2", zip: skillZip("fleet-ops", "V2", "d2") }]);
  const [b] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.notEqual(a.localDir, b.localDir);
  assert.equal(b.description, "d2");
  const h = fakeHands();
  await new LazyDefaultSkills([a], onEvent as never).ensure(h as never, ".skills/fleet-ops");
  assert.equal(writePaths(h).length, 2, "chat A still uploads its own v1 copy");
  assert.equal(events.filter((e) => e.status === "error").length, 0);
});

test("an unversioned tool past the TTL is staged fresh, not deleted in place", async (t) => {
  world.setTools([{ id: 11, name: "fleet-ops", version: null, zip: skillZip("fleet-ops", "U", "d") }]);
  const [a] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  const real = Date.now();
  t.mock.method(Date, "now", () => real + 10 * 60_000);
  const [b] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.notEqual(a.localDir, b.localDir);
  assert.ok(fs.existsSync(a.localDir), "the old directory is still there for the chat that holds it");
});

test("a staged directory that is gone anyway is re-staged on the lazy write", async () => {
  world.setTools([{ id: 11, name: "fleet-ops", version: "v1", zip: skillZip("fleet-ops", "B", "d") }]);
  const [a] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  pd.gcStagedForTest(Date.now() + 25 * 3_600_000);
  assert.equal(fs.existsSync(a.localDir), false, "GC removed it (older than the age)");
  const h = fakeHands();
  await new LazyDefaultSkills([a], onEvent as never).ensure(h as never, ".skills/fleet-ops");
  assert.deepEqual(writePaths(h), [".skills/fleet-ops/SKILL.md", ".skills/fleet-ops/references/extra.md"]);
});

test("GC keeps anything younger than the age", async () => {
  world.setTools([{ id: 11, name: "fleet-ops", version: "v1", zip: skillZip("fleet-ops", "B", "d") }]);
  const [a] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  pd.gcStagedForTest(Date.now() + 3_600_000);
  assert.ok(fs.existsSync(a.localDir));
});

test("lookup is by id: a default is found however many other tools exist, and no list is fetched", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, name: `other-${i}`, zip: skillZip("o", "", "") }));
  world.setTools([...many, { id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "B", "d") }]);
  const out = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.equal(out.length, 1);
  assert.equal(world.listCalls, 0);
  assert.deepEqual(world.byIdCalls, [11]);
});

test("an unresolvable default is loud and non-fatal", async () => {
  world.setTools([]);
  const out = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.deepEqual(out, []);
  assert.ok(events.some((e) => e.status === "error" && String(e.brief).includes("11")));
});

test("a hanging marketplace is bounded by the deadline", async () => {
  world.setTools([{ id: 11, name: "fleet-ops", hang: true }]);
  pd.timeouts.lookupMs = 150;
  const t0 = Date.now();
  const out = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  pd.timeouts.lookupMs = 10_000;
  assert.deepEqual(out, []);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(events.some((e) => e.status === "error"));
});

test("slow downloads are staged in parallel, so the chat waits for one, not the sum", async () => {
  const d = { skills: [{ tool_id: 21 }, { tool_id: 22 }, { tool_id: 23 }] };
  world.setTools([21, 22, 23].map((id) => ({ id, name: `s${id}`, delayMs: 400, zip: skillZip(`s${id}`, "B", "d") })));
  const t0 = Date.now();
  const out = await resolveDefaultSkills({ skills: d.skills.map((s) => ({ toolId: s.tool_id })), mcpServers: {} }, "ak", onEvent as never);
  assert.equal(out.length, 3);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms; sequential staging would be >=1200ms`);
});

test("a defaults file with more than the supported number of skills is refused", async () => {
  const dir = fs.mkdtempSync((await import("node:os")).tmpdir() + "/pd-max-");
  const f = dir + "/d.json";
  fs.writeFileSync(f, JSON.stringify({ skills: Array.from({ length: 51 }, (_, i) => ({ tool_id: i + 1 })) }));
  assert.equal(loadPlatformDefaults(f), null);
  fs.writeFileSync(f, JSON.stringify({ skills: Array.from({ length: 50 }, (_, i) => ({ tool_id: i + 1 })) }));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(loadPlatformDefaults(f)?.skills.length, 50);
});

test("a cache hit whose staged directory is gone is a miss: it re-stages instead of throwing", async () => {
  world.setTools([{ id: 11, name: "fleet-ops", version: "v1", zip: skillZip("fleet-ops", "B", "d") }]);
  const [a] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  fs.rmSync(a.localDir, { recursive: true, force: true });
  const [b] = await resolveDefaultSkills(defs(), "ak", onEvent as never);
  assert.ok(b, "the default is still mounted");
  assert.ok(fs.existsSync(b.localDir));
  assert.equal(world.downloads.length, 2, "it downloaded again");
  assert.equal(events.filter((e) => e.status === "error").length, 0);
  // and the lazy restage path survives the same loss
  fs.rmSync(b.localDir, { recursive: true, force: true });
  const h = fakeHands();
  await new LazyDefaultSkills([b], onEvent as never).ensure(h as never, ".skills/fleet-ops");
  assert.equal(writePaths(h).length, 2);
});
