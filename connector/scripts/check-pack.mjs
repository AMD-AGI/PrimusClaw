// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Fails unless the npm tarball is exactly what is meant to be published. Run after `npm run build`,
// from this directory:
//
//   node scripts/check-pack.mjs [--tarball FILE] [--version X.Y.Z] [--repository https://github.com/OWNER/REPO]
//
// It inspects a real tarball: the one in --tarball (the release workflow checks the file it is about
// to publish), or else one it packs itself with `npm pack`. With no other flag it checks what must hold
// on every change (the file list, the bin, the engine, the licence, a bundle that is the one just built
// and reports the package's own version). The release workflow adds --version and --repository, which pin
// the version to the tag and the repository to the one that is publishing: npm refuses a provenance
// statement whose repository differs from `repository.url`.
//
// The list of files is read from the tarball itself, not from the `files` field in package.json, so a
// stray file cannot ship because both lists forgot it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: { tarball: { type: "string" }, version: { type: "string" }, repository: { type: "string" } },
});

const problems = [];
const fail = (msg) => problems.push(msg);
const errText = (e) => (e instanceof Error ? e.message : String(e));

const scratch = mkdtempSync(join(tmpdir(), "check-pack-"));
try {
  let tarball = values.tarball === undefined ? undefined : resolve(values.tarball);
  if (tarball === undefined) {
    // --ignore-scripts: the caller has built already; this must not rebuild and print into the JSON.
    const out = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    tarball = join(scratch, JSON.parse(out)[0].filename);
  }
  const fromTarball = (member, encoding) => execFileSync("tar", ["-xzOf", tarball, `package/${member}`], { encoding, maxBuffer: 256 * 1024 * 1024 });

  // What ships: every file of the tarball (npm puts all of them under package/).
  const allowed = new Set(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
  const packed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => (line.startsWith("package/") ? line.slice("package/".length) : `../${line}`));
  for (const f of packed) if (!allowed.has(f)) fail(`unexpected file in the package: ${f}`);
  for (const f of allowed) if (!packed.includes(f)) fail(`missing from the package: ${f}${f === "dist/cli.js" ? " (run npm run build first)" : ""}`);

  // The manifest that ships, not the one in the working directory.
  const pkg = JSON.parse(fromTarball("package.json", "utf8"));
  if (pkg.name !== "@primusclaw/connector") fail(`name is ${JSON.stringify(pkg.name)}, expected "@primusclaw/connector"`);
  if (pkg.private === true) fail('"private": true would make npm refuse to publish');
  // A prerelease would need a dist-tag, which the release workflow does not set.
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) fail(`version ${JSON.stringify(pkg.version)} is not MAJOR.MINOR.PATCH`);
  if (values.version !== undefined && pkg.version !== values.version) fail(`package.json version ${pkg.version} is not the expected ${values.version}`);
  if (basename(tarball) !== `primusclaw-connector-${pkg.version}.tgz`) fail(`the tarball is named ${basename(tarball)}, expected primusclaw-connector-${pkg.version}.tgz`);
  if (pkg.engines?.node !== ">=22") fail(`engines.node is ${JSON.stringify(pkg.engines?.node)}, expected ">=22"`);
  if (JSON.stringify(pkg.bin) !== JSON.stringify({ "claw-connector": "dist/cli.js" })) fail(`bin is ${JSON.stringify(pkg.bin)}, expected only claw-connector -> dist/cli.js`);
  if (pkg.license !== "MIT") fail(`license is ${JSON.stringify(pkg.license)}, expected "MIT"`);
  if (pkg.repository?.directory !== "connector") fail(`repository.directory is ${JSON.stringify(pkg.repository?.directory)}, expected "connector"`);
  if (values.repository !== undefined) {
    const url = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    if (url !== values.repository) fail(`repository.url ${JSON.stringify(pkg.repository?.url)} does not name ${values.repository}`);
  }

  // The licence in the package is a copy of the repository's; a drifted copy would publish the wrong terms.
  if (packed.includes("LICENSE")) {
    let repo = null;
    try { repo = readFileSync(join(root, "..", "LICENSE"), "utf8"); } catch { /* a checkout of the package alone */ }
    if (repo !== null && fromTarball("LICENSE", "utf8") !== repo) fail("the LICENSE in the package differs from the repository LICENSE");
  }

  // The bundle in the tarball is the one just built, and what `claw-connector --version` prints (src/version.ts,
  // kept by hand next to package.json) is the package's version. The bundle needs the dependencies, so it is
  // the working copy that runs.
  if (packed.includes("dist/cli.js")) {
    try {
      const shipped = fromTarball("dist/cli.js", "buffer");
      if (!shipped.equals(readFileSync(join(root, "dist/cli.js")))) fail("dist/cli.js in the package is not the bundle in this checkout (run npm run build)");
      if (!shipped.toString("utf8").startsWith("#!/usr/bin/env node\n")) fail("dist/cli.js does not start with the node shebang");
      const reported = execFileSync(process.execPath, [join(root, "dist/cli.js"), "--version"], { encoding: "utf8" }).trim();
      if (reported !== pkg.version) fail(`dist/cli.js --version prints ${JSON.stringify(reported)}, package.json says ${pkg.version} (update src/version.ts)`);
    } catch (e) {
      fail(`could not check dist/cli.js: ${errText(e)}`);
    }
  }

  if (problems.length === 0) console.log(`check-pack: ${basename(tarball)} (${pkg.name}@${pkg.version}) ships ${[...packed].sort().join(", ")}`);
} catch (e) {
  fail(`could not inspect the tarball: ${errText(e)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-pack: ${p}`);
  process.exit(1);
}
