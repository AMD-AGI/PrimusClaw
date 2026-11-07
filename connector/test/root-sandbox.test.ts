// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Root, an agent with approval = "never", and the Claude adapter: Claude Code offers bypassPermissions to root only
 * with IS_SANDBOX set, so without the connector setting it every phone session of such an agent was refused with
 * mode_unavailable (seen on a development container, 2026-11-07). The stand-in adapter does what claude-agent-acp 0.99.0 does under
 * FAKE_ROOT=1 (fake-adapter.mjs); the uid is the one `run` is told (`euid: 0`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { applyRootSandbox, bypassUnavailableWarnings } from "../src/claude-mode.js";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { resolveDirs } from "../src/paths.js";
import { probeAgents } from "../src/probe.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

// The connector's own environment reaches the adapter; a developer's or a CI runner's IS_SANDBOX would hide the case.
const saved = process.env.IS_SANDBOX;
before(() => { delete process.env.IS_SANDBOX; });
after(() => { if (saved !== undefined) process.env.IS_SANDBOX = saved; });

/** A Claude agent (recognised by `claude-agent-acp` on its command line) that runs the stand-in adapter. */
const claudeAgent = (work: string, approval: string, extraEnv = "") => `
[[agents]]
id = "cc"
preset = "claude"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}, "claude-agent-acp"]
roots = [${JSON.stringify(work)}]
approval = ${JSON.stringify(approval)}
[agents.env]
FAKE_ROOT = "1"
${extraEnv}
`;

describe("applyRootSandbox and bypassUnavailableWarnings", () => {
  const work = tmpdir("rs-work-");
  const parse = (approval: string, extraEnv = "", top = "") => parseConfig(`${top}\n${claudeAgent(work, approval, extraEnv)}`);

  test("root, approval = never: IS_SANDBOX=1 is set for that agent's adapter (and the existing-sessions agent it brings), and said", () => {
    const c = parse("never");
    const notes = applyRootSandbox(c.agents, {}, { euid: 0 });
    assert.deepEqual(c.agents.map((a) => [a.id, a.env.IS_SANDBOX]), [["cc", "1"], ["cc-sessions", "1"]]);
    assert.deepEqual(notes.map((n) => n.split(":")[0]), ["cc", "cc-sessions"]);
    assert.deepEqual(bypassUnavailableWarnings(c.agents, {}, { euid: 0, managedFile: path.join(work, "none.json") }), []);
  });

  test("not set: for a non-root user, for approval = ask, when the connector already has it, for Codex", () => {
    const nonRoot = parse("never");
    assert.deepEqual(applyRootSandbox(nonRoot.agents, {}, { euid: 1000 }), []);
    assert.equal(nonRoot.agents[0]!.env.IS_SANDBOX, undefined);
    const ask = parse("ask");
    assert.deepEqual(applyRootSandbox(ask.agents, {}, { euid: 0 }), []);
    assert.equal(ask.agents[0]!.env.IS_SANDBOX, undefined);
    const inherited = parse("never");
    assert.deepEqual(applyRootSandbox(inherited.agents, { IS_SANDBOX: "1" }, { euid: 0 }), []);
    const codex = parseConfig(`[[agents]]\nid = "cx"\npreset = "codex"\nroots = [${JSON.stringify(work)}]\napproval = "never"\n`);
    assert.deepEqual(applyRootSandbox(codex.agents, {}, { euid: 0 }), []);
    assert.equal(codex.agents[0]!.env.IS_SANDBOX, undefined);
  });

  test("an owner's own IS_SANDBOX (even empty) is kept, and an empty one is warned about with the fix", () => {
    const c = parse("never", `IS_SANDBOX = ""`);
    assert.deepEqual(applyRootSandbox(c.agents, {}, { euid: 0 }), []);
    assert.equal(c.agents[0]!.env.IS_SANDBOX, "");
    const w = bypassUnavailableWarnings(c.agents, {}, { euid: 0, managedFile: path.join(work, "none.json") });
    assert.deepEqual(w.map((x) => x.split(":")[0]), ["cc", "cc-sessions"]);
    assert.match(w[0]!, /^cc: sessions will be refused \(mode_unavailable\): .*remove IS_SANDBOX from its env, or set approval = "ask"$/);
  });

  test("disableBypassPermissionsMode in the user's Claude settings is warned about, for root and non-root", () => {
    const claude = tmpdir("rs-claude-");
    fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }));
    for (const euid of [0, 1000]) {
      const c = parse("never", `CLAUDE_CONFIG_DIR = ${JSON.stringify(claude)}`);
      applyRootSandbox(c.agents, {}, { euid });
      const w = bypassUnavailableWarnings(c.agents, {}, { euid, managedFile: path.join(work, "none.json") });
      assert.deepEqual(w.map((x) => x.split(":")[0]), ["cc", "cc-sessions"], String(euid));
      assert.match(w[0]!, /disableBypassPermissionsMode is "disable" in .*settings\.json/);
    }
  });
});

describe("a phone session on root, through run", () => {
  function setup(approval: string, extraEnv = "") {
    const base = tmpdir("rs-");
    const home = path.join(base, "home");
    const work = path.join(base, "work");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config", "agents.toml"), claudeAgent(work, approval, extraEnv));
    const out: string[] = [];
    const err: string[] = [];
    const c: Ctx = {
      dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(base, "claude") },
      out: (s) => out.push(s), err: (s) => err.push(s), hostname: "box", claudeManagedSettings: path.join(base, "managed.json"), euid: 0,
    };
    return { c, out, err, work };
  }

  async function openSession(approval: string, extraEnv = "") {
    const t = setup(approval, extraEnv);
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      claw.tokens.add("good-token");
      await main(["login", "--server", claw.url, "--key", "good-token"], { ...t.c, out: () => {}, err: () => {} });
      running = main(["run"], { ...t.c, onConnector: (cn) => { connector = cn; }, timing: { heartbeatMs: 150, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100, modeConfirmMs: 250 } });
      await claw.until("online", () => claw.online);
      const sid = claw.newSession("cc", t.work);
      const ev = await claw.until("session_started or session_closed", () => claw.eventsOf(sid).find((e) => e.type === "session_started" || e.type === "session_closed"), 15_000);
      return { ev, out: t.out };
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  }

  test("approval = never opens in bypassPermissions, and run says why it set IS_SANDBOX", async () => {
    const { ev, out } = await openSession("never");
    assert.equal(ev.type, "session_started", JSON.stringify(ev.data));
    assert.equal(ev.data.currentMode, "bypassPermissions");
    assert.equal(ev.data.unattended, true);
    assert.ok(out.some((l) => /^note: cc: running as root, .*IS_SANDBOX=1/.test(l)), out.join("\n"));
  });

  test("approval = ask opens in default, without IS_SANDBOX", async () => {
    const { ev, out } = await openSession("ask");
    assert.equal(ev.type, "session_started", JSON.stringify(ev.data));
    assert.equal(ev.data.currentMode, "default");
    assert.ok(!out.some((l) => l.startsWith("note:")), out.join("\n"));
  });

  test("an owner who sets IS_SANDBOX empty is refused as before, and warned at start", async () => {
    const { ev, out } = await openSession("never", `IS_SANDBOX = ""`);
    assert.equal(ev.type, "session_closed");
    assert.equal(ev.data.reason, "mode_unavailable");
    assert.ok(out.some((l) => /^warning: cc: sessions will be refused \(mode_unavailable\)/.test(l)), out.join("\n"));
  });
});

describe("doctor: the adapter's modes against agents.toml, before any phone session", () => {
  function setup(approval: string, extraEnv = "") {
    const base = tmpdir("rd-");
    const home = path.join(base, "home");
    const work = path.join(base, "work");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config", "agents.toml"), claudeAgent(work, approval, extraEnv));
    const out: string[] = [];
    const c: Ctx = {
      dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(base, "claude") },
      out: (s) => out.push(s), err: (s) => out.push(s), hostname: "box", claudeManagedSettings: path.join(base, "managed.json"), euid: 0,
    };
    return { c, out };
  }

  test("root with approval = never: ok, bypassPermissions offered", async () => {
    const t = setup("never");
    assert.equal(await main(["doctor"], t.c), EXIT.ok, t.out.join("\n"));
    assert.ok(t.out.some((l) => /^cc: ok \(modes: .*bypassPermissions/.test(l)), t.out.join("\n"));
  });

  test("a mismatch is a problem with the fix, exit 1, and --json says the same", async () => {
    const t = setup("never", `IS_SANDBOX = ""`);
    assert.equal(await main(["doctor"], t.c), EXIT.failure);
    assert.ok(t.out.some((l) => /^  problem: sessions will be refused \(mode_unavailable\): .*bypassPermissions.*IS_SANDBOX/.test(l)), t.out.join("\n"));
    const j = setup("never", `IS_SANDBOX = ""`);
    assert.equal(await main(["doctor", "--json"], j.c), EXIT.failure);
    const doc = JSON.parse(j.out.join("\n"));
    assert.equal(doc.ok, false);
    assert.deepEqual(doc.agents[0].modes, ["default", "plan", "acceptEdits"]);
  });

  test("an adapter that cannot start is a problem, not a pass", async () => {
    const work = tmpdir("rd-w-");
    const c = parseConfig(`[[agents]]\nid = "gone"\ncommand = "/nonexistent/adapter"\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
    const [r] = await probeAgents(c.agents, { logDir: tmpdir("rd-log-"), version: "test", timeoutMs: 5000 });
    assert.equal(r!.ok, false);
    assert.match(r!.problems[0]!, /did not open a session/);
  });
});
