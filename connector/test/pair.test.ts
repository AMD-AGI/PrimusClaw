// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `claw-connector pair`: a one-time code from the chat, traded at Claw for this machine's sign-in, then the connector. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { main, EXIT, setupHooks, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { alternateName, chooseAgents, cmdPair, defaultRoot, detectAgents, pairedConfig } from "../src/pair.js";
import { defaultDeps, presetSignInProblem, type DoctorDeps } from "../src/doctor.js";
import { credentialsFile, identityFile, identityKeepFile, resolveDirs } from "../src/paths.js";
import { saveCredentials } from "../src/credentials.js";
import { FakeClaw } from "./support/fake-claw.js";
import { tmpdir } from "./support/harness.js";

const GRANT = `cpg_${"g".repeat(43)}`;

/** How `pair` finds the sign-ins here (doctor.ts, its programs answering as below): each agent signed in, unless named in `out`. */
function signIns(out: string[] = []): DoctorDeps {
  return defaultDeps({}, {
    platform: "linux", home: tmpdir("pair-signin-"),
    probe: async (cmd) => {
      const tool = path.basename(cmd);
      if (tool === "claude") return { code: 0, out: JSON.stringify({ loggedIn: !out.includes("claude") }) };
      if (tool === "codex") return out.includes("codex") ? { code: 1, out: "Not logged in" } : { code: 0, out: "Logged in using ChatGPT" };
      return { code: null, out: "" };
    },
  });
}

function ctx(home: string, extra: Partial<Ctx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: Ctx = {
    dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config") },
    out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", doctor: signIns(), ...extra,
  };
  return { c, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

/** A PATH with these programs on it, as empty executables. */
function fakePath(...bins: string[]): string {
  const dir = tmpdir("bin-");
  for (const b of bins) fs.writeFileSync(path.join(dir, b), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

/** Claw's claim route answered here (`answer`), everything else passed on to the real network (the stand-in Claw). */
function claimFetch(answer: (body: any) => { status: number; body: unknown }, seen: any[]): typeof fetch {
  return (async (u: any, init: any) => {
    if (String(u).endsWith("/v1/remote-agents/pairings/claim")) {
      const body = JSON.parse(String(init.body));
      seen.push({ url: String(u), body });
      const a = answer(body);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    return fetch(u, init);
  }) as typeof fetch;
}

describe("claw-connector pair", () => {
  test("a good code writes agents.toml for the agents found here, saves the grant, and run registers with it", async () => {
    const claw = await FakeClaw.start();
    let running: Promise<number> | undefined;
    let connector: { stop(): void } | undefined;
    try {
      const home = tmpdir();
      const work = tmpdir("w-");
      const seen: any[] = [];
      const f = claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT, server: claw.url } } }), seen);
      // A connector id of an earlier sign-in, which is not this grant's.
      fs.mkdirSync(resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv).state, { recursive: true });
      fs.writeFileSync(identityFile(resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv)), JSON.stringify({ server: claw.url, connector_id: "old", cursor: 0, handled: [] }));
      fs.writeFileSync(identityKeepFile(resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv)), JSON.stringify({ server: claw.url, connector_id: "old" }));
      const a = ctx(home, { fetch: f, cwd: work, env: { PATH: fakePath("claude", "codex"), CLAUDE_CONFIG_DIR: path.join(home, "cc") } });
      assert.equal(await main(["pair", "abcd-efgh-jkmn", "--server", claw.url, "--no-start"], a.c), EXIT.ok, a.errText());
      // The hostname, and the name to use instead should it be another machine of theirs: it and the folder.
      assert.deepEqual(seen.map((s) => s.body), [{ code: "abcd-efgh-jkmn", name: "box", alternate_name: `box-${path.basename(work)}` }]);
      const toml = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8");
      const cfg = parseConfig(toml, { hostname: "box" });
      // (A claude agent also brings the machine's own Claude conversations, `claude-sessions`, by itself.)
      assert.deepEqual(cfg.agents.filter((x) => x.id !== "claude-sessions").map((x) => [x.id, x.roots, x.unattended]), [["claude", [work], false], ["codex", [work], false]]);
      assert.equal(cfg.server, claw.url);
      const saved = JSON.parse(fs.readFileSync(credentialsFile(a.c.dirs), "utf8"));
      assert.deepEqual([saved.kind, saved.token, saved.server, saved.device_name], ["grant", GRANT, claw.url, "box"]);
      assert.equal(fs.statSync(credentialsFile(a.c.dirs)).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(identityFile(a.c.dirs)), false, "the earlier connector id is forgotten: this grant registers anew");
      assert.equal(fs.existsSync(identityKeepFile(a.c.dirs)), false, "connector-id.json too, or a damaged connector.json would bring the earlier id back");
      assert.doesNotMatch(a.text() + a.errText(), new RegExp(GRANT), "the grant is never printed");

      // The grant is the bearer `run` presents, and it registers a connector.
      claw.tokens.add(GRANT);
      fs.writeFileSync(path.join(home, "config", "agents.toml"), `server = ${JSON.stringify(claw.url)}\n[[agents]]\nid = "fake"\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", "setInterval(()=>{},1000)"]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
      const r = ctx(home, { timing: { heartbeatMs: 150, pausePollMs: 40, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100 }, onConnector: (cn) => { connector = cn; } });
      running = main(["run"], r.c);
      await claw.until("online", () => claw.online && claw.heartbeats.length > 0);
      assert.equal(claw.registered, 1);
      assert.ok(claw.requests.every((q) => q.auth === `Bearer ${GRANT}`));
      connector!.stop();
      assert.equal(await running, EXIT.ok);
      running = undefined;
      // logout revokes it with the connector-side route, which a grant reaches.
      assert.equal(await main(["logout"], ctx(home).c), EXIT.ok);
      assert.deepEqual(claw.revocations.map((x) => [x.method, x.auth]), [["POST", `Bearer ${GRANT}`]]);
      assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
      // Revoked at Claw while running: a paired machine is told to pair again, not to log in.
      saveCredentials(credentialsFile(a.c.dirs), { v: 1, server: claw.url, kind: "grant", token: GRANT, saved_at: "" });
      const rv = ctx(home, { timing: { heartbeatMs: 150, pausePollMs: 40, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100 } });
      const again = main(["run"], rv.c);
      await claw.until("registered again", () => claw.online);
      claw.revoke();
      assert.equal(await again, EXIT.revoked);
      assert.match(rv.errText(), /this connector was revoked: every agent was stopped. Pair it again: ask the chat for a new pairing command/);
      // Started again afterwards (by the service, or by hand), and asked for its status: still told to pair, never to log in,
      // which a paired machine never did. A machine signed in with login is still told to log in.
      const rerun = ctx(home);
      assert.equal(await main(["run"], rerun.c), EXIT.needsPerson);
      assert.match(rerun.errText(), /not starting: .*Pair it again: ask the chat for a new pairing command \("连接我的开发环境"\)/s);
      assert.doesNotMatch(rerun.errText(), /claw-connector login/);
      const st = ctx(home);
      assert.equal(await main(["status"], st.c), EXIT.ok);
      assert.match(st.text(), /needs a new sign-in: .*; ask the chat for a new pairing command/);
      assert.doesNotMatch(st.text(), /claw-connector login/);
      saveCredentials(credentialsFile(a.c.dirs), { v: 1, server: claw.url, kind: "key", key: "k", saved_at: "" });
      const keyed = ctx(home);
      assert.equal(await main(["run"], keyed.c), EXIT.needsPerson);
      assert.match(keyed.errText(), /not starting: .*Sign in again \(claw-connector login\)/s);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  });

  test("a hostname another of their machines has: paired under the name Claw gives back (hostname and folder), said once", async () => {
    const home = tmpdir();
    const work = path.join(tmpdir("w-"), "proj");
    fs.mkdirSync(work);
    const seen: any[] = [];
    const a = ctx(home, {
      fetch: claimFetch((b) => ({ status: 201, body: { ok: true, data: { token: GRANT, name: b.alternate_name } } }), seen),
      cwd: work, env: { PATH: fakePath("claude"), USER: "alice", CLAUDE_CONFIG_DIR: path.join(home, "cc") },
    });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], a.c), EXIT.ok, a.errText());
    assert.deepEqual(seen[0].body, { code: "ABCD-EFGH-JKMN", name: "box", alternate_name: "box-proj" });
    assert.equal(parseConfig(fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8"), { hostname: "box" }).name, "box-proj");
    assert.equal(JSON.parse(fs.readFileSync(credentialsFile(a.c.dirs), "utf8")).device_name, "box-proj");
    assert.match(a.text(), /another of your machines is already called "box": this one is "box-proj" \(choose another with --name\)/);
    assert.match(a.text(), /paired "box-proj" with/);

    // A name the person chose (--name) is never swapped: no alternate is sent, and an answer naming another is not taken.
    const home2 = tmpdir();
    const seen2: any[] = [];
    const b = ctx(home2, { fetch: claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT, name: "other" } } }), seen2), cwd: work });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--name", "mine", "--no-start"], b.c), EXIT.ok, b.errText());
    assert.deepEqual(seen2[0].body, { code: "ABCD-EFGH-JKMN", name: "mine" });
    assert.equal(parseConfig(fs.readFileSync(path.join(home2, "config", "agents.toml"), "utf8"), { hostname: "box" }).name, "mine");
  });

  test("the alternate name: hostname and folder, or the user in the home directory, in safe characters", () => {
    assert.equal(alternateName("box", "/work/my repo!", "alice"), "box-my-repo");
    assert.equal(alternateName("box", os.homedir(), "alice"), "box-alice");
    assert.equal(alternateName("box", "/", null), "box");
    assert.equal(alternateName("h".repeat(64), "/w/proj", null).length <= 64, true);
  });

  test("a wrong, expired or used code writes nothing and exits 78 with what to do", async () => {
    const home = tmpdir();
    const a = ctx(home, { fetch: claimFetch(() => ({ status: 400, body: { ok: false, error: "invalid_code" } }), []), cwd: tmpdir("w-") });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api"], a.c), EXIT.needsPerson);
    assert.match(a.errText(), /not valid.*expired.*连接我的开发环境/s);
    assert.equal(fs.existsSync(path.join(home, "config", "agents.toml")), false);
    assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), false);
  });

  test("an agents.toml already here is kept; Claw out of reach, no server, plain http and a missing code are refused", async () => {
    const home = tmpdir();
    const work = tmpdir("w-");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    const mine = `server = "https://claw.example/api"\nname = "mine"\n[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(work)}]\n`;
    fs.writeFileSync(path.join(home, "config", "agents.toml"), mine);
    const seen: any[] = [];
    const ok = ctx(home, { fetch: claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), seen), cwd: "/" });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--no-start"], ok.c), EXIT.ok, ok.errText());
    assert.equal(seen[0].url, "https://claw.example/api/v1/remote-agents/pairings/claim", "the server and name of the file are used");
    assert.equal(seen[0].body.name, "mine");
    assert.equal(fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8"), mine);
    assert.match(ok.text(), /kept/);

    // An agents.toml or CLAW_URL naming another Claw: refused before the code is spent.
    const spent: any[] = [];
    const other = ctx(home, { fetch: claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), spent) });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://other.example/api", "--no-start"], other.c), EXIT.usage);
    assert.match(other.errText(), /names another Claw/);
    const env = ctx(tmpdir(), { fetch: claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), spent), env: { CLAW_URL: "https://env.example/api" } });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], env.c), EXIT.usage);
    assert.deepEqual(spent, [], "no code was spent");

    const offline = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const b = ctx(tmpdir(), { fetch: offline });
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api"], b.c), EXIT.failure);
    assert.match(b.errText(), /could not reach Claw/);
    const c = ctx(tmpdir());
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN"], c.c), EXIT.usage);
    assert.match(c.errText(), /--server/);
    assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "http://claw.example/api"], ctx(tmpdir()).c), EXIT.failure);
    assert.equal(await main(["pair", "--server", "https://claw.example/api"], ctx(tmpdir()).c), EXIT.usage);
  });

  test("an agents.toml that appears while the code is being claimed is held to the same server rule", async () => {
    for (const [server, expected] of [["https://elsewhere.example/api", EXIT.needsPerson], ["https://claw.example/api", EXIT.ok]] as const) {
      const home = tmpdir();
      const file = path.join(home, "config", "agents.toml");
      const appear = () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `server = ${JSON.stringify(server)}\n[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(tmpdir("w-"))}]\n`);
        return { status: 201, body: { ok: true, data: { token: GRANT } } };
      };
      const a = ctx(home, { fetch: claimFetch(appear, []), cwd: tmpdir("w-") });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], a.c), expected, a.errText());
      assert.equal(fs.existsSync(credentialsFile(a.c.dirs)), expected === EXIT.ok, server);
    }
  });

  describe("the Claude Code hooks, offered as init offers them", () => {
    const stand = (name: string): string => { const f = path.join(tmpdir("pair-hookbin-"), name); fs.writeFileSync(f, "// stand-in\n"); return f; };
    const scripts = () => ({ hookScript: stand("terminal-hook.js"), approvalHookScript: stand("approval-hook.js") });
    const commands = (dir: string): string[] => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      return Object.values<any>(doc.hooks ?? {}).flatMap((groups) => groups.flatMap((g: any) => g.hooks.map((h: any) => h.command as string)));
    };
    const granted = () => claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), []);
    const setup = (home: string) => {
      const cc = path.join(home, "cc");
      fs.mkdirSync(cc, { recursive: true });
      fs.writeFileSync(path.join(cc, "settings.json"), JSON.stringify({ model: "opus" }, null, 2));
      return cc;
    };

    test("at a terminal, Enter installs the session and approval hooks after the pairing and before the connector starts", async () => {
      const home = tmpdir();
      const cc = setup(home);
      const order: string[] = [];
      const asked: Array<[string, boolean | undefined]> = [];
      const a = ctx(home, {
        fetch: granted(), cwd: tmpdir("w-"), env: { PATH: fakePath("claude"), CLAUDE_CONFIG_DIR: cc }, ...scripts(),
        ask: async (q, d) => { asked.push([q, d]); order.push("asked"); return d ?? false; },
      });
      const rc = await cmdPair(["ABCD-EFGH-JKMN", "--server", "https://claw.example/api"], a.c, {
        runningPid: () => null, stop: async () => undefined, hooks: setupHooks,
        start: async () => { order.push("started"); return 0; },
      });
      assert.equal(rc, 0, a.errText());
      assert.deepEqual(order, ["asked", "started"]);
      assert.deepEqual(asked, [["Add them? [Y/n] ", true]]);
      const cmds = commands(cc);
      assert.equal(cmds.filter((c) => c.includes("terminal-hook.js")).length, 2);
      assert.equal(cmds.filter((c) => c.includes("approval-hook.js") && c.includes(path.join(a.c.dirs.state, "approvals.sock"))).length, 6);
      assert.equal(JSON.parse(fs.readFileSync(path.join(cc, "settings.json"), "utf8")).model, "opus");
      assert.match(a.text(), /paired "box"[\s\S]*installed the approval hooks[\s\S]*is coming online/);
    });

    test("a no, nobody to ask, or --no-hooks leaves Claude Code's settings alone and the pairing goes on; --hooks with --no-hooks is refused before the code is spent", async () => {
      for (const [how, args, ask] of [
        ["no", [], async () => false],
        ["no terminal", [], undefined],
        ["--no-hooks", ["--no-hooks"], async () => assert.fail("--no-hooks must not ask")],
      ] as const) {
        const home = tmpdir();
        const cc = setup(home);
        const before = fs.readFileSync(path.join(cc, "settings.json"), "utf8");
        const a = ctx(home, { fetch: granted(), cwd: tmpdir("w-"), env: { PATH: fakePath("claude"), CLAUDE_CONFIG_DIR: cc }, ...scripts(), ...(ask ? { ask } : {}) });
        assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start", ...args], a.c), EXIT.ok, `${how}: ${a.errText()}`);
        assert.equal(fs.readFileSync(path.join(cc, "settings.json"), "utf8"), before, how);
        assert.ok(fs.existsSync(credentialsFile(a.c.dirs)), `${how}: still paired`);
        if (how !== "--no-hooks") assert.match(a.text(), /did not add the Claude Code hooks .*claw-connector hooks install --approvals/, how);
        if (how === "no terminal") assert.match(a.text(), /no terminal to ask in/);
      }
      const spent: any[] = [];
      const both = ctx(tmpdir(), { fetch: claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), spent) });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--hooks", "--no-hooks"], both.c), EXIT.usage);
      assert.match(both.errText(), /contradict/);
      assert.deepEqual(spent, []);
    });

    test("Claude Code installed but never run here (no config directory yet): the same question, and Enter creates the directory with the hooks; a no or no terminal creates nothing", async () => {
      for (const [how, ask] of [["enter", async (_q: string, d?: boolean) => d ?? false], ["no", async () => false], ["no terminal", undefined]] as const) {
        const home = tmpdir();
        const cc = path.join(home, "never-run", ".claude");
        const asked: string[] = [];
        const a = ctx(home, {
          fetch: granted(), cwd: tmpdir("w-"), env: { PATH: fakePath("claude"), CLAUDE_CONFIG_DIR: cc }, ...scripts(),
          ...(ask ? { ask: async (q: string, d?: boolean) => { asked.push(q); return ask(q, d); } } : {}),
        });
        assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], a.c), EXIT.ok, `${how}: ${a.errText()}`);
        assert.ok(fs.existsSync(credentialsFile(a.c.dirs)), `${how}: paired`);
        assert.doesNotMatch(a.text(), /not installed|once you use Claude Code/, how);
        if (how === "enter") {
          assert.deepEqual(asked, ["Add them? [Y/n] "]);
          assert.match(a.text(), /Claude Code has not run here yet: .* is created with only entries marked --managed-by claw-connector/);
          const cmds = commands(cc);
          assert.equal(cmds.filter((c) => c.includes("terminal-hook.js")).length, 2);
          assert.equal(cmds.filter((c) => c.includes("approval-hook.js")).length, 6);
          assert.match(a.text(), /installed the approval hooks/);
        } else {
          assert.equal(fs.existsSync(cc), false, `${how}: nothing created`);
          assert.match(a.text(), /did not add the Claude Code hooks .*claw-connector hooks install --approvals/, how);
        }
      }
    });

    test("Claude Code not installed here: nothing asked or created, and the command to run once it is; --hooks adds them anyway", async () => {
      const home = tmpdir();
      const cc = path.join(home, ".claude");
      const a = ctx(home, { fetch: granted(), cwd: tmpdir("w-"), env: { PATH: fakePath("codex"), CLAUDE_CONFIG_DIR: cc }, ...scripts(), ask: async () => assert.fail("nothing to ask about") });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], a.c), EXIT.ok, a.errText());
      assert.equal(fs.existsSync(cc), false);
      assert.match(a.text(), /Claude Code is not installed here \(no claude on PATH\), so its hooks were not added; once you install it, run: claw-connector hooks install --approvals/);
      const forced = tmpdir();
      const fc = path.join(forced, ".claude");
      const b = ctx(forced, { fetch: granted(), cwd: tmpdir("w-"), env: { PATH: "", CLAUDE_CONFIG_DIR: fc }, ...scripts(), ask: async () => assert.fail("--hooks must not ask") });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start", "--hooks"], b.c), EXIT.ok, b.errText());
      assert.equal(commands(fc).filter((c) => c.includes("approval-hook.js")).length, 6);
    });

    test("paired again on a machine that has the hooks: nothing asked, nothing changed", async () => {
      const home = tmpdir();
      const cc = setup(home);
      const s = scripts();
      const first = ctx(home, { fetch: granted(), cwd: tmpdir("w-"), env: { PATH: fakePath("claude"), CLAUDE_CONFIG_DIR: cc }, ...s, ask: async () => true });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], first.c), EXIT.ok, first.errText());
      const bytes = fs.readFileSync(path.join(cc, "settings.json"), "utf8");
      const again = ctx(home, { fetch: granted(), env: { PATH: fakePath("claude"), CLAUDE_CONFIG_DIR: cc }, ...s, ask: async () => assert.fail("asked again") });
      assert.equal(await main(["pair", "ABCD-EFGH-JKMN", "--server", "https://claw.example/api", "--no-start"], again.c), EXIT.ok, again.errText());
      assert.equal(fs.readFileSync(path.join(cc, "settings.json"), "utf8"), bytes);
      assert.match(again.text(), /approval hooks are already in/);
    });
  });

  test("an agent installed but not signed in is written commented out, with what to run before turning it on", async () => {
    const home = tmpdir();
    const work = tmpdir("w-");
    const f = claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), []);
    // claude and codex on PATH, Codex never signed in (codex login status: "Not logged in").
    const a = ctx(home, { fetch: f, cwd: work, env: { PATH: fakePath("claude", "codex"), CLAUDE_CONFIG_DIR: path.join(home, "cc") }, doctor: signIns(["codex"]) });
    assert.equal(await main(["pair", "abcd-efgh-jkmn", "--server", "https://claw.example/api", "--no-start"], a.c), EXIT.ok, a.errText());
    const file = path.join(home, "config", "agents.toml");
    const toml = fs.readFileSync(file, "utf8");
    assert.deepEqual(parseConfig(toml, { hostname: "box" }).agents.map((x) => x.id), ["claude", "claude-sessions"], "codex is not turned on");
    assert.match(toml, /^# codex is installed here but cannot be used yet: Codex is not signed in on this machine\.\n# To offer it: codex login; then remove the "# " in front of the four lines below and run: claw-connector service install\n# \[\[agents\]\]\n# id = "codex"$/m);
    assert.match(a.text(), new RegExp(`^wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: claude, working in`, "m"));
    assert.match(a.text(), /^codex is installed but cannot be used yet \(Codex is not signed in on this machine\), so it was left out: .*To offer it: codex login; then uncomment that block and run: claw-connector service install$/m);
    // Uncommented as the note says, it is a working agent.
    const on = toml.split("\n").map((l) => (/^# (\[\[agents\]\]|id = "codex"|preset = "codex"|roots = )/.test(l) ? l.slice(2) : l)).join("\n");
    assert.deepEqual(parseConfig(on, { hostname: "box" }).agents.filter((x) => x.id !== "claude-sessions").map((x) => [x.id, x.roots]), [["claude", [work]], ["codex", [work]]]);
  });

  test("none signed in: the first installed is turned on anyway (agents.toml needs one) and pair says what it needs", async () => {
    const home = tmpdir();
    const f = claimFetch(() => ({ status: 201, body: { ok: true, data: { token: GRANT } } }), []);
    const a = ctx(home, { fetch: f, cwd: tmpdir("w-"), env: { PATH: fakePath("claude", "codex"), CLAUDE_CONFIG_DIR: path.join(home, "cc") }, doctor: signIns(["claude", "codex"]) });
    assert.equal(await main(["pair", "abcd-efgh-jkmn", "--server", "https://claw.example/api", "--no-start"], a.c), EXIT.ok, a.errText());
    const toml = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8");
    assert.deepEqual(parseConfig(toml, { hostname: "box" }).agents.map((x) => x.id), ["claude", "claude-sessions"]);
    assert.match(a.text(), /^claude: Claude Code is not signed in on this machine; its sessions fail until you run: claude auth login$/m);
    assert.match(a.text(), /^codex is installed but cannot be used yet/m);
    // A check that cannot tell (it throws, or answers nothing) never leaves an agent out.
    const unsure = await chooseAgents({ PATH: fakePath("claude", "codex") }, async (id) => { if (id === "codex") throw new Error("no answer"); return null; });
    assert.deepEqual([unsure.agents, unsure.parked], [["claude", "codex"], []]);
  });

  test("the sign-in check pair uses is doctor's, asked of the real programs", async () => {
    const bin = tmpdir("bin-");
    const prog = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const home = tmpdir("signin-home-");
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
    const d = defaultDeps(env, { home, platform: "linux" });
    prog("codex", `echo "Not logged in"; exit 1`);
    prog("claude", `echo '{"loggedIn": false}'`);
    assert.deepEqual(await presetSignInProblem("codex", env, d), { detail: "Codex is not signed in on this machine", fix: "codex login" });
    assert.deepEqual(await presetSignInProblem("claude", env, d), { detail: "Claude Code is not signed in on this machine", fix: "claude auth login" });
    prog("codex", `echo "Logged in using ChatGPT"`);
    prog("claude", `echo '{"loggedIn": true}'`);
    assert.equal(await presetSignInProblem("codex", env, d), null);
    assert.equal(await presetSignInProblem("claude", env, d), null);
    assert.equal(await presetSignInProblem("cursor", env, d), null, "no check for it: never left out");
  });

  test("what pair writes and where agents may work", () => {
    assert.deepEqual(detectAgents({ PATH: fakePath("claude", "cursor-agent") }), ["claude", "cursor"]);
    assert.deepEqual(detectAgents({ PATH: "" }), []);
    assert.equal(defaultRoot("/"), os.homedir(), "never the whole filesystem");
    assert.equal(defaultRoot("/srv/x/"), "/srv/x");
    const work = tmpdir("w-");
    const text = pairedConfig({ server: "https://c.example/api", name: "dev \"pod\"", agents: ["claude", "cursor"], root: work });
    const cfg = parseConfig(text, { hostname: "h" });
    assert.equal(cfg.name, "dev \"pod\"");
    assert.deepEqual(cfg.agents.filter((a) => a.id !== "claude-sessions").map((a) => [a.id, a.roots]), [["claude", [work]], ["cursor", [work]]]);
  });
});
