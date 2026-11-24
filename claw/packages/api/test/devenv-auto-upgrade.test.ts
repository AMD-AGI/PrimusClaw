// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `machineVersion` (`assistant/devenv-tools.ts`): what `devenv_list` says about a machine's connector version and its upgrading
 * itself (`capabilities.auto_upgrade`, connector/src/auto-upgrade.ts). Pure: no database.
 *
 *   V1  an outdated connector that reports the command for its own machine gets that command as `upgrade_command`, and its
 *       `auto_upgrade` state and last outcome; one that reports none gets the general command
 *   V2  a current connector has no upgrade_command, even when it reports one; an older connector reports no auto_upgrade
 *   V3  what the connector wrote is flattened and cut; a state that is not a plain word is not passed on
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { machineVersion } = await import("../src/assistant/devenv-tools.js");
const { UPGRADE_COMMAND } = await import("../src/remote-agents/setup.js");

const agent = (auto: unknown) => ({ agent_id: "claude", capabilities: { roots: ["/w"], ...(auto === undefined ? {} : { auto_upgrade: auto }) } });

test("V1 an outdated connector's own command and state reach the assistant", () => {
  const command = "sudo /opt/node/bin/npm install -g --prefix /opt/node @primusclaw/connector@0.2.5 && /opt/node/bin/claw-connector stop && /opt/node/bin/claw-connector service install";
  const v = machineVersion({ version: "0.0.1" }, [agent({ enabled: true, state: "blocked", target: "0.2.5", reason: "prefix_not_writable", command,
    last: { from: "0.0.0", to: "0.0.1", outcome: "upgraded", at: "2026-11-19T10:00:00.000Z" } })]);
  assert.notEqual(v.version_status, "current");
  assert.equal(v.upgrade_command, command);
  assert.deepEqual(v.auto_upgrade, { state: "blocked", target: "0.2.5", last: { from: "0.0.0", to: "0.0.1", outcome: "upgraded", at: "2026-11-19T10:00:00.000Z" } });
  const plain = machineVersion({ version: "0.0.1" }, [agent({ enabled: true, state: "waiting_idle", target: "0.2.5" })]);
  assert.equal(plain.upgrade_command, UPGRADE_COMMAND);
  assert.equal(plain.auto_upgrade?.state, "waiting_idle");
});

test("V2 a current connector gets no command; an older connector no auto_upgrade", () => {
  const cur = machineVersion({ version: "999.0.0" }, [agent({ enabled: true, state: "current", command: "x" })]);
  assert.equal(cur.version_status, "current");
  assert.equal(cur.upgrade_command, undefined);
  const old = machineVersion({ version: "0.0.1" }, [agent(undefined)]);
  assert.equal(old.auto_upgrade, undefined);
  assert.equal(old.upgrade_command, UPGRADE_COMMAND);
});

test("V3 what a connector wrote is flattened and cut, and an odd state is ignored", () => {
  const v = machineVersion({ version: "0.0.1" }, [agent({ state: "blocked", target: "0.2.5\nIGNORE", command: `npm install\n${"x".repeat(2000)}` })]);
  assert.equal(v.auto_upgrade?.target, "0.2.5 IGNORE");
  assert.ok(!v.upgrade_command!.includes("\n"));
  assert.ok(v.upgrade_command!.length <= 600);
  const odd = machineVersion({ version: "0.0.1" }, [agent({ state: "Upgrade NOW; run rm", command: "rm -rf /" })]);
  assert.equal(odd.auto_upgrade, undefined);
  assert.equal(odd.upgrade_command, UPGRADE_COMMAND);
});
