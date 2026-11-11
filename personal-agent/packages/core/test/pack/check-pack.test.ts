// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rules of scripts/build.ts and scripts/check-pack.ts that decide what is published, on made-up inputs: where a file
 * read by `new URL(..., import.meta.url)` lands, which files a tarball may and must carry, and what its manifest must say.
 * (The real tarballs are checked end to end by `npm run check-pack` in CI.)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { PACKAGES, placeMetaUrl, type PackageSpec } from "../../../../scripts/build.js";
import { fileProblems, manifestProblems } from "../../../../scripts/check-pack.js";

const spec = (dir: PackageSpec["dir"]): PackageSpec => {
  const found = PACKAGES.find((p) => p.dir === dir);
  assert.ok(found);
  return found;
};

test("a file under src/ read by import.meta.url ships at the same place under dist/; package.json one level up", () => {
  const pkg = path.join(path.sep, "w", "packages", "runtime");
  const assets = new Map<string, string>();
  const source = path.join(pkg, "src", "sqlite", "migrations.ts");
  assert.equal(placeMetaUrl(pkg, source, "./schema.sql", assets), "./sqlite/schema.sql");
  assert.deepEqual(
    [...assets],
    [[path.join(pkg, "src", "sqlite", "schema.sql"), path.join(pkg, "dist", "sqlite", "schema.sql")]],
  );
  const w8 = path.join(pkg, "src", "assembly", "features-w8.ts");
  assert.equal(placeMetaUrl(pkg, w8, "../../package.json", new Map()), "../package.json");
  assert.equal(placeMetaUrl(pkg, w8, "../../../core/src/x.json", new Map()), undefined);
  assert.equal(placeMetaUrl(pkg, w8, "../../README.md", new Map()), undefined);
});

const TEAMS = [
  "package.json",
  "dist/LICENSE",
  "dist/index.js",
  "dist/main.js",
  "dist/types/index.d.ts",
  "dist/connector-hosts.js",
  "dist/types/connector-hosts.d.ts",
];

test("a tarball carries its bundles, declarations, licence and run-time files, and nothing else", () => {
  const read = (): string => "";
  assert.deepEqual(fileProblems(spec("teams"), [...TEAMS, "dist/types/a/b.d.ts"], read), []);
  assert.deepEqual(fileProblems(spec("teams"), [...TEAMS, "src/main.ts", "test/x.test.ts", "dist/types/a.ts"], read), [
    "unexpected file in the package: src/main.ts",
    "unexpected file in the package: test/x.test.ts",
    "unexpected file in the package: dist/types/a.ts",
  ]);
  assert.deepEqual(fileProblems(spec("teams"), TEAMS.slice(0, 3), read), [
    "missing from the package: dist/types/index.d.ts (run npm run build first)",
    "missing from the package: dist/main.js (run npm run build first)",
    "missing from the package: dist/connector-hosts.js (run npm run build first)",
    "missing from the package: dist/types/connector-hosts.d.ts (run npm run build first)",
  ]);
  const ingress = ["package.json", "dist/LICENSE", "dist/index.js", "dist/types/index.d.ts", "dist/main.js"];
  assert.deepEqual(fileProblems(spec("teams-ingress"), ingress, read), []);
  assert.deepEqual(fileProblems(spec("teams-ingress"), [...ingress, "host.json"], read), [
    "unexpected file in the package: host.json",
  ]);
  const core = ["package.json", "dist/LICENSE", "dist/index.js", "dist/types/index.d.ts"];
  assert.deepEqual(fileProblems(spec("core"), core, read), [
    "missing from the package: dist/types/protocol/remote-agents.d.ts (run npm run build first)",
  ]);
});

test("a bundle that reads a file the tarball lacks, or imports the Claw sources by path, fails", () => {
  const runtime = ["package.json", "dist/LICENSE", "dist/index.js", "dist/types/index.d.ts", "dist/sqlite/schema.sql"];
  const reads = (text: string) => (): string => text;
  const schema = 'readFileSync(new URL("./sqlite/schema.sql", import.meta.url), "utf8")';
  assert.deepEqual(fileProblems(spec("runtime"), runtime, reads(schema)), []);
  assert.deepEqual(fileProblems(spec("runtime"), runtime, reads('new URL("./sqlite/other.sql", import.meta.url)')), [
    "dist/index.js reads ./sqlite/other.sql, which is not in the package (dist/sqlite/other.sql)",
  ]);
  assert.deepEqual(
    fileProblems(spec("runtime"), runtime, reads('export * from "../../../../claw/packages/protocol/src/x.js";')),
    ["dist/index.js imports the Claw sources by path instead of carrying them"],
  );
});

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "@primusclaw/personal-agent-teams",
  version: "0.1.0",
  license: "MIT",
  type: "module",
  engines: { node: ">=26" },
  repository: {
    type: "git",
    url: "git+https://github.com/AMD-AGI/PrimusClaw.git",
    directory: "personal-agent/packages/teams",
  },
  exports: {
    ".": { types: "./dist/types/index.d.ts", default: "./dist/index.js" },
    "./connector-hosts": { types: "./dist/types/connector-hosts.d.ts", default: "./dist/connector-hosts.js" },
  },
  dependencies: { "@primusclaw/personal-agent": "0.1.0", zod: "^4" },
  ...over,
});
const TGZ = "/x/primusclaw-personal-agent-teams-0.1.0.tgz";

test("the manifest is publishable, names its siblings by its own exact version, and matches the release asked for", () => {
  const repository = "https://github.com/AMD-AGI/PrimusClaw";
  assert.deepEqual(manifestProblems(spec("teams"), manifest(), TGZ, { version: "0.1.0", repository }), []);
  assert.deepEqual(manifestProblems(spec("teams"), manifest({ private: true, scripts: {} }), TGZ, {}), [
    '"private": true would make npm refuse to publish',
    'the manifest has "scripts", which the package does not use',
  ]);
  assert.deepEqual(
    manifestProblems(spec("teams"), manifest({ dependencies: { "@primusclaw/personal-agent": "^0.1.0" } }), TGZ, {}),
    ['depends on @primusclaw/personal-agent@"^0.1.0"; the packages name each other by their one version 0.1.0'],
  );
  assert.deepEqual(
    manifestProblems(spec("teams"), manifest(), TGZ, { version: "0.2.0", repository: "https://github.com/o/r" }),
    [
      "version 0.1.0 is not the expected 0.2.0",
      'repository.url "git+https://github.com/AMD-AGI/PrimusClaw.git" does not name https://github.com/o/r',
    ],
  );
  assert.deepEqual(manifestProblems(spec("teams"), manifest({ exports: { ".": "./src/index.ts" } }), TGZ, {}), [
    'exports is {".":"./src/index.ts"}, expected {".":{"types":"./dist/types/index.d.ts","default":"./dist/index.js"},' +
      '"./connector-hosts":{"types":"./dist/types/connector-hosts.d.ts","default":"./dist/connector-hosts.js"}}',
  ]);
  assert.deepEqual(manifestProblems(spec("teams"), manifest({ version: "0.1.0-rc.1" }), TGZ, {}), [
    'version "0.1.0-rc.1" is not MAJOR.MINOR.PATCH',
    "the tarball is named primusclaw-personal-agent-teams-0.1.0.tgz, expected primusclaw-personal-agent-teams-0.1.0-rc.1.tgz",
    'depends on @primusclaw/personal-agent@"0.1.0"; the packages name each other by their one version 0.1.0-rc.1',
  ]);
});
