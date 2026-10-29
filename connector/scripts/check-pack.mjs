// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Fails unless the package, as `npm pack` would build it, is exactly what is meant to be
// published. Run after `npm run build`, from this directory:
//
//   node scripts/check-pack.mjs [--version X.Y.Z] [--repository https://github.com/OWNER/REPO]
//
// With no flags it checks what must hold on every change (the file list, the bin, the engine,
// the licence, that the built CLI reports the package's own version). The release workflow adds
// the flags, which pin the version to the tag and the repository to the one that is publishing:
// npm refuses a provenance statement whose repository differs from `repository.url`.
//
// It reads the manifest npm itself reports (`npm pack --dry-run --json`), not a list kept here
// next to the `files` field, so a stray file cannot ship because both lists forgot it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: { version: { type: "string" }, repository: { type: "string" } },
});

const problems = [];
const fail = (msg) => problems.push(msg);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (pkg.name !== "@primusclaw/connector") fail(`name is ${JSON.stringify(pkg.name)}, expected "@primusclaw/connector"`);
if (pkg.private === true) fail('"private": true would make npm refuse to publish');
// A prerelease would need a dist-tag, which the release workflow does not set.
if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) fail(`version ${JSON.stringify(pkg.version)} is not MAJOR.MINOR.PATCH`);
if (values.version !== undefined && pkg.version !== values.version) fail(`package.json version ${pkg.version} is not the expected ${values.version}`);
if (pkg.engines?.node !== ">=22") fail(`engines.node is ${JSON.stringify(pkg.engines?.node)}, expected ">=22"`);
if (JSON.stringify(pkg.bin) !== JSON.stringify({ "claw-connector": "dist/cli.js" })) fail(`bin is ${JSON.stringify(pkg.bin)}, expected only claw-connector -> dist/cli.js`);
if (pkg.license !== "MIT") fail(`license is ${JSON.stringify(pkg.license)}, expected "MIT"`);
if (pkg.repository?.directory !== "connector") fail(`repository.directory is ${JSON.stringify(pkg.repository?.directory)}, expected "connector"`);
if (values.repository !== undefined) {
  const url = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
  if (url !== values.repository) fail(`repository.url ${JSON.stringify(pkg.repository?.url)} does not name ${values.repository}`);
}

// The only files that may ship. npm adds package.json and LICENSE by itself.
const allowed = new Set(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
let packed = [];
try {
  // --ignore-scripts: the caller has built already; this must not rebuild and print into the JSON.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  packed = JSON.parse(out)[0].files.map((f) => f.path);
} catch (e) {
  fail(`npm pack --dry-run failed: ${e instanceof Error ? e.message : String(e)}`);
}
for (const f of packed) if (!allowed.has(f)) fail(`unexpected file in the package: ${f}`);
for (const f of allowed) if (!packed.includes(f)) fail(`missing from the package: ${f}${f === "dist/cli.js" ? " (run npm run build first)" : ""}`);

// The licence in the package is a copy of the repository's; a drifted copy would publish the wrong terms.
try {
  const own = readFileSync(join(root, "LICENSE"), "utf8");
  let repo = null;
  try { repo = readFileSync(join(root, "..", "LICENSE"), "utf8"); } catch { /* a checkout of the package alone */ }
  if (repo !== null && own !== repo) fail("connector/LICENSE differs from the repository LICENSE");
} catch {
  fail("connector/LICENSE is missing");
}

// What `claw-connector --version` prints is src/version.ts, kept by hand next to package.json.
try {
  const cli = readFileSync(join(root, "dist/cli.js"), "utf8");
  if (!cli.startsWith("#!/usr/bin/env node\n")) fail("dist/cli.js does not start with the node shebang");
  const reported = execFileSync(process.execPath, [join(root, "dist/cli.js"), "--version"], { encoding: "utf8" }).trim();
  if (reported !== pkg.version) fail(`dist/cli.js --version prints ${JSON.stringify(reported)}, package.json says ${pkg.version} (update src/version.ts)`);
} catch (e) {
  fail(`could not run dist/cli.js --version: ${e instanceof Error ? e.message : String(e)}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-pack: ${p}`);
  process.exit(1);
}
console.log(`check-pack: ${pkg.name}@${pkg.version} ships ${[...packed].sort().join(", ")}`);
