// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * scripts/build-ingress.ts: the Teams ingress's deployable zip is the same bytes for the same sources, a zip that
 * another reader (Python's zipfile) unpacks to the files it was given, and a Function app package: host.json, a
 * package.json whose main is the bundle, the bundle, and the licences.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildIngress, functionFiles, zip } from "../scripts/build-ingress.js";

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-ingress-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a zip of the same entries is the same bytes, in name order, and Python's zipfile reads it back", (t) => {
  const dir = scratch(t);
  const entries = [
    { name: "b/c.txt", data: Buffer.from("second\n") },
    { name: "a.json", data: Buffer.from('{"a": 1}\n'.repeat(100)) },
    { name: "empty", data: Buffer.alloc(0) },
  ];
  const one = zip(entries);
  assert.deepEqual(zip([...entries].reverse()), one);
  const file = path.join(dir, "x.zip");
  fs.writeFileSync(file, one);
  const read = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys,zipfile\n" +
        "z=zipfile.ZipFile(sys.argv[1])\n" +
        "assert z.testzip() is None\n" +
        "print(json.dumps([[i.filename,i.date_time[:3],z.read(i).decode()] for i in z.infolist()]))",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), [
    ["a.json", [1980, 1, 1], '{"a": 1}\n'.repeat(100)],
    ["b/c.txt", [1980, 1, 1], "second\n"],
    ["empty", [1980, 1, 1], ""],
  ]);
});

test("the Function package is host.json, a package.json naming the bundle, the bundle and the licences", async (t) => {
  const files = await functionFiles();
  assert.deepEqual(files.map((f) => f.name).sort(), [
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "dist/main.js",
    "host.json",
    "package.json",
  ]);
  const read = (name: string): string => files.find((f) => f.name === name)?.data.toString("utf8") ?? "";
  const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;
  const version = (
    JSON.parse(fs.readFileSync(path.join("packages", "teams-ingress", "package.json"), "utf8")) as { version: string }
  ).version;
  assert.deepEqual(
    [manifest["main"], manifest["type"], manifest["version"], manifest["engines"]],
    ["dist/main.js", "module", version, { node: ">=26" }],
  );
  assert.deepEqual(
    JSON.parse(read("host.json")),
    JSON.parse(fs.readFileSync("packages/teams-ingress/host.json", "utf8")),
  );
  const bundle = read("dist/main.js");
  // The one module left to the host, and the require the bundled @azure/functions code calls.
  assert.match(bundle, /require\("@azure\/functions-core"\)|from "@azure\/functions-core"/);
  assert.ok(bundle.startsWith('import { createRequire as __ingressCreateRequire } from "node:module";'));
  for (const pkg of ["@azure/functions@", "@azure/service-bus@", "@azure/identity@", "jose@"]) {
    assert.ok(read("THIRD_PARTY_NOTICES").includes(pkg), pkg);
  }
  const dir = scratch(t);
  const first = await buildIngress(dir);
  const again = await buildIngress(path.join(dir, "again"));
  assert.equal(first.sha256, again.sha256);
  assert.equal(path.basename(first.file), `personal-agent-teams-ingress-${version}.zip`);
  assert.equal(fs.readFileSync(`${first.file}.sha256`, "utf8"), `${first.sha256}  ${path.basename(first.file)}\n`);
});
