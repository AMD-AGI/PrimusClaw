// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * No reading that can only hold a destroy reaches the record through a single
 * CAS whose conflict is swallowed.
 *
 * Three review rounds in a row found one more site of the same shape: a
 * jobs-probe reading applied with `observe` (or a reclaim-evidence field set by
 * hand) and then written once, `kv.update(...).catch(() => {})`, under a
 * revision read before the probe. Any write in between -- a TTL renewal,
 * another replica -- dropped a failed probe, a positive count, or the end of a
 * streak, and another replica then destroyed the sandbox inside the quiet
 * window. Each round's audit was a hand-kept list of sites and missed one.
 *
 * So the sites are derived here from the source, every production file under
 * src/: any function that applies a reading or writes a reclaim-evidence field
 * may not, after doing so, swallow the failure of a single write. A new site
 * fails this test until it goes through persistHoldingObservation (or a
 * bounded re-read retry), whatever its author knew about the others.
 *
 * Asserted through the source, like keepalive-narrow-evidence.test.ts: the
 * race is between two I/O calls, and what is pinned is the shape of the write.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...productionFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

interface Chunk { file: string; name: string; text: string; line: number }

/** Every top-level function, from its declaration to the next one at column zero. */
function functionsOf(file: string, text: string): Chunk[] {
  const decl = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/gm;
  const starts: { name: string; at: number }[] = [];
  for (let m = decl.exec(text); m; m = decl.exec(text)) starts.push({ name: m[1], at: m.index });
  return starts.map((s, i) => ({
    file,
    name: s.name,
    text: text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length),
    line: text.slice(0, s.at).split("\n").length,
  }));
}

const FIELDS = "lastProbeFailureAt|lastPositiveCountAt|reclaimStreak";
const CLEARED = "quiescedAt|idleSince";

/** Where a function applies a jobs-probe reading or writes a reclaim-evidence field. */
const EVIDENCE: RegExp[] = [
  /(?<!function\s)\bobserve(?:Reading)?\(/g,
  // The record merged with this process's unwritten holds is evidence too.
  /(?<!function\s)\bwithLocalHolds\(/g,
  new RegExp(`\\b(?:${FIELDS})\\s*:(?!:)`, "g"),
  new RegExp(`\\.(?:${FIELDS}|${CLEARED})\\s*=(?!=)`, "g"),
  new RegExp(`\\b(?:${CLEARED})\\s*:\\s*undefined`, "g"),
  new RegExp(`delete\\s+[\\w.]+\\.(?:${FIELDS}|${CLEARED})\\b`, "g"),
];

/** A single KV write whose failure is swallowed. */
const SWALLOWED: RegExp[] = [
  // kv.update(...).catch(() => {}) and its spellings.
  /\.(?:update|put)\([^;]*?\)\s*\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g,
  // try { ... kv.update(...) ... } catch { } -- an empty or comment-only catch.
  /try\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\.(?:update|put)\((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\}\s*catch\s*(?:\(\s*\w*\s*\))?\s*\{(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*\}/g,
];

function spans(text: string, res: RegExp[]): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = [];
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ at: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.at - b.at);
}

function positions(text: string, res: RegExp[]): number[] {
  return spans(text, res).map((s) => s.at);
}

/**
 * Inside a retry loop that re-reads the record: a `for`/`while` opened before
 * the write, with a read of the record between the loop head and the write.
 */
function inRetryLoop(text: string, w: { at: number; end: number }): boolean {
  const loop = text.slice(0, w.at).search(/\b(?:for|while)\s*\(/);
  return loop >= 0 && /\.get\(/.test(text.slice(loop, w.end));
}

/**
 * The one swallowed write allowed after a reading: confirmReclaim's, which is
 * reached only for a reading that ended no streak and carries no failure or
 * positive count (an ADVANCING reading), after a holding one has already been
 * routed to persistHoldingObservation. Pinned below by its own assertion.
 */
const ADVANCING_ONLY = new Set(["sandbox/keepalive.ts#confirmReclaim"]);

function derive(files: { path: string; text: string }[]) {
  const sites: { site: string; line: number; guard: string }[] = [];
  const violations: string[] = [];
  for (const f of files) {
    const rel = relative(SRC, f.path);
    for (const fn of functionsOf(rel, f.text)) {
      const evidence = positions(fn.text, EVIDENCE);
      if (evidence.length === 0) continue;
      // A write whose payload or preceding code carries the evidence.
      const swallowed = spans(fn.text, SWALLOWED).filter((w) => w.end > evidence[0]);
      const id = `${rel}#${fn.name}`;
      for (const at of evidence) {
        sites.push({
          site: id,
          line: fn.line + fn.text.slice(0, at).split("\n").length - 1,
          guard: fn.text.slice(at, at + 40).split("\n")[0],
        });
      }
      for (const w of swallowed) {
        if (inRetryLoop(fn.text, w)) continue;
        if (ADVANCING_ONLY.has(id)) continue;
        const line = fn.line + fn.text.slice(0, w.at).split("\n").length - 1;
        violations.push(`${rel}:${line} (${fn.name}): ${fn.text.slice(w.at, w.at + 90).replace(/\s+/g, " ")}`);
      }
    }
  }
  return { sites, violations };
}

export function holdingWriteViolations(files: { path: string; text: string }[]): string[] {
  return derive(files).violations;
}

const FILES = productionFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("no reading or reclaim-evidence write is followed by a swallowed single write", (t) => {
  const { sites, violations } = derive(FILES);
  // The derivation must be finding the sites it exists for, or a broken regex
  // would pass everything.
  const ids = new Set(sites.map((s) => s.site));
  for (const known of [
    "sandbox/keepalive.ts#persistHoldingObservation",
    "sandbox/keepalive.ts#recordObservation",
    "sandbox/keepalive.ts#confirmReclaim",
    "sandbox/keepalive.ts#persistVerdict",
    "sandbox/keepalive.ts#refreshIdleSince",
    "sandbox/ensure-hands.ts#clearIdleMarkers",
  ]) {
    assert.ok(ids.has(known), `the derivation no longer sees ${known}; sites=${[...ids].join(", ")}`);
  }
  t.diagnostic(`evidence-bearing functions: ${[...ids].sort().join(", ")}`);
  assert.deepEqual(violations, [], `swallowed single writes after a reading:\n${violations.join("\n")}`);
});

test("the guard refuses the shape it was written for", () => {
  // The expired-retry busy branch as it was on 2f36af1.
  const mutant = `
async function retryPendingStop(deps, recordKey, identity, infoNow, claimRevision, running) {
  if (running > 0) {
    const next = observe(deps, identity, infoNow, { kind: "count", count: running });
    await deps.kv.update(recordKey, sc.encode(JSON.stringify(next)), claimRevision).catch(() => {});
    return false;
  }
}
async function clearAnchor(kv, key, info, revision) {
  try {
    await kv.update(key, sc.encode(JSON.stringify({ ...info, quiescedAt: undefined })), revision);
  } catch { /* lost the race */ }
}
`;
  const found = holdingWriteViolations([{ path: join(SRC, "sandbox/mutant.ts"), text: mutant }]);
  assert.equal(found.length, 2, `both swallowed writes are refused; found=${JSON.stringify(found)}`);
});

test("confirmReclaim swallows a write only for an advancing reading", () => {
  const text = FILES.find((f) => f.path.endsWith("sandbox/keepalive.ts"))!.text;
  const fn = functionsOf("sandbox/keepalive.ts", text).find((c) => c.name === "confirmReclaim")!;
  const branch = fn.text.indexOf("if (reading?.holds)");
  const routed = fn.text.indexOf("persistHoldingObservation(", branch);
  const bare = positions(fn.text, SWALLOWED);
  assert.ok(branch >= 0 && routed > branch, "a holding reading is routed to persistHoldingObservation");
  assert.equal(bare.length, 1, "one swallowed write, the advancing one");
  assert.ok(bare[0] > routed, "and it comes after the holding branch returned");
  // Every caller that applies a reading hands it to the confirmation, so the
  // confirmation knows which branch it is in.
  for (const c of functionsOf("sandbox/keepalive.ts", text)) {
    if (c.name === "observe") continue;
    const applied = (c.text.match(/\bobserveReading\(/g) ?? []).length
      - (c.name === "observeReading" ? 1 : 0);
    if (applied === 0) continue;
    const handed = (c.text.match(/observed\.reading/g) ?? []).length;
    assert.equal(handed, applied, `${c.name} applies ${applied} reading(s) and hands ${handed} to confirmReclaim`);
  }
  // A bare observe() is a reading with its class thrown away: only the two
  // writers that re-read and retry may use it.
  for (const c of functionsOf("sandbox/keepalive.ts", text)) {
    if (/(?<!function\s)\bobserve\(/.test(c.text)) {
      assert.ok(["persistHoldingObservation", "recordObservation"].includes(c.name),
        `${c.name} applies a reading with observe() and cannot know whether it holds`);
    }
  }
});
