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

/** kv.update(...).catch(() => {}) and its spellings: a single KV write whose failure is swallowed. */
const SWALLOWED_CATCH = /\.(?:update|put)\([^;]*?\)\s*\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g;

/** Index of the brace closing the one opened at `open`, or -1. Linear. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Whether `body` is only whitespace and comments. Linear. */
function blank(body: string): boolean {
  for (let i = skipSpace(body, 0); i < body.length; i = skipSpace(body, i)) {
    if (body.startsWith("//", i)) {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? body.length : nl + 1;
    } else if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * try { ... kv.update(...) ... } catch { } -- a write inside a try whose catch
 * is empty or comment-only. A scan rather than one regular expression: the
 * nested-brace expression this replaced backtracked exponentially on a catch
 * full of comment markers.
 */
function emptyCatchWrites(text: string): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = [];
  const head = /\btry\s*\{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = closingBrace(text, open);
    if (close < 0) continue;
    // Anchored at the write, not the `try`: whether the write is in a retry
    // loop is asked from where the write is.
    const write = text.slice(open + 1, close).search(/\.(?:update|put)\(/);
    if (write < 0) continue;
    let i = skipSpace(text, close + 1);
    if (!text.startsWith("catch", i)) continue;
    i = skipSpace(text, i + "catch".length);
    if (text[i] === "(") {
      const param = text.indexOf(")", i);
      if (param < 0 || !/^\(\s*\w*\s*\)$/.test(text.slice(i, param + 1))) continue;
      i = skipSpace(text, param + 1);
    }
    if (text[i] !== "{") continue;
    const end = closingBrace(text, i);
    if (end >= 0 && blank(text.slice(i + 1, end))) out.push({ at: open + 1 + write, end: end + 1 });
  }
  return out;
}

function regexSpans(text: string, res: RegExp[]): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = [];
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ at: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Every single KV write whose failure is swallowed. */
function swallowedWrites(text: string): { at: number; end: number }[] {
  return [...regexSpans(text, [SWALLOWED_CATCH]), ...emptyCatchWrites(text)].sort((a, b) => a.at - b.at);
}

function positions(text: string, res: RegExp[]): number[] {
  return regexSpans(text, res).map((s) => s.at).sort((a, b) => a - b);
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
      const swallowed = swallowedWrites(fn.text).filter((w) => w.end > evidence[0]);
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
  const bare = swallowedWrites(fn.text).map((w) => w.at);
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

test("the try/catch scan is linear on the inputs the old expression backtracked on", () => {
  // CodeQL js/redos on the expression this scan replaced: a catch body full of
  // comment markers. Each input is scanned well inside a second.
  for (const marker of ["//", "*//*"]) {
    const prefix = marker === "//" ? "try{{.put(}}catch{{//" : "try{{.put(}}catch{{/*";
    const text = prefix + marker.repeat(50_000);
    const started = process.hrtime.bigint();
    holdingWriteViolations([{ path: join(SRC, "sandbox/adversarial.ts"), text: `function f() {\n  observe(x);\n${text}\n}\n` }]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${JSON.stringify(marker)} x50000 took ${ms.toFixed(0)} ms`);
  }
  // And it still sees what it is for, in each spelling.
  for (const write of [
    "try { await kv.update(k, v, r); } catch { }",
    "try { await kv.put(k, v); } catch (err) { /* lost */ }",
    "try {\n  if (a) { await kv.update(k, v, r); }\n} catch {\n  // lost the race\n}",
  ]) {
    const found = holdingWriteViolations([{
      path: join(SRC, "sandbox/mutant.ts"),
      text: `function f(info) {\n  info.lastProbeFailureAt = 1;\n  ${write}\n}\n`,
    }]);
    assert.equal(found.length, 1, `missed: ${write}`);
  }
  // A catch that does something is not swallowed.
  assert.deepEqual(holdingWriteViolations([{
    path: join(SRC, "sandbox/mutant.ts"),
    text: "function f(info) {\n  info.lastProbeFailureAt = 1;\n  try { await kv.update(k, v, r); } catch (err) { log(err); }\n}\n",
  }]), []);
});

test("holding evidence goes to the hold key, and every destructive confirmation reads it fail-closed", () => {
  // The record's CAS can lose every attempt (the record is renewed on every
  // sweep), so the sanctioned holding path is the hold key's unconditional put,
  // made before the retry loop, and the confirmation every idle_empty and
  // instance_replaced destroy goes through reads it before allowing one.
  const text = FILES.find((f) => f.path.endsWith("sandbox/keepalive.ts"))!.text;
  const fns = functionsOf("sandbox/keepalive.ts", text);
  const persist = fns.find((c) => c.name === "persistHoldingObservation")!.text;
  const put = persist.indexOf("putReclaimHold(");
  const loop = persist.search(/\bfor\s*\(/);
  assert.ok(put >= 0 && loop > put, "persistHoldingObservation puts the hold key before its CAS loop");

  const confirm = fns.find((c) => c.name === "confirmReclaim")!.text;
  const read = confirm.indexOf("readReclaimHold(");
  const allowed = confirm.indexOf("return true");
  assert.ok(read >= 0 && allowed > read, "confirmReclaim reads the hold key before it can allow a destroy");
  const failClosed = confirm.slice(read).match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n {4}\}/);
  assert.ok(failClosed && /return false;/.test(failClosed[1]), "an unreadable hold key holds the destroy");
  assert.equal((confirm.match(/return true/g) ?? []).length, 1, "one way out that allows a destroy");

  // Every destroy for these reasons is behind confirmReclaim.
  for (const c of fns) {
    const reclaims = c.text.match(/onKeepaliveReclaim\("(?:idle_empty|instance_replaced)"\)/g) ?? [];
    if (reclaims.length === 0) continue;
    assert.ok(c.text.includes("confirmReclaim("), `${c.name} reclaims without confirmReclaim`);
  }

  // The hold key is never written under CAS: no update/create on it anywhere.
  const hold = FILES.find((f) => f.path.endsWith("sandbox/reclaim-hold.ts"))!.text;
  assert.ok(/\bkv\.put\(key,/.test(hold), "the hold key is written with put");
  assert.ok(!/\.(?:update|create)\(/.test(hold), "and never with a revision-conditioned write");
});
