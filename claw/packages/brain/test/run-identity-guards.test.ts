// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The guards that keep the identity single-sourced.
 *
 * The original defect was not a wrong value but a second place allowed to
 * invent one, and every ledger test passed while it shipped. These are source-
 * and type-level: they fail at build time on the edit that reintroduces it,
 * rather than on a run that happens to exercise the path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, "..", "src");
const packageRoot = path.join(here, "..");
const workspaceRoot = path.join(here, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const sources = sourceFiles(srcRoot).map((file) => ({
  file: path.relative(srcRoot, file),
  text: readFileSync(file, "utf8"),
}));

/**
 * Every workspace's product source.
 *
 * "Exactly one module may mint a key" is a claim about the tree, not about one
 * package: a second cast in the API or in the protocol package would satisfy a
 * guard that only ever read `brain/src` while making the claim false.
 */
const repoSources = readdirSync(workspaceRoot)
  .map((pkg) => path.join(workspaceRoot, pkg, "src"))
  .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
  .flatMap((dir) => sourceFiles(dir))
  .map((file) => ({
    file: path.relative(workspaceRoot, file),
    text: readFileSync(file, "utf8"),
  }));

test("T5.1/T3.3 a proxy string, and an undecided wait mode, do not compile", async () => {
  // `tsc` over a file of @ts-expect-error lines: loosening the brand or giving
  // `mode` a default turns each of them into an unused expectation, which is
  // itself an error, so the guard cannot rot into a no-op.
  const { stdout, stderr } = await run(process.execPath, [
    path.join(packageRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(here, "types", "tsconfig.json"),
  ], { cwd: packageRoot, timeout: 180_000 }).catch((err: Error & { stdout?: string }) => {
    assert.fail(`the brand guard no longer compiles:\n${err.stdout ?? err.message}`);
  }) as { stdout: string; stderr: string };
  assert.equal(`${stdout}${stderr}`.trim(), "");
});

test("T5.2 exactly one module in the repository can mint a ledger key", () => {
  assert.ok(repoSources.length > sources.length, "the scan must reach past this package");
  const minting = repoSources.filter((s) => /as\s+RunIdentityKey\b/.test(s.text));
  assert.deepEqual(minting.map((s) => s.file), ["brain/src/tasks/run-identity.ts"],
    "a second cast is a second identity for one run, which is the defect this replaces");
});

test("T5.2 no module outside the resolver declares a brand of its own", () => {
  // Declaring the type a second time would let a package mint one without ever
  // writing the cast this guard looks for.
  const declaring = repoSources.filter((s) => /type RunIdentityKey\s*=/.test(s.text));
  assert.deepEqual(declaring.map((s) => s.file), ["brain/src/tasks/run-identity.ts"]);
});

test("T5.2 nothing outside Brain names the branded key at all", () => {
  // The declaration living in Brain is what keeps the brand out of the wire and
  // storage types: a protocol or API module that could name it could hold one.
  const naming = repoSources
    .filter((s) => !s.file.startsWith("brain/"))
    .filter((s) => /\bRunIdentityKey\b/.test(s.text));
  assert.deepEqual(naming.map((s) => s.file), []);
});

test("T5.3 every ledger call site is handed an identity, never a proxy", () => {
  // The test that would have caught the original defect: it reads the argument
  // rather than the value, so a proxy fails here before it can ship.
  const call = /\b(?:beginRun|endRun|phaseOf|runTimeOf|whileWaiting|whileRecovering)\s*\(\s*([^,)]*)/g;
  const offenders: string[] = [];
  for (const { file, text } of sources) {
    // The ledger's own module declares these; every other mention is a call.
    if (file === "tasks/run-phase.ts") continue;
    for (const match of text.matchAll(call)) {
      const argument = match[1].trim();
      const ok = /runIdentity|identity\.key|^key$/.test(argument);
      if (!ok || /pickRunScope|dag_root_task_id\s*\|\||lockKey/.test(argument)) {
        offenders.push(`${file}: ${argument}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("T5.4 neither the engine nor the loop computes a key of its own", () => {
  for (const file of ["agent/engine.ts", "agent/agent-loop.ts"]) {
    const text = sources.find((s) => s.file === file)!.text;
    assert.ok(!text.includes("resolveRunIdentity"),
      `${file} must read the identity it was given, not resolve a second one`);
    assert.ok(!/dag_root_task_id\s*\|\|/.test(text), `${file} still derives a key from request fields`);
    assert.ok(!/runKey/.test(text), `${file} still carries the old proxy key`);
  }
});

test("the sub-agent's options literal is type-checked again", () => {
  // The `as any` on it is how the omitted key stayed invisible: the sub-agent
  // simply never passed one, and nothing said so.
  const text = sources.find((s) => s.file === "agent/sub-agent.ts")!.text;
  assert.ok(!/\}\s*as any\s*\)/.test(text), "an options literal cast away is a contract nobody checks");
  assert.match(text, /runIdentity: opts\.runIdentity/);
});
