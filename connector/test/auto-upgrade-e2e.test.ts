// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector upgrading itself, end to end, with real processes: real npm tarballs of this connector (built from this
 * source as four versions) served by a stand-in registry, a real `npm install -g --prefix`, the script supervisor
 * (`claw-connector supervise`) keeping `run --supervised` up, and a stand-in Claw that recommends a version.
 *
 *  1. 1.0.0 is told 1.0.1: it upgrades, the supervisor starts itself again on 1.0.1 (same pid), 1.0.1 connects, the session
 *     hooks are brought up to date and the approval hooks the person took out are not added back.
 *  2. 1.0.2 is a broken build (its `run` exits at once): three trials fail, 1.0.1 is put back, 1.0.2 is pinned as failed and
 *     never downloaded again, and the heartbeat says so.
 *  3. 1.0.3 passes its trial but its real run exits at once (before any of its own code runs): the supervisor counts three such
 *     runs, puts 1.0.1 back, starts itself again on it, and 1.0.1 reports 1.0.3 as failed.
 *  4. With auto-upgrade off nothing is downloaded; turned on, the connector is killed outright (SIGKILL, as a service manager
 *     that gave up waiting) while it downloads 1.0.4: 1.0.1 is still in place and works; started again, it upgrades to 1.0.4
 *     and nothing of the killed download is left.
 *  5. Without the script supervisor (as systemd or launchd run it: `run --supervised` started again after a failure), 1.0.5
 *     passes its trial and its real runs fail a moment after they start: the fourth run puts 1.0.4 back by itself.
 *  6. (as a user who cannot write the prefix) nothing changes, and the heartbeat carries the command that does it by hand.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { processStart } from "../src/children.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { FakeRegistry } from "./support/fake-registry.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@primusclaw/connector";
const node = process.execPath;
const npmCli = path.join(path.dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
const running = new Set<ChildProcess>();

/**
 * How a build is broken: `run` exits 3 at once (`run`), only outside a trial run (`real`: before any connector code runs), or
 * a moment after a real run started (`late`). `--version` always answers.
 */
type Broken = "no" | "run" | "real" | "late";
const BANNER: Record<Broken, string> = {
  no: "",
  run: `if (process.argv[2] === "run") { console.error("broken build"); process.exit(3); }`,
  real: `if (process.argv[2] === "run" && !process.env.CLAW_CONNECTOR_UPGRADE_TRIAL) { console.error("broken build"); process.exit(3); }`,
  late: `if (process.argv[2] === "run" && !process.env.CLAW_CONNECTOR_UPGRADE_TRIAL) setTimeout(() => { console.error("broken build"); process.exit(3); }, 1500);`,
};

/** One build of this connector as `version`, packed as npm packs it, broken as `broken` says. */
async function pack(work: string, version: string, broken: Broken = "no"): Promise<{ file: string; manifest: any }> {
  const dir = path.join(work, `connector-${version}`, "package");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  await build({
    entryPoints: ["cli.ts", "terminal-hook.ts", "approval-hook.ts"].map((f) => path.join(root, "src", f)),
    outdir: path.join(dir, "dist"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["@agentclientprotocol/sdk", "smol-toml", "zod"],
    banner: { js: `#!/usr/bin/env node${BANNER[broken] ? `\n${BANNER[broken]}` : ""}` },
    plugins: [{ name: "version", setup: (b) => { b.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({ contents: `export const VERSION = ${JSON.stringify(version)};`, loader: "ts" })); } }],
  });
  for (const f of ["cli.js", "terminal-hook.js", "approval-hook.js"]) fs.chmodSync(path.join(dir, "dist", f), 0o755);
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")), version };
  delete manifest.scripts;
  delete manifest.devDependencies;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  return { file: tar(path.dirname(dir), `connector-${version}.tgz`), manifest };
}

function tar(parent: string, name: string): string {
  const file = path.join(parent, "..", name);
  const r = spawnSync("tar", ["-czf", file, "-C", parent, "package"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return file;
}

/** The connector's own dependencies, packed from node_modules: the registry serves them too, so nothing leaves this machine. */
function packDependency(work: string, name: string): { file: string; manifest: any } {
  const dir = path.join(work, `dep-${name.replace("/", "+")}`, "package");
  fs.cpSync(path.join(root, "node_modules", name), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return { file: tar(path.dirname(dir), `dep-${name.replace("/", "+")}.tgz`), manifest };
}

/** npm, without blocking this process: the stand-in registry it talks to answers from this process's event loop. */
function npm(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(node, [npmCli, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr!.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.once("exit", (status) => { clearTimeout(t); resolve({ status, stderr }); });
  });
}

/** The installed connector's command, without blocking this process (the stand-in Claw answers from its event loop). */
function cli(pkgDir: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(node, [path.join(pkgDir, "dist", "cli.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout!.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    p.stderr!.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    const t = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.once("exit", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}

function startSupervisor(pkgDir: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const fd = fs.openSync(log, "a");
  const p = spawn(node, [path.join(pkgDir, "dist", "cli.js"), "supervise"], { env, detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  running.add(p);
  p.once("exit", () => running.delete(p));
  return p;
}

after(() => {
  for (const p of running) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
});

async function until<T>(what: string, f: () => T | undefined | null | false, ms = 60_000, log?: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${log ? `\n--- log ---\n${fs.readFileSync(log, "utf8").slice(-4000)}` : ""}`);
    await sleep(100);
  }
}

const version = (pkgDir: string): string => JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
const capsOf = (hb: any) => hb.agents[0].capabilities;

test("a supervised connector upgrades itself, rolls a broken version back, survives a kill, honours off, and changes nothing where it may not", { timeout: 540_000 }, async (t) => {
  assert.ok(fs.existsSync(npmCli), `npm beside ${node}`);
  const work = tmpdir("cc-upgrade-");
  const registry = await FakeRegistry.start();
  const claw = await FakeClaw.start();
  t.after(async () => { await registry.close(); await claw.close(); });
  for (const [v, broken] of [["1.0.0", "no"], ["1.0.1", "no"], ["1.0.2", "run"], ["1.0.3", "real"], ["1.0.4", "no"], ["1.0.5", "late"], ["1.0.6", "no"]] as const) {
    const p = await pack(work, v, broken);
    registry.add(p.manifest, p.file);
  }
  for (const dep of ["zod", "smol-toml", "@agentclientprotocol/sdk"]) {
    const p = packDependency(work, dep);
    registry.add(p.manifest, p.file);
  }

  const prefix = path.join(work, "prefix");
  const home = path.join(work, "home");
  const userHome = path.join(work, "user");
  const claude = path.join(userHome, ".claude");
  const log = path.join(work, "supervisor.log");
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(work, "npmrc"), "");
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(node), "/usr/bin", "/bin"].join(path.delimiter), HOME: userHome, TMPDIR: process.env.TMPDIR ?? "/tmp",
    CLAW_CONNECTOR_HOME: home, CLAUDE_CONFIG_DIR: claude,
    npm_config_registry: registry.url, npm_config_cache: path.join(work, "npm-cache"), npm_config_userconfig: path.join(work, "npmrc"),
    npm_config_update_notifier: "false", NO_PROXY: "*", no_proxy: "*",
    CLAW_CONNECTOR_UPGRADE_TIMING: "checkMs=100,idleMs=200,retryMs=3000,trialMs=20000,trialGapMs=100,probationMs=1500",
  };
  const installed = await npm(["install", "-g", "--prefix", prefix, `${PKG}@1.0.0`], env);
  assert.equal(installed.status, 0, installed.stderr);
  const pkgDir = path.join(prefix, "lib", "node_modules", "@primusclaw", "connector");
  assert.equal(version(pkgDir), "1.0.0");

  const workDir = path.join(work, "w");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `name = "upgrade-box"
[[agents]]
id = "fake"
kind = "example"
name = "Fake agent"
command = ${JSON.stringify(node)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
safe_modes = ["default"]
roots = [${JSON.stringify(workDir)}]
`);
  assert.equal((await cli(pkgDir, ["login", "--key", "good-token", "--server", claw.url], env)).status, 0);
  // The hooks, installed by 1.0.0, the approval hooks then taken out by the person, and one session hook lost (an older
  // version's set): every start brings the session hooks up to date, and no start or upgrade adds the approval hooks back.
  assert.equal((await cli(pkgDir, ["hooks", "install"], env)).status, 0);
  assert.equal((await cli(pkgDir, ["hooks", "uninstall", "--approvals"], env)).status, 0);
  const settings = path.join(claude, "settings.json");
  const s0 = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s0.hooks.PermissionRequest, undefined);
  delete s0.hooks.SessionEnd;
  fs.writeFileSync(settings, JSON.stringify(s0, null, 2));

  // --- 1: 1.0.0 -> 1.0.1 ----------------------------------------------------------------------------------------------
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.1" };
  const sup = startSupervisor(pkgDir, env, log);
  await until("1.0.0 to connect", () => claw.heartbeats.some((b) => b.version === "1.0.0"), 30_000, log);
  // The trial run of 1.0.1 is its first heartbeat; from then on Claw recommends the broken 1.0.2 (phase 2).
  await until("a heartbeat from 1.0.1", () => claw.heartbeats.some((b) => b.version === "1.0.1"), 90_000, log);
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.2" };
  assert.equal(version(pkgDir), "1.0.1");
  await until("the supervisor to start itself again on 1.0.1", () => /supervisor 1\.0\.1 started/.test(fs.readFileSync(log, "utf8")), 30_000, log);
  const restarted = fs.readFileSync(log, "utf8").match(/supervisor 1\.0\.1 started \(pid (\d+)\)/);
  assert.equal(Number(restarted?.[1]), sup.pid, "the same supervisor process, now on the new code");
  assert.ok(fs.existsSync(path.join(prefix, "lib", "node_modules", "@primusclaw", ".connector-backup-1.0.0", "dist", "cli.js")), "the old version is kept");
  // (by a start of the connector, without a word to the person beyond one line in the log)
  const s1 = await until("the session hooks to be brought up to date", () => { const v = JSON.parse(fs.readFileSync(settings, "utf8")); return v.hooks.SessionEnd ? v : null; }, 30_000, log);
  assert.ok(s1.hooks.SessionStart);
  assert.match(fs.readFileSync(log, "utf8"), /Claude Code hooks: .*settings\.json: session hooks updated/);
  assert.ok(JSON.stringify(s1.hooks).includes(path.join(pkgDir, "dist", "terminal-hook.js")), "they run the installed connector");
  assert.equal(s1.hooks.PermissionRequest, undefined, "the approval hooks the person took out are not added back by the upgrade");

  // --- 2: the broken 1.0.2 -------------------------------------------------------------------------------------------
  const state = path.join(home, "state", "auto-upgrade.json");
  await until("1.0.2 to be pinned as failed", () => { try { return JSON.parse(fs.readFileSync(state, "utf8")).failed?.version === "1.0.2"; } catch { return false; } }, 120_000, log);
  assert.equal(version(pkgDir), "1.0.1", "1.0.1 is back in place");
  assert.equal((await cli(pkgDir, ["--version"], env)).stdout.trim(), "1.0.1");
  const n = claw.heartbeats.length;
  const told = await until("1.0.1 to say the upgrade failed", () => claw.heartbeats.slice(n).find((b) => b.version === "1.0.1" && capsOf(b).auto_upgrade?.state === "failed"), 60_000, log);
  assert.equal(capsOf(told).auto_upgrade.last.outcome, "rolled_back");
  assert.equal(capsOf(told).auto_upgrade.failed_version, "1.0.2");
  assert.ok(capsOf(told).health.problems.some((p: any) => p.code === "connector_upgrade_failed"));
  assert.equal(registry.downloads(PKG, "1.0.2"), 1);
  await sleep(1500);
  assert.equal(registry.downloads(PKG, "1.0.2"), 1, "a failed version is not tried again");
  assert.match(fs.readFileSync(log, "utf8"), /trial runs failed/);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.PermissionRequest, undefined, "nor by the runs of 1.0.1 since");

  // --- 3: 1.0.3 passes its trial, and its real runs fail before any of its code runs -------------------------------------------
  const scope = path.dirname(pkgDir);
  const n3 = claw.heartbeats.length;
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.3" };
  await until("1.0.3 to pass its trial", () => /upgraded 1\.0\.1 -> 1\.0\.3; exit 79/.test(fs.readFileSync(log, "utf8")), 90_000, log);
  await until("1.0.3 to be pinned as failed", () => { try { return JSON.parse(fs.readFileSync(state, "utf8")).failed?.version === "1.0.3"; } catch { return false; } }, 90_000, log);
  assert.match(fs.readFileSync(log, "utf8"), /supervisor 1\.0\.3 started/);
  assert.equal(fs.readFileSync(log, "utf8").match(/the connector ended \(exit 3\)/g)?.length ?? 0, 2, "two runs of 1.0.3 failed and were started again; the third was the last");
  assert.match(fs.readFileSync(log, "utf8"), /failed \(exit 3\) once too often; the version before it is back/);
  assert.equal(version(pkgDir), "1.0.1", "1.0.1 is back in place");
  const told3 = await until("1.0.1 to say 1.0.3 failed", () => claw.heartbeats.slice(n3).find((b) => b.version === "1.0.1" && capsOf(b).auto_upgrade?.state === "failed" && capsOf(b).auto_upgrade?.failed_version === "1.0.3"), 60_000, log);
  assert.equal(capsOf(told3).auto_upgrade.last.outcome, "rolled_back");
  assert.equal(Number(fs.readFileSync(log, "utf8").match(/supervisor 1\.0\.1 started \(pid (\d+)\)/g)?.at(-1)?.match(/pid (\d+)/)?.[1]), sup.pid, "still the same supervisor process");
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).probation, undefined);
  await sleep(1500);
  assert.equal(registry.downloads(PKG, "1.0.3"), 1, "not tried again");

  // --- 4: off, then on, and killed outright while it downloads --------------------------------------------------------------
  assert.equal((await cli(pkgDir, ["auto-upgrade", "off"], env)).status, 0);
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.4" };
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
  await until("the supervisor to end after a stop", () => processStart(sup.pid!) === null, 30_000, log);
  const m = claw.heartbeats.length;
  const sup4 = startSupervisor(pkgDir, env, log);
  await until("1.0.1 to say it is off", () => claw.heartbeats.slice(m).find((b) => b.version === "1.0.1" && capsOf(b).auto_upgrade?.state === "off"), 30_000, log);
  await sleep(1500);
  assert.equal(registry.downloads(PKG, "1.0.4"), 0, "nothing is downloaded while it is off");
  registry.hold(PKG, "1.0.4");
  assert.equal((await cli(pkgDir, ["auto-upgrade", "on"], env)).status, 0);
  await until("the download of 1.0.4 to start", () => registry.downloads(PKG, "1.0.4") === 1, 60_000, log);
  const stages = () => fs.readdirSync(scope).filter((x) => x.startsWith(".connector-stage-"));
  assert.equal(stages().length, 1);
  process.kill(-sup4.pid!, "SIGKILL");
  await until("the killed supervisor to be gone", () => processStart(sup4.pid!) === null, 10_000, log);
  assert.equal(version(pkgDir), "1.0.1", "the live install was never touched");
  assert.equal((await cli(pkgDir, ["--version"], env)).stdout.trim(), "1.0.1");
  // The npm the killed run started is not in its process group (as it would be in a service's cgroup): it finishes into the
  // directory nobody owns any more.
  registry.release(PKG, "1.0.4");
  const left = path.join(scope, stages()[0]!);
  await until("the orphaned download to finish", () => fs.existsSync(path.join(left, "lib", "node_modules", "@primusclaw", "connector", "package.json")), 60_000, log);
  await sleep(1000);
  startSupervisor(pkgDir, env, log);
  await until("a heartbeat from 1.0.4", () => claw.heartbeats.some((b) => b.version === "1.0.4"), 90_000, log);
  await until("the 1.0.4 supervisor", () => /supervisor 1\.0\.4 started/.test(fs.readFileSync(log, "utf8")), 30_000, log);
  assert.equal(version(pkgDir), "1.0.4");
  assert.ok(!fs.existsSync(left), "the killed run's download is gone");
  assert.deepEqual(stages(), []);
  const status = JSON.parse((await cli(pkgDir, ["auto-upgrade", "status", "--json"], env)).stdout);
  assert.equal(status.enabled, true);
  assert.equal(status.install.prefix, fs.realpathSync(prefix));

  // --- 5: as systemd runs it, a version whose real runs fail a moment after they start ---------------------------------------
  await until("1.0.4 to pass its probation", () => { try { return JSON.parse(fs.readFileSync(state, "utf8")).probation === undefined; } catch { return false; } }, 30_000, log);
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
  await sleep(500);
  const exits: Array<number | null> = [];
  let looping = true;
  const unit = (async () => {
    // Restart=on-failure, RestartPreventExitStatus=78: what the systemd unit says (service.ts), with a short RestartSec.
    while (looping) {
      const fd = fs.openSync(log, "a");
      const p = spawn(node, [path.join(pkgDir, "dist", "cli.js"), "run", "--supervised"], { env, detached: true, stdio: ["ignore", fd, fd] });
      fs.closeSync(fd);
      running.add(p);
      const code = await new Promise<number | null>((ok) => p.once("exit", (c) => ok(c)));
      running.delete(p);
      exits.push(code);
      if (code === 0 || code === 78) return;
      await sleep(300);
    }
  })();
  const n5 = claw.heartbeats.length;
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.5" };
  await until("1.0.5 to be pinned as failed", () => { try { return JSON.parse(fs.readFileSync(state, "utf8")).failed?.version === "1.0.5"; } catch { return false; } }, 120_000, log);
  const told5 = await until("1.0.4 to say 1.0.5 failed", () => claw.heartbeats.slice(n5).find((b) => b.version === "1.0.4" && capsOf(b).auto_upgrade?.state === "failed" && capsOf(b).auto_upgrade?.failed_version === "1.0.5"), 60_000, log);
  assert.equal(capsOf(told5).auto_upgrade.last.outcome, "rolled_back");
  assert.equal(version(pkgDir), "1.0.4");
  assert.deepEqual(exits, [79, 3, 3, 3, 79], "upgraded; three real runs of 1.0.5 failed; the fourth put 1.0.4 back");
  assert.ok(claw.heartbeats.slice(n5).some((b) => b.version === "1.0.5"), "1.0.5 did connect (its trial, and its real runs before they failed)");
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
  looping = false;
  await unit;
  assert.equal(exits.at(-1), 0);

  // --- 6: a prefix this user may not write ------------------------------------------------------------------------------
  if (process.getuid?.() === 0) {
    t.diagnostic("phase 6 needs a user who cannot write the prefix; root can write anything");
  } else {
    fs.chmodSync(scope, 0o555);
    fs.chmodSync(path.join(prefix, "bin"), 0o555);
    t.after(() => { fs.chmodSync(scope, 0o755); fs.chmodSync(path.join(prefix, "bin"), 0o755); });
    claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.6" };
    const k = claw.heartbeats.length;
    startSupervisor(pkgDir, env, log);
    const blocked = await until("1.0.4 to say it cannot upgrade", () => claw.heartbeats.slice(k).find((b) => capsOf(b).auto_upgrade?.state === "blocked"), 30_000, log);
    assert.equal(capsOf(blocked).auto_upgrade.reason, "prefix_not_writable");
    const command = capsOf(blocked).auto_upgrade.command as string;
    assert.ok(command.includes(`install -g --prefix ${fs.realpathSync(prefix)} ${PKG}@1.0.6`), command);
    assert.ok(capsOf(blocked).health.problems.some((p: any) => p.code === "connector_upgrade_blocked"));
    await sleep(1000);
    assert.equal(registry.downloads(PKG, "1.0.6"), 0);
    assert.equal(version(pkgDir), "1.0.4");
  }
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
});
