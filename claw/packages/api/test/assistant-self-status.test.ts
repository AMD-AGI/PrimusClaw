// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant knows it is Clawy and how it has been running (`assistant/self-status.ts`).
 *
 *   S1  the router is told that Clawy is itself, and how to count what a lookup returned; a worker has no claw_self_status
 *   S3  the time floor of a ULID id sorts at or below every id made at that time or later, and above every one made before
 *   S5  the build is CLAW_BUILD when set, else the tag build.sh wrote into the image, else unknown; never what is not a tag
 *   S4  it reads no session settings, no message text and no error message, and every scan is bounded
 *
 * S2 is in assistant-self-status-db.test.ts: on a real Postgres, with the assistant's configuration set before it is read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { buildOf, renderRouterSelfSection, ulidFloor } from "../src/assistant/self-status.js";
import { ulid } from "../src/tasks/ids.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID made at `ms`, as `tasks/ids.ts` makes one then. */
function ulidAt(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < 10; i++) { const mod = n % 32; out = ALPHABET[mod] + out; n = (n - mod) / 32; }
  return out + ulid().slice(10);
}

test("S1 the router is told it is Clawy, with the tool when it is on, and how to count", () => {
  const on = renderRouterSelfSection(true);
  assert.match(on, /Clawy is you/);
  assert.match(on, /claw_self_status/);
  assert.match(on, /never count its items as the answer/);
  const off = renderRouterSelfSection(false);
  assert.match(off, /Clawy is you/);
  assert.doesNotMatch(off, /call claw_self_status/);
});

test("S3 a ULID's time floor sorts between the ids made before it and the ids made from it on", () => {
  const t = Date.UTC(2026, 10, 6, 6, 51, 12, 345);
  const floor = ulidFloor(t);
  assert.equal(floor.length, 26);
  for (let i = 0; i < 50; i++) {
    assert.ok(ulidAt(t) >= floor, "made at the floor's time");
    assert.ok(ulidAt(t + 1 + i * 1000) > floor, "made after it");
    assert.ok(ulidAt(t - 1 - i * 1000) < floor, "made before it");
  }
  assert.equal(ulidFloor(t).slice(0, 10), ulidAt(t).slice(0, 10));
});

test("S4 it reads no session settings, no message text, no error message, and bounds every scan", () => {
  const src = readFileSync(new URL("../src/assistant/self-status.ts", import.meta.url), "utf8");
  const sql = [...src.matchAll(/q\(\s*`([\s\S]*?)`/g)].map((m) => m[1]).join("\n");
  assert.ok(sql.length > 0);
  assert.doesNotMatch(sql, /claw_sessions/);
  assert.doesNotMatch(sql, /\bconfig\b/);
  assert.doesNotMatch(sql, /\bcontent\b|\btext\b|error_message|\boutput\b/);
  assert.match(src, /SET TRANSACTION READ ONLY/);
  assert.match(src, /statement_timeout/);
  const statements = [...src.matchAll(/q\(\s*`([\s\S]*?)`/g)].map((m) => m[1]);
  for (const table of ["claw_assistant_messages", "claw_tasks", "claw_work_items", "claw_assistant_says", "claw_assistant_review_handoffs"]) {
    const reading = statements.filter((st) => st.includes(`FROM ${table}`));
    assert.ok(reading.length > 0, table);
    for (const st of reading) assert.match(st, /LIMIT/, `${table} is read with a limit`);
  }
});

test("S5 the build: CLAW_BUILD, else the image's BUILD file, else unknown, and never what is not a tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-build-"));
  const file = pathToFileURL(join(dir, "BUILD"));
  assert.equal(buildOf("", file), null, "no file");
  writeFileSync(file, "202611070012\n");
  assert.equal(buildOf("", file), "202611070012");
  assert.equal(buildOf("from-env", file), "from-env");
  writeFileSync(file, "a tag; rm -rf /\n");
  assert.equal(buildOf("", file), null);
  // The path the image has: packages/api/BUILD, two levels above src/assistant and dist/assistant.
  assert.equal(new URL("../../BUILD", pathToFileURL("/app/packages/api/dist/assistant/self-status.js")).pathname, "/app/packages/api/BUILD");
});
