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
import { spawn } from "node:child_process";
import {
  AutoUpgrader, autoUpgradeSetting, configSetting, installLayout, manualCommand, performUpgrade, probationExited, probationForget, probationPassed, probationStart,
  readAutoUpgradeSetting, readUpgradeState, upgradeTarget, upgradeTiming, watchProbation, writeConfigSetting, writeUpgradeState, type Blocked, type Layout, type StageResult,
} from "../src/auto-upgrade.js";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { VERSION } from "../src/version.js";
import { approvalSocketFile } from "../src/approvals.js";
import { parseConfig } from "../src/config.js";
import { autoUpgradeFile, resolveDirs } from "../src/paths.js";
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
  test("agents.toml there but unreadable, or not parsing, or saying neither true nor false: off, never the default", async () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir() } as NodeJS.ProcessEnv);
    fs.mkdirSync(dirs.config, { recursive: true });
    const file = path.join(dirs.config, "agents.toml");
    // A read that fails (here: it is a directory; on a machine: a network disk that does not answer in time).
    fs.mkdirSync(file);
    for (const s of [autoUpgradeSetting(dirs, {}), await readAutoUpgradeSetting(dirs, {})]) {
      assert.equal(s.enabled, false);
      assert.equal(s.source, "unreadable");
    }
    fs.rmdirSync(file);
    for (const text of ["auto_upgrade = false\n[[agents\n", "auto_upgrade = \"no\"\n"]) {
      fs.writeFileSync(file, text);
      assert.deepEqual([autoUpgradeSetting(dirs, {}).enabled, autoUpgradeSetting(dirs, {}).source], [false, "unreadable"], text);
      assert.equal((await readAutoUpgradeSetting(dirs, {})).source, "unreadable");
    }
    // The variable still decides where it is set.
    assert.deepEqual(autoUpgradeSetting(dirs, { CLAW_CONNECTOR_AUTO_UPGRADE: "1" }), { enabled: true, source: "env" });
    fs.rmSync(file);
    assert.deepEqual(await readAutoUpgradeSetting(dirs, {}), { enabled: true, source: "default" });
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

async function upgrading(o: {
  env?: NodeJS.ProcessEnv; supervised?: boolean; blocked?: Blocked | null; topToml?: string; idleMs?: number; retryMs?: number; attach?: boolean;
  /** The stand-in agent's environment. */
  agentEnv?: Record<string, string>;
  /** Runs while the preflight asks (npm view): a command may come meanwhile. */
  duringPreflight?: (h: Harness) => Promise<void>;
  /** Runs while it downloads (npm install into the staging prefix): `auto-upgrade off` may be given meanwhile. */
  duringStage?: (dirs: ReturnType<typeof resolveDirs>) => Promise<void>;
} = {}) {
  const home = tmpdir();
  const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv);
  const preflights: string[] = [];
  const stages: string[] = [];
  const stagedPrefixes: string[] = [];
  let harness: Harness | null = null;
  const up = new AutoUpgrader({
    dirs, env: o.env ?? {}, version: "1.0.0", supervised: o.supervised ?? true, cli: "/nowhere/cli.js", node: process.execPath, log: silentLogger,
    timing: { ...upgradeTiming({}), checkMs: 30, idleMs: o.idleMs ?? 150, retryMs: o.retryMs ?? 200 },
    layout: async () => LAYOUT,
    preflight: async (_l, target) => { preflights.push(target); if (o.duringPreflight && harness) await o.duringPreflight(harness); return o.blocked ?? null; },
    stage: async (_l, target): Promise<StageResult> => {
      stages.push(target);
      const prefix = tmpdir();
      const pkgDir = path.join(prefix, "pkg");
      fs.mkdirSync(pkgDir);
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: target }));
      stagedPrefixes.push(prefix);
      if (o.duringStage) await o.duringStage(dirs);
      return { staged: { version: target, prefix, pkgDir } };
    },
  });
  const h = await Harness.create({ home, upgrade: up, version: "1.0.0", start: false, topToml: o.topToml, env: o.agentEnv, ...(o.attach ? { attach: { sessions: [] } } : {}) });
  harness = h;
  if (o.topToml) { fs.mkdirSync(dirs.config, { recursive: true }); fs.writeFileSync(path.join(dirs.config, "agents.toml"), o.topToml); }
  h.claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.1" };
  const ended = h.start();
  let result: string | null = null;
  void ended.then((r) => { result = r; });
  return { h, up, ended, preflights, stages, stagedPrefixes, result: () => result };
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

  test("auto-upgrade off given while it downloads still wins: the run goes on, nothing is swapped, and the download goes", async () => {
    const { h, preflights, stages, stagedPrefixes, result } = await upgrading({
      idleMs: 50, retryMs: 100, topToml: "# connector\n",
      duringStage: async (dirs) => { await sleep(300); writeConfigSetting(dirs, false); },
    });
    await h.online();
    await h.claw.until("it downloaded", () => stages.length === 1);
    await h.claw.until("a heartbeat that says off", () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === "off"));
    await sleep(600);
    assert.equal(result(), null, "the run did not end to upgrade");
    assert.equal(h.connector.upgradeTarget, null);
    assert.deepEqual(preflights, ["1.0.1"]);
    assert.equal(stages.length, 1, "not downloaded again while off");
    assert.ok(!fs.existsSync(stagedPrefixes[0]!), "the download was removed");
    assert.equal(capsOf(h.claw.heartbeats.at(-1)).auto_upgrade.enabled, false);
    assert.equal(await h.stop(), "stopped");
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

  test("never while a command is still being carried out (a session that is still starting), though no turn runs yet", async () => {
    const gate = path.join(tmpdir(), "new-gate");
    const { h, ended, preflights, result } = await upgrading({ idleMs: 100, retryMs: 300, env: {}, agentEnv: { FAKE_NEW_GATE: gate } });
    await h.online();
    const sid = h.claw.newSession("fake", h.work);
    await h.claw.until("the agent asked for the session", () => h.adapterLog().some((l) => l.method === "session/new"));
    await sleep(1500);
    assert.equal(result(), null, "no upgrade while the session.new is carried out");
    assert.deepEqual(preflights, []);
    fs.writeFileSync(gate, "");
    await h.claw.until("the session started", () => h.claw.eventsOf(sid, "session_started")[0]);
    assert.equal(await ended, "upgrade");
  });

  test("not while the command stream is down: a prompt Claw queued meanwhile would wait out the upgrade too", async () => {
    const { h, ended, preflights, result } = await upgrading({ idleMs: 100, retryMs: 300 });
    await h.online();
    await h.claw.until("a heartbeat that says it waits for idle", () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === "waiting_idle"));
    h.claw.unavailable = 1_000_000;
    h.claw.dropStreams();
    await sleep(1500);
    assert.equal(result(), null, "no upgrade while disconnected");
    assert.deepEqual(preflights, []);
    h.claw.unavailable = 0;
    assert.equal(await ended, "upgrade");
  });

  test("not while a terminal's approval waits for an answer from the chat", async () => {
    // Off until the card is there (so it does not upgrade before the terminal asks), then on.
    const { h, ended, preflights, result } = await upgrading({ idleMs: 100, retryMs: 300, attach: true, topToml: "auto_upgrade = false\n" });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await h.claw.until("the approval socket", () => fs.existsSync(sock));
    const hook = spawn(process.execPath, ["--import", "tsx", path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "approval-hook.ts"),
      "ask", "--dir", h.attachDir, "--socket", sock, "--managed-by", "claw-connector"], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAW_APPROVAL_HOOKS: "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise((res) => hook.on("exit", res));
    const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    hook.stdin.end(JSON.stringify({ session_id: REF, transcript_path: "/x/y.jsonl", cwd: h.work, permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }));
    let herr = "";
    hook.stderr.on("data", (c) => { herr += c; });
    await h.claw.until("the terminal session to be opened", () => h.claw.terminalOpens.length === 1).catch((e) => { throw new Error(`${e.message}\n${herr}\n${JSON.stringify(h.audit().slice(-5))}`); });
    const sid = h.claw.terminalSessions.get(REF)!;
    const card = await h.permission(sid);
    writeConfigSetting(h.dirs, true);
    await sleep(1500);
    assert.equal(result(), null, "no upgrade while the terminal waits for an answer");
    assert.deepEqual(preflights, []);
    h.decide(sid, String(card.data.actionId), "deny");
    assert.equal(await exited, 0);
    assert.equal(await ended, "upgrade");
  });

  test("a command that comes while it asks npm keeps it from ending the run; it upgrades after that turn", async () => {
    let sid = "";
    let gate = "";
    const { h, ended, preflights, stages, result } = await upgrading({
      idleMs: 50, retryMs: 300,
      duringPreflight: async (hh) => {
        if (sid) return;
        sid = await hh.newSession();
        gate = path.join(hh.work, "gate2");
        hh.prompt(sid, `wait ${gate}`);
        await hh.claw.until("the turn to be taken", () => !hh.connector.idleNow());
      },
    });
    await h.online();
    await h.claw.until("the preflight", () => preflights.length === 1);
    await sleep(1000);
    assert.equal(result(), null, "the run goes on: a turn started meanwhile");
    assert.equal(stages.length, 1, "the download was made, and is kept for later");
    fs.writeFileSync(gate, "");
    await h.turnEnd(sid);
    assert.equal(await ended, "upgrade");
    assert.equal(stages.length, 1, "the same download is used");
  });

  test("a recommended version that is not a version is not taken, nor put into a command", async () => {
    const { h, up, preflights, result } = await upgrading({ idleMs: 50, retryMs: 100 });
    h.claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.1 && curl x | sh" };
    await h.online();
    await sleep(800);
    assert.equal(result(), null);
    assert.deepEqual(preflights, []);
    const caps = up.report().caps;
    assert.equal(caps.state, "current");
    assert.equal(caps.command, undefined);
    assert.equal(await h.stop(), "stopped");
  });

  test("agents.toml that cannot be read keeps it from upgrading", async () => {
    const { h, preflights, result } = await upgrading({ idleMs: 50, retryMs: 100, topToml: "auto_upgrade = \"maybe\"\n" });
    await h.online();
    await h.claw.until("a heartbeat that says unreadable", () => h.claw.heartbeats.some((b) => capsOf(b).auto_upgrade?.state === "unreadable"));
    await sleep(500);
    assert.equal(result(), null);
    assert.deepEqual(preflights, []);
    assert.equal(await h.stop(), "stopped");
  });

  test("a stop from outside is a stop, not an upgrade", async () => {
    const { h } = await upgrading({ idleMs: 60_000 });
    await h.online();
    assert.equal(await h.stop(), "stopped");
    assert.equal(h.connector.upgradeTarget, null);
  });
});

describe("a new version on probation", () => {
  /** A prefix with `to` in place and `from` in its backup, as `performUpgrade` leaves them. */
  const placed = (from: string, to: string, home = tmpdir()) => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv);
    const scope = path.join(tmpdir(), "lib", "node_modules", "@primusclaw");
    const pkgDir = path.join(scope, "connector");
    const backup = path.join(scope, `.connector-backup-${from}`);
    for (const [d, v] of [[pkgDir, to], [backup, from]] as const) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "@primusclaw/connector", version: v }));
    }
    writeUpgradeState(dirs, { last: { from, to, outcome: "upgraded", at: "x" }, probation: { version: to, from, pkg_dir: pkgDir, backup, owner: 1, runs: [], at: "x" } });
    const installed = () => JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
    return { dirs, pkgDir, backup, installed };
  };
  /** auto-upgrade.json cannot be written by this process (its temporary file's name is taken by a directory). */
  const unwritableState = (dirs: ReturnType<typeof resolveDirs>) => fs.mkdirSync(`${autoUpgradeFile(dirs)}.${process.pid}.tmp`);

  test("runs that start and never prove it: the one after the third puts the old version back and pins the new one", () => {
    const { dirs, backup, installed } = placed("1.0.0", "1.0.1");
    assert.equal(probationStart(dirs, "1.0.1", 101, 3, silentLogger), "watch");
    assert.equal(probationStart(dirs, "1.0.1", 102, 3, silentLogger), "watch");
    assert.equal(probationStart(dirs, "1.0.1", 103, 3, silentLogger), "watch");
    assert.equal(installed(), "1.0.1");
    assert.equal(probationStart(dirs, "1.0.1", 104, 3, silentLogger), "rolled_back");
    assert.equal(installed(), "1.0.0");
    assert.ok(!fs.existsSync(backup), "the copy is what is in place now");
    const st = readUpgradeState(dirs);
    assert.equal(st.failed?.version, "1.0.1");
    assert.equal(st.last?.outcome, "rolled_back");
    assert.equal(st.probation, undefined);
    assert.equal(upgradeTarget("1.0.0", { minimum: "1.0.0", recommended: "1.0.1" }, st.failed!.version).hasOwnProperty("skip"), true);
  });

  test("runs that end before they could count themselves are counted by the supervisor, once each", () => {
    const { dirs, installed } = placed("1.0.0", "1.0.1");
    assert.equal(probationExited(dirs, 1, 3, silentLogger), false, "the upgrading run's own end is not counted");
    assert.equal(probationStart(dirs, "1.0.1", 201, 3, silentLogger), "watch");
    assert.equal(probationExited(dirs, 201, 3, silentLogger), false, "counted once, when it started");
    assert.equal(probationExited(dirs, 202, 3, silentLogger), false);
    assert.equal(installed(), "1.0.1");
    assert.equal(probationExited(dirs, 203, 3, silentLogger), true);
    assert.equal(installed(), "1.0.0");
    assert.equal(readUpgradeState(dirs).failed?.version, "1.0.1");
  });

  test("a run that stays connected ends the probation; a stop on purpose does not count; another version drops it", () => {
    const a = placed("1.0.0", "1.0.1");
    probationStart(a.dirs, "1.0.1", 301, 3, silentLogger);
    probationForget(a.dirs, "1.0.1", 301);
    assert.deepEqual(readUpgradeState(a.dirs).probation?.runs, []);
    probationStart(a.dirs, "1.0.1", 302, 3, silentLogger);
    probationPassed(a.dirs, "1.0.1", silentLogger);
    assert.equal(readUpgradeState(a.dirs).probation, undefined);
    for (const pid of [303, 304, 305, 306]) assert.equal(probationStart(a.dirs, "1.0.1", pid, 3, silentLogger), "none");
    assert.equal(a.installed(), "1.0.1");
    const b = placed("1.0.0", "1.0.1");
    assert.equal(probationStart(b.dirs, "1.0.7", 401, 3, silentLogger), "none", "installed by hand meanwhile");
    assert.equal(readUpgradeState(b.dirs).probation, undefined);
  });

  test("a kill between the two renames of the swap (no package in place): the old version comes back at the first exit seen, the upgrading run's own too", () => {
    const { dirs, pkgDir, installed } = placed("1.0.0", "1.0.1");
    fs.rmSync(pkgDir, { recursive: true });
    assert.equal(probationExited(dirs, 1, 3, silentLogger), true);
    assert.equal(installed(), "1.0.0");
    assert.equal(readUpgradeState(dirs).failed?.version, "1.0.1");
  });

  test("auto-upgrade off given after the run ended to upgrade, before the swap: performUpgrade moves nothing", async () => {
    const home = tmpdir();
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv);
    fs.mkdirSync(dirs.config, { recursive: true });
    fs.writeFileSync(path.join(dirs.config, "agents.toml"), "auto_upgrade = false\n");
    const prefix = tmpdir();
    const pkgDir = path.join(prefix, "lib", "node_modules", "@primusclaw", "connector");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@primusclaw/connector", version: "1.0.0" }));
    const sp = tmpdir();
    const spkg = path.join(sp, "pkg");
    fs.mkdirSync(spkg);
    fs.writeFileSync(path.join(spkg, "package.json"), JSON.stringify({ name: "@primusclaw/connector", version: "1.0.1" }));
    const layout: Layout = { pkgDir, prefix, cli: path.join(pkgDir, "dist", "cli.js"), node: process.execPath, npm: ["npm"], npmShown: "npm" };
    for (const env of [{}, { CLAW_CONNECTOR_AUTO_UPGRADE: "0" }] as NodeJS.ProcessEnv[]) {
      if ("CLAW_CONNECTOR_AUTO_UPGRADE" in env) writeConfigSetting(dirs, true);
      fs.mkdirSync(spkg, { recursive: true });
      fs.writeFileSync(path.join(spkg, "package.json"), JSON.stringify({ name: "@primusclaw/connector", version: "1.0.1" }));
      const r = await performUpgrade({ layout, from: "1.0.0", to: "1.0.1", staged: { version: "1.0.1", prefix: sp, pkgDir: spkg }, dirs, env, log: silentLogger, timing: upgradeTiming({}), signal: new AbortController().signal });
      assert.equal(r.outcome, "off", JSON.stringify(env));
      assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version, "1.0.0");
      assert.equal(readUpgradeState(dirs).probation, undefined);
      assert.ok(!fs.existsSync(path.join(prefix, "lib", "node_modules", "@primusclaw", ".connector-backup-1.0.0")), "nothing moved aside");
      assert.ok(!fs.existsSync(sp), "the download goes");
    }
  });

  test("a run that cannot be counted (auto-upgrade.json cannot be written) never runs uncounted: the old version comes back", () => {
    const a = placed("1.0.0", "1.0.1");
    unwritableState(a.dirs);
    assert.equal(probationStart(a.dirs, "1.0.1", 501, 3, silentLogger), "rolled_back");
    assert.equal(a.installed(), "1.0.0");
    const b = placed("1.0.0", "1.0.1");
    unwritableState(b.dirs);
    assert.equal(probationExited(b.dirs, 601, 3, silentLogger), true);
    assert.equal(b.installed(), "1.0.0");
  });

  test("a run counts itself before anything else it does: one with no usable configuration still counts, and the fourth puts the old version back", async () => {
    const home = tmpdir();
    const { dirs, installed } = placed("1.0.0", VERSION, home);
    const c: Ctx = { dirs, env: {}, out: () => {}, err: () => {}, hostname: "box" };
    // No agents.toml, no sign-in: the run ends at once, as a version that fails before it connects would.
    assert.equal(await main(["run", "--supervised"], c), EXIT.needsPerson);
    assert.deepEqual(readUpgradeState(dirs).probation?.runs, [process.pid]);
    writeUpgradeState(dirs, { ...readUpgradeState(dirs), probation: { ...readUpgradeState(dirs).probation!, runs: [11, 12, 13] } });
    assert.equal(await main(["run", "--supervised"], c), EXIT.upgraded);
    assert.equal(installed(), "1.0.0");
    assert.equal(readUpgradeState(dirs).failed?.version, VERSION);
  });

  describe("proving itself", () => {
    const fakeRun = () => {
      let open!: () => void;
      const c = { connected: new Promise<void>((r) => { open = r; }), connectedSince: null as number | null };
      return { c, up: () => { c.connectedSince = Date.now(); open(); }, down: () => { c.connectedSince = null; } };
    };
    test("connected without a break for the probation time; a drop starts the time again", async () => {
      const r = fakeRun();
      let passed = 0;
      let late = 0;
      const w = watchProbation(r.c, { trialMs: 2_000, probationMs: 400 }, { passed: () => passed++, late: () => late++ });
      r.up();
      await sleep(250);
      r.down();
      await sleep(250);
      assert.equal(passed, 0, "dropped before the time was up");
      r.c.connectedSince = Date.now();
      await sleep(250);
      assert.equal(passed, 0, "not counted from the first connection");
      await sleep(400);
      assert.equal(passed, 1);
      assert.equal(late, 0);
      assert.equal(w.late, false);
      w.dispose();
    });
    test("connected once, then the stream dropped and never came back: late after the trial time, never passed", async (t) => {
      const r = fakeRun();
      let passed = 0;
      let late = 0;
      const w = watchProbation(r.c, { trialMs: 300, probationMs: 5_000 }, { passed: () => passed++, late: () => late++ });
      t.after(() => w.dispose());
      r.up();
      await sleep(100);
      r.down();
      await sleep(150);
      assert.equal(late, 0, "a short drop is not late yet");
      await sleep(400);
      assert.deepEqual([late, passed, w.late], [1, 0, true]);
      r.c.connectedSince = Date.now();
      await sleep(200);
      assert.deepEqual([late, passed], [1, 0], "it ended: a late reconnect changes nothing");
      w.dispose();
    });
    test("each drop has its own trial time: short drops far apart are never late", async (t) => {
      const r = fakeRun();
      let passed = 0;
      let late = 0;
      const w = watchProbation(r.c, { trialMs: 300, probationMs: 5_000 }, { passed: () => passed++, late: () => late++ });
      t.after(() => w.dispose());
      r.up();
      for (let i = 0; i < 3; i++) {
        await sleep(100);
        r.down();
        await sleep(200);
        r.c.connectedSince = Date.now();
        await sleep(300);
      }
      assert.deepEqual([late, passed, w.late], [0, 0, false]);
    });
    test("never connected in time: late, and never passed", async () => {
      const r = fakeRun();
      let passed = 0;
      let late = 0;
      const w = watchProbation(r.c, { trialMs: 200, probationMs: 100 }, { passed: () => passed++, late: () => late++ });
      await sleep(350);
      r.up();
      await sleep(300);
      assert.deepEqual([late, passed, w.late], [1, 0, true]);
      w.dispose();
    });
  });
});
