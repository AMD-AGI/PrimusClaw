// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Upgrading itself (src/auto-upgrade.ts), in this process: which version it may go to, whether it is on, where it is
 * installed, and, with a running connector, that it ends its run to upgrade only while nothing is going on. The upgrade itself
 * (npm, the trial run, the rollback, the supervisor starting the new code) is test/auto-upgrade-e2e.test.ts, with real processes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  AutoUpgrader, autoUpgradeSetting, configSetting, installLayout, manualCommand, upgradeTarget, upgradeTiming, writeConfigSetting,
  type Blocked, type Layout,
} from "../src/auto-upgrade.js";
import { parseConfig } from "../src/config.js";
import { resolveDirs } from "../src/paths.js";
import { silentLogger, sleep } from "../src/util.js";
import { Harness, tmpdir } from "./support/harness.js";

describe("which version", () => {
  const rec = (minimum: string, recommended: string) => ({ minimum, recommended });
  test("exactly the recommended version, when it is newer and of the same major version", () => {
    assert.deepEqual(upgradeTarget("1.2.3", rec("1.0.0", "1.4.0")), { target: "1.4.0" });
    assert.deepEqual(upgradeTarget("0.2.3", rec("0.1.3", "0.2.5")), { target: "0.2.5" });
  });
  test("never down, never to the same version, never to a prerelease or across a major version", () => {
    assert.equal((upgradeTarget("1.4.0", rec("1.0.0", "1.3.9")) as { skip: string }).skip, "current");
    assert.equal((upgradeTarget("1.4.0", rec("1.0.0", "1.4.0")) as { skip: string }).skip, "current");
    assert.equal((upgradeTarget("1.4.0", rec("1.0.0", "1.5.0-rc.1")) as { skip: string }).skip, "prerelease");
    assert.equal((upgradeTarget("1.4.0", rec("1.0.0", "2.0.0")) as { skip: string }).skip, "major");
    assert.equal((upgradeTarget("0.9.0", rec("0.1.0", "1.0.0")) as { skip: string }).skip, "major");
    assert.equal((upgradeTarget("garbage", rec("1.0.0", "1.0.1")) as { skip: string }).skip, "invalid");
  });
  test("below 1.0.0, a new minor version only when Claw's minimum puts both in one range", () => {
    // Claw takes 0.1.3 and up, so 0.1.x -> 0.2.x is within what it says works together.
    assert.deepEqual(upgradeTarget("0.1.21", rec("0.1.3", "0.2.3")), { target: "0.2.3" });
    // Claw's minimum is 0.2.0: the 0.1 line is not in its range, so a move across minors is left to a person.
    assert.equal((upgradeTarget("0.1.21", rec("0.2.0", "0.2.3")) as { skip: string }).skip, "minor");
    // Within one minor line the minimum does not matter.
    assert.deepEqual(upgradeTarget("0.2.0", rec("0.2.1", "0.2.3")), { target: "0.2.3" });
  });
  test("a version that failed here is not tried again until a newer one is recommended", () => {
    assert.equal((upgradeTarget("1.0.0", rec("1.0.0", "1.0.2"), "1.0.2") as { skip: string }).skip, "failed_before");
    assert.deepEqual(upgradeTarget("1.0.0", rec("1.0.0", "1.0.3"), "1.0.2"), { target: "1.0.3" });
  });
});

describe("whether it is on", () => {
  test("on by default; agents.toml turns it off; the variable wins over both", () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir() } as NodeJS.ProcessEnv);
    fs.mkdirSync(dirs.config, { recursive: true });
    assert.deepEqual(autoUpgradeSetting(dirs, {}), { enabled: true, source: "default" });
    fs.writeFileSync(path.join(dirs.config, "agents.toml"), "# head\nname = \"box\"\n\n[[agents]]\nid = \"a\"\n");
    assert.deepEqual(autoUpgradeSetting(dirs, {}), { enabled: true, source: "default" });
    writeConfigSetting(dirs, false);
    assert.deepEqual(autoUpgradeSetting(dirs, {}), { enabled: false, source: "config" });
    assert.deepEqual(autoUpgradeSetting(dirs, { CLAW_CONNECTOR_AUTO_UPGRADE: "1" }), { enabled: true, source: "env" });
    writeConfigSetting(dirs, true);
    assert.deepEqual(autoUpgradeSetting(dirs, { CLAW_CONNECTOR_AUTO_UPGRADE: "0" }), { enabled: false, source: "env" });
    assert.deepEqual(autoUpgradeSetting(dirs, {}), { enabled: true, source: "config" });
  });
  test("writing the setting changes one line, at the top level, and leaves the agents as they were", () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir() } as NodeJS.ProcessEnv);
    fs.mkdirSync(dirs.config, { recursive: true });
    const file = path.join(dirs.config, "agents.toml");
    const before = `# my connector\n# second line\n\n# the claude agent\n[[agents]]\nid = "c"\npreset = "claude"\nroots = ["${dirs.config}"]\n`;
    fs.writeFileSync(file, before);
    writeConfigSetting(dirs, false);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(configSetting(after), false);
    assert.equal(after.match(/^auto_upgrade = /gm)?.length, 1, "one key");
    assert.ok(after.startsWith("# my connector\n# second line\n\n# Whether this connector upgrades itself"), after);
    assert.ok(after.indexOf("auto_upgrade = false") < after.indexOf("[[agents]]"));
    assert.ok(after.includes("# the claude agent\n[[agents]]"), "the agent keeps its comment");
    assert.deepEqual(parseConfig(after).agents.map((a) => a.id), parseConfig(before).agents.map((a) => a.id));
    writeConfigSetting(dirs, true);
    const again = fs.readFileSync(file, "utf8");
    assert.equal(configSetting(again), true);
    assert.equal(again.match(/^auto_upgrade = /gm)?.length, 1, "changed in place, not added twice");
  });
  test("there is nothing to write without agents.toml", () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir() } as NodeJS.ProcessEnv);
    assert.throws(() => writeConfigSetting(dirs, false), /claw-connector init/);
  });
  test("test timings come from the variable, with floors", () => {
    const t = upgradeTiming({ CLAW_CONNECTOR_UPGRADE_TIMING: "checkMs=5,idleMs=300,trialAttempts=0,bogus=1" });
    assert.equal(t.checkMs, 10);
    assert.equal(t.idleMs, 300);
    assert.equal(t.trialAttempts, 1);
    assert.equal(upgradeTiming({}).retryMs, 15 * 60_000);
  });
});

describe("where it is installed", () => {
  const fakeInstall = (root: string) => {
    const pkgDir = path.join(root, "lib", "node_modules", "@primusclaw", "connector");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@primusclaw/connector", version: "1.0.0" }));
    return pkgDir;
  };
  test("a global npm install, under any prefix, with the npm beside the node that runs it", async () => {
    const prefix = tmpdir();
    const pkgDir = fakeInstall(prefix);
    const nodeDir = path.join(tmpdir(), "bin");
    fs.mkdirSync(nodeDir);
    const npmCli = path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, "");
    fs.writeFileSync(path.join(nodeDir, "npm"), "");
    const l = await installLayout(path.join(pkgDir, "dist", "cli.js"), path.join(nodeDir, "node"), { PATH: "" }) as Layout;
    assert.equal(l.prefix, fs.realpathSync(prefix));
    assert.equal(l.pkgDir, fs.realpathSync(pkgDir));
    assert.deepEqual(l.npm, [path.join(nodeDir, "node"), path.resolve(npmCli)]);
    assert.equal(l.npmShown, path.join(nodeDir, "npm"));
    assert.equal(manualCommand(l, "1.0.1"),
      `${path.join(nodeDir, "npm")} install -g --prefix ${l.prefix} @primusclaw/connector@1.0.1 && ${l.prefix}/bin/claw-connector stop && ${l.prefix}/bin/claw-connector service install`);
    assert.match(manualCommand(l, "1.0.1", true), /^sudo /);
  });
  test("a source checkout, an npx cache, or no npm at all", async () => {
    const here = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli.ts");
    assert.ok("unmanaged" in await installLayout(here, process.execPath, process.env));
    const npx = path.join(tmpdir(), "_npx", "abc", "node_modules");
    fs.mkdirSync(npx, { recursive: true });
    const pkgDir = fakeInstall(path.join(npx, ".."));
    assert.ok("unmanaged" in await installLayout(path.join(pkgDir, "dist", "cli.js"), process.execPath, process.env));
    const lone = fakeInstall(tmpdir());
    const l = await installLayout(path.join(lone, "dist", "cli.js"), path.join(tmpdir(), "node"), { PATH: "" }) as Layout;
    assert.equal(l.npm, null);
    assert.equal(l.npmShown, "npm");
  });
});

/** A layout that is never touched: the in-process tests stop at the decision to upgrade. */
const LAYOUT: Layout = { pkgDir: "/nowhere/lib/node_modules/@primusclaw/connector", prefix: "/nowhere", cli: "/nowhere/cli.js", node: process.execPath, npm: ["npm"], npmShown: "npm" };

async function upgrading(o: { env?: NodeJS.ProcessEnv; supervised?: boolean; blocked?: Blocked | null; topToml?: string; idleMs?: number; retryMs?: number } = {}) {
  const home = tmpdir();
  const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv);
  const preflights: string[] = [];
  const up = new AutoUpgrader({
    dirs, env: o.env ?? {}, version: "1.0.0", supervised: o.supervised ?? true, cli: "/nowhere/cli.js", node: process.execPath, log: silentLogger,
    timing: { ...upgradeTiming({}), checkMs: 30, idleMs: o.idleMs ?? 150, retryMs: o.retryMs ?? 200 },
    layout: async () => LAYOUT,
    preflight: async (_l, target) => { preflights.push(target); return o.blocked ?? null; },
  });
  const h = await Harness.create({ home, upgrade: up, version: "1.0.0", start: false, topToml: o.topToml });
  if (o.topToml) { fs.mkdirSync(dirs.config, { recursive: true }); fs.writeFileSync(path.join(dirs.config, "agents.toml"), o.topToml); }
  h.claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.1" };
  const ended = h.start();
  let result: string | null = null;
  void ended.then((r) => { result = r; });
  return { h, up, ended, preflights, result: () => result };
}

const capsOf = (hb: any) => hb.agents[0].capabilities;

describe("a running connector", () => {
  test("ends its run to upgrade once it has been idle for a while, and says so in the heartbeat until then", async () => {
    const { h, ended, preflights } = await upgrading({ idleMs: 400 });
    await h.online();
    await h.claw.until("a heartbeat that says it waits for idle", () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === "waiting_idle"));
    assert.equal(await ended, "upgrade");
    assert.equal(h.connector.upgradeTarget, "1.0.1");
    assert.deepEqual(preflights, ["1.0.1"]);
    assert.equal(capsOf(h.claw.heartbeats.at(-1)).auto_upgrade.target, "1.0.1");
  });

  test("never while a turn runs; once it ends, it waits the retry time and the idle time, then upgrades", async () => {
    const { h, ended, result } = await upgrading({ idleMs: 100, retryMs: 600 });
    const sid = await h.newSession();
    const gate = path.join(h.work, "gate");
    h.prompt(sid, `wait ${gate}`);
    await sleep(1500);
    assert.equal(result(), null, "no upgrade while the turn runs");
    assert.equal(h.connector.upgradeTarget, null);
    const doneAt = Date.now();
    fs.writeFileSync(gate, "");
    await h.turnEnd(sid);
    assert.equal(await ended, "upgrade");
    assert.ok(Date.now() - doneAt >= 100, "not before the idle time");
  });

  test("never while a permission card waits for an answer", async () => {
    const { h, ended, result } = await upgrading({ idleMs: 100, retryMs: 300 });
    const sid = await h.newSession();
    h.prompt(sid, "write a.txt");
    const perm = await h.permission(sid);
    await sleep(1200);
    assert.equal(result(), null, "no upgrade while a card waits");
    h.decide(sid, perm.data.actionId, "reject");
    await h.turnEnd(sid);
    assert.equal(await ended, "upgrade");
  });

  test("off: by the variable, or by agents.toml; and never in a run no supervisor restarts", async () => {
    for (const o of [{ env: { CLAW_CONNECTOR_AUTO_UPGRADE: "0" } }, { topToml: "auto_upgrade = false\n" }, { supervised: false }]) {
      const { h, preflights, result } = await upgrading({ ...o, idleMs: 50, retryMs: 100 });
      await h.online();
      const want = o.supervised === false ? "unsupervised" : "off";
      await h.claw.until(`a heartbeat that says ${want}`, () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === want));
      await sleep(600);
      assert.equal(result(), null, JSON.stringify(o));
      assert.deepEqual(preflights, []);
      const last = capsOf(h.claw.heartbeats.at(-1)).auto_upgrade;
      assert.equal(last.enabled, o.supervised === false);
      if (o.supervised === false) assert.match(last.command, /@primusclaw\/connector@1\.0\.1/);
      assert.equal(await h.stop(), "stopped");
    }
  });

  test("where it cannot (a prefix it may not write), it changes nothing, says why with the command, and asks again only after the retry time", async () => {
    const blocked: Blocked = { reason: "prefix_not_writable", detail: "/opt/x/lib/node_modules/@primusclaw cannot be written by this user (EACCES)", command: "sudo npm install -g --prefix /opt/x @primusclaw/connector@1.0.1 && /opt/x/bin/claw-connector stop && /opt/x/bin/claw-connector service install" };
    const { h, preflights, result } = await upgrading({ blocked, idleMs: 50, retryMs: 1000 });
    await h.online();
    await h.claw.until("a heartbeat that says it is blocked", () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === "blocked"));
    const hb = h.claw.heartbeats.find((b) => capsOf(b).auto_upgrade?.state === "blocked");
    assert.equal(capsOf(hb).auto_upgrade.command, blocked.command);
    assert.equal(capsOf(hb).auto_upgrade.reason, "prefix_not_writable");
    const problem = capsOf(hb).health.problems.find((p: any) => p.code === "connector_upgrade_blocked");
    assert.ok(problem, "the chat is told");
    assert.equal(problem.scope, "machine");
    assert.equal(problem.fix, blocked.command);
    const n = preflights.length;
    await sleep(600);
    assert.equal(preflights.length, n, "not asked again before the retry time");
    assert.equal(result(), null);
    assert.equal(await h.stop(), "stopped");
  });

  test("a stop from outside is a stop, not an upgrade", async () => {
    const { h } = await upgrading({ idleMs: 60_000 });
    await h.online();
    assert.equal(await h.stop(), "stopped");
    assert.equal(h.connector.upgradeTarget, null);
  });
});
