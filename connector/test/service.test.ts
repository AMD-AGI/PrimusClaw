// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `service`, `supervise`, exit 78 and the disconnect record: what keeps a connector up, and what keeps it down. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { main, EXIT, type Ctx } from "../src/commands.js";
import { needsLogin, recentDisconnects } from "../src/health.js";
import { keepaliveFile, needsLoginFile, pidFile, resolveDirs, serviceEnvFile, supervisorPidFile } from "../src/paths.js";
import { accountName, carriedEnv, codexEnvKeys, cronLines, ephemeralWhere, launchdPlist, readMounts, supervise, systemdUnit, withThreadPool, type ExecResult, type ServiceDeps } from "../src/service.js";
import { FakeClaw } from "./support/fake-claw.js";
import { isDefinitiveRefusal } from "../src/connector.js";
import { HttpError } from "../src/claw-client.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

function ctx(home: string, extra: Partial<Ctx> = {}, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config"), ...env }, out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", ...extra };
  return { c, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const writeConfig = (home: string, work: string) => {
  fs.mkdirSync(path.join(home, "config"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `
[[agents]]
id = "fake"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
roots = [${JSON.stringify(work)}]
`);
};

/** A stand-in for systemctl / launchctl / loginctl that records every call. */
function fakeExec(answers: Record<string, ExecResult> = {}) {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]): ExecResult => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    for (const [k, v] of Object.entries(answers)) if (line.startsWith(k)) return v;
    return { code: 0, out: "" };
  };
  return { calls, exec };
}

/** A process recorded as this home's script supervisor (pid and start time, as `supervise` records itself) that ends on SIGTERM. */
async function fakeSupervisor(home: string, code = "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)") {
  const p = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
  const { processStart } = await import("../src/children.js");
  let start: string | null = null;
  for (let i = 0; i < 50 && !start; i++) { start = processStart(p.pid!); if (!start) await new Promise((r) => setTimeout(r, 20)); }
  const dirs = ctx(home).c.dirs;
  fs.mkdirSync(dirs.state, { recursive: true });
  fs.writeFileSync(supervisorPidFile(dirs), JSON.stringify({ pid: p.pid, start }));
  return p;
}

/** Whether a child process has ended (within 5 s). */
async function exited(p: ReturnType<typeof spawn>): Promise<boolean> {
  if (p.exitCode !== null || p.signalCode !== null) return true;
  return await Promise.race([new Promise<boolean>((r) => p.once("exit", () => r(true))), new Promise<boolean>((r) => setTimeout(() => r(false), 5_000))]);
}

const D = (over: Partial<ServiceDeps> = {}): Partial<ServiceDeps> => {
  const cli = path.join(tmpdir("cli-"), "cli.js");
  fs.writeFileSync(cli, "");
  return { platform: "linux", uid: 1000, user: "me", node: "/usr/bin/node", cli, systemdBooted: () => true, readCrontab: () => null, writeCrontab: () => false, ...over };
};

describe("a run the service starts has a thread pool a stalled disk cannot fill", () => {
  // The pool size must be in the environment before node starts: the ES module loader starts the pool (four threads)
  // before any line of the program runs, so setting it from inside the program does nothing.
  const probe = path.join(path.dirname(new URL(import.meta.url).pathname), "support", "pool-probe.mjs");
  const lookupMs = async (env: NodeJS.ProcessEnv): Promise<string> => {
    const dir = tmpdir("fifo-");
    const fifos = Array.from({ length: 6 }, (_, i) => path.join(dir, `f${i}`));
    for (const f of fifos) assert.equal(spawnSync("mkfifo", ["-m", "600", f]).status, 0, `mkfifo ${f}`);
    const p = spawn(process.execPath, [probe, ...fifos], { env, stdio: ["ignore", "pipe", "ignore"] });
    try {
      let out = "";
      p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
      for (let i = 0; i < 100 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 50));
      return out.trim();
    } finally { p.kill("SIGKILL"); }
  };
  const bare = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e.UV_THREADPOOL_SIZE; return e; };

  test("with the environment a run is started with, a DNS lookup still gets a thread while six file calls are stuck", async () => {
    const ms = await lookupMs(withThreadPool(bare()));
    assert.match(ms, /^\d+$/, `the lookup answered (got ${JSON.stringify(ms)})`);
    assert.ok(Number(ms) < 1_000, `in ${ms} ms`);
  });
  test("control: with node's default pool the same lookup is stuck (the probe measures what it claims)", async () => {
    assert.equal(await lookupMs(bare()), "stuck");
  });
  test("the systemd unit, the launchd plist and the supervisor's run all start node with it; a value the user set is kept", async () => {
    const d = { node: "/usr/bin/node", cli: "/x/cli.js" } as ServiceDeps;
    assert.match(systemdUnit(d, [["PATH", "/bin"]]), /^Environment="UV_THREADPOOL_SIZE=16"$/m);
    assert.match(launchdPlist(d, [["PATH", "/bin"]], "/l"), /<key>UV_THREADPOOL_SIZE<\/key><string>16<\/string>/);
    const own = systemdUnit(d, [["UV_THREADPOOL_SIZE", "64"]]);
    assert.match(own, /^Environment="UV_THREADPOOL_SIZE=64"$/m);
    assert.doesNotMatch(own, /UV_THREADPOOL_SIZE=16/);
    const seen = path.join(tmpdir("pool-"), "seen");
    const record = (env: NodeJS.ProcessEnv) => supervise(ctx(tmpdir(), {}, env).c, {
      command: [process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.env.UV_THREADPOOL_SIZE ?? 'unset')", seen]], restartMs: 20,
    });
    assert.equal(await record({}), 0);
    assert.equal(fs.readFileSync(seen, "utf8"), "16");
    assert.equal(await record({ UV_THREADPOOL_SIZE: "8" }), 0);
    assert.equal(fs.readFileSync(seen, "utf8"), "8");
  });
});

describe("the units", () => {
  test("the systemd unit restarts 5 s after any failure but never after 78, starts run --supervised, and keeps $ and % literal", () => {
    const unit = systemdUnit({ node: "/opt/node 22/bin/node", cli: "/x/$HOME/cli.js" } as ServiceDeps, [["PATH", "/a:/b"], ["HTTPS_PROXY", "http://u:p%41$x@h:3128"]]);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^RestartSec=5$/m);
    assert.match(unit, /^RestartPreventExitStatus=78$/m);
    assert.match(unit, /^StartLimitIntervalSec=0$/m);
    // ExecStart= expands $VAR, so `$` is doubled there; Environment= does not, so it is written as is. `%` is doubled in both.
    assert.match(unit, /^ExecStart="\/opt\/node 22\/bin\/node" "\/x\/\$\$HOME\/cli\.js" run --supervised$/m);
    assert.match(unit, /^Environment="HTTPS_PROXY=http:\/\/u:p%%41\$x@h:3128"$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
  });

  test("a proxy URL with a password is withheld unless named with --env", () => {
    const env = { HTTPS_PROXY: "http://u:pw@proxy:3128", https_proxy: "http://u:pw@proxy:3128", HTTP_PROXY: "http://proxy:3128" };
    const plain = carriedEnv(env);
    assert.deepEqual(plain.vars, [["HTTP_PROXY", "http://proxy:3128"]]);
    assert.deepEqual(plain.withheld, ["HTTPS_PROXY", "https_proxy"]);
    const asked = carriedEnv(env, ["HTTPS_PROXY"]);
    assert.deepEqual(asked.vars, [["HTTPS_PROXY", "http://u:pw@proxy:3128"], ["HTTP_PROXY", "http://proxy:3128"]]);
    assert.deepEqual(asked.withheld, ["https_proxy"]);
  });

  test("a unit gets the listed variables and the agents' plain settings; never a credential, which goes to service-env.json; never the connector's key", () => {
    const env = {
      PATH: "/bin", CLAW_CONNECTOR_KEY: "ak-secret", ANTHROPIC_API_KEY: "sk", FOO: "1", GH_TOKEN: "t", BAR: "2",
      ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_MODEL: "m", IS_SANDBOX: "1", OPENAI_API_KEY: "ok", MY_GW_KEY: "g",
      npm_config_registry: "https://npm.example", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: h",
    };
    const c = carriedEnv(env, ["FOO", "GH_TOKEN", "CLAW_CONNECTOR_KEY"], ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "OPENAI_API_KEY", "MY_GW_KEY"]);
    assert.deepEqual(new Map(c.vars), new Map([["PATH", "/bin"], ["IS_SANDBOX", "1"], ["npm_config_registry", "https://npm.example"], ["ANTHROPIC_BASE_URL", "https://gw.example"], ["ANTHROPIC_MODEL", "m"], ["CLAUDE_CODE_USE_BEDROCK", "1"], ["FOO", "1"]]));
    assert.deepEqual(new Map(c.secrets), new Map([["ANTHROPIC_API_KEY", "sk"], ["ANTHROPIC_CUSTOM_HEADERS", "x-api-key: h"], ["OPENAI_API_KEY", "ok"], ["MY_GW_KEY", "g"], ["GH_TOKEN", "t"]]));
    assert.deepEqual(c.refused, ["CLAW_CONNECTOR_KEY"]);
    assert.ok(!c.vars.some(([k]) => k === "BAR"), "an unrelated variable is not carried unless asked for");
    const u = carriedEnv({ ANTHROPIC_BASE_URL: "https://user:pw@gw.example", npm_config_registry: "https://tok@npm.example/" });
    assert.deepEqual(u.vars, [], "a URL with a user name or password in it never goes into a unit");
    assert.deepEqual(new Map(u.secrets), new Map([["ANTHROPIC_BASE_URL", "https://user:pw@gw.example"], ["npm_config_registry", "https://tok@npm.example/"]]));
  });

  test("a config directory of this account's that others may write (umask 0002) is closed to them before the sign-in goes in", async () => {
    for (const mode of [0o775, 0o777]) {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
      fs.chmodSync(path.join(home, "config"), mode);
      const a = ctx(home, { service: { ...D(), exec: fakeExec({ "systemctl --user is-active": { code: 0, out: "active" } }).exec } }, { XDG_CONFIG_HOME: tmpdir("xdg-"), ANTHROPIC_API_KEY: "sk-x" });
      assert.equal(await main(["service", "install", "--supervisor", "systemd"], a.c), EXIT.ok, a.errText());
      assert.equal(fs.statSync(path.join(home, "config")).mode & 0o777, 0o700, mode.toString(8));
      const fd = fs.openSync(serviceEnvFile(a.c.dirs), "r");
      try { assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600); } finally { fs.closeSync(fd); }
    }
  });

  test("a config directory that is a link is not written through", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const elsewhere = tmpdir("elsewhere-");
    const linked = path.join(tmpdir("cfg-"), "claw-connector");
    fs.symlinkSync(elsewhere, linked);
    const { writeSecretFile } = await import("../src/service.js");
    assert.throws(() => writeSecretFile(path.join(linked, "service-env.json"), "{}"), /a link is not followed/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test("a config directory swapped for a link after the check does not redirect the chmod or the write (Linux)", { skip: !fs.existsSync("/proc/self/fd") }, async () => {
    const { writeSecretFile } = await import("../src/service.js");
    const parent = tmpdir("swap-");
    const dir = path.join(parent, "claw-connector");
    const victim = tmpdir("victim-");
    fs.mkdirSync(dir, { mode: 0o775 });
    fs.chmodSync(dir, 0o775);
    fs.chmodSync(victim, 0o755);
    // Someone who may rename entries in the parent swaps the directory for a link between the check and the write.
    const real = fs.fchmodSync;
    let swapped = false;
    (fs as { fchmodSync: typeof fs.fchmodSync }).fchmodSync = (fd, mode) => {
      if (!swapped) { swapped = true; fs.renameSync(dir, path.join(parent, "moved")); fs.symlinkSync(victim, dir); }
      return real(fd, mode);
    };
    try { writeSecretFile(path.join(dir, "service-env.json"), "{\"K\":\"v\"}\n"); } finally { (fs as { fchmodSync: typeof fs.fchmodSync }).fchmodSync = real; }
    assert.ok(swapped);
    assert.deepEqual(fs.readdirSync(victim), [], "nothing written through the link");
    assert.equal(fs.statSync(victim).mode & 0o777, 0o755, "the link's target was not chmod-ed");
    assert.deepEqual(fs.readdirSync(path.join(parent, "moved")), ["service-env.json"], "written into the directory that was checked");
    assert.equal(fs.statSync(path.join(parent, "moved")).mode & 0o777, 0o700);
  });

  test("where a directory cannot be written through its descriptor (macOS), a path others could change on the way is refused", async () => {
    const { renamableAncestor } = await import("../src/service.js");
    const top = tmpdir("anc-");
    const open = path.join(top, "open");
    fs.mkdirSync(path.join(open, "cfg"), { recursive: true });
    fs.chmodSync(open, 0o777);
    assert.equal(renamableAncestor(path.join(open, "cfg")), open, "a world-writable parent without the sticky bit");
    fs.chmodSync(open, 0o1777);
    assert.equal(renamableAncestor(path.join(open, "cfg")), null, "sticky, like /tmp: others cannot rename our entries");
    fs.chmodSync(open, 0o755);
    assert.equal(renamableAncestor(path.join(open, "cfg")), null);
    // A link on the way is refused even when everything it points through is safe.
    const via = path.join(top, "via");
    fs.symlinkSync(open, via);
    assert.equal(renamableAncestor(path.join(via, "cfg")), via);
    let chowned = false;
    try { fs.chownSync(open, 4242, 4242); chowned = true; } catch { /* not root, or a user namespace that cannot map 4242 */ }
    if (chowned) assert.equal(renamableAncestor(path.join(open, "cfg"), process.getuid?.() === 0 ? 0 : 4243), open, "a parent owned by another account (not root)");
  });

  test("without /proc/self/fd (macOS), a config path that leads through a link into a directory others may write is refused", async () => {
    const { writeSecretFile } = await import("../src/service.js");
    const top = tmpdir("mac-");
    const open = path.join(top, "open");
    fs.mkdirSync(path.join(open, "cfg"), { recursive: true });
    fs.chmodSync(open, 0o777);
    fs.mkdirSync(path.join(top, "safe"), { mode: 0o755 });
    fs.symlinkSync(open, path.join(top, "safe", "link"));
    const real = fs.existsSync;
    (fs as { existsSync: typeof fs.existsSync }).existsSync = (p) => (String(p).startsWith("/proc/self/fd/") ? false : real(p));
    try {
      assert.throws(() => writeSecretFile(path.join(top, "safe", "link", "cfg", "service-env.json"), "{}"), /can be changed by other accounts/);
      fs.chmodSync(open, 0o755);
      writeSecretFile(path.join(top, "safe", "link", "cfg", "service-env.json"), "{}");
      assert.deepEqual(fs.readdirSync(path.join(open, "cfg")), ["service-env.json"]);
    } finally { (fs as { existsSync: typeof fs.existsSync }).existsSync = real; }
  });

  test("a cron daemon counts only in this container's own mount namespace (hostPID shows the host's)", async () => {
    const { cronDaemonRunning } = await import("../src/service.js");
    const proc = tmpdir("proc-");
    const mk = (pid: string, comm: string, ns: string) => {
      fs.mkdirSync(path.join(proc, pid, "ns"), { recursive: true });
      fs.writeFileSync(path.join(proc, pid, "comm"), comm + "\n");
      fs.writeFileSync(path.join(proc, pid, "cmdline"), `/usr/sbin/${comm}\0-f`);
      fs.symlinkSync(ns, path.join(proc, pid, "ns", "mnt"));
    };
    mk("self", "node", "mnt:[100]");
    mk("2000", "cron", "mnt:[1]");
    assert.equal(cronDaemonRunning(proc), false, "the host's cron, seen through hostPID");
    mk("42", "crond", "mnt:[100]");
    assert.equal(cronDaemonRunning(proc), true);
  });

  test("a crontab that cannot be written is said as such, with the lines, not as a machine without cron", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    await fakeSupervisor(home);
    const a = ctx(home, { service: { ...D({ systemdBooted: () => false, node: process.execPath }), readCrontab: () => "", writeCrontab: () => false } }, { PATH: "/bin" });
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    assert.match(a.errText(), /could not write your crontab/);
    assert.match(a.errText(), /\*\/5 \* \* \* \* sh .*keepalive\.sh/);
    assert.doesNotMatch(a.text(), /No cron daemon runs here/);
    fs.rmSync(supervisorPidFile(a.c.dirs), { force: true });
  });

  test("the container-home note reads only the mount table, never a mount itself", () => {
    const mounts = readMounts("100 1 0:50 / / rw - overlay overlay rw\n101 100 0:60 / /mnt/never-answers rw - nfs4 host:/x rw\n");
    const realAccess = fs.accessSync;
    const realReal = fs.realpathSync;
    (fs as { accessSync: unknown }).accessSync = () => { throw new Error("a stalled mount was touched"); };
    (fs as { realpathSync: unknown }).realpathSync = () => { throw new Error("a stalled mount was touched"); };
    try {
      assert.match(ephemeralWhere("/root/.config/claw-connector", mounts) ?? "", /\/mnt\/never-answers/);
    } finally { (fs as { accessSync: unknown }).accessSync = realAccess; (fs as { realpathSync: unknown }).realpathSync = realReal; }
  });

  test("a terminal's own session variables, and a value that spans lines, are not carried", () => {
    const c = carriedEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1", CLAUDE_CODE_SESSION_ID: "s", CODEX_SANDBOX: "seatbelt", CODEX_THREAD_ID: "t",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", ANTHROPIC_MODEL: "a\nb" });
    assert.deepEqual(c.vars, [["PATH", "/bin"], ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "8000"]], "a count of tokens is a setting, not a secret");
    assert.deepEqual(c.secrets, []);
    assert.deepEqual(c.withheld, ["ANTHROPIC_MODEL"]);
  });

  test("Codex's env_key names count as the agents' sign-in variables", async () => {
    const home = tmpdir("ch-");
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw"\nenv_key = "GW_TOKEN_X"\n`);
    assert.deepEqual(await codexEnvKeys({}, home), ["GW_TOKEN_X"]);
    assert.deepEqual(await codexEnvKeys({ CODEX_HOME: path.join(home, "nope") }, home), []);
  });

  test("a uid with no passwd entry still gets a name (os.userInfo throws ENOENT there)", () => {
    const throws = () => { throw Object.assign(new Error("ENOENT: no such file or directory, uv_os_get_passwd"), { code: "ENOENT" }); };
    assert.equal(accountName({}, 4242, throws), "4242");
    assert.equal(accountName({ LOGNAME: "me" }, 4242, throws), "me");
    assert.equal(accountName({ USER: "u" }, 4242, throws), "u");
  });
});

describe("service install / uninstall / status", () => {
  test("install refuses with 78 until there is a config and a sign-in, and after a revocation until login", async () => {
    const home = tmpdir();
    const f = fakeExec();
    const a = ctx(home, { service: { ...D(), exec: f.exec } });
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], a.c), EXIT.needsPerson);
    assert.match(a.errText(), /agents\.toml/);
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    fs.mkdirSync(a.c.dirs.state, { recursive: true });
    fs.writeFileSync(needsLoginFile(a.c.dirs), JSON.stringify({ at: "t", reason: "this connector was revoked" }));
    const b = ctx(home, { service: { ...D(), exec: f.exec } });
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], b.c), EXIT.needsPerson);
    assert.match(b.errText(), /revoked/);
    assert.deepEqual(f.calls, [], "nothing was installed");
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    assert.equal(needsLogin(b.c.dirs), null, "login clears the mark");
  });

  test("systemd: writes the unit under XDG_CONFIG_HOME, enables and (re)starts it, hints linger, carries PATH but not the key; uninstall removes it", async () => {
    const home = tmpdir();
    const xdg = tmpdir("xdg-");
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const f = fakeExec({ "systemctl --user is-system-running": { code: 1, out: "degraded" }, "systemctl --user is-active": { code: 0, out: "active" }, "loginctl show-user": { code: 0, out: "no" } });
    const env = { XDG_CONFIG_HOME: xdg, PATH: "/usr/local/bin:/usr/bin", CLAW_CONNECTOR_HOME: home, CLAW_CONNECTOR_KEY: "ak-must-not-leak" };
    const a = ctx(home, { service: { ...D(), exec: f.exec } }, env);
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    const unit = path.join(xdg, "systemd", "user", "claw-connector.service");
    const body = fs.readFileSync(unit, "utf8");
    assert.equal(fs.statSync(unit).mode & 0o777, 0o600);
    assert.match(body, /Environment="PATH=\/usr\/local\/bin:\/usr\/bin"/);
    assert.match(body, /Environment="CLAW_CONNECTOR_HOME=/);
    assert.doesNotMatch(body, /ak-must-not-leak|CLAW_CONNECTOR_KEY/);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("systemctl")), [
      "systemctl --user is-system-running", "systemctl --user daemon-reload", "systemctl --user enable claw-connector.service", "systemctl --user restart claw-connector.service",
      "systemctl --user is-active claw-connector.service",
    ]);
    assert.match(a.text(), /loginctl enable-linger me/);
    const s = ctx(home, { service: { ...D(), exec: fakeExec({ "systemctl --user is-active": { code: 0, out: "active" } }).exec } }, env);
    await main(["service", "status"], s.c);
    assert.match(s.text(), /service: +systemd \(active\)/);
    const u = ctx(home, { service: { ...D(), exec: f.exec } }, env);
    assert.equal(await main(["service", "uninstall"], u.c), EXIT.ok);
    assert.equal(fs.existsSync(unit), false);
    assert.ok(f.calls.includes("systemctl --user disable --now claw-connector.service"));
  });

  test("a failing systemctl is reported and fails the install", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const f = fakeExec({ "systemctl --user enable": { code: 1, out: "Failed to connect to bus" } });
    const a = ctx(home, { service: { ...D(), exec: f.exec } }, { XDG_CONFIG_HOME: tmpdir("xdg-") });
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], a.c), EXIT.failure);
    assert.match(a.errText(), /Failed to connect to bus/);
  });

  test("a unit systemctl accepted but that is not active fails the install; a booted systemd whose user manager is offline means script", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const f = fakeExec({ "systemctl --user is-active": { code: 3, out: "failed" } });
    const a = ctx(home, { service: { ...D(), exec: f.exec } }, { XDG_CONFIG_HOME: tmpdir("xdg-") });
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], a.c), EXIT.failure);
    assert.match(a.errText(), /did not start \(is-active: failed\)/);
    // The unit is enabled even though its first run failed (say, exit 78): a later login must find it to restart.
    f.calls.length = 0;
    await main(["login", "--server", "https://claw.example", "--key", "k2"], ctx(home, { service: { ...D(), exec: f.exec } }).c);
    assert.deepEqual(f.calls, ["systemctl --user restart claw-connector.service"]);
    const { detectSupervisor } = await import("../src/service.js");
    assert.equal(detectSupervisor({ ...(D() as ServiceDeps), exec: fakeExec({ "systemctl --user is-system-running": { code: 1, out: "offline" } }).exec }), "script");
    assert.equal(detectSupervisor({ ...(D({ platform: "darwin" }) as ServiceDeps), exec: fakeExec().exec }), "launchd");
  });

  test("login after a revocation starts the installed service again (systemd: restart; launchd: kickstart); with none installed it touches nothing", async () => {
    for (const [sup, want] of [["systemd", "systemctl --user restart claw-connector.service"], ["launchd", "launchctl kickstart -k gui/1000/com.primusclaw.connector"]] as const) {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      const f = fakeExec({ "systemctl --user is-active": { code: 0, out: "active" } });
      const svc = { ...D({ platform: sup === "launchd" ? "darwin" : "linux", home: tmpdir("home-") }), exec: f.exec };
      await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home, { service: svc }).c);
      assert.equal(await main(["service", "install", "--supervisor", sup], ctx(home, { service: svc }, { XDG_CONFIG_HOME: tmpdir("xdg-") }).c), EXIT.ok);
      const c = ctx(home).c;
      fs.writeFileSync(needsLoginFile(c.dirs), JSON.stringify({ at: "t", reason: "this connector was revoked" }));
      f.calls.length = 0;
      const l = ctx(home, { service: svc });
      assert.equal(await main(["login", "--server", "https://claw.example", "--key", "k2"], l.c), EXIT.ok);
      assert.deepEqual(f.calls, [want]);
      assert.match(l.text(), new RegExp(`started the ${sup} service again`));
    }
    const other = tmpdir();
    const f = fakeExec();
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(other, { service: { ...D(), exec: f.exec } }).c);
    assert.deepEqual(f.calls, [], "no service.json in this state directory: nothing to start");
  });

  test("the keep-alive check starts nothing while only a person can help: signed out, no config", async () => {
    const home = tmpdir();
    const a = ctx(home, { service: D() });
    assert.equal(await main(["service", "ensure"], a.c), EXIT.needsPerson);
    assert.match(a.errText(), /not starting: .*agents\.toml/);
    writeConfig(home, tmpdir("w-"));
    const b = ctx(home, { service: D() });
    assert.equal(await main(["service", "ensure"], b.c), EXIT.needsPerson);
    assert.match(b.errText(), /not starting: not signed in/);
    assert.equal(fs.existsSync(supervisorPidFile(b.c.dirs)), false);
  });

  test("launchd: a LaunchAgent that restarts any unclean exit and tells run it is under launchd", async () => {
    const home = tmpdir();
    const userHome = tmpdir("home-");
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const f = fakeExec();
    const a = ctx(home, { service: { ...D({ platform: "darwin", home: userHome }), exec: f.exec } }, { PATH: "/opt/homebrew/bin:/usr/bin" });
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    const plist = fs.readFileSync(path.join(userHome, "Library", "LaunchAgents", "com.primusclaw.connector.plist"), "utf8");
    assert.equal(fs.statSync(path.join(userHome, "Library", "LaunchAgents", "com.primusclaw.connector.plist")).mode & 0o777, 0o600, "proxy URLs in it may carry a password");
    assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
    assert.match(plist, /<key>CLAW_CONNECTOR_SUPERVISOR<\/key><string>launchd<\/string>/);
    assert.match(plist, /<string>run<\/string><string>--supervised<\/string>/);
    assert.ok(f.calls.some((c) => c.startsWith("launchctl bootstrap gui/1000 ")));
  });

  test("script: writes an executable keep-alive script with the environment and prints the @reboot and */5 lines", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    // A supervisor that is already alive: install stops it and starts one again (as systemctl restart does), so that an
    // edited agents.toml or environment is read. The new one runs an empty cli.js, which ends at once.
    const old = await fakeSupervisor(home);
    // What this very container answers: systemctl exits 0 and does nothing, and there is no /run/systemd/system.
    const chroot = fakeExec({ "systemctl": { code: 0, out: "Running in chroot, ignoring command 'is-system-running'" } });
    const a = ctx(home, { service: { ...D({ systemdBooted: () => false, node: process.execPath }), exec: chroot.exec } }, { PATH: "/bin" });
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    assert.equal(await exited(old), true, "the supervisor that was running was stopped");
    assert.match(a.text(), new RegExp(`stopped the running supervisor \\(pid ${old.pid}\\)`));
    assert.match(a.text(), /started the supervisor \(pid \d+\)/);
    const script = keepaliveFile(a.c.dirs);
    const fd = fs.openSync(script, "r");
    const mode = fs.fstatSync(fd).mode & 0o777;
    const body = fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    assert.equal(mode, 0o700);
    assert.match(body, /export PATH='\/bin'/);
    assert.match(body, /service ensure\n$/);
    assert.deepEqual(chroot.calls, [], "systemctl was not even asked");
    // Installing is not "something calls keepalive.sh": doctor must not take the install's own start for a schedule.
    const { keepaliveStampFile } = await import("../src/paths.js");
    assert.equal(fs.existsSync(keepaliveStampFile(a.c.dirs)), false);
    // No cron daemon (the fake's default, and the usual container): said plainly, with the line a startup hook needs.
    assert.match(a.text(), /No cron daemon runs here: after a reboot or a container restart NOTHING starts the connector again/);
    assert.match(a.text(), /^  sh '.*keepalive\.sh' >\/dev\/null 2>&1$/m);
    fs.rmSync(supervisorPidFile(a.c.dirs), { force: true });
  });

  test("script: a stopped supervisor that no parent reaps (a container's PID 1) counts as stopped once its pid file is gone", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    // Stands for the zombie: on SIGTERM it removes its pid file as supervise() does, but the process stays (kill(pid, 0) succeeds).
    const pidf = supervisorPidFile(ctx(home).c.dirs);
    const old = await fakeSupervisor(home, `process.on('SIGTERM', () => require('fs').rmSync(${JSON.stringify(pidf)}, { force: true })); setInterval(() => {}, 1000)`);
    try {
      const a = ctx(home, { service: { ...D({ systemdBooted: () => false, node: process.execPath }), exec: fakeExec().exec } }, { PATH: "/bin" });
      const t0 = Date.now();
      assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
      assert.ok(Date.now() - t0 < 10_000, "not the 20 s wait");
      assert.match(a.text(), /started the supervisor \(pid \d+\)/);
    } finally { old.kill("SIGKILL"); fs.rmSync(pidf, { force: true }); }
  });

  test("script: with no supervisor running, install starts one and stops nothing", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const a = ctx(home, { service: { ...D({ systemdBooted: () => false, node: process.execPath }), exec: fakeExec().exec } }, { PATH: "/bin" });
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    assert.doesNotMatch(a.text(), /stopped the running supervisor/);
    assert.match(a.text(), /started the supervisor \(pid \d+\)/);
    fs.rmSync(supervisorPidFile(a.c.dirs), { force: true });
  });

  test("script: where a cron daemon runs, the two lines go into the crontab once, beside the user's own, and uninstall takes them out", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    await fakeSupervisor(home);
    const script = keepaliveFile(ctx(home).c.dirs);
    let tab = `MAILTO=me\n\n0 3 * * * backup.sh\n# my note about ${script}\n\n`;
    const svc = { ...D({ systemdBooted: () => false, node: process.execPath }), readCrontab: () => tab, writeCrontab: (t: string) => { tab = t; return true; } };
    for (let i = 0; i < 2; i++) {
      const a = ctx(home, { service: svc }, { PATH: "/bin" });
      assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
      assert.match(a.text(), /added to your crontab/);
    }
    assert.equal(tab, `MAILTO=me\n\n0 3 * * * backup.sh\n# my note about ${script}\n\n${cronLines(script).join("\n")}\n`, "installed twice, listed once; the user's lines kept, blank ones too");
    // uninstall would stop the recorded supervisor: point the record at nothing alive.
    fs.rmSync(supervisorPidFile(ctx(home).c.dirs), { force: true });
    const u = ctx(home, { service: svc });
    assert.equal(await main(["service", "uninstall"], u.c), EXIT.ok);
    assert.equal(tab, `MAILTO=me\n\n0 3 * * * backup.sh\n# my note about ${script}\n\n`, "only the lines install wrote are removed");
    assert.match(u.text(), /and its crontab lines/);
  });
});

describe("supervise", () => {
  /** A command that exits with the next code from a list (a signal name kills itself with it), one per round. */
  function scripted(codes: Array<number | string>) {
    const dir = tmpdir("sup-");
    const counter = path.join(dir, "n");
    fs.writeFileSync(counter, "0");
    const js = `const fs=require("fs");const n=+fs.readFileSync(${JSON.stringify(counter)},"utf8");fs.writeFileSync(${JSON.stringify(counter)},String(n+1));const c=${JSON.stringify(codes)}[n];if(typeof c==="string")process.kill(process.pid,c);else process.exit(c);`;
    return { command: [process.execPath, ["-e", js]] as [string, string[]], rounds: () => +fs.readFileSync(counter, "utf8") };
  }

  test("restarts after a crash and after being killed, and stops for good at 78", async () => {
    const home = tmpdir();
    const s = scripted([1, "SIGKILL", 78, 0]);
    const a = ctx(home);
    assert.equal(await supervise(a.c, { command: s.command, restartMs: 20 }), 78);
    assert.equal(s.rounds(), 3, "never started again after 78");
    assert.match(a.errText(), /exit 1\); restarting/);
    assert.match(a.errText(), /killed by SIGKILL\); restarting/);
    assert.match(a.errText(), /needs a new sign-in \(exit 78\)/);
    assert.equal(recentDisconnects(a.c.dirs, 5).at(-1)?.reason, "process_died");
    assert.equal(fs.existsSync(supervisorPidFile(a.c.dirs)), false, "its pid file is gone when it ends");
  });

  test("a clean exit (claw-connector stop) ends it", async () => {
    const s = scripted([0, 1]);
    assert.equal(await supervise(ctx(tmpdir()).c, { command: s.command, restartMs: 20 }), 0);
    assert.equal(s.rounds(), 1);
  });

  test("a second supervisor on the same home refuses", async () => {
    const home = tmpdir();
    const first = ctx(home);
    const ac = new AbortController();
    const s = scripted([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const running = supervise(first.c, { command: s.command, restartMs: 50, signal: ac.signal });
    const other = ctx(home);
    // Same process, so make the recorded pid look like another live one: this test's parent.
    const { processStart } = await import("../src/children.js");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(supervisorPidFile(other.c.dirs), JSON.stringify({ pid: process.ppid, start: processStart(process.ppid) }));
    assert.equal(await supervise(other.c, { command: s.command }), 1);
    assert.match(other.errText(), /already running/);
    ac.abort();
    assert.equal(await running, 0);
  });
});

describe("exit 78 and the disconnect record", () => {
  test("run does not start while a sign-in is needed (no request to Claw): 78, or 0 under launchd (which cannot exempt 78)", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    const c = ctx(home).c;
    fs.mkdirSync(c.dirs.state, { recursive: true });
    fs.writeFileSync(needsLoginFile(c.dirs), JSON.stringify({ at: "2026-11-06T00:00:00Z", reason: "this connector was revoked" }));
    const a = ctx(home);
    assert.equal(await main(["run", "--supervised"], a.c), EXIT.needsPerson);
    assert.match(a.errText(), /not starting: this connector was revoked/);
    assert.equal(await main(["run", "--supervised"], ctx(home, {}, { CLAW_CONNECTOR_SUPERVISOR: "launchd" }).c), EXIT.ok);
    const noConfig = ctx(tmpdir(), {}, { CLAW_CONNECTOR_SUPERVISOR: "launchd" });
    assert.equal(await main(["run", "--supervised"], noConfig.c), EXIT.ok, "under launchd every 78 is a clean exit, or launchd restarts it");
    assert.match(noConfig.errText(), /agents\.toml/);
    const byHand = ctx(home);
    assert.equal(await main(["run"], byHand.c), EXIT.needsPerson, "a run by hand, or a unit written for the old exit code 3, stops here too");
  });

  test("a key Claw refuses at start: 78 and needs-login.json, which status shows", async () => {
    const claw = await FakeClaw.start();
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "deleted-key"], ctx(home).c);
      // Judged as later in the run: authFailLimit refusals from a Claw that answers, lasting authFailWindowMs.
      const r = ctx(home, { timing: { backoffMinMs: 10, backoffMaxMs: 20, authFailLimit: 3, authFailWindowMs: 50 } });
      assert.equal(await main(["run"], r.c), EXIT.needsPerson);
      assert.match(needsLogin(r.c.dirs)?.reason ?? "", /refused the sign-in/);
      const s = ctx(home);
      await main(["status"], s.c);
      assert.match(s.text(), /needs a new sign-in/);
      assert.match(s.text(), /last down: .* auth_failed/);
    } finally { await claw.close(); }
  });

  test("a key deleted while running: after authFailLimit refusals in a row, lasting authFailWindowMs, the run stops its agents and exits 78", async () => {
    const claw = await FakeClaw.start();
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const r = ctx(home, { timing: { heartbeatMs: 60, pausePollMs: 40, backoffMinMs: 20, backoffMaxMs: 60, authFailLimit: 3, authFailWindowMs: 150 } });
      const running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.tokens.delete("good-token");
      claw.dropStreams();
      assert.equal(await running, EXIT.needsPerson);
      assert.match(r.errText(), /keeps refusing this sign-in/);
      assert.ok(needsLogin(r.c.dirs));
      assert.equal(recentDisconnects(r.c.dirs, 1)[0]?.reason, "auth_failed");
    } finally { await claw.close(); }
  });

  test("a key refused on every heartbeat while the command stream stays open (pings keep coming) still ends the run with 78", async () => {
    const claw = await FakeClaw.start({ pingMs: 20 });
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const r = ctx(home, { timing: { heartbeatMs: 40, pausePollMs: 40, authFailLimit: 3, authFailWindowMs: 200 } });
      const running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.tokens.delete("good-token"); // the open stream is not re-checked, as with an API key on the real server
      assert.equal(await running, EXIT.needsPerson);
      assert.equal(recentDisconnects(r.c.dirs, 1)[0]?.reason, "auth_failed");
    } finally { await claw.close(); }
  });

  test("a short burst of refusals (shorter than authFailWindowMs) does not end the run", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const r = ctx(home, { timing: { heartbeatMs: 40, pausePollMs: 40, backoffMinMs: 10, backoffMaxMs: 30, authFailLimit: 2, authFailWindowMs: 60_000 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.tokens.delete("good-token");
      claw.dropStreams();
      await new Promise((res) => setTimeout(res, 300));
      claw.tokens.add("good-token");
      const before = claw.heartbeats.length;
      await claw.until("back", () => claw.online && claw.heartbeats.length > before);
      assert.equal(needsLogin(r.c.dirs), null);
      connector.stop();
      assert.equal(await running, EXIT.ok);
    } finally { connector?.stop(); await running; await claw.close(); }
  });

  test("an identity-service outage (503, 401, 503, 401 ...) far longer than authFailWindowMs does not end the run, which comes back by itself", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const r = ctx(home, { timing: { heartbeatMs: 30, pausePollMs: 40, backoffMinMs: 5, backoffMaxMs: 20, authFailLimit: 2, authFailWindowMs: 40 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.outage = true;
      claw.dropStreams();
      // Many times authFailLimit refusals, over many times authFailWindowMs: before this fix the 4th ended the run (exit 78).
      await claw.until("refusals", () => claw.outageRefusals >= 12, 10_000);
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(needsLogin(r.c.dirs), null, "no needs-login.json while Claw is failing");
      claw.outage = false;
      const before = claw.heartbeats.length;
      await claw.until("back", () => claw.online && claw.heartbeats.length > before, 10_000);
      connector.stop();
      assert.equal(await running, EXIT.ok);
    } finally { connector?.stop(); await running; await claw.close(); }
  });

  test("a supervisor restart straight into the outage: the first answer a 401 still does not end the run", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      claw.outage = true;
      // Two refusals first: the client asks again once on a 401 (an access token may just have expired), so the start
      // itself sees the refusal, not the 503 after it.
      claw.outagePattern = [401, 401, 503];
      const r = ctx(home, { timing: { heartbeatMs: 30, pausePollMs: 40, backoffMinMs: 5, backoffMaxMs: 20, authFailLimit: 2, authFailWindowMs: 40 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run", "--supervised"], r.c);
      await claw.until("refusals", () => claw.outageRefusals >= 8, 10_000);
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(needsLogin(r.c.dirs), null);
      claw.outage = false;
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0, 10_000);
      connector.stop();
    } finally { connector?.stop(); await running; await claw.close(); }
  });

  test("a revocation right after an outage still ends the run at once with 78", async () => {
    const claw = await FakeClaw.start();
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      // Default authOutageQuietMs (10 min) and authFailWindowMs (2 min): only the revocation can end this run in time.
      const r = ctx(home, { timing: { heartbeatMs: 30, pausePollMs: 40, backoffMinMs: 5, backoffMaxMs: 20 } });
      const running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.outage = true;
      claw.dropStreams();
      await claw.until("refusals", () => claw.outageRefusals >= 4, 10_000);
      claw.outage = false;
      const t0 = Date.now();
      claw.revoked = true;
      claw.dropStreams();
      assert.equal(await running, EXIT.revoked);
      assert.ok(Date.now() - t0 < 5_000, `exit 78 came ${Date.now() - t0} ms after the revocation`);
      assert.match(needsLogin(r.c.dirs)?.reason ?? "", /revoked/);
    } finally { await claw.close(); }
  });

  test("a 401 or 403 that is not Claw's word (no JSON error: a gateway, a proxy's page) is never counted", () => {
    assert.equal(isDefinitiveRefusal(new HttpError(401, "invalid_api_key", "/x")), true);
    assert.equal(isDefinitiveRefusal(new HttpError(403, "insufficient_scope", "/x")), true);
    assert.equal(isDefinitiveRefusal(new HttpError(401, "http_401", "/x")), false);
    assert.equal(isDefinitiveRefusal(new HttpError(403, "http_403", "/x")), false);
    assert.equal(isDefinitiveRefusal(new HttpError(503, "authentication_service_unavailable", "/x")), false);
  });

  test("a run that was killed is recorded by the next one as process_died, with its last heartbeat", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const c = ctx(home).c;
      fs.mkdirSync(c.dirs.state, { recursive: true });
      // What SIGKILL leaves: a pid file naming a process that is gone.
      fs.writeFileSync(pidFile(c.dirs), JSON.stringify({ pid: 999_999_999, start: "1" }));
      const r = ctx(home, { timing: { heartbeatMs: 100, pausePollMs: 40 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      const downs = recentDisconnects(r.c.dirs, 5);
      assert.equal(downs[0]?.reason, "process_died");
      connector.stop();
      assert.equal(await running, EXIT.ok);
      assert.equal(recentDisconnects(r.c.dirs, 1)[0]?.reason, "stopped");
    } finally { connector?.stop(); await running; await claw.close(); }
  });
});

describe("the disconnect record", () => {
  test("is trimmed to its newer half past 128 KiB, newest last", async () => {
    const { recordDisconnect } = await import("../src/health.js");
    const dirs = ctx(tmpdir()).c.dirs;
    for (let i = 0; i < 700; i++) await recordDisconnect(dirs, { reason: "stream_lost", detail: `${i} ${"x".repeat(200)}` });
    const size = Buffer.byteLength(fs.readFileSync(path.join(dirs.state, "disconnects.jsonl"), "utf8"));
    assert.ok(size <= 128 * 1024, `size ${size}`);
    assert.match(recentDisconnects(dirs, 1)[0]?.detail ?? "", /^699 /);
    // Every record kept is a whole one, and the newer half survives: right after a trim nothing recent is lost.
    const kept = recentDisconnects(dirs, 10_000);
    assert.ok(kept.length > 200, `kept ${kept.length}`);
    const nums = kept.map((k) => Number(k.detail?.split(" ")[0]));
    assert.deepEqual(nums, nums.map((_, i) => nums[0]! + i), "contiguous, oldest first");
    let trimmedAt = -1;
    const fresh = ctx(tmpdir()).c.dirs;
    for (let i = 0; i < 700 && trimmedAt < 0; i++) {
      await recordDisconnect(fresh, { reason: "stream_lost", detail: `${i} ${"x".repeat(200)}` });
      if (recentDisconnects(fresh, 10_000).length < i + 1) trimmedAt = i;
    }
    assert.ok(trimmedAt > 0, "a trim happened");
    const after = recentDisconnects(fresh, 10_000);
    assert.ok(after.length >= trimmedAt / 2 - 1, `kept ${after.length} of ${trimmedAt + 1}`);
    assert.match(after.at(-1)?.detail ?? "", new RegExp(`^${trimmedAt} `), "the record that caused the trim is kept");
  });
});

describe("the agents' sign-in under a service", () => {
  test("install keeps ANTHROPIC_API_KEY out of the unit, in service-env.json (0600); a run then gives it to the agent, whose session opens", async () => {
    const claw = await FakeClaw.start();
    let running: Promise<number> | null = null;
    const held: { c: import("../src/connector.js").Connector | null } = { c: null };
    // The adapter inherits this test process's environment: whatever key the machine running the tests has must not
    // stand in for the one the service is meant to supply.
    const own = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = tmpdir();
      const work = tmpdir("w-");
      writeConfig(home, work);
      // The agent signs in with ANTHROPIC_API_KEY, as Claude Code does for a key or gateway user.
      fs.appendFileSync(path.join(home, "config", "agents.toml"), `[agents.env]\nFAKE_NEEDS_ENV = "ANTHROPIC_API_KEY"\n`);
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const xdg = tmpdir("xdg-");
      const f = fakeExec({ "systemctl --user is-system-running": { code: 0, out: "running" }, "systemctl --user is-active": { code: 0, out: "active" } });
      const shell = { XDG_CONFIG_HOME: xdg, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-must-not-be-in-the-unit", ANTHROPIC_BASE_URL: "https://gw.example" };
      const i = ctx(home, { service: { ...D(), exec: f.exec } }, shell);
      assert.equal(await main(["service", "install"], i.c), EXIT.ok, i.errText());
      const unit = fs.readFileSync(path.join(xdg, "systemd", "user", "claw-connector.service"), "utf8");
      assert.doesNotMatch(unit, /sk-ant-must-not-be|ANTHROPIC_API_KEY/);
      assert.match(unit, /Environment="ANTHROPIC_BASE_URL=https:\/\/gw\.example"/);
      const fd = fs.openSync(serviceEnvFile(i.c.dirs), "r");
      try {
        assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(fs.readFileSync(fd, "utf8")), { ANTHROPIC_API_KEY: "sk-ant-must-not-be-in-the-unit" });
      } finally { fs.closeSync(fd); }
      assert.match(i.text(), /sign-in for the service .*: ANTHROPIC_API_KEY/);
      assert.doesNotMatch(i.text() + i.errText(), /sk-ant-must-not-be/, "names only, never the value");
      // The service's run: the unit's environment, without the key.
      const r = ctx(home, { timing: { heartbeatMs: 150, pausePollMs: 40, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100 }, onConnector: (cn) => { held.c = cn; } }, { PATH: "/usr/bin" });
      running = main(["run", "--supervised"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      const sid = claw.newSession("fake", work);
      const got = await claw.until("an answer", () => claw.eventsOf(sid, "session_started")[0] ?? claw.eventsOf(sid, "session_closed")[0]);
      assert.equal(got.type, "session_started", JSON.stringify(got.data));
      const st = ctx(home, { service: { ...D(), exec: f.exec } });
      await main(["service", "status"], st.c);
      assert.match(st.text(), /agent env: +ANTHROPIC_API_KEY/);
    } finally {
      held.c?.stop();
      if (running) await running;
      await claw.close();
      if (own !== undefined) process.env.ANTHROPIC_API_KEY = own;
    }
  });

  test("install again from a shell without the key keeps it; uninstall removes the file", async () => {
    const home = tmpdir();
    writeConfig(home, tmpdir("w-"));
    await main(["login", "--server", "https://claw.example", "--key", "k"], ctx(home).c);
    const f = fakeExec({ "systemctl --user is-active": { code: 0, out: "active" } });
    const svc = { ...D(), exec: f.exec };
    const xdg = tmpdir("xdg-");
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], ctx(home, { service: svc }, { XDG_CONFIG_HOME: xdg, OPENAI_API_KEY: "o1" }).c), EXIT.ok);
    const again = ctx(home, { service: svc }, { XDG_CONFIG_HOME: xdg, ANTHROPIC_API_KEY: "a1" });
    assert.equal(await main(["service", "install", "--supervisor", "systemd"], again.c), EXIT.ok);
    assert.deepEqual(JSON.parse(fs.readFileSync(serviceEnvFile(again.c.dirs), "utf8")), { OPENAI_API_KEY: "o1", ANTHROPIC_API_KEY: "a1" });
    assert.match(again.text(), /OPENAI_API_KEY \(kept from before\)/);
    assert.equal(await main(["service", "uninstall", "--supervisor", "systemd"], ctx(home, { service: svc }, { XDG_CONFIG_HOME: xdg }).c), EXIT.ok);
    assert.equal(fs.existsSync(serviceEnvFile(again.c.dirs)), false);
  });

  test("an agent's own [agents.env] and the connector's environment win over what the service kept", async () => {
    const { applyServiceEnv } = await import("../src/service.js");
    const agents = [{ env: { ANTHROPIC_API_KEY: "own" } as Record<string, string> }, { env: {} as Record<string, string> }];
    assert.deepEqual(applyServiceEnv(agents, { ANTHROPIC_API_KEY: "kept", OPENAI_API_KEY: "kept-o" }, { OPENAI_API_KEY: "shell" }), ["ANTHROPIC_API_KEY"]);
    assert.deepEqual(agents.map((a) => a.env), [{ ANTHROPIC_API_KEY: "own" }, { ANTHROPIC_API_KEY: "kept" }]);
  });
});

describe("a container whose home does not outlive it", () => {
  const MOUNTINFO = [
    "100 1 0:50 / / rw,relatime - overlay overlay rw,lowerdir=/x",
    "101 100 0:60 / /mnt/ceph rw,relatime - ceph 10.0.0.1:/ rw",
    "102 100 0:61 / /proc rw - proc proc rw",
    "103 100 0:62 / /root/persist rw - ext4 /dev/sdb rw",
  ].join("\n");

  test("a configuration on overlay is said to be lost with the container, naming the persistent mounts; on a real disk nothing is said", () => {
    const mounts = readMounts(MOUNTINFO);
    assert.deepEqual(mounts.map((m) => `${m.point}:${m.fstype}`), ["/:overlay", "/mnt/ceph:ceph", "/proc:proc", "/root/persist:ext4"]);
    const said = ephemeralWhere("/root/.config/claw-connector", mounts);
    assert.match(said ?? "", /on the container's own file system \(overlay\), which is lost when the container is recreated/);
    assert.match(said ?? "", /CLAW_CONNECTOR_CONFIG_DIR=/);
    assert.equal(ephemeralWhere("/root/persist/claw", mounts), null);
    assert.equal(ephemeralWhere("/mnt/ceph/me/claw", mounts), null);
    assert.match(said ?? "", /then run init and login again/, "a machine that signed in with login is told to do so again");
    // A paired machine never ran init or login: it is sent back to the chat for a new pairing command.
    const paired = ephemeralWhere("/root/.config/claw-connector", mounts, true) ?? "";
    assert.match(paired, /then ask Clawy for a new pairing command \("连接我的开发环境"\) and run it in that shell/);
    assert.doesNotMatch(paired, /init|login/);
  });

  test("CLAW_CONNECTOR_CONFIG_DIR moves only the configuration and sign-in; the state stays", () => {
    const d = resolveDirs({ CLAW_CONNECTOR_CONFIG_DIR: "/persist/cc" } as NodeJS.ProcessEnv, "/home/me");
    assert.deepEqual(d, { config: "/persist/cc", state: "/home/me/.local/state/claw-connector" });
    const h = resolveDirs({ CLAW_CONNECTOR_HOME: "/h", CLAW_CONNECTOR_CONFIG_DIR: "/persist/cc" } as NodeJS.ProcessEnv);
    assert.deepEqual(h, { config: "/persist/cc", state: "/h/state" });
  });
});

describe("Claw's connector limit", () => {
  test("409 connector_limit_reached: the run stays up, says what to do once, retries slowly and comes online when a slot frees", async () => {
    const claw = await FakeClaw.start();
    let running: Promise<number> | null = null;
    const held: { c: import("../src/connector.js").Connector | null } = { c: null };
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      claw.atConnectorLimit = true;
      const r = ctx(home, { timing: { heartbeatMs: 150, pausePollMs: 40, backoffMinMs: 20, backoffMaxMs: 100, limitRetryMs: 200 }, onConnector: (cn) => { held.c = cn; } });
      let ended = false;
      running = main(["run"], r.c).finally(() => { ended = true; });
      await claw.until("two refusals", () => claw.limitRefusals >= 2);
      assert.equal(ended, false, "the run did not end: a supervisor would restart it every 5 s for good");
      const last = recentDisconnects(r.c.dirs, 5);
      assert.equal(last.filter((x) => x.reason === "connector_limit_reached").length, 1, "said once, not on every try");
      assert.match(last.at(-1)?.detail ?? "", /remove machines you no longer use/);
      // Paused while waiting: a slot that frees up meanwhile is not taken until "resume".
      await main(["pause"], ctx(home).c);
      claw.atConnectorLimit = false;
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(claw.registered, 0, "not registered while paused");
      await main(["resume"], ctx(home).c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0, 5_000);
    } finally {
      held.c?.stop();
      if (running) await running;
      await claw.close();
    }
  });
});
