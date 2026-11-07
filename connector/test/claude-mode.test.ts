// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A Claude agent that asks before every step, on a machine whose own Claude settings default to bypassPermissions:
 * the connector used to see the adapter start the session in bypassPermissions, warn that it would not ask, and close
 * it (mode_not_enforced). It now tells the adapter to leave bypass out (`allowDangerouslySkipPermissions: false`), and
 * the session opens in `default`. The stand-in adapter does what claude-agent-acp 0.99.0 does with that option
 * (fake-adapter.mjs); test/real-modes.test.ts runs the real one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { claudeSessionMeta } from "../src/claude-mode.js";
import { main, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { resolveDirs } from "../src/paths.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const agent = (work: string, extra: string, args = `[${JSON.stringify(ADAPTER)}, "claude-agent-acp"]`) => `
[[agents]]
id = "cc"
preset = "claude"
command = ${JSON.stringify(process.execPath)}
args = ${args}
roots = [${JSON.stringify(work)}]
${extra}
[agents.env]
FAKE_START_MODE = "bypassPermissions"
FAKE_NEW_WARN = "1"
`;

describe("claudeSessionMeta", () => {
  const work = tmpdir("cm-work-");
  const meta = { _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } } };

  test("a Claude agent that asks gets it; one without approval, claude-attach, and other adapters do not", () => {
    assert.deepEqual(claudeSessionMeta(parseConfig(agent(work, "")).agents[0]!), meta);
    assert.deepEqual(claudeSessionMeta(parseConfig(agent(work, `approval = "ask"`)).agents[0]!), meta);
    assert.deepEqual(claudeSessionMeta(parseConfig(agent(work, `approval = "never"`)).agents[0]!), {});
    assert.deepEqual(claudeSessionMeta(parseConfig(`allow_unsafe_modes = true\n${agent(work, "")}`).agents[0]!), {});
    assert.deepEqual(claudeSessionMeta(parseConfig(agent(work, "", `[${JSON.stringify(ADAPTER)}]`)).agents[0]!), {});
    assert.deepEqual(claudeSessionMeta(parseConfig(`[[agents]]\nid = "att"\npreset = "claude-attach"\nroots = [${JSON.stringify(work)}]\n`).agents[0]!), {});
    assert.deepEqual(claudeSessionMeta(parseConfig(`[[agents]]\nid = "cx"\npreset = "codex"\nroots = [${JSON.stringify(work)}]\n`).agents[0]!), {});
  });
});

describe("through run: Claude's own settings default to bypassPermissions", () => {
  async function openSession(extra: string, args?: string) {
    const base = tmpdir("cm-");
    const home = path.join(base, "home");
    const work = path.join(base, "work");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config", "agents.toml"), agent(work, extra, args));
    const out: string[] = [];
    const c: Ctx = {
      dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(base, "claude") },
      out: (s) => out.push(s), err: (s) => out.push(s), hostname: "box", claudeManagedSettings: path.join(base, "managed.json"), euid: 1000,
    };
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      claw.tokens.add("good-token");
      await main(["login", "--server", claw.url, "--key", "good-token"], { ...c, out: () => {}, err: () => {} });
      running = main(["run"], { ...c, onConnector: (cn) => { connector = cn; }, timing: { heartbeatMs: 150, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100, modeConfirmMs: 250 } });
      await claw.until("online", () => claw.online);
      const sid = claw.newSession("cc", work);
      return await claw.until("session_started or session_closed", () => claw.eventsOf(sid).find((e) => e.type === "session_started" || e.type === "session_closed"), 15_000);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  }

  test("an agent that asks opens in default and asks", async () => {
    const ev = await openSession(`approval = "ask"`);
    assert.equal(ev.type, "session_started", JSON.stringify(ev.data));
    assert.equal(ev.data.currentMode, "default");
    assert.equal(ev.data.unattended, false);
  });

  test("without the option (an adapter the connector does not recognise as Claude's) it is still closed, not opened unattended", async () => {
    const ev = await openSession(`approval = "ask"`, `[${JSON.stringify(ADAPTER)}]`);
    assert.equal(ev.type, "session_closed");
    assert.equal(ev.data.reason, "mode_not_enforced");
  });

  test("an agent with approval = never still opens in bypassPermissions", async () => {
    const ev = await openSession(`approval = "never"`);
    assert.equal(ev.type, "session_started", JSON.stringify(ev.data));
    assert.equal(ev.data.currentMode, "bypassPermissions");
    assert.equal(ev.data.unattended, true);
  });
});
