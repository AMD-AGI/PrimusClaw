// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The red line of the layering: core is channel-neutral. It imports its own files, zod, and (from src/protocol.ts
 * alone) the Claw wire contract -- nothing else: no channel package, no runtime, no Azure, no Bot Framework, no HTTP
 * server, no node:sqlite / node:crypto / prom-client, no Node built-in at all. What it needs from outside comes through
 * a port or a plugin. .dependency-cruiser.cjs states the same rules for the whole workspace; this test keeps the line
 * even where that tool is not run, and reads every import form TypeScript knows (static, dynamic, re-export, require).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(core, "src");
const protocolSource = path.resolve(core, "../../../claw/packages/protocol/src");
const ALLOWED_PACKAGES = new Set(["zod"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function specifiers(text: string): string[] {
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/** Why `specifier`, imported by `file`, breaks the line; undefined when it is allowed. */
export function violation(file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(file), specifier);
    if (target.startsWith(src + path.sep)) return undefined;
    if (target.startsWith(protocolSource + path.sep)) {
      return path.basename(file) === "protocol.ts" && path.dirname(file) === src
        ? undefined
        : "only src/protocol.ts reaches the Claw wire contract";
    }
    return "a relative import out of packages/core/src";
  }
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (name !== undefined && ALLOWED_PACKAGES.has(name)) return undefined;
  return "core imports only itself, zod and the wire contract (a port or a plugin brings the rest)";
}

function violations(file: string, text: string): string[] {
  return specifiers(text).flatMap((s) => {
    const why = violation(file, s);
    return why === undefined ? [] : [`${path.relative(core, file)} imports "${s}": ${why}`];
  });
}

test("core's sources import nothing but core, zod and (protocol.ts only) the wire contract", () => {
  const files = sourceFiles(src);
  assert.ok(files.length > 10, `expected core's sources, found ${String(files.length)}`);
  assert.deepEqual(
    files.flatMap((f) => violations(f, fs.readFileSync(f, "utf8"))),
    [],
  );
});

test("core's package.json depends on nothing but zod", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(core, "package.json"), "utf8")) as Record<string, unknown>;
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = Object.keys(pkg[field] ?? {});
    assert.deepEqual(
      deps.filter((d) => !ALLOWED_PACKAGES.has(d)),
      [],
      field,
    );
  }
});

test("the check itself refuses each kind of forbidden import", () => {
  const file = path.join(src, "ports", "x.ts");
  const forbidden = [
    'import Fastify from "fastify";',
    'import { DatabaseSync } from "node:sqlite";',
    'import { createHmac } from "node:crypto";',
    'import crypto from "crypto";',
    'import client from "prom-client";',
    'import { ServiceBusClient } from "@azure/service-bus";',
    'import { teamsCaps } from "@primusclaw/personal-agent-teams";',
    'import { systemClock } from "@primusclaw/personal-agent-runtime";',
    'import { x } from "../../../teams/src/index.js";',
    'export * from "../../../runtime/src/index.js";',
    'const m = await import("botbuilder");',
    'const r = require("node:fs");',
    'import { REMOTE_COMMANDS } from "../../../../claw/packages/protocol/src/remote-agents.js";',
  ];
  for (const line of forbidden) assert.equal(violations(file, line).length, 1, line);
  for (const line of [
    'import { z } from "zod";',
    'import type { Clock } from "./clock.js";',
    'import "../result.js";',
  ]) {
    assert.deepEqual(violations(file, line), [], line);
  }
  assert.deepEqual(
    violations(
      path.join(src, "protocol.ts"),
      'export * from "../../../../claw/packages/protocol/src/claw-api/index.js";',
    ),
    [],
  );
});
