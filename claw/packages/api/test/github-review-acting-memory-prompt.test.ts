// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What goes into the prompt of a turn from the requester's long-term memory, for a session that acts as a user (`config.acting_as`). The
 * model of such a session reads what strangers wrote, and its answer is posted publicly, so the requester's remembered entries and
 * profile are not put in front of it, nor the notice that memory is off. The requester has memory on here, with an entry and a profile
 * stored: the case where the gate is the only thing between them and the prompt.
 *
 *   P1  an ordinary session of an opted-in user gets its profile and entries (unchanged)
 *   P2  a session with `acting_as` gets neither, and no notice, from the same user with the same rows
 *   P3  the same through `buildMessages`, which is what every turn path calls
 *   P4  a session whose row cannot be read gets none either: memory is not used, the turn is not failed
 *   P5  a user who is opted out still gets the notice in an ordinary session, and none in an acting one
 */
process.env.CLAW_MEMORY_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { db } = await import("../src/infra/db.js");
const { buildSystemContextParts, buildMessages, MEMORY_OFF_NOTICE } = await import("../src/sessions/context-builder.js");

const originalQuery = db.query;
const ENTRY = "REQUESTER-PRIVATE-ENTRY";
const PROFILE = "REQUESTER-PRIVATE-PROFILE";
let optedIn: boolean;
let actingAs: Map<string, unknown>;
let unreadable: Set<string>;
let memoryReads: number;
let sessionReads: number;

beforeEach(() => {
  optedIn = true;
  actingAs = new Map([["acting", "someone-else"]]);
  unreadable = new Set();
  memoryReads = 0;
  sessionReads = 0;
  db.query = (async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT config->'acting_as' AS acting_as FROM claw_sessions WHERE session_id = \$1/.test(sql)) {
      sessionReads++;
      if (unreadable.has(params[0])) throw Object.assign(new Error("connection reset"), { code: "57P01" });
      return actingAs.has(params[0]) ? { rows: [{ acting_as: actingAs.get(params[0]) }] } : { rows: [{ acting_as: null }] };
    }
    if (/FROM claw_user_memory_prefs/.test(sql)) { memoryReads++; return { rows: [{ enabled: optedIn }] }; }
    if (/category = 'user_profile'/.test(sql)) { memoryReads++; return { rows: [{ content: PROFILE }] }; }
    if (/FROM claw_memory_entries/.test(sql)) {
      memoryReads++;
      return { rows: [{ id: 1, category: "preference", content: ENTRY, importance: 0.9 }] };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  db.query = originalQuery;
});

const text = (parts: string[]) => parts.join("\n");

test("P1 an ordinary session of an opted-in user gets its profile and entries", async () => {
  const { parts, profileTokens, memoryTokens } = await buildSystemContextParts("ordinary", "alice");
  assert.ok(text(parts).includes(ENTRY));
  assert.ok(text(parts).includes(PROFILE));
  assert.ok(profileTokens > 0 && memoryTokens > 0);
});

test("P2 a session with acting_as gets neither the entries nor the profile, and no notice", async () => {
  const { parts, profileTokens, memoryTokens } = await buildSystemContextParts("acting", "alice");
  assert.equal(text(parts).includes(ENTRY), false, "no entry");
  assert.equal(text(parts).includes(PROFILE), false, "no profile");
  assert.equal(parts.includes(MEMORY_OFF_NOTICE), false, "no notice");
  assert.equal(text(parts).includes("Long-term Memory"), false);
  assert.equal(profileTokens + memoryTokens, 0);
  assert.equal(memoryReads, 0, "the requester's memory is not even read");
});

test("P3 the messages a turn is built from carry none of it", async () => {
  const ordinary = await buildMessages("ordinary", "hello", "alice");
  assert.ok(JSON.stringify(ordinary).includes(ENTRY), "control: an ordinary turn has it");
  const acting = await buildMessages("acting", "hello", "alice");
  assert.equal(JSON.stringify(acting).includes(ENTRY), false);
  assert.equal(JSON.stringify(acting).includes(PROFILE), false);
  assert.equal(JSON.stringify(acting).includes("Long-term Memory"), false);
});

test("P4 a session whose row cannot be read gets none of it, and the turn is not failed", async () => {
  unreadable.add("acting");
  const { parts } = await buildSystemContextParts("acting", "alice");
  assert.equal(text(parts).includes(ENTRY), false);
  assert.equal(text(parts).includes(PROFILE), false);
});

test("P5 an opted-out user is told memory is off in an ordinary session, and nothing in an acting one", async () => {
  optedIn = false;
  assert.ok((await buildSystemContextParts("ordinary", "alice")).parts.includes(MEMORY_OFF_NOTICE), "control");
  assert.equal((await buildSystemContextParts("acting", "alice")).parts.includes(MEMORY_OFF_NOTICE), false);
});
