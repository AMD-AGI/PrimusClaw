// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The subcommands, run through `main` against a temporary home, a stand-in identity service and a stand-in Claw. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { main, EXIT, type Ctx } from "../src/commands.js";
import { processStart } from "../src/children.js";
import { credentialsFile, identityFile, pauseFile, resolveDirs, type Dirs } from "../src/paths.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { FakeIdentity } from "./support/fake-identity.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

function ctx(home: string, extra: Partial<Ctx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  // `init` and `hooks` write into a Claude config directory: the test's own, never the real home's.
  const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config") }, out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", ...extra };
  return { c, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const writeConfig = (home: string, work: string, extra = "", agentEnv = "") => {
  const dir = path.join(home, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agents.toml"), `${extra}
[[agents]]
id = "fake"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
roots = [${JSON.stringify(work)}]
${agentEnv ? `[agents.env]\n${agentEnv}\n` : ""}`);
};

/** The connector id a previous run stored, as `run` writes it; `revoked` is what `run` adds once Claw revoked that row. */
const seedIdentity = (dirs: Dirs, server: string, id = "stored-connector", revoked = false) => {
  fs.mkdirSync(dirs.state, { recursive: true });
  fs.writeFileSync(identityFile(dirs), JSON.stringify({ server, connector_id: id, cursor: 0, handled: [], ...(revoked ? { revoked: true } : {}) }), { mode: 0o600 });
};
const storedId = (dirs: Dirs): any => JSON.parse(fs.readFileSync(identityFile(dirs), "utf8"));

describe("claw-connector commands", () => {
  test("no command and an unknown one are usage errors; version and help work", async () => {
    const home = tmpdir();
    assert.equal(await main([], ctx(home).c), EXIT.usage);
    const u = ctx(home);
    assert.equal(await main(["frobnicate"], u.c), EXIT.usage);
    assert.match(u.errText(), /unknown command/);
    const v = ctx(home);
    assert.equal(await main(["--version"], v.c), EXIT.ok);
    assert.equal(v.text(), "0.1.0");
    assert.equal(await main(["--help"], ctx(home).c), EXIT.ok);
  });

  test("init writes a sample once and never overwrites it; the sample is a valid file once its root exists", async () => {
    const home = tmpdir();
    const a = ctx(home);
    assert.equal(await main(["init"], a.c), EXIT.ok);
    const file = path.join(home, "config", "agents.toml");
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text + "\n# mine\n");
    const b = ctx(home);
    await main(["init"], b.c);
    assert.match(b.text(), /already exists/);
    assert.match(fs.readFileSync(file, "utf8"), /# mine/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test("login with a key (development) saves a 0600 file and says it is not the normal way", async () => {
    const home = tmpdir();
    const a = ctx(home);
    assert.equal(await main(["login", "--server", "https://claw.example/api/", "--key", "ak-test"], a.c), EXIT.ok);
    const file = credentialsFile(a.c.dirs);
    const fd = fs.openSync(file, "r");
    try {
      assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(fd, "utf8")).server, "https://claw.example/api");
    } finally { fs.closeSync(fd); }
    assert.match(a.text(), /development key/);
    assert.doesNotMatch(a.text() + a.errText(), /ak-test/, "the key is never echoed");
  });

  test("plain http is refused for the server and for the identity service (except localhost), before anything is saved or sent", async () => {
    const home = tmpdir();
    for (const args of [
      ["login", "--server", "http://claw.example/api", "--key", "k"],
      ["login", "--server", "https://claw.example/api", "--identity-url", "http://identity.example"],
    ]) {
      const a = ctx(home);
      assert.equal(await main(args, a.c), EXIT.failure, args.join(" "));
      assert.match(a.errText(), /must be an https:\/\/ URL/);
      assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
    }
    const ok = ctx(home);
    assert.equal(await main(["login", "--server", "http://127.0.0.1:9/api", "--key", "k"], ok.c), EXIT.ok, "a local development server is fine");
  });

  test("login without a server or without an identity URL says what is missing", async () => {
    const home = tmpdir();
    const a = ctx(home);
    assert.equal(await main(["login"], a.c), EXIT.usage);
    assert.match(a.errText(), /--server/);
    const b = ctx(home);
    assert.equal(await main(["login", "--server", "https://x.example"], b.c), EXIT.usage);
    assert.match(b.errText(), /--identity-url/);
  });

  test("login runs the device flow, prints the code and the link, and stores only the refresh token", async () => {
    const id = await FakeIdentity.start();
    try {
      const home = tmpdir();
      const a = ctx(home, { fetch: ((u: any, i: any) => fetch(u, i)) as typeof fetch });
      id.interval = 0.01;
      id.pollScript = ["authorization_pending", "ok"];
      seedIdentity(a.c.dirs, "https://claw.example/api");
      assert.equal(await main(["login", "--server", "https://claw.example/api", "--identity-url", id.url, "--name", "dev-pod"], a.c), EXIT.ok);
      assert.equal(storedId(a.c.dirs).connector_id, "stored-connector", "a re-login keeps the live connector row it registered, so it does not use up another one");
      assert.match(a.text(), /ABCD-EFGH/);
      assert.match(a.text(), /device\?user_code=ABCD-EFGH/);
      const saved = JSON.parse(fs.readFileSync(credentialsFile(a.c.dirs), "utf8"));
      assert.deepEqual([saved.kind, saved.refresh_token, saved.identity_url, saved.client_id, saved.device_name], ["device", "refresh-1", id.url, "claw-connector", "dev-pod"]);
      assert.equal(saved.access_token, undefined, "the short-lived access token is never written down");
      assert.doesNotMatch(a.text() + a.errText(), /refresh-1|access-1/);
      assert.equal(id.requests[0]!.form.device_name, "dev-pod");
    } finally { await id.close(); }
  });

  test("a denied login saves nothing and fails", async () => {
    const id = await FakeIdentity.start();
    try {
      const home = tmpdir();
      const a = ctx(home);
      id.interval = 0.01;
      id.pollScript = ["access_denied"];
      seedIdentity(a.c.dirs, "https://x.example", "stored-connector", true);
      assert.equal(await main(["login", "--server", "https://x.example", "--identity-url", id.url], a.c), EXIT.failure);
      assert.match(a.errText(), /denied/);
      assert.equal(fs.existsSync(identityFile(a.c.dirs)), true, "a login that saved nothing leaves even a revoked connector id alone");
      assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
    } finally { await id.close(); }
  });

  test("run needs a config with agents and a sign-in, and refuses a credentials file others can read", async () => {
    const home = tmpdir();
    const work = tmpdir("w-");
    const a = ctx(home);
    assert.equal(await main(["run"], a.c), EXIT.failure);
    assert.match(a.errText(), /agents\.toml/);
    writeConfig(home, work);
    const b = ctx(home);
    assert.equal(await main(["run"], b.c), EXIT.failure);
    assert.match(b.errText(), /not signed in/);
    await main(["login", "--server", "http://127.0.0.1:1", "--key", "k"], ctx(home).c);
    fs.chmodSync(credentialsFile(b.c.dirs), 0o644);
    const d = ctx(home);
    assert.equal(await main(["run"], d.c), EXIT.failure);
    assert.match(d.errText(), /readable by other users/);
  });

  test("run with a device sign-in: refreshes, connects, serves, and stop ends it with its adapters; status reflects it", async () => {
    const claw = await FakeClaw.start();
    const id = await FakeIdentity.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      const work = tmpdir("w-");
      writeConfig(home, work);
      id.refreshTokens.add("r0");
      claw.tokens.add("access-1");
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      fs.writeFileSync(path.join(home, "config", "credentials.json"), JSON.stringify({ v: 1, server: claw.url, kind: "device", identity_url: id.url, client_id: "claw-connector", refresh_token: "r0", saved_at: "" }), { mode: 0o600 });
      const r = ctx(home, { timing: { heartbeatMs: 150, pausePollMs: 40, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      assert.ok(claw.requests.every((q) => q.auth === "Bearer access-1"), "the refreshed access token is what is presented");
      assert.deepEqual([...id.refreshTokens], ["refresh-1"], "the refresh token rotated and the new one was stored");
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config", "credentials.json"), "utf8")).refresh_token, "refresh-1");
      const sid = claw.newSession("fake", work);
      await claw.until("started", () => claw.eventsOf(sid, "session_started")[0]);
      const s = ctx(home);
      await main(["status", "--json"], s.c);
      const st = JSON.parse(s.text());
      assert.equal(st.running, process.pid);
      assert.equal(st.signed_in.kind, "device");
      assert.deepEqual(st.agents, ["fake"]);
      assert.equal(st.adapters.length, 1);
      // A second run on the same home is refused while this one lives.
      const second = ctx(home);
      assert.equal(await main(["run"], second.c), EXIT.failure);
      assert.match(second.errText(), /already running/);
      const pid = st.adapters[0].pid;
      connector.stop();
      assert.equal(await running, EXIT.ok);
      assert.equal(processStart(pid), null);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
      await id.close();
    }
  });

  test("a revoked sign-in at the identity service ends run with the revoked exit code", async () => {
    const claw = await FakeClaw.start();
    const id = await FakeIdentity.start();
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      fs.writeFileSync(path.join(home, "config", "credentials.json"), JSON.stringify({ v: 1, server: claw.url, kind: "device", identity_url: id.url, client_id: "claw-connector", refresh_token: "never-issued", saved_at: "" }), { mode: 0o600 });
      const r = ctx(home);
      assert.equal(await main(["run"], r.c), EXIT.revoked);
      assert.match(r.errText(), /revoked/);
      assert.equal(claw.requests.length, 0, "never reached Claw without a credential");
    } finally { await claw.close(); await id.close(); }
  });

  test("a revoked connector at Claw ends run with the revoked exit code", async () => {
    const claw = await FakeClaw.start();
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const r = ctx(home, { timing: { heartbeatMs: 100, pausePollMs: 40 } });
      const running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      claw.revoke();
      assert.equal(await running, EXIT.revoked);
    } finally { await claw.close(); }
  });

  test("revoke, then login, then run: the revocation keeps the stored id and marks it; login drops it so run registers a new connector", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      const timing = { heartbeatMs: 100, pausePollMs: 40 };
      await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
      const first = ctx(home, { timing });
      const firstRun = main(["run"], first.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      const revokedId = claw.connectorId;
      claw.revoke();
      assert.equal(await firstRun, EXIT.revoked);
      const idFile = identityFile(first.c.dirs);
      assert.equal(JSON.parse(fs.readFileSync(idFile, "utf8")).connector_id, revokedId, "a revocation must not make run register a new connector on its own");
      assert.equal(JSON.parse(fs.readFileSync(idFile, "utf8")).revoked, true, "run records that Claw revoked this row, which is what login looks for");
      // Run again without logging in: the row is revoked for good, so it ends the same way, and nothing new was registered.
      assert.equal(await main(["run"], ctx(home, { timing }).c), EXIT.revoked);
      assert.equal(claw.registered, 1);
      // Logging in again is the owner's decision to connect anew: it forgets an id that is marked revoked.
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      assert.equal(fs.existsSync(idFile), false);
      const second = ctx(home, { timing, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], second.c);
      await claw.until("online again under a new id", () => claw.registered === 2 && claw.online);
      assert.notEqual(claw.connectorId, revokedId);
      assert.equal(JSON.parse(fs.readFileSync(idFile, "utf8")).connector_id, claw.connectorId);
      connector.stop();
      assert.equal(await running, EXIT.ok);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  });

  test("login, run, login, run again: the second sign-in reuses the connector row, so a re-login never uses up the per-user limit", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      const timing = { heartbeatMs: 100, pausePollMs: 40 };
      const runOnce = async () => {
        running = main(["run"], ctx(home, { timing, onConnector: (cn) => { connector = cn; } }).c);
        await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
        connector.stop();
        assert.equal(await running, EXIT.ok);
      };
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      await runOnce();
      const id = claw.connectorId;
      assert.equal(claw.registered, 1);
      // A new sign-in (the refresh token expired, say) and a sign-out followed by a sign-in both keep the row.
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      assert.equal(await main(["logout"], ctx(home).c), EXIT.ok);
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      claw.heartbeats.length = 0;
      await runOnce();
      assert.equal(claw.registered, 1, "no second registration: the stored row is still alive");
      assert.equal(claw.connectorId, id);
      assert.equal(storedId(resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv)).connector_id, id);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  });

  test("a sign-in that the identity service revoked leaves the connector row alive: the next login reuses it", async () => {
    const claw = await FakeClaw.start();
    const id = await FakeIdentity.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const home = tmpdir();
      writeConfig(home, tmpdir("w-"));
      const a = ctx(home);
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      fs.writeFileSync(credentialsFile(a.c.dirs), JSON.stringify({ v: 1, server: claw.url, kind: "device", identity_url: id.url, client_id: "claw-connector", refresh_token: "never-issued", saved_at: "" }), { mode: 0o600 });
      seedIdentity(a.c.dirs, claw.url, claw.connectorId);
      assert.equal(await main(["run"], ctx(home).c), EXIT.revoked);
      assert.equal(storedId(a.c.dirs).revoked, undefined, "the row was not revoked, only the sign-in, so it is not marked");
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      assert.equal(storedId(a.c.dirs).connector_id, claw.connectorId);
      running = main(["run"], ctx(home, { timing: { heartbeatMs: 100, pausePollMs: 40 }, onConnector: (cn) => { connector = cn; } }).c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      assert.equal(claw.registered, 0, "the stored row served the new sign-in");
      connector.stop();
      assert.equal(await running, EXIT.ok);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
      await id.close();
    }
  });

  test("login and logout forget a stored connector id only when it is marked revoked", async () => {
    const id = await FakeIdentity.start();
    try {
      const home = tmpdir();
      const a = ctx(home);
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      for (const revoked of [false, true]) {
        // --key path
        seedIdentity(a.c.dirs, "https://x.example", "stored-connector", revoked);
        assert.equal(await main(["login", "--server", "https://x.example", "--key", "k"], ctx(home).c), EXIT.ok);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), !revoked, `login --key, revoked=${revoked}`);
        // device path
        id.interval = 0.01;
        id.pollScript = ["ok"];
        seedIdentity(a.c.dirs, "https://x.example", "stored-connector", revoked);
        assert.equal(await main(["login", "--server", "https://x.example", "--identity-url", id.url], ctx(home).c), EXIT.ok);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), !revoked, `login device, revoked=${revoked}`);
        // logout
        seedIdentity(a.c.dirs, "https://x.example", "stored-connector", revoked);
        assert.equal(await main(["logout"], ctx(home).c), EXIT.ok);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), !revoked, `logout, revoked=${revoked}`);
        if (!revoked) assert.equal(storedId(a.c.dirs).connector_id, "stored-connector");
      }
    } finally { await id.close(); }
  });

  test("pause writes the marker and resume removes it; with nothing running, pause also stops recorded leftovers", async () => {
    const home = tmpdir();
    const a = ctx(home);
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    try {
      const { ChildRegistry } = await import("../src/children.js");
      new ChildRegistry(path.join(a.c.dirs.state, "children.json")).add({ pid: orphan.pid!, pgid: orphan.pid!, agent_id: "x", session_id: "s" });
      assert.equal(await main(["pause"], a.c), EXIT.ok);
      assert.equal(fs.existsSync(pauseFile(a.c.dirs)), true);
      assert.match(a.text(), /leftover/);
      await sleep(100);
      assert.equal(processStart(orphan.pid!), null);
      const b = ctx(home);
      assert.equal(await main(["resume"], b.c), EXIT.ok);
      assert.equal(fs.existsSync(pauseFile(a.c.dirs)), false);
    } finally { try { process.kill(-orphan.pid!, "SIGKILL"); } catch { /* gone */ } }
  });

  test("stop with a connector running in another process signals exactly that pid and its recorded adapters; it never touches an unrecorded process", async () => {
    const claw = await FakeClaw.start();
    const home = tmpdir();
    const work = tmpdir("w-");
    writeConfig(home, work);
    await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli.ts");
    const tsx = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [cli, "run"], { env: { ...process.env, CLAW_CONNECTOR_HOME: home }, stdio: "ignore", detached: true });
    try {
      await claw.until("the separate process to be online", () => claw.online && claw.heartbeats.length > 0, 20_000);
      const sid = claw.newSession("fake", work);
      await claw.until("started", () => claw.eventsOf(sid, "session_started")[0]);
      const adapters = JSON.parse(fs.readFileSync(path.join(home, "state", "children.json"), "utf8")).map((r: any) => r.pid);
      assert.equal(adapters.length, 1);
      const s = ctx(home);
      assert.equal(await main(["stop"], s.c), EXIT.ok);
      assert.match(s.text(), /stopped the connector/);
      await sleep(200);
      assert.equal(processStart(adapters[0]), null, "the recorded adapter is gone");
      assert.notEqual(processStart(bystander.pid!), null, "a process that was not recorded is untouched");
    } finally {
      for (const p of [child, bystander]) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
      await claw.close();
    }
  });

  test("stop after the connector itself was killed hard still stops the agents it had recorded", async () => {
    const claw = await FakeClaw.start();
    const home = tmpdir();
    const work = tmpdir("w-");
    writeConfig(home, work, "", 'FAKE_SURVIVE_EOF = "1"');
    await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli.ts");
    const tsx = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [cli, "run"], { env: { ...process.env, CLAW_CONNECTOR_HOME: home }, stdio: "ignore", detached: true });
    try {
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0, 20_000);
      const sid = claw.newSession("fake", work);
      await claw.until("started", () => claw.eventsOf(sid, "session_started")[0]);
      const run = JSON.parse(fs.readFileSync(path.join(home, "state", "connector.pid"), "utf8"));
      const adapters: number[] = JSON.parse(fs.readFileSync(path.join(home, "state", "children.json"), "utf8")).map((r: any) => r.pid);
      process.kill(run.pid, "SIGKILL"); // no cleanup runs: the adapter is left behind
      await sleep(300);
      assert.notEqual(processStart(adapters[0]!), null, "the adapter outlived its connector");
      const s = ctx(home);
      assert.equal(await main(["stop"], s.c), EXIT.ok);
      await sleep(200);
      assert.equal(processStart(adapters[0]!), null, "stop removed it");
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      await claw.close();
    }
  });

  test("logout revokes the refresh token at the identity service and deletes the sign-in, and keeps a live connector id", async () => {
    const id = await FakeIdentity.start();
    try {
      const home = tmpdir();
      const a = ctx(home);
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      id.refreshTokens.add("r9");
      fs.writeFileSync(credentialsFile(a.c.dirs), JSON.stringify({ v: 1, server: "https://x.example", kind: "device", identity_url: id.url, client_id: "claw-connector", refresh_token: "r9", saved_at: "" }), { mode: 0o600 });
      seedIdentity(a.c.dirs, "https://x.example");
      assert.equal(await main(["logout"], a.c), EXIT.ok);
      assert.equal(storedId(a.c.dirs).connector_id, "stored-connector", "signing out leaves the connector row alone, so the next sign-in reuses it");
      assert.deepEqual(id.revokedTokens, ["r9"]);
      assert.equal(id.refreshTokens.has("r9"), false);
      assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
    } finally { await id.close(); }
  });
});

// --- the Claude Code session hooks -------------------------------------------------------------------

describe("init and hooks: the Claude Code session hooks", () => {
  const stand = (): string => { const f = path.join(tmpdir("cc-hookbin-"), "terminal-hook.js"); fs.writeFileSync(f, "// stand-in\n"); return f; };
  const claudeDir = (home: string) => { const d = path.join(home, "claude-config"); fs.mkdirSync(d, { recursive: true }); return d; };
  const settings = (dir: string) => path.join(dir, "settings.json");
  const hookCommands = (dir: string): string[] => {
    const doc = JSON.parse(fs.readFileSync(settings(dir), "utf8"));
    return Object.values<any>(doc.hooks ?? {}).flatMap((groups) => groups.flatMap((g: any) => g.hooks.map((h: any) => h.command as string)));
  };

  test("init installs the hooks into the Claude config directory, once, and says so; run again it changes nothing", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    fs.writeFileSync(settings(dir), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } }, null, 2));
    const script = stand();
    const a = ctx(home, { hookScript: script });
    assert.equal(await main(["init"], a.c), EXIT.ok);
    assert.match(a.text(), /installed the Claude Code session hooks in .*settings\.json/);
    const cmds = hookCommands(dir);
    assert.equal(cmds.filter((c) => c.includes("terminal-hook.js") && c.includes(`--dir '${dir}'`)).length, 2);
    assert.ok(cmds.includes("mine.sh"), "the user's own hook is still there");
    assert.equal(JSON.parse(fs.readFileSync(settings(dir), "utf8")).model, "opus");
    const bytes = fs.readFileSync(settings(dir), "utf8");
    const b = ctx(home, { hookScript: script });
    assert.equal(await main(["init"], b.c), EXIT.ok);
    assert.match(b.text(), /already exists/);
    assert.match(b.text(), /session hooks are already in/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), bytes);
  });

  test("init --no-hooks leaves Claude Code alone; with no Claude directory it says how to do it later and creates nothing", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    const a = ctx(home, { hookScript: stand() });
    assert.equal(await main(["init", "--no-hooks"], a.c), EXIT.ok);
    assert.equal(fs.existsSync(settings(dir)), false);
    const other = tmpdir();
    const b = ctx(other, { hookScript: stand() });
    assert.equal(await main(["init"], b.c), EXIT.ok);
    assert.match(b.text(), /no Claude Code directory at .*claude hooks install|no Claude Code directory at .*hooks install/s);
    assert.equal(fs.existsSync(path.join(other, "claude-config")), false);
  });

  test("a settings file that cannot be merged into does not fail init: the sample is written, the problem is reported, the file is untouched", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    fs.writeFileSync(settings(dir), "{ not json");
    const a = ctx(home, { hookScript: stand() });
    assert.equal(await main(["init"], a.c), EXIT.ok);
    assert.ok(fs.existsSync(path.join(home, "config", "agents.toml")));
    assert.match(a.errText(), /hooks: .*not valid JSON/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), "{ not json");
  });

  test("a source checkout that was not built has no hook script: init says so and still succeeds", async () => {
    const home = tmpdir();
    claudeDir(home);
    const a = ctx(home);
    assert.equal(await main(["init"], a.c), EXIT.ok);
    assert.match(a.errText(), /terminal-hook\.js does not exist/);
  });

  test("hooks install, status and uninstall, for the directory named", async () => {
    const home = tmpdir();
    const dir = path.join(home, "elsewhere");
    const script = stand();
    const i = ctx(home, { hookScript: script });
    assert.equal(await main(["hooks", "install", "--config-dir", dir], i.c), EXIT.ok);
    assert.ok(fs.existsSync(settings(dir)), "an explicit directory is created if it is not there");
    const st = ctx(home);
    assert.equal(await main(["hooks", "status", "--config-dir", dir, "--json"], st.c), EXIT.ok);
    const [row] = JSON.parse(st.text());
    assert.deepEqual([row.dir, row.installed, row.healthy, row.events], [dir, true, true, ["SessionStart", "SessionEnd"]]);
    const plain = ctx(home);
    await main(["hooks", "status", "--config-dir", dir], plain.c);
    assert.match(plain.text(), /installed$/);
    const u = ctx(home);
    assert.equal(await main(["hooks", "uninstall", "--config-dir", dir], u.c), EXIT.ok);
    assert.match(u.text(), /removed the Claude Code session hooks/);
    assert.deepEqual(hookCommands(dir), []);
    const again = ctx(home);
    await main(["hooks", "uninstall", "--config-dir", dir], again.c);
    assert.match(again.text(), /no session hooks of ours/);
    assert.equal(await main(["hooks", "install", "--config-dir", dir], ctx(home, { hookScript: script }).c), EXIT.ok);
    fs.rmSync(script);
    const broken = ctx(home);
    await main(["hooks", "status", "--config-dir", dir], broken.c);
    assert.match(broken.text(), /installed, but broken; .*does not exist/);
  });

  test("a hooks command with no or an unknown subcommand is a usage error; a settings file it cannot read is a failure and stays untouched", async () => {
    const home = tmpdir();
    for (const args of [["hooks"], ["hooks", "frobnicate"]]) {
      const u = ctx(home);
      assert.equal(await main(args, u.c), EXIT.usage, args.join(" "));
      assert.match(u.errText(), /usage: claw-connector hooks/);
    }
    const dir = claudeDir(home);
    fs.writeFileSync(settings(dir), "[]");
    const f = ctx(home, { hookScript: stand() });
    assert.equal(await main(["hooks", "install", "--config-dir", dir], f.c), EXIT.failure);
    assert.match(f.errText(), /not a JSON object/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), "[]");
  });

  test("without --config-dir the directories are those of the claude-attach agents; failing that, the default one", async () => {
    const home = tmpdir();
    const a = path.join(home, "cfg-a");
    const b = path.join(home, "cfg-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const dflt = claudeDir(home);
    const agent = (id: string, dir: string | null) => `[[agents]]\nid = "${id}"\npreset = "claude-attach"\nroots = [${JSON.stringify(os.tmpdir())}]\n${dir ? `[agents.env]\nCLAUDE_CONFIG_DIR = ${JSON.stringify(dir)}\n` : ""}`;
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.writeFileSync(path.join(home, "config", "agents.toml"), [agent("one", a), agent("two", b), agent("three", a)].join("\n"));
    const i = ctx(home, { hookScript: stand() });
    assert.equal(await main(["hooks", "install"], i.c), EXIT.ok);
    assert.equal(i.out.length, 2, "two different directories, each once");
    assert.equal(hookCommands(a).length, 2);
    assert.equal(hookCommands(b).length, 2);
    assert.equal(fs.existsSync(settings(dflt)), false, "the default directory is not touched when the agents name theirs");
    // an attach agent that names no directory uses CLAUDE_CONFIG_DIR of the environment, else the home's .claude
    fs.writeFileSync(path.join(home, "config", "agents.toml"), agent("solo", null));
    const j = ctx(home, { hookScript: stand() });
    assert.equal(await main(["hooks", "install"], j.c), EXIT.ok);
    assert.equal(hookCommands(dflt).length, 2);
    // a directory that does not exist, not named explicitly, is not invented
    const k = ctx(tmpdir(), { hookScript: stand() });
    assert.equal(await main(["hooks", "install"], k.c), EXIT.failure);
    assert.match(k.errText(), /no Claude Code directory .*--config-dir/);
  });
});
