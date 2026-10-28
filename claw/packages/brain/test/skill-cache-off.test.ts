// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SKILL_CACHE_MAX_BYTES=0 is the off switch, and off means off: a plugin skill
 * is fetched on every turn exactly as it was before the cache existed -- one
 * listing and one read per file, a running/success pair of events, and no extra
 * validating listing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPluginWorld, skillRow } from "./support/plugin-world.js";

process.env.SKILL_CACHE_MAX_BYTES = "0";
const pw = await startPluginWorld();
const { resolvePluginToolsFromMessage } = await import("../src/tasks/plugin-from-message.js");
const { skillCache } = await import("../src/tools/skill-cache.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claw-skill-cache-off-"));
test.after(async () => { fs.rmSync(TMP, { recursive: true, force: true }); await pw.close(); });

test("with the cache off, every turn lists and reads the skill again and announces it", async () => {
  assert.equal(skillCache.enabled, false);
  pw.put("skills/off/SKILL.md", "---\nname: off\ndescription: off\n---\nbody\n");
  pw.put("skills/off/scripts/run.py", "print(1)\n");
  for (let i = 1; i <= 3; i++) {
    pw.resetCounts();
    const events: Array<Record<string, unknown>> = [];
    const result = await resolvePluginToolsFromMessage(
      { plugin_id: 9, plugin_tools: [skillRow(1, "off")], session_id: `off-${process.pid}-${i}` } as never,
      async (e: unknown) => { events.push(e as Record<string, unknown>); },
      path.join(TMP, `w${i}`),
    );
    assert.equal(result.skillContents.off?.includes("body"), true, `turn ${i}: skill present`);
    assert.equal(pw.counts.gets.length, 2, `turn ${i}: both objects read`);
    assert.equal(pw.counts.lists, 1, `turn ${i}: the one listing the download itself needs, nothing more`);
    assert.equal(events.filter((e) => e.tool === "download_skill").length, 2, `turn ${i}: running + success`);
  }
});
