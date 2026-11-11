// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Builds the four packages into what npm publishes (from personal-agent/: `npm run build`):
 *
 *   packages/<pkg>/dist/index.js        one ES module per package, bundled by esbuild (teams also dist/main.js, the
 *                                       program, and dist/connector-hosts.js; teams-ingress also dist/main.js, the
 *                                       Function app's entry)
 *   packages/<pkg>/dist/types/**.d.ts   the declarations, by tsc
 *   packages/<pkg>/dist/LICENSE         the repository's licence
 *
 * Every bare import stays external (the dependencies, and the other packages, installed from the registry), so each
 * package carries only its own code. Core is the exception the wire contract makes: it reaches claw/packages/protocol by a
 * relative path (src/protocol.ts), and that source is compiled into core's bundle and its declarations, never published
 * as a package of its own. A bundle that takes in a file outside its package's src (and, for core, the protocol's) fails
 * the build.
 *
 * A file a module reads at run time by `new URL("<path>", import.meta.url)` (the store's schema.sql, the teams
 * package.json the worker reports its version from) would point somewhere else once the module is one bundle in dist/.
 * The build rewrites each such URL to where the file is in the published package, copying a file under src/ to the same
 * place under dist/, and fails on any other use of import.meta.url, dirname or filename, which it cannot place.
 *
 * The workspace itself never loads dist/: tsconfig.json's `paths` name each package's src for typecheck, tests and lint.
 *
 * The Teams ingress's deployable Function package (one bundle with its dependencies) is scripts/build-ingress.ts.
 *
 *   node --import tsx scripts/build.ts [core|runtime|teams|teams-ingress ...]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolSrc = path.resolve(root, "..", "claw", "packages", "protocol", "src");

export interface PackageSpec {
  /** The directory under packages/. */
  readonly dir: "core" | "runtime" | "teams" | "teams-ingress";
  readonly name: string;
  /** The entries under src/, each bundled into dist/<entry>.js. */
  readonly entries: readonly string[];
}

/** The packages in dependency order: each one's declarations are built against the ones before it. */
export const PACKAGES: readonly PackageSpec[] = [
  { dir: "core", name: "@primusclaw/personal-agent", entries: ["index"] },
  { dir: "runtime", name: "@primusclaw/personal-agent-runtime", entries: ["index"] },
  { dir: "teams", name: "@primusclaw/personal-agent-teams", entries: ["index", "main", "connector-hosts"] },
  { dir: "teams-ingress", name: "@primusclaw/personal-agent-teams-ingress", entries: ["index", "main"] },
];

const inside = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + path.sep);
const posix = (p: string): string => p.split(path.sep).join("/");
const META_URL = /new URL\(\s*(["'])([^"'\\]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const ANY_META_PATH = /import\.meta\.(url|dirname|filename)/;

/**
 * Where a file named by `new URL(target, import.meta.url)` in `source` is in the published package, as a path relative to
 * dist/ (where every bundle of the package sits); undefined when the package does not ship it. A file under src/ is
 * added to `assets` (source -> its place under dist/).
 */
export function placeMetaUrl(
  pkgDir: string,
  source: string,
  target: string,
  assets: Map<string, string>,
): string | undefined {
  const src = path.join(pkgDir, "src");
  const dist = path.join(pkgDir, "dist");
  const file = path.resolve(path.dirname(source), target);
  let shipped: string;
  if (inside(src, file)) {
    shipped = path.join(dist, path.relative(src, file));
    assets.set(file, shipped);
  } else if (file === path.join(pkgDir, "package.json")) {
    shipped = file;
  } else {
    return undefined;
  }
  const rel = posix(path.relative(dist, shipped));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The esbuild plugin that places `new URL("<literal>", import.meta.url)` in the bundles (see the header). */
function importMetaUrls(pkgDir: string, assets: Map<string, string>): Plugin {
  return {
    name: "import-meta-url",
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        const text = fs.readFileSync(args.path, "utf8");
        if (!ANY_META_PATH.test(text)) return undefined;
        const errors: { text: string }[] = [];
        const contents = text.replace(META_URL, (whole, quote: string, target: string) => {
          const placed = placeMetaUrl(pkgDir, args.path, target, assets);
          if (placed === undefined)
            errors.push({
              text: `new URL(${JSON.stringify(target)}, import.meta.url) names a file the package does not ship`,
            });
          else if (!fs.existsSync(path.resolve(path.dirname(args.path), target)))
            errors.push({
              text: `new URL(${JSON.stringify(target)}, import.meta.url) names a file that does not exist`,
            });
          return placed === undefined ? whole : `new URL(${quote}${placed}${quote}, import.meta.url)`;
        });
        if (ANY_META_PATH.test(contents.replace(META_URL, ""))) {
          errors.push({
            text: 'import.meta.url, dirname or filename used other than as new URL("<literal>", import.meta.url): the bundle cannot place it',
          });
        }
        return errors.length > 0 ? { errors } : { contents, loader: "ts" };
      });
    },
  };
}

async function bundle(pkg: PackageSpec): Promise<void> {
  const pkgDir = path.join(root, "packages", pkg.dir);
  const assets = new Map<string, string>();
  const result = await build({
    entryPoints: pkg.entries.map((e) => path.join(pkgDir, "src", `${e}.ts`)),
    outdir: path.join(pkgDir, "dist"),
    entryNames: "[name]",
    bundle: true,
    // No shared chunks: dist/main.js runs the worker when it is the program (`import.meta.main` in src/main.ts), which a
    // chunk it imported never is. A package's entries are whole bundles of their own.
    splitting: false,
    format: "esm",
    platform: "node",
    target: "node26",
    // Every bare specifier (zod, fastify, the other two packages) is installed next to the package, never bundled.
    packages: "external",
    // Not the workspace's tsconfig.json: its `paths` are for development. These are its settings that change emitted code.
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: true } },
    metafile: true,
    legalComments: "inline",
    logLevel: "warning",
    plugins: [importMetaUrls(pkgDir, assets)],
  });
  const allowed = [path.join(pkgDir, "src"), ...(pkg.dir === "core" ? [protocolSrc] : [])];
  const strays = Object.keys(result.metafile.inputs)
    .map((input) => path.resolve(root, input))
    .filter((input) => !allowed.some((dir) => inside(dir, input)));
  if (strays.length > 0)
    throw new Error(`${pkg.name}: the bundle takes in files outside its sources: ${strays.join(", ")}`);
  for (const [from, to] of assets) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/** Move every file under `from` to the same place under `to`. */
function moveTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, entry.name);
    const t = path.join(to, entry.name);
    if (entry.isDirectory()) moveTree(f, t);
    else fs.renameSync(f, t);
  }
}

/**
 * The declarations, by tsc with the package's tsconfig.build.json (the packages before it as their built declarations).
 * tsc keeps the layout under the repository root, since core's program reaches claw/: the package ships its own src/ as
 * dist/types/, and core the protocol's src/ as dist/types/protocol/, its src/protocol.d.ts pointing there.
 */
function declarations(pkg: PackageSpec): void {
  const pkgDir = path.join(root, "packages", pkg.dir);
  const raw = path.join(pkgDir, "dist", "types-raw");
  const types = path.join(pkgDir, "dist", "types");
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", path.join(pkgDir, "tsconfig.build.json"), "--outDir", raw], {
    stdio: "inherit",
  });
  moveTree(path.join(raw, "personal-agent", "packages", pkg.dir, "src"), types);
  if (pkg.dir === "core") {
    moveTree(path.join(raw, "claw", "packages", "protocol", "src"), path.join(types, "protocol"));
    const file = path.join(types, "protocol.d.ts");
    const text = fs.readFileSync(file, "utf8");
    const rewritten = text.replaceAll('"../../../../claw/packages/protocol/src/', '"./protocol/');
    if (rewritten === text || rewritten.includes("../claw/packages/protocol/"))
      throw new Error(`${file}: the protocol's path was not rewritten`);
    fs.writeFileSync(file, rewritten);
  }
  fs.rmSync(raw, { recursive: true, force: true });
}

/** Build the packages named in `only` (every package when empty), in dependency order. */
export async function buildPackages(only: readonly string[]): Promise<void> {
  for (const pkg of PACKAGES) {
    if (only.length > 0 && !only.includes(pkg.dir)) continue;
    const dist = path.join(root, "packages", pkg.dir, "dist");
    fs.rmSync(dist, { recursive: true, force: true });
    await bundle(pkg);
    declarations(pkg);
    // The licence travels with every copy (npm picks up a LICENSE only at a package's own root, which these have none of).
    fs.copyFileSync(path.join(root, "..", "LICENSE"), path.join(dist, "LICENSE"));
    console.log(`build: ${pkg.name} -> packages/${pkg.dir}/dist`);
  }
}

if (import.meta.main) {
  await buildPackages(process.argv.slice(2));
}
