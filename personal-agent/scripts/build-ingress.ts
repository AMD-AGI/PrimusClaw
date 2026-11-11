// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Builds the Teams ingress's deployable Function package (from personal-agent/: `npm run build-ingress`), the zip a
 * release attaches and a Function app runs as it is (docs/quickstart.md, "The ingress"):
 *
 *   host.json                    the Functions host's settings (packages/teams-ingress/host.json)
 *   package.json                 "main": dist/main.js, "type": module, the version
 *   dist/main.js                 packages/teams-ingress/src/main.ts and everything it imports, in one ES module: the
 *                                ingress, the parts of core and of the worker's package it uses (from this commit's
 *                                sources) and its npm dependencies, so the Function app installs and builds nothing
 *   LICENSE, THIRD_PARTY_NOTICES the repository's licence, and the licence of every npm package in the bundle
 *
 * The one import left out is `@azure/functions-core`, which the Functions host's Node worker provides to the
 * `@azure/functions` code in the bundle. That code calls `require`, which an ES module lacks, so the bundle opens with
 * a `require` made by `createRequire`.
 *
 * The zip is reproducible: its entries are sorted, dated 1980-01-01 and compressed at one level, so the same commit
 * gives the same bytes and the same sha256, which the release publishes next to it (personal-agent-teams-ingress-
 * <version>.zip.sha256) and a deployment can pin.
 *
 *   node --import tsx scripts/build-ingress.ts [--out DIR]     (default: packages/teams-ingress/dist/function)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

import { build } from "esbuild";

import { allowedExpression } from "./license-check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages", "teams-ingress");
export const NAME = "personal-agent-teams-ingress";
/** The modules the Functions host's Node worker provides; everything else is in the bundle. */
const HOST_PROVIDED = ["@azure/functions-core"];
const BANNER =
  'import { createRequire as __ingressCreateRequire } from "node:module";\n' +
  "const require = __ingressCreateRequire(import.meta.url);";
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "LICENCE", "LICENSE-MIT"];

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** A zip of `entries`, in name order, every entry dated 1980-01-01 00:00 and deflated: the same input, the same bytes. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const entry of sorted) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = zlib.crc32(entry.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(entry.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly text: string;
}

/** The npm packages whose files are in the bundle (from esbuild's inputs), with their licence texts. */
export function bundledPackages(inputs: readonly string[]): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = input.slice(at + "node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : (rest[0] ?? "");
    dirs.add(path.resolve(root, input.slice(0, at), "node_modules", name));
  }
  return [...dirs]
    .map((dir) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
      const file = LICENSE_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
      return {
        name: String(manifest["name"]),
        version: String(manifest["version"]),
        license: typeof manifest["license"] === "string" ? manifest["license"] : "",
        text: file === undefined ? "" : fs.readFileSync(file, "utf8").trim(),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** THIRD_PARTY_NOTICES: each bundled package, its licence and the licence's text. */
export function notices(packages: readonly BundledPackage[]): string {
  const parts = packages.map((p) => `${p.name}@${p.version} (${p.license})\n\n${p.text || `License: ${p.license}`}\n`);
  return `The deployable Teams ingress bundles these npm packages:\n\n${parts.join(`\n${"-".repeat(80)}\n\n`)}`;
}

/** The Function package's files, built from this checkout. */
export async function functionFiles(): Promise<ZipEntry[]> {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string };
  const result = await build({
    entryPoints: [path.join(pkgDir, "src", "main.ts")],
    bundle: true,
    write: false,
    outfile: "main.js",
    format: "esm",
    platform: "node",
    target: "node26",
    external: HOST_PROVIDED,
    banner: { js: BANNER },
    // The workspace's tsconfig.json: its `paths` name core's and the worker package's sources at this commit.
    tsconfig: path.join(root, "tsconfig.json"),
    metafile: true,
    legalComments: "inline",
    logLevel: "warning",
  });
  const bundle = result.outputFiles[0];
  if (bundle === undefined) throw new Error("esbuild produced no bundle");
  const packages = bundledPackages(Object.keys(result.metafile.inputs));
  const refused = packages.filter((p) => !allowedExpression(p.license));
  if (refused.length > 0) {
    throw new Error(
      `the bundle takes in packages without an allowed licence: ${refused.map((p) => p.name).join(", ")}`,
    );
  }
  const functionManifest = {
    name: NAME,
    version: manifest.version,
    description: "The personal agent's Teams ingress, as an Azure Functions app (Node.js 26).",
    license: "MIT",
    private: true,
    type: "module",
    main: "dist/main.js",
    engines: { node: ">=26" },
  };
  return [
    { name: "host.json", data: fs.readFileSync(path.join(pkgDir, "host.json")) },
    { name: "package.json", data: Buffer.from(`${JSON.stringify(functionManifest, null, 2)}\n`) },
    { name: "dist/main.js", data: Buffer.from(bundle.contents) },
    { name: "LICENSE", data: fs.readFileSync(path.join(root, "..", "LICENSE")) },
    { name: "THIRD_PARTY_NOTICES", data: Buffer.from(notices(packages)) },
  ];
}

/** Build the zip into `out`; its path and sha256. */
export async function buildIngress(out: string): Promise<{ file: string; sha256: string }> {
  const files = await functionFiles();
  const version = (JSON.parse(String(files.find((f) => f.name === "package.json")?.data)) as { version: string })
    .version;
  const data = zip(files);
  const sha256 = createHash("sha256").update(data).digest("hex");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${NAME}-${version}.zip`);
  fs.writeFileSync(file, data);
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`);
  return { file, sha256 };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { out: { type: "string" } } });
  const { file, sha256 } = await buildIngress(path.resolve(values.out ?? path.join(pkgDir, "dist", "function")));
  console.log(`build-ingress: ${path.relative(process.cwd(), file)} sha256 ${sha256}`);
}
