// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The wire contract has one definition, in claw/packages/protocol; the personal agent must not carry a second. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as theirsApi from "../../../../claw/packages/protocol/src/claw-api/index.js";
import * as theirsRemote from "../../../../claw/packages/protocol/src/remote-agents.js";
import * as ours from "../src/protocol.js";
import * as core from "../src/index.js";
import { own } from "../src/own.js";

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every value the contract exports, by name. */
const contract: Record<string, unknown> = { ...theirsApi, ...theirsRemote };

test("src/protocol.ts re-exports the very objects of the shared modules (not copies)", () => {
  const names = Object.keys(contract);
  assert.ok(names.length > 10, "the contract exports its constants");
  for (const name of names) {
    assert.equal(own(ours as Record<string, unknown>, name), own(contract, name), name);
    assert.equal(own(core as Record<string, unknown>, name), own(contract, name), `core index: ${name}`);
  }
  assert.equal(ours.REMOTE_COMMANDS, theirsRemote.REMOTE_COMMANDS);
  assert.equal(ours.ASSISTANT_EVENT_TYPES, theirsApi.ASSISTANT_EVENT_TYPES);
});

test("no other file of any package reaches into the protocol package, and none restates its constants", () => {
  const constants = Object.entries(contract)
    .filter(([, v]) => typeof v !== "function")
    .map(([k]) => k);
  const restated = new RegExp(`\\b(?:const|let|var)\\s+(?:${constants.join("|")})\\b`);
  const files = ["core", "runtime", "teams"].flatMap((p) => sourceFiles(path.join(packages, p, "src")));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(packages, file);
    if (rel !== path.join("core", "src", "protocol.ts")) {
      assert.doesNotMatch(text, /claw\/packages\/protocol/, `${rel} must import the contract from core`);
    }
    assert.doesNotMatch(text, restated, `${rel} restates a constant of the contract`);
  }
});
