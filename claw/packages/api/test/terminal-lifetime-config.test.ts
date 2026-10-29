// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `TERMINAL_MAX_LIFETIME_SECONDS`: what an operator can set, and what they cannot.
 *
 * The lifetime is the only thing that bounds a terminal whose output never stops,
 * and the shell it bounds holds the user's SaFE key. So it has a default of eight
 * hours, it cannot be switched off (0 is refused, like anything outside 60 seconds
 * to 7 days), and a refused value is not silently applied: the default stands and
 * start-up reports the setting.
 *
 * config.ts reads each setting once, at import, so every case is a process of its
 * own with the value in its environment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(value: string | undefined): { seconds: number; ms: number; problems: string[] } {
  const env: Record<string, string | undefined> = { ...process.env, TERMINAL_MAX_LIFETIME_SECONDS: value };
  if (value === undefined) delete env.TERMINAL_MAX_LIFETIME_SECONDS;
  const code = `
    const c = await import("./src/config.ts");
    const t = await import("./src/routes/terminal.ts");
    console.log("RESULT " + JSON.stringify({
      seconds: c.TERMINAL_MAX_LIFETIME_SECONDS,
      ms: t.terminalSettings.maxLifetimeMs,
      problems: c.envSettingProblems().filter((p) => p.includes("TERMINAL_MAX_LIFETIME_SECONDS")),
    }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: API, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `no result in: ${out.slice(0, 300)}`);
  return JSON.parse(line.slice("RESULT ".length));
}

const DEFAULT = 28_800;

test("unset or blank is the default, eight hours, and is not a problem", () => {
  for (const v of [undefined, "", "   "]) {
    const r = read(v);
    assert.equal(r.seconds, DEFAULT, JSON.stringify(v));
    assert.equal(r.ms, DEFAULT * 1000, "the proxy is given milliseconds");
    assert.deepEqual(r.problems, []);
  }
});

test("a value in range is used, at both ends of the range", () => {
  for (const [v, want] of [["3600", 3600], ["60", 60], ["604800", 604_800]] as const) {
    const r = read(v);
    assert.equal(r.seconds, want, v);
    assert.equal(r.ms, want * 1000, v);
    assert.deepEqual(r.problems, [], v);
  }
});

test("0 does not switch the bound off: it is refused, the default stands, and the refusal is reported", () => {
  const r = read("0");
  assert.equal(r.seconds, DEFAULT);
  assert.equal(r.ms, DEFAULT * 1000);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /TERMINAL_MAX_LIFETIME_SECONDS=0/);
});

test("negative, too short, too long and not-a-number are refused the same way", () => {
  for (const v of ["-1", "59", "604801", "99999999999", "abc", "8h"]) {
    const r = read(v);
    assert.equal(r.seconds, DEFAULT, v);
    assert.equal(r.problems.length, 1, `${v} must be reported`);
  }
});
