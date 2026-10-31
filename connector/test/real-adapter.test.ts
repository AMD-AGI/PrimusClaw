// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The owner's opt-in against the REAL claude-agent-acp adapter and a real model, not the stand-in. Skipped unless
 * both variables below are set, and it says so: CI has no model credentials, so this is run by hand before a
 * release that touches session.ts or config.ts.
 *
 *   CLAW_REAL_CLAUDE_ACP        path to the adapter's dist/index.js (npm i @agentclientprotocol/claude-agent-acp@0.99.0)
 *   CLAW_REAL_CLAUDE_SETTINGS   path to a Claude settings.json whose `env` (and `model`) reach a model; nothing else is used
 *
 * Both cases run the adapter with the user's own Claude settings defaulting to bypassPermissions, the situation in
 * which the adapter warns that it will not ask for permission.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { tmpdir } from "./support/harness.js";
import { ClawClient } from "../src/claw-client.js";
import { parseConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { KeyTokenProvider } from "../src/credentials.js";
import { fileAudit } from "../src/audit.js";
import { auditFile, resolveDirs } from "../src/paths.js";
import { silentLogger } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";

const ADAPTER = process.env.CLAW_REAL_CLAUDE_ACP;
const SETTINGS = process.env.CLAW_REAL_CLAUDE_SETTINGS;
const skip = ADAPTER && SETTINGS ? false : "set CLAW_REAL_CLAUDE_ACP and CLAW_REAL_CLAUDE_SETTINGS to run against the real adapter";

const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const f of cleanups) await f(); });

async function realConnector(agentToml: string) {
  const user = JSON.parse(fs.readFileSync(SETTINGS!, "utf8")) as { env?: unknown; model?: unknown };
  const claudeHome = tmpdir("cc-claude-");
  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ env: user.env, model: user.model, permissions: { defaultMode: "bypassPermissions" } }), { mode: 0o600 });
  fs.writeFileSync(path.join(claudeHome, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  const work = tmpdir("cc-work-");
  const claw = await FakeClaw.start();
  const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir() } as NodeJS.ProcessEnv);
  const config = parseConfig(`[[agents]]
id = "claude"
preset = "claude"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
roots = [${JSON.stringify(work)}]
${agentToml}
[agents.env]
CLAUDE_CONFIG_DIR = ${JSON.stringify(claudeHome)}
`);
  const client = new ClawClient({ server: claw.url, tokens: new KeyTokenProvider("good-token"), requestTimeoutMs: 3000 });
  const connector = new Connector({
    config, dirs, client, server: claw.url, audit: fileAudit(auditFile(dirs)), log: silentLogger, version: "test",
    timing: { heartbeatMs: 500, watchdogMs: 5000, batchMs: 15, modeConfirmMs: 3000, permissionTtlMs: 30_000 },
  });
  const running = connector.run();
  cleanups.push(async () => { connector.stop(); await running.catch(() => undefined); await claw.close(); });
  await claw.until("the connector online", () => claw.online && claw.heartbeats.length > 0, 30_000);
  const sid = claw.newSession("claude", work);
  await claw.until("started or closed", () => claw.eventsOf(sid).some((e) => e.type === "session_started" || e.type === "session_closed"), 90_000);
  return { claw, sid, work, dirs };
}

describe("the real claude-agent-acp adapter, user settings defaulting to bypassPermissions", { skip }, () => {
  test("without the owner's opt-in the session is refused (the adapter says it will not ask)", async () => {
    const { claw, sid, dirs } = await realConnector("");
    assert.equal(claw.eventsOf(sid, "session_closed")[0]!.data.reason, "mode_not_enforced");
    assert.equal(claw.eventsOf(sid, "session_started").length, 0);
    assert.ok(fs.readFileSync(auditFile(dirs), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((a) => a.kind === "permission_callback_warning" && a.accepted === false));
  });

  test('with approval = "never" the session runs: a file is written and a command run with no permission request, and the session says it is unattended', async () => {
    const { claw, sid, work } = await realConnector('approval = "never"');
    const started = claw.eventsOf(sid, "session_started")[0]!;
    assert.deepEqual([started.data.currentMode, started.data.unattended], ["bypassPermissions", true]);
    claw.issue("prompt", sid, { text: "Use your tools: write a file named hello.txt containing the word hi, then run the shell command: echo ok > ran.txt. Then say done." });
    const end = await claw.until("the turn to end", () => claw.eventsOf(sid, "turn_end")[0], 180_000);
    assert.equal(end.data.stopReason, "end_turn");
    assert.equal(claw.eventsOf(sid, "permissionRequest").length, 0, "nothing was asked");
    assert.equal(fs.readFileSync(path.join(work, "hello.txt"), "utf8").trim(), "hi");
    assert.equal(fs.readFileSync(path.join(work, "ran.txt"), "utf8").trim(), "ok");
  });
});
