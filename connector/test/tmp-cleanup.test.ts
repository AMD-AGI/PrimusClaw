// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The suite leaves nothing in TMPDIR: every directory a test makes through support/tmp.ts (the harness's home, work
 * and Claude directories among them) is gone when its file ends, whether the file passed, failed or exited in the
 * middle of a test, and no adapter a harness's session started outlives it. support/tmp-fixture.ts runs as a test file in a process of its own, under a TMPDIR of its own.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "support", "tmp-fixture.ts");
/** What node and tsx keep in TMPDIR for themselves, reused across runs: not the suite's. */
const TOOL_CACHE = /^(tsx-\d+|node-compile-cache)$/;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "); } catch { return false; }
};

function run(end: string): { status: number | null; made: string[]; adapters: number[]; left: string[]; out: string } {
  const tmp = tmpdir("tmpguard-");
  const report = path.join(tmpdir("tmpguard-report-"), "made.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP_FIXTURE_END: end, TMP_FIXTURE_REPORT: report };
  delete env.NODE_TEST_CONTEXT; // its own run, not a subtest reporting to this one
  const r = spawnSync(process.execPath, ["--import", "tsx", "--test-reporter=tap", FIXTURE], {
    cwd: path.dirname(here), env, encoding: "utf8", timeout: 60_000,
  });
  const { dirs: made = [], adapters = [] } = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")) as { dirs?: string[]; adapters?: number[] }) : {};
  return { status: r.status, made, adapters, left: fs.readdirSync(tmp).filter((n) => !TOOL_CACHE.test(n)), out: `${r.stdout}\n${r.stderr}` };
}

describe("temporary directories", { skip: process.platform !== "linux" && "reads /proc" }, () => {
  for (const [end, status] of [["pass", 0], ["fail", 1], ["exit", 3]] as const) {
    test(`a test file that ends with ${end} leaves no cc-* directory (nor any other) in TMPDIR`, () => {
      const r = run(end);
      assert.equal(r.status, status, r.out);
      const prefixes = new Set(r.made.map((d) => path.basename(d).slice(0, -6)));
      for (const p of ["cc-", "cc-work-", "cc-claude-", "cc-claudecfg-", "cc-fakecli-", "cc-nest-", "cc-wrap-", "w-"]) {
        assert.ok(prefixes.has(p), `the fixture made a ${p}* directory (it made ${[...prefixes].join(", ")})`);
      }
      assert.equal(r.adapters.length, 2, `the fixture started its two adapters\n${r.out}`);
      for (const pid of r.adapters) assert.equal(alive(pid), false, `adapter ${pid} outlived the file`);
      assert.deepEqual(r.left, [], `left in TMPDIR: ${r.left.join(", ")}\n${r.out}`);
      for (const d of r.made) assert.equal(fs.existsSync(d), false, d);
    });
  }
});
