// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fails unless the three npm tarballs are what is meant to be published, and work once installed. Run after
 * `npm run build`, from personal-agent/:
 *
 *   node --import tsx scripts/check-pack.ts [--version X.Y.Z] [--repository https://github.com/OWNER/REPO] [--out DIR]
 *
 * It packs each package with `npm pack` and reads the real tarball, never the `files` field. The file list: the bundles,
 * the declarations, the licence, the files a bundle reads at run time, and nothing else (no TypeScript source, test or
 * fixture). The manifest: name, one version for all three, the exact version they name each other by, not private, the
 * licence, the repository directory, the engine, the entries. Then it installs the three tarballs into an empty
 * directory outside the workspace and checks what a user gets there: each package imports, the wire contract is compiled
 * into core, the store's schema loads, the worker program runs and refuses an empty environment, and a TypeScript file
 * naming the three packages compiles against their declarations.
 *
 * --version pins the version (a release passes its tag's), --repository the repository that publishes (npm refuses a
 * provenance statement whose repository differs from `repository.url`), and --out keeps the checked tarballs in DIR, so
 * that what is published is exactly what was checked.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PACKAGES, type PackageSpec } from "./build.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = PACKAGES.map((p) => p.name);
const TSC = path.join(root, "node_modules", "typescript", "bin", "tsc");

export interface Expect {
  readonly version?: string | undefined;
  readonly repository?: string | undefined;
}

/** The files each package must ship besides its declarations (dist/types/**.d.ts). */
const SHIPPED: Readonly<Record<PackageSpec["dir"], readonly string[]>> = {
  core: [
    "package.json",
    "dist/LICENSE",
    "dist/index.js",
    "dist/types/index.d.ts",
    "dist/types/protocol/remote-agents.d.ts",
  ],
  runtime: ["package.json", "dist/LICENSE", "dist/index.js", "dist/types/index.d.ts", "dist/sqlite/schema.sql"],
  teams: ["package.json", "dist/LICENSE", "dist/index.js", "dist/types/index.d.ts", "dist/main.js"],
};

const errText = (e: unknown): string => {
  const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr) : "";
  return (e instanceof Error ? e.message : String(e)) + (stderr ? `\n${stderr}` : "");
};

/** Run `cmd`; its stdout (it throws, with stderr, when the command fails). */
function run(cmd: string, args: readonly string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The files of a tarball, relative to its package/ directory. */
export function tarballFiles(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => (line.startsWith("package/") ? line.slice("package/".length) : `../${line}`));
}

const member = (tarball: string, file: string): string =>
  execFileSync("tar", ["-xzOf", tarball, `package/${file}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** What is wrong with the list of files a package ships, and with what its bundles read at run time. */
export function fileProblems(pkg: PackageSpec, packed: readonly string[], read: (file: string) => string): string[] {
  const problems: string[] = [];
  const expected = new Set(SHIPPED[pkg.dir]);
  for (const f of packed) {
    if (!expected.has(f) && !/^dist\/types\/.+\.d\.ts$/.test(f)) problems.push(`unexpected file in the package: ${f}`);
  }
  for (const f of expected)
    if (!packed.includes(f)) problems.push(`missing from the package: ${f} (run npm run build first)`);
  for (const bundle of packed.filter((f) => /^dist\/[^/]+\.js$/.test(f))) {
    const text = read(bundle);
    for (const [, target] of text.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
      const at = path.posix.normalize(path.posix.join("dist", target ?? ""));
      if (!packed.includes(at)) problems.push(`${bundle} reads ${target ?? ""}, which is not in the package (${at})`);
    }
    if (/from\s*["'](\.\.\/)+claw\//.test(text))
      problems.push(`${bundle} imports the Claw sources by path instead of carrying them`);
  }
  return problems;
}

/** What is wrong with the fields of a package's shipped manifest that do not depend on the release. */
function fixedFieldProblems(pkg: PackageSpec, m: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const repository = (m["repository"] ?? {}) as { directory?: unknown };
  const want = (field: string, got: unknown, expected: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  };
  want("name", m["name"], pkg.name);
  want("license", m["license"], "MIT");
  want("type", m["type"], "module");
  want("engines", m["engines"], { node: ">=26" });
  want("repository.directory", repository.directory, `personal-agent/packages/${pkg.dir}`);
  want("exports", m["exports"], { ".": { types: "./dist/types/index.d.ts", default: "./dist/index.js" } });
  if (m["private"] === true) problems.push('"private": true would make npm refuse to publish');
  for (const field of ["main", "module", "bin", "scripts"]) {
    if (Object.hasOwn(m, field)) problems.push(`the manifest has "${field}", which the package does not use`);
  }
  return problems;
}

/** What is wrong with a package's shipped manifest. */
export function manifestProblems(
  pkg: PackageSpec,
  m: Record<string, unknown>,
  tarball: string,
  expect: Expect,
): string[] {
  const problems = fixedFieldProblems(pkg, m);
  const version = typeof m["version"] === "string" ? m["version"] : "";
  if (!/^\d+\.\d+\.\d+$/.test(version))
    problems.push(`version ${JSON.stringify(m["version"])} is not MAJOR.MINOR.PATCH`);
  if (expect.version !== undefined && version !== expect.version) {
    problems.push(`version ${version} is not the expected ${expect.version}`);
  }
  const file = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
  if (path.basename(tarball) !== file)
    problems.push(`the tarball is named ${path.basename(tarball)}, expected ${file}`);
  if (expect.repository !== undefined) {
    const raw = (m["repository"] as { url?: unknown } | undefined)?.url;
    const url = (typeof raw === "string" ? raw : "").replace(/^git\+/, "").replace(/\.git$/, "");
    if (url !== expect.repository)
      problems.push(`repository.url ${JSON.stringify(raw)} does not name ${expect.repository}`);
  }
  for (const [dep, range] of Object.entries((m["dependencies"] ?? {}) as Record<string, unknown>)) {
    if (NAMES.includes(dep) && range !== version) {
      problems.push(
        `depends on ${dep}@${JSON.stringify(range)}; the three name each other by their one version ${version}`,
      );
    }
  }
  return problems;
}

const PROBE = `
  const core = await import("@primusclaw/personal-agent");
  const runtime = await import("@primusclaw/personal-agent-runtime");
  const teams = await import("@primusclaw/personal-agent-teams");
  const problems = [];
  if (core.CONNECTOR_PACKAGE !== "@primusclaw/connector") problems.push("core does not carry the wire contract (CONNECTOR_PACKAGE)");
  if (typeof core.neutralPlugins !== "function" || typeof core.integrationRegistry !== "function") problems.push("core lacks its plugin entry points");
  if (typeof runtime.openWorkerStore !== "function") problems.push("runtime lacks openWorkerStore");
  if (typeof teams.buildWorker !== "function" || typeof teams.main !== "function") problems.push("teams lacks buildWorker or main");
  console.log(JSON.stringify(problems));
`;

/**
 * A consumer naming each package's types. The @ts-expect-error lines make it fail if a type came out as `any` (the
 * directive is itself an error when the line under it compiles).
 */
const CONSUMER = [
  'import { neutralPlugins, integrationRegistry, CONNECTOR_PACKAGE, type Plugins, type IntegrationRegistry } from "@primusclaw/personal-agent";',
  'import { openWorkerStore } from "@primusclaw/personal-agent-runtime";',
  'import { buildWorker, main, type WorkerOptions, type Worker } from "@primusclaw/personal-agent-teams";',
  "const plugins: Plugins = neutralPlugins();",
  "const registry: IntegrationRegistry = integrationRegistry();",
  'registry.addMcpServer("x", "X");',
  "const pkg: string = CONNECTOR_PACKAGE;",
  "const options: WorkerOptions = {};",
  "const built: Promise<Worker> = buildWorker({}, plugins, options);",
  "const exit: Promise<number> = main({});",
  "// @ts-expect-error neutralPlugins takes a partial Plugins, not a number",
  "neutralPlugins(1);",
  "// @ts-expect-error openWorkerStore takes settings",
  "openWorkerStore();",
  "export { built, exit, pkg };",
  "",
].join("\n");

/** What is wrong once the tarballs are installed in `user` (an empty directory outside the workspace). */
function installedProblems(user: string, tarballs: readonly string[]): string[] {
  const problems: string[] = [];
  fs.writeFileSync(
    path.join(user, "package.json"),
    JSON.stringify({ name: "check-pack-user", private: true, type: "module" }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...tarballs], user);
  try {
    const said = JSON.parse(
      run(process.execPath, ["--input-type=module", "-e", PROBE], user).trim().split("\n").at(-1) ?? "[]",
    ) as string[];
    problems.push(...said);
  } catch (e) {
    problems.push(`the packages do not import: ${errText(e)}`);
  }
  // The worker program, with an empty environment: it must start, then refuse with one CRITICAL line (status 2: no
  // secrets). A bundle that never ran its main, or failed to load, says nothing of the kind.
  const program = path.join(user, "node_modules", "@primusclaw", "personal-agent-teams", "dist", "main.js");
  const ran = spawnSync(process.execPath, [program], {
    cwd: user,
    env: { PATH: process.env["PATH"] ?? "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (ran.status !== 2 || !/ CRITICAL secrets: /.test(ran.stderr)) {
    problems.push(
      `dist/main.js with an empty environment exited ${String(ran.status)}, expected 2 with a CRITICAL secrets line: ${ran.stderr}`,
    );
  }
  // Twice: as a typical project compiles (skipLibCheck), and with every declaration file checked as well, under the
  // settings the packages are written with, so a declaration naming a module or type the package lacks fails here.
  fs.writeFileSync(path.join(user, "consumer.ts"), CONSUMER);
  for (const extra of [{ skipLibCheck: true }, { skipLibCheck: false, exactOptionalPropertyTypes: true }]) {
    const compilerOptions = {
      target: "ES2022",
      module: "NodeNext",
      strict: true,
      noEmit: true,
      types: ["node"],
      ...extra,
    };
    const typeRoots = [path.join(root, "node_modules", "@types")];
    fs.writeFileSync(
      path.join(user, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { ...compilerOptions, typeRoots }, files: ["consumer.ts"] }),
    );
    const tsc = spawnSync(process.execPath, [TSC, "-p", path.join(user, "tsconfig.json")], {
      cwd: user,
      encoding: "utf8",
    });
    if (tsc.status !== 0)
      problems.push(`a TypeScript consumer (${JSON.stringify(extra)}) does not compile:\n${tsc.stdout}${tsc.stderr}`);
  }
  return problems.map((p) => `installed: ${p}`);
}

/** Pack, inspect and install the three packages; every problem found. */
export function checkPack(expect: Expect, out: string | undefined): string[] {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "personal-agent-pack-"));
  try {
    const problems: string[] = [];
    const tarballs: string[] = [];
    const versions = new Set<unknown>();
    for (const pkg of PACKAGES) {
      // --ignore-scripts: the caller has built; nothing may rebuild between this check and the publish.
      const packed = run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
        path.join(root, "packages", pkg.dir),
      );
      const tarball = path.join(scratch, (JSON.parse(packed) as { filename: string }[])[0]?.filename ?? "");
      tarballs.push(tarball);
      const manifest = JSON.parse(member(tarball, "package.json")) as Record<string, unknown>;
      versions.add(manifest["version"]);
      const found = [
        ...fileProblems(pkg, tarballFiles(tarball), (f) => member(tarball, f)),
        ...manifestProblems(pkg, manifest, tarball, expect),
      ];
      problems.push(...found.map((p) => `${pkg.name}: ${p}`));
    }
    if (versions.size !== 1)
      problems.push(`the three packages are released in lockstep, but name ${String(versions.size)} versions`);
    if (problems.length > 0) return problems;
    const user = path.join(scratch, "user");
    fs.mkdirSync(user);
    problems.push(...installedProblems(user, tarballs));
    if (problems.length === 0 && out !== undefined) {
      fs.mkdirSync(out, { recursive: true });
      for (const t of tarballs) fs.copyFileSync(t, path.join(out, path.basename(t)));
    }
    if (problems.length === 0)
      console.log(
        `check-pack: ${tarballs.map((t) => path.basename(t)).join(", ")} ship, install, import and type-check`,
      );
    return problems;
  } catch (e) {
    return [`could not check the packages: ${errText(e)}`];
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { version: { type: "string" }, repository: { type: "string" }, out: { type: "string" } },
  });
  const problems = checkPack(
    { version: values.version, repository: values.repository },
    values.out === undefined ? undefined : path.resolve(values.out),
  );
  for (const p of problems) console.error(`check-pack: ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}
