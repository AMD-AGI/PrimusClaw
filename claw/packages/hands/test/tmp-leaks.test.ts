// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Suites that left their temporary directories in TMPDIR on every run, run here as their own processes with a
 * TMPDIR of this test's: none of what they made is there when they end.
 *
 *   L1 command-shell.test.ts: no command-shell-*
 *   L2 env-file.test.ts: no hands-env-*
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../../utils/test/tmp-dirs.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const cases: Array<[string, string, string[]]> = [
  ["L1", "command-shell.test.ts", ["command-shell-"]],
  ["L2", "env-file.test.ts", ["hands-env-"]],
];

for (const [id, file, prefixes] of cases) {
  test(`${id} ${file} leaves no ${prefixes.map((p) => `${p}*`).join(" or ")} in TMPDIR`, () => {
    const tmp = tmpDir("tmp-leaks-");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    // The suite is a test file of its own here, not a part of this one's report.
    delete env.NODE_TEST_CONTEXT;
    delete env.CLAW_TEST_KEEP_TMP;
    const r = spawnSync(process.execPath, ["--import", "tsx", join(HERE, file)], { cwd: join(HERE, ".."), env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${file} passes on its own\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(tmp).filter((n) => prefixes.some((p) => n.startsWith(p))), []);
  });
}
