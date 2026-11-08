// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The subcommands, run through `main` against a temporary home, a stand-in identity service and a stand-in Claw. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { main, COMMANDS, EXIT, type Ctx } from "../src/commands.js";
import { withThreadPool } from "../src/service.js";
import { PRESETS, parseConfig } from "../src/config.js";
import { processStart } from "../src/children.js";
import { credentialsFile, identityFile, identityKeepFile, pauseFile, resolveDirs, type Dirs } from "../src/paths.js";
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
  fs.writeFileSync(identityKeepFile(dirs), JSON.stringify({ server, connector_id: id }), { mode: 0o600 });
};
const storedId = (dirs: Dirs): any => JSON.parse(fs.readFileSync(identityFile(dirs), "utf8"));
/** Drains the FIFO named by its argument for as long as it lives: every writer that opens it gets its write through. */
const DRAIN = "const fs = require('node:fs'); for (;;) { try { fs.readFileSync(process.argv[1]); } catch { process.exit(0); } }";
/** The adapters children.json records, once it records any (it is written off the event loop, a moment after the start). */
const recordedAdapters = (home: string): number[] | undefined => {
  try {
    const pids = JSON.parse(fs.readFileSync(path.join(home, "state", "children.json"), "utf8")).map((r: any) => r.pid as number);
    return pids.length ? pids : undefined;
  } catch { return undefined; }
};

describe("claw-connector commands", () => {
  test("no command and an unknown one are usage errors; version and help work", async () => {
    const home = tmpdir();
    assert.equal(await main([], ctx(home).c), EXIT.usage);
    const u = ctx(home);
    assert.equal(await main(["frobnicate"], u.c), EXIT.usage);
    assert.match(u.errText(), /unknown command/);
    const v = ctx(home);
    assert.equal(await main(["--version"], v.c), EXIT.ok);
    assert.equal(v.text(), "0.1.13");
    assert.equal(await main(["--help"], ctx(home).c), EXIT.ok);
  });

  // Derived from the command table, so a command added later is covered without touching this test.
  const commandNames = Object.keys(COMMANDS);
  test("every subcommand answers -h and --help with its own help, exit 0, and does nothing else", async () => {
    assert.ok(commandNames.length >= 14, `the command table lists ${commandNames.length} commands`);
    for (const name of commandNames) {
      for (const flag of ["--help", "-h"]) {
        // Also after other arguments, e.g. `hooks install --help` or `pair CODE --server URL -h`.
        for (const argv of [[name, flag], [name, "install", "--json", flag]]) {
          const home = tmpdir();
          const r = ctx(home, { stdin: async () => { throw new Error(`${argv.join(" ")} read stdin`); } });
          assert.equal(await main(argv, r.c), EXIT.ok, `${argv.join(" ")}: ${r.errText()}`);
          assert.equal(r.errText(), "", argv.join(" "));
          assert.ok(r.text().startsWith(`Usage: claw-connector ${name}`), `${argv.join(" ")} printed ${JSON.stringify(r.text().slice(0, 80))}`);
          assert.deepEqual(fs.readdirSync(home), [], `${argv.join(" ")} wrote into the connector home`);
        }
      }
      const h = ctx(tmpdir());
      assert.equal(await main(["help", name], h.c), EXIT.ok);
      assert.ok(h.text().startsWith(`Usage: claw-connector ${name}`), `help ${name}`);
    }
    // The overall help lists every command meant for people, each at the start of its entry.
    const all = ctx(tmpdir());
    assert.equal(await main(["--help"], all.c), EXIT.ok);
    for (const [name, c] of Object.entries(COMMANDS)) {
      const listed = all.text().split("\n").some((l) => l === `  ${name}` || l.startsWith(`  ${name} `));
      assert.equal(listed, !c.hidden, `overall help and ${name}`);
    }
    // After `--` a "--help" is an argument, not a request for help: `stop -- --help` is a usage error.
    assert.equal(await main(["stop", "--", "--help"], ctx(tmpdir()).c), EXIT.usage);
  });

  test("an unknown option is a usage error (exit 2) for every subcommand, with that command's usage", async () => {
    for (const name of commandNames) {
      const home = tmpdir();
      const r = ctx(home, { stdin: async () => { throw new Error(`${name} read stdin`); } });
      assert.equal(await main([name, "--no-such-option"], r.c), EXIT.usage, `${name}: ${r.errText()}`);
      assert.match(r.errText(), /usage: claw-connector/i, name);
      assert.equal(r.text(), "", name);
      assert.deepEqual(fs.readdirSync(home), [], `${name} --no-such-option wrote into the connector home`);
    }
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

  /** The file `init` wrote, as `run` would load it (the root made real, nothing else touched): which agents are on, and which of them do not ask. */
  const loadWritten = (home: string) => {
    const text = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8").replaceAll("~/work", tmpdir("w-"));
    return parseConfig(text, { hostname: "box" }).agents;
  };
  /** The same file with every agent block switched on, as it would be once the owner enables the others: what each block's lines are worth. */
  const loadSample = (home: string) => {
    const root = tmpdir("w-");
    const text = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8")
      .split("\n").map((l) => l.replace(/^# (\[\[agents\]\]|id = "[a-z-]+"|preset = "[a-z-]+"|roots = \[.*\]|approval = "(?:ask|never)")$/, "$1")).join("\n").replaceAll("~/work", root);
    return parseConfig(text, { hostname: "box" }).agents.map((a) => [a.id, a.askMode, a.unattended, a.args.join(" ")]);
  };
  const ASK = [["claude", "default", false, PRESETS.claude!.args.join(" ")], ["claude-attach", "default", false, PRESETS.claude!.args.join(" ")], ["codex", "read-only", false, PRESETS.codex!.args.join(" ")], ["cursor", "ask", false, "acp"]];
  const NEVER = [["claude", "bypassPermissions", true, PRESETS.claude!.args.join(" ")], ["claude-attach", "bypassPermissions", true, PRESETS.claude!.args.join(" ")], ["codex", "agent-full-access", true, PRESETS.codex!.args.join(" ")], ["cursor", "agent", true, "--force acp"]];
  // [name, args, what each agent block is worth once enabled, the agents that are on in the written file and run unattended,
  //  the agents the command says are not on in it (null: it says nothing about any), what it says]
  const initRows: Array<[string, string[], unknown[][], string[], string | null, RegExp]> = [
    ["by default every agent asks, and the output says how to turn that off", [], ASK, [], null, /every agent in this file asks[^]*--approval never/],
    ["--approval ask is the same as nothing", ["--approval", "ask"], ASK, [], null, /every agent in this file asks/],
    ["--approval never: the agents that are on run without per-step approval, with their own mode and flags; the others carry it for when they are enabled", ["--approval", "never"], NEVER, ["claude"], "claude-attach, codex, cursor", /no per-step approval for: claude\.[^]*unattended[^]*set approval = "ask"/],
    ["--approval claude=never: only that agent", ["--approval", "claude=never"], [NEVER[0]!, ASK[1]!, ASK[2]!, ASK[3]!], ["claude"], null, /no per-step approval for: claude\./],
    ["a later setting wins: never for all, but cursor asks", ["--approval", "never", "--approval", "cursor=ask"], [NEVER[0]!, NEVER[1]!, NEVER[2]!, ASK[3]!], ["claude"], "claude-attach, codex", /for: claude\./],
    ["--approval codex=never: codex is not on in the file, so nothing runs unattended and the command says so", ["--approval", "codex=never"], [ASK[0]!, ASK[1]!, NEVER[2]!, ASK[3]!], [], "codex", /every agent in this file asks/],
  ];
  for (const [name, args, expected, unattended, parked, say] of initRows) {
    test(`init ${name}`, async () => {
      const home = tmpdir();
      const a = ctx(home);
      assert.equal(await main(["init", ...args], a.c), EXIT.ok);
      assert.deepEqual(loadSample(home), expected);
      assert.match(a.text(), say);
      if (parked) assert.match(a.text(), new RegExp(`${parked}: not enabled in this file \\(the block is commented out\\), so approval = "never" does nothing there`));
      else assert.doesNotMatch(a.text(), /not enabled/);
      // The file as written, not as the owner might edit it: the agents the command says run without asking are exactly the ones
      // that are on and unattended in it (the message once listed agents the file leaves commented out).
      const all = loadWritten(home);
      // Claude brings the agent that lists the conversations already on the machine, with Claude's own approval setting.
      assert.deepEqual(all.map((x) => x.id), ["claude", "claude-sessions"], "only Claude is on in the sample (and its existing conversations)");
      assert.deepEqual([all[1]!.kind, all[1]!.unattended, all[1]!.attach], ["attach", all[0]!.unattended, { cli: "claude", tmux: "tmux" }]);
      const written = all.filter((x) => x.id !== "claude-sessions");
      assert.deepEqual(written.filter((x) => x.unattended).map((x) => x.id), unattended);
      assert.deepEqual(/no per-step approval for: ([a-z, ]+)\./.exec(a.text())?.[1]?.split(", ") ?? [], unattended);
    });
  }

  test("the way back init writes next to approval = never is setting it to ask, which works whatever else the file says", async () => {
    const home = tmpdir();
    const a = ctx(home);
    await main(["init", "--approval", "claude=never"], a.c);
    const text = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8");
    assert.match(text, /To go back to asking, set it to "ask"/);
    assert.match(a.text(), /To go back, set approval = "ask"/);
    assert.doesNotMatch(text + a.text(), /delete (this|the approval)/i, "deleting the line is not enough when allow_unsafe_modes = true is set");
  });

  for (const args of [["--approval", "sometimes"], ["--approval", "claude=maybe"], ["--approval", "vim=never"], ["--approval"], ["--no-approval"], ["--approval", "=never"]]) {
    test(`init ${args.join(" ")} is refused and writes nothing`, async () => {
      const home = tmpdir();
      const a = ctx(home);
      assert.notEqual(await main(["init", ...args], a.c), EXIT.ok);
      assert.equal(fs.existsSync(path.join(home, "config", "agents.toml")), false);
      assert.ok(a.errText().length > 0);
    });
  }

  test("init --approval never on a file that is there leaves it alone and says how to change it", async () => {
    const home = tmpdir();
    await main(["init"], ctx(home).c);
    const file = path.join(home, "config", "agents.toml");
    const before = fs.readFileSync(file, "utf8");
    const b = ctx(home);
    assert.equal(await main(["init", "--approval", "never"], b.c), EXIT.ok);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.match(b.text(), /already exists; left alone[^]*approval = "ask" or "never" in its \[\[agents\]\] table/);
  });

  test("status says which agents run without per-step approval, in the text and in --json", async () => {
    const home = tmpdir();
    const work = tmpdir("w-");
    const dir = path.join(home, "config");
    fs.mkdirSync(dir, { recursive: true });
    const agent = (id: string, extra: string) => `[[agents]]\nid = "${id}"\ncommand = "x"\nask_mode = "${extra ? "yolo" : "default"}"\n${extra}roots = [${JSON.stringify(work)}]\n`;
    fs.writeFileSync(path.join(dir, "agents.toml"), agent("free", `approval = "never"\n`) + agent("careful", ""));
    const t = ctx(home);
    await main(["status"], t.c);
    assert.match(t.text(), /agents:\s+free \(no per-step approval\), careful\n/);
    const j = ctx(home);
    await main(["status", "--json"], j.c);
    assert.deepEqual([JSON.parse(j.text()).agents, JSON.parse(j.text()).unattended], [["free", "careful"], ["free"]]);
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
    // Each is exit 78: a supervisor must not restart a run that only a person can fix.
    const a = ctx(home);
    assert.equal(await main(["run"], a.c), EXIT.needsPerson);
    assert.match(a.errText(), /agents\.toml/);
    writeConfig(home, work);
    const b = ctx(home);
    assert.equal(await main(["run"], b.c), EXIT.needsPerson);
    assert.match(b.errText(), /not signed in/);
    await main(["login", "--server", "http://127.0.0.1:1", "--key", "k"], ctx(home).c);
    fs.chmodSync(credentialsFile(b.c.dirs), 0o644);
    const d = ctx(home);
    assert.equal(await main(["run"], d.c), EXIT.needsPerson);
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
      // children.json is written off the event loop: a moment after the adapter started.
      await claw.until("the adapter on record", () => recordedAdapters(home));
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
      // A new sign-in (the refresh token expired, say) keeps the row.
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      claw.heartbeats.length = 0;
      await runOnce();
      assert.equal(claw.registered, 1, "no second registration: the stored row is still alive");
      assert.equal(claw.connectorId, id);
      assert.equal(storedId(resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv)).connector_id, id);
      // A sign-out revokes it (a revoked row is not counted against the limit), and the next sign-in registers anew.
      assert.equal(await main(["logout"], ctx(home).c), EXIT.ok);
      assert.equal(claw.revokedIds.has(id), true);
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
      claw.heartbeats.length = 0;
      await runOnce();
      assert.equal(claw.registered, 2);
      assert.notEqual(claw.connectorId, id);
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
        assert.equal(fs.existsSync(identityKeepFile(a.c.dirs)), !revoked, `login --key keeps or forgets connector-id.json with it, revoked=${revoked}`);
        // device path
        id.interval = 0.01;
        id.pollScript = ["ok"];
        seedIdentity(a.c.dirs, "https://x.example", "stored-connector", revoked);
        assert.equal(await main(["login", "--server", "https://x.example", "--identity-url", id.url], ctx(home).c), EXIT.ok);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), !revoked, `login device, revoked=${revoked}`);
        assert.equal(fs.existsSync(identityKeepFile(a.c.dirs)), !revoked, `login device keeps or forgets connector-id.json with it, revoked=${revoked}`);
        // logout, with Claw out of reach: a revoked row needs nothing of it; a live one cannot be revoked, so its id stays
        seedIdentity(a.c.dirs, "https://x.example", "stored-connector", revoked);
        const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
        assert.equal(await main(["logout"], ctx(home, { fetch: offline }).c), revoked ? EXIT.ok : EXIT.failure);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), !revoked, `logout, revoked=${revoked}`);
        assert.equal(fs.existsSync(identityKeepFile(a.c.dirs)), !revoked, `logout keeps or forgets connector-id.json with it, revoked=${revoked}`);
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
      const adapters: number[] = await claw.until("the adapter on record", () => recordedAdapters(home));
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

  test("a state directory that stops answering stops no heartbeat: events wait for the disk and go once it answers", async () => {
    // A FIFO nobody reads blocks whoever opens it to write, as a stalled network disk blocks a write: connector.json's,
    // sessions.json's (records and running turns) and children.json's temporary files, the audit trail, the adapter log and
    // the session's outbox log all become one (seven stuck calls: more than libuv's default four threads). Before, the first blocked write froze the
    // whole process (heartbeat included) until the disk came back.
    const claw = await FakeClaw.start();
    const home = tmpdir();
    const work = tmpdir("w-");
    writeConfig(home, work);
    await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c);
    const here = path.dirname(new URL(import.meta.url).pathname);
    const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [path.join(here, "support", "run-fast.ts")], { env: withThreadPool({ ...process.env, CLAW_CONNECTOR_HOME: home }), stdio: "ignore", detached: true });
    const readers: Array<ReturnType<typeof spawn>> = [];
    // Made beside the file and renamed over it: the running connector may write the file again between a remove and
    // a mkfifo (the outbox log, while the session starts), which made mkfifo fail with EEXIST.
    const fifo = (file: string) => {
      const tmp = `${file}.fifo`;
      const r = spawnSync("mkfifo", ["-m", "600", tmp]);
      assert.equal(r.status, 0, `mkfifo ${tmp}: ${r.stderr}`);
      fs.renameSync(tmp, file);
    };
    try {
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0, 20_000);
      const sid = claw.newSession("fake", work);
      await claw.until("started", () => claw.eventsOf(sid, "session_started")[0], 10_000);
      const state = path.join(home, "state");
      const log = fs.readdirSync(path.join(state, "outbox")).find((n) => n.endsWith(".jsonl"))!;
      const blocked = ["connector.json.tmp", "sessions.json.tmp", "sessions.json.turns.tmp", "children.json.tmp", "audit.jsonl", path.join("logs", "adapter-fake.log"), path.join("outbox", log)]
        .map((f) => path.join(state, f));
      for (const f of blocked) fifo(f);

      claw.issue("prompt", sid, { text: "say stuck" });
      // A second session meanwhile: its record, its adapter's pid and its log all wait on the disk.
      claw.newSession("fake", work);
      const before = claw.heartbeats.length;
      await sleep(2_000);
      const during = claw.heartbeats.length - before;
      assert.ok(during >= 8, `heartbeats went on while the disk did not answer: ${during} in 2 s at 100 ms`);
      assert.ok(claw.online, "the command stream is still open");
      assert.equal(claw.eventsOf(sid, "turn_end").length, 0, "the turn's events wait until their lines are written");

      // The disk answers again (each FIFO drained by a reader from now on): the events go. (An event waits for the record
      // it depends on, so the session record and the others must answer too, as they would on a disk that came back.)
      for (const f of blocked) {
        // A reader with no shell: each read blocks until a writer opens the FIFO, then the next waits for the next writer.
        readers.push(spawn(process.execPath, ["-e", DRAIN, f], { stdio: "ignore", detached: true }));
      }
      await claw.until("the turn's end, once the disk answers", () => claw.eventsOf(sid, "turn_end")[0], 10_000);
    } finally {
      for (const p of [child, ...readers]) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
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
      const adapters: number[] = await claw.until("the adapter on record", () => recordedAdapters(home));
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

  describe("logout revokes the connector at Claw before it deletes the sign-in", () => {
    const deviceCreds = (dirs: Dirs, server: string, identityUrl: string, refresh: string) => {
      fs.mkdirSync(path.dirname(credentialsFile(dirs)), { recursive: true });
      fs.writeFileSync(credentialsFile(dirs), JSON.stringify({ v: 1, server, kind: "device", identity_url: identityUrl, client_id: "claw-connector", refresh_token: refresh, saved_at: "" }), { mode: 0o600 });
    };

    test("a key: the row is revoked with the user-side DELETE, then the sign-in and the stored id are deleted", async () => {
      const claw = await FakeClaw.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
        seedIdentity(a.c.dirs, claw.url, claw.connectorId);
        assert.equal(await main(["logout"], a.c), EXIT.ok);
        assert.deepEqual(claw.revocations, [{ method: "DELETE", id: claw.connectorId, auth: "Bearer good-token" }]);
        assert.equal(claw.revoked, true, "Claw sends the row nothing more");
        assert.match(a.text(), new RegExp(`revoked connector ${claw.connectorId}[^]*signed out`));
        assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), false, "a revoked row is forgotten, so the next run registers anew");
      } finally { await claw.close(); }
    });

    test("a device sign-in: the row is revoked on the connector-side route with a fresh access token, then the rotated refresh token is revoked", async () => {
      const claw = await FakeClaw.start();
      const id = await FakeIdentity.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        id.refreshTokens.add("r9");
        claw.tokens.add("access-1");
        deviceCreds(a.c.dirs, claw.url, id.url, "r9");
        seedIdentity(a.c.dirs, claw.url, claw.connectorId);
        assert.equal(await main(["logout"], a.c), EXIT.ok, a.errText());
        assert.deepEqual(claw.revocations, [{ method: "POST", id: claw.connectorId, auth: "Bearer access-1" }]);
        assert.equal(claw.revoked, true);
        // The refresh to get the access token rotated r9 into refresh-1: the live one is what must be revoked.
        assert.deepEqual(id.revokedTokens, ["refresh-1"]);
        assert.equal(id.refreshTokens.size, 0, "no refresh token of this sign-in is left alive");
        assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), false);
      } finally { await claw.close(); await id.close(); }
    });

    test("Claw unreachable: signed out here, told the row is alive and how to revoke it, exit not 0, and the key is never printed", async () => {
      const claw = await FakeClaw.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
        seedIdentity(a.c.dirs, claw.url, claw.connectorId);
        claw.unavailable = 10;
        assert.equal(await main(["logout"], a.c), EXIT.failure);
        assert.equal(claw.revoked, false);
        assert.doesNotMatch(a.text(), /signed out$/m, "it does not claim a clean sign-out");
        assert.match(a.errText(), new RegExp(`signed out on this machine, but connector ${claw.connectorId} was NOT revoked at Claw`));
        assert.ok(a.errText().includes(`curl -fsS -X DELETE -H "Authorization: Bearer <your Claw API key>" ${claw.url}/v1/remote-agents/connectors/${claw.connectorId}`), a.errText());
        assert.doesNotMatch(a.text() + a.errText(), /good-token/);
        assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false, "the sign-in is deleted all the same");
        assert.equal(storedId(a.c.dirs).connector_id, claw.connectorId, "the live row's id is kept, so a later sign-in reuses it");
      } finally { await claw.close(); }
    });

    test("a device sign-in and a Claw from before the connector-side route: not revoked, said so, exit not 0; the sign-in is still revoked", async () => {
      const claw = await FakeClaw.start();
      const id = await FakeIdentity.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        claw.revokeRoute = false;
        id.refreshTokens.add("r9");
        claw.tokens.add("access-1");
        claw.tokens.add("access-2");
        deviceCreds(a.c.dirs, claw.url, id.url, "r9");
        seedIdentity(a.c.dirs, claw.url, claw.connectorId);
        assert.equal(await main(["logout"], a.c), EXIT.failure);
        assert.equal(claw.revoked, false);
        assert.match(a.errText(), /was NOT revoked at Claw \(.*401 authentication_required\)/);
        assert.equal(id.refreshTokens.size, 0, "the sign-in itself is revoked");
        assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
        assert.equal(storedId(a.c.dirs).connector_id, claw.connectorId);
      } finally { await claw.close(); await id.close(); }
    });

    test("a row stored for another server than this sign-in's: no credential is sent to either server, said so, exit not 0", async () => {
      const a = await FakeClaw.start();
      const b = await FakeClaw.start();
      const id = await FakeIdentity.start();
      try {
        for (const kind of ["key", "device"] as const) {
          const home = tmpdir();
          const c = ctx(home);
          // Signed in to A and ran there; then signed in to B.
          assert.equal(await main(["login", "--server", a.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
          seedIdentity(c.c.dirs, a.url, a.connectorId);
          if (kind === "key") {
            b.tokens.add("key-b");
            assert.equal(await main(["login", "--server", b.url, "--key", "key-b"], ctx(home).c), EXIT.ok);
          } else {
            id.refreshTokens.add("rb");
            deviceCreds(c.c.dirs, b.url, id.url, "rb");
          }
          a.requests.length = 0;
          b.requests.length = 0;
          assert.equal(await main(["logout"], c.c), EXIT.failure, kind);
          assert.deepEqual(a.requests, [], `${kind}: nothing reached A, so B's credential was not handed to it`);
          assert.deepEqual(b.requests, [], `${kind}: nor B, which never had this row`);
          assert.equal(a.revoked, false);
          assert.match(c.errText(), new RegExp(`connector ${a.connectorId} was NOT revoked at Claw \\(it was registered at ${a.url}, but this sign-in is for ${b.url}`));
          assert.ok(c.errText().includes(`${a.url}/v1/remote-agents/connectors/${a.connectorId}`), c.errText());
          assert.doesNotMatch(c.text() + c.errText(), /key-b|good-token|access-/);
          assert.equal(storedId(c.c.dirs).connector_id, a.connectorId);
          assert.equal(fs.existsSync(credentialsFile(c.c.dirs)), false);
        }
      } finally { await a.close(); await b.close(); await id.close(); }
    });

    test("a row Claw already revoked (or never had for this account) is reported and forgotten, and is a clean sign-out", async () => {
      const claw = await FakeClaw.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
        seedIdentity(a.c.dirs, claw.url, claw.connectorId);
        claw.revoke();
        assert.equal(await main(["logout"], a.c), EXIT.ok);
        assert.match(a.text(), /no live connector[^]*signed out/);
        assert.equal(fs.existsSync(identityFile(a.c.dirs)), false);
      } finally { await claw.close(); }
    });

    test("no sign-in left but a live row stored: told it is alive and how to revoke it, exit not 0", async () => {
      const home = tmpdir();
      const a = ctx(home);
      seedIdentity(a.c.dirs, "https://claw.example/claw-api", "stored-connector");
      assert.equal(await main(["logout"], a.c), EXIT.failure);
      assert.match(a.errText(), /stored-connector was NOT revoked at Claw \(this machine is not signed in\)/);
      assert.match(a.errText(), /https:\/\/claw\.example\/claw-api\/v1\/remote-agents\/connectors\/stored-connector/);
    });

    test("nothing registered: nothing to revoke at Claw, and a clean sign-out", async () => {
      const claw = await FakeClaw.start();
      try {
        const home = tmpdir();
        const a = ctx(home);
        assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], ctx(home).c), EXIT.ok);
        assert.equal(await main(["logout"], a.c), EXIT.ok);
        assert.deepEqual(claw.revocations, []);
        assert.equal(a.text(), "signed out");
      } finally { await claw.close(); }
    });
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

  test("init with nobody to ask leaves Claude Code's settings alone and prints the command that would add the hooks", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    const mine = JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } }, null, 2);
    fs.writeFileSync(settings(dir), mine);
    const a = ctx(home, { hookScript: stand() });
    assert.equal(await main(["init"], a.c), EXIT.ok);
    assert.ok(fs.existsSync(path.join(home, "config", "agents.toml")), "the sample is still written");
    assert.equal(fs.readFileSync(settings(dir), "utf8"), mine, "settings.json byte for byte as it was");
    assert.match(a.text(), /left .*settings\.json alone \(no terminal to ask in\).*claw-connector hooks install/);
    const bare = tmpdir();
    const bareDir = claudeDir(bare);
    assert.equal(await main(["init"], ctx(bare, { hookScript: stand() }).c), EXIT.ok);
    assert.equal(fs.existsSync(settings(bareDir)), false, "and no settings.json is created where there was none");
  });

  test("init at a terminal asks first: no leaves the settings alone, yes installs the hooks once; run again it neither asks nor changes anything", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    fs.writeFileSync(settings(dir), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } }, null, 2));
    const before = fs.readFileSync(settings(dir), "utf8");
    const script = stand();
    const asked: string[] = [];
    const no = ctx(home, { hookScript: script, ask: async (q) => { asked.push(q); return false; } });
    assert.equal(await main(["init"], no.c), EXIT.ok);
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /settings\.json.*\[y\/N\]/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), before);
    assert.match(no.text(), /left .*settings\.json alone\. .*claw-connector hooks install/);
    const yes = ctx(home, { hookScript: script, ask: async (q) => { asked.push(q); return true; } });
    assert.equal(await main(["init"], yes.c), EXIT.ok);
    assert.equal(asked.length, 2);
    assert.match(yes.text(), /installed the Claude Code session hooks in .*settings\.json/);
    const cmds = hookCommands(dir);
    assert.equal(cmds.filter((c) => c.includes("terminal-hook.js") && c.includes(`--dir '${dir}'`)).length, 2);
    assert.ok(cmds.includes("mine.sh"), "the user's own hook is still there");
    assert.equal(JSON.parse(fs.readFileSync(settings(dir), "utf8")).model, "opus");
    const bytes = fs.readFileSync(settings(dir), "utf8");
    const again = ctx(home, { hookScript: script, ask: async (q) => { asked.push(q); return false; } });
    assert.equal(await main(["init"], again.c), EXIT.ok);
    assert.equal(asked.length, 2, "hooks of ours already there are not asked about again");
    assert.match(again.text(), /session hooks are already in/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), bytes);
  });

  test("init --hooks installs without asking; --hooks with --no-hooks is a usage error", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    const a = ctx(home, { hookScript: stand(), ask: async () => assert.fail("--hooks must not ask") });
    assert.equal(await main(["init", "--hooks"], a.c), EXIT.ok);
    assert.match(a.text(), /installed the Claude Code session hooks/);
    assert.equal(hookCommands(dir).filter((c) => c.includes("terminal-hook.js")).length, 2);
    const both = ctx(tmpdir(), { hookScript: stand() });
    assert.equal(await main(["init", "--hooks", "--no-hooks"], both.c), EXIT.usage);
    assert.match(both.errText(), /contradict/);
  });

  test("init --no-hooks leaves Claude Code alone; with no Claude directory it says how to do it later and creates nothing", async () => {
    const home = tmpdir();
    const dir = claudeDir(home);
    const a = ctx(home, { hookScript: stand(), ask: async () => assert.fail("--no-hooks must not ask") });
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
    assert.equal(await main(["init", "--hooks"], a.c), EXIT.ok);
    assert.ok(fs.existsSync(path.join(home, "config", "agents.toml")));
    assert.match(a.errText(), /hooks: .*not valid JSON/);
    assert.equal(fs.readFileSync(settings(dir), "utf8"), "{ not json");
  });

  test("a source checkout that was not built has no hook script: init says so and still succeeds", async () => {
    const home = tmpdir();
    claudeDir(home);
    const a = ctx(home, { ask: async () => true });
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
