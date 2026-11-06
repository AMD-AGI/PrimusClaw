// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `service`, `supervise`, exit 78 and the disconnect record: what keeps a connector up, and what keeps it down. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { main, EXIT, type Ctx } from "../src/commands.js";
import { needsLogin, recentDisconnects } from "../src/health.js";
import { keepaliveFile, needsLoginFile, pidFile, resolveDirs, supervisorPidFile } from "../src/paths.js";
import { carriedEnv, supervise, systemdUnit, type ExecResult, type ServiceDeps } from "../src/service.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

function ctx(home: string, extra: Partial<Ctx> = {}, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config"), ...env }, out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", ...extra };
  return { c, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const writeConfig = (home: string, work: string) => {
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
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

const D = (over: Partial<ServiceDeps> = {}): Partial<ServiceDeps> => {
  const cli = path.join(tmpdir("cli-"), "cli.js");
  fs.writeFileSync(cli, "");
  return { platform: "linux", uid: 1000, user: "me", node: "/usr/bin/node", cli, systemdBooted: () => true, ...over };
};

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

  test("only the listed variables are carried, and never one named like a credential, even when asked for", () => {
    const { vars, refused } = carriedEnv({ PATH: "/bin", CLAW_CONNECTOR_KEY: "ak-secret", ANTHROPIC_API_KEY: "sk", FOO: "1", GH_TOKEN: "t" }, ["FOO", "GH_TOKEN", "ANTHROPIC_API_KEY"]);
    assert.deepEqual(vars, [["PATH", "/bin"], ["FOO", "1"]]);
    assert.deepEqual(refused, ["GH_TOKEN", "ANTHROPIC_API_KEY"]);
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
    // A supervisor that is already alive (this test process) makes install leave it be instead of spawning one.
    fs.mkdirSync(ctx(home).c.dirs.state, { recursive: true });
    fs.writeFileSync(supervisorPidFile(ctx(home).c.dirs), JSON.stringify({ pid: process.pid, start: (await import("../src/children.js")).processStart(process.pid) }));
    // What this very container answers: systemctl exits 0 and does nothing, and there is no /run/systemd/system.
    const chroot = fakeExec({ "systemctl": { code: 0, out: "Running in chroot, ignoring command 'is-system-running'" } });
    const a = ctx(home, { service: { ...D({ systemdBooted: () => false }), exec: chroot.exec } }, { PATH: "/bin" });
    assert.equal(await main(["service", "install"], a.c), EXIT.ok, a.errText());
    const script = keepaliveFile(a.c.dirs);
    const fd = fs.openSync(script, "r");
    const mode = fs.fstatSync(fd).mode & 0o777;
    const body = fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    assert.equal(mode, 0o700);
    assert.match(body, /export PATH='\/bin'/);
    assert.match(body, /service ensure\n$/);
    assert.match(a.text(), /supervisor running \(pid \d+\)/);
    assert.deepEqual(chroot.calls, [], "systemctl was not even asked");
    assert.match(a.text(), /@reboot sh .*keepalive\.sh/);
    assert.match(a.text(), /\*\/5 \* \* \* \* sh .*keepalive\.sh/);
    fs.rmSync(supervisorPidFile(a.c.dirs));
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
      const r = ctx(home);
      assert.equal(await main(["run"], r.c), EXIT.needsPerson);
      assert.match(needsLogin(r.c.dirs)?.reason ?? "", /refused the sign-in/);
      const s = ctx(home);
      await main(["status"], s.c);
      assert.match(s.text(), /needs a new sign-in/);
      assert.match(s.text(), /last down: .* failed/);
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
    for (let i = 0; i < 700; i++) recordDisconnect(dirs, { reason: "stream_lost", detail: `${i} ${"x".repeat(200)}` });
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
      recordDisconnect(fresh, { reason: "stream_lost", detail: `${i} ${"x".repeat(200)}` });
      if (recentDisconnects(fresh, 10_000).length < i + 1) trimmedAt = i;
    }
    assert.ok(trimmedAt > 0, "a trim happened");
    const after = recentDisconnects(fresh, 10_000);
    assert.ok(after.length >= trimmedAt / 2 - 1, `kept ${after.length} of ${trimmedAt + 1}`);
    assert.match(after.at(-1)?.detail ?? "", new RegExp(`^${trimmedAt} `), "the record that caused the trim is kept");
  });
});
