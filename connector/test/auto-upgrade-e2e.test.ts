// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector upgrading itself, end to end, with real processes: real npm tarballs of this connector (built from this
 * source as four versions) served by a stand-in registry, a real `npm install -g --prefix`, the script supervisor
 * (`claw-connector supervise`) keeping `run --supervised` up, and a stand-in Claw that recommends a version.
 *
 *  1. 1.0.0 is told 1.0.1: it upgrades, the supervisor starts itself again on 1.0.1 (same pid), 1.0.1 connects, the session
 *     hooks that were installed are brought up to date and the approval hooks that were not are not added.
 *  2. 1.0.2 is a broken build (its `run` exits at once): three trials fail, 1.0.1 is put back, 1.0.2 is pinned as failed and
 *     never downloaded again, and the heartbeat says so.
 *  3. With auto-upgrade off nothing is downloaded; turned on, it upgrades to 1.0.3.
 *  4. (as a user who cannot write the prefix) nothing changes, and the heartbeat carries the command that does it by hand.
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

/** One build of this connector as `version`, packed as npm packs it. `broken`: its `run` exits 3 at once (`--version` still answers). */
async function pack(work: string, version: string, broken = false): Promise<{ file: string; manifest: any }> {
  const dir = path.join(work, `connector-${version}`, "package");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  await build({
    entryPoints: ["cli.ts", "terminal-hook.ts", "approval-hook.ts"].map((f) => path.join(root, "src", f)),
    outdir: path.join(dir, "dist"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["@agentclientprotocol/sdk", "smol-toml", "zod"],
    banner: { js: `#!/usr/bin/env node${broken ? `\nif (process.argv[2] === "run") { console.error("broken build"); process.exit(3); }` : ""}` },
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

test("a supervised connector upgrades itself, rolls a broken version back, honours off, and changes nothing where it may not", { timeout: 300_000 }, async (t) => {
  assert.ok(fs.existsSync(npmCli), `npm beside ${node}`);
  const work = tmpdir("cc-upgrade-");
  const registry = await FakeRegistry.start();
  const claw = await FakeClaw.start();
  t.after(async () => { await registry.close(); await claw.close(); });
  for (const [v, broken] of [["1.0.0", false], ["1.0.1", false], ["1.0.2", true], ["1.0.3", false], ["1.0.4", false]] as const) {
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
    CLAW_CONNECTOR_UPGRADE_TIMING: "checkMs=100,idleMs=200,retryMs=3000,trialMs=20000,trialGapMs=100",
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
  // The session hooks, installed by 1.0.0, then one of them lost (an older version's set): the upgrade brings them up to date.
  assert.equal((await cli(pkgDir, ["hooks", "install"], env)).status, 0);
  const settings = path.join(claude, "settings.json");
  const s0 = JSON.parse(fs.readFileSync(settings, "utf8"));
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
  // (by the first run of 1.0.1, as it starts)
  const s1 = await until("the installed session hooks to be brought up to date", () => { const v = JSON.parse(fs.readFileSync(settings, "utf8")); return v.hooks.SessionEnd ? v : null; }, 30_000, log);
  assert.ok(s1.hooks.SessionStart);
  assert.match(fs.readFileSync(log, "utf8"), /brought the Claude Code session hooks in .* up to date/);
  assert.equal(s1.hooks.PermissionRequest, undefined, "hooks that were not installed are not added");

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

  // --- 3: off, then on ----------------------------------------------------------------------------------------------
  assert.equal((await cli(pkgDir, ["auto-upgrade", "off"], env)).status, 0);
  claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.3" };
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
  await until("the supervisor to end after a stop", () => processStart(sup.pid!) === null, 30_000, log);
  const m = claw.heartbeats.length;
  startSupervisor(pkgDir, env, log);
  await until("1.0.1 to say it is off", () => claw.heartbeats.slice(m).find((b) => b.version === "1.0.1" && capsOf(b).auto_upgrade?.state === "off"), 30_000, log);
  await sleep(1500);
  assert.equal(registry.downloads(PKG, "1.0.3"), 0, "nothing is downloaded while it is off");
  assert.equal((await cli(pkgDir, ["auto-upgrade", "on"], env)).status, 0);
  await until("a heartbeat from 1.0.3", () => claw.heartbeats.some((b) => b.version === "1.0.3"), 90_000, log);
  assert.equal(version(pkgDir), "1.0.3");
  const status = JSON.parse((await cli(pkgDir, ["auto-upgrade", "status", "--json"], env)).stdout);
  assert.equal(status.enabled, true);
  assert.equal(status.install.prefix, fs.realpathSync(prefix));

  // --- 4: a prefix this user may not write ------------------------------------------------------------------------------
  if (process.getuid?.() === 0) {
    t.diagnostic("phase 4 needs a user who cannot write the prefix; root can write anything");
  } else {
    await until("the 1.0.3 supervisor", () => /supervisor 1\.0\.3 started/.test(fs.readFileSync(log, "utf8")), 30_000, log);
    const scope = path.dirname(pkgDir);
    fs.chmodSync(scope, 0o555);
    fs.chmodSync(path.join(prefix, "bin"), 0o555);
    t.after(() => { fs.chmodSync(scope, 0o755); fs.chmodSync(path.join(prefix, "bin"), 0o755); });
    claw.connectorVersions = { minimum: "1.0.0", recommended: "1.0.4" };
    assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
    await sleep(500);
    const k = claw.heartbeats.length;
    startSupervisor(pkgDir, env, log);
    const blocked = await until("1.0.3 to say it cannot upgrade", () => claw.heartbeats.slice(k).find((b) => capsOf(b).auto_upgrade?.state === "blocked"), 30_000, log);
    assert.equal(capsOf(blocked).auto_upgrade.reason, "prefix_not_writable");
    const command = capsOf(blocked).auto_upgrade.command as string;
    assert.ok(command.includes(`install -g --prefix ${fs.realpathSync(prefix)} ${PKG}@1.0.4`), command);
    assert.ok(capsOf(blocked).health.problems.some((p: any) => p.code === "connector_upgrade_blocked"));
    await sleep(1000);
    assert.equal(registry.downloads(PKG, "1.0.4"), 0);
    assert.equal(version(pkgDir), "1.0.3");
  }
  assert.equal((await cli(pkgDir, ["stop"], env)).status, 0);
});
