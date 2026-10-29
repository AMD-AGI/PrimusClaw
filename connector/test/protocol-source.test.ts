// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The wire contract has one definition, in claw/packages/protocol; the connector must not carry a second. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ours from "../src/protocol.js";
import * as theirs from "../../claw/packages/protocol/src/remote-agents.js";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = fs.readdirSync(src).filter((f) => f.endsWith(".ts"));

test("src/protocol.ts re-exports the very objects of the shared module (not copies)", () => {
  assert.equal(ours.REMOTE_AGENT_LIMITS, theirs.REMOTE_AGENT_LIMITS);
  assert.equal(ours.REMOTE_AGENT_TIMING, theirs.REMOTE_AGENT_TIMING);
  assert.equal(ours.REMOTE_COMMANDS, theirs.REMOTE_COMMANDS);
  assert.equal(ours.isRemoteCommandType, theirs.isRemoteCommandType);
  assert.equal(ours.REMOTE_AGENT_PROTOCOL_VERSION, theirs.REMOTE_AGENT_PROTOCOL_VERSION);
});

test("no other file reaches into the protocol package, and none restates its constants", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    if (f !== "protocol.ts") assert.doesNotMatch(text, /claw\/packages\/protocol/, `${f} must import ./protocol.js`);
    assert.doesNotMatch(text, /export const (REMOTE_AGENT_LIMITS|REMOTE_AGENT_TIMING|REMOTE_COMMAND_TYPES)\b/, f);
  }
});

test("the connector's own timings are the contract's: heartbeat, watchdog, ping relation", async () => {
  const { DEFAULT_TIMING } = await import("../src/connector.js");
  assert.equal(DEFAULT_TIMING.heartbeatMs, theirs.REMOTE_AGENT_TIMING.heartbeatMs);
  assert.equal(DEFAULT_TIMING.watchdogMs, theirs.REMOTE_AGENT_TIMING.watchdogMs);
  assert.ok(DEFAULT_TIMING.watchdogMs > theirs.REMOTE_AGENT_TIMING.pingMs * 2, "a lost ping or two does not drop a healthy stream");
  assert.equal(DEFAULT_TIMING.heartbeatMs, 30_000);
  assert.equal(DEFAULT_TIMING.watchdogMs, 75_000);
  assert.equal(DEFAULT_TIMING.batchMs, 150);
  assert.equal(DEFAULT_TIMING.batchMax, 20);
  assert.equal(DEFAULT_TIMING.backoffMinMs, 1000);
  assert.equal(DEFAULT_TIMING.backoffMaxMs, 60_000);
});

test("package.json and the version constant agree", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(src, "..", "package.json"), "utf8"));
  const { VERSION } = await import("../src/version.js");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.bin["claw-connector"], "dist/cli.js");
});
