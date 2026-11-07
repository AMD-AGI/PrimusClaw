// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `claw-connector pair`: a one-time code from the chat, traded at Claw for this machine's sign-in, then the connector. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { main, EXIT, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { defaultRoot, detectAgents, pairedConfig } from "../src/pair.js";
import { credentialsFile, identityFile, resolveDirs } from "../src/paths.js";
import { FakeClaw } from "./support/fake-claw.js";
import { tmpdir } from "./support/harness.js";

const GRANT = `cpg_${"g".repeat(43)}`;

function ctx(home: string, extra: Partial<Ctx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: Ctx = {
    dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config") },
    out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", ...extra,
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
      const a = ctx(home, { fetch: f, cwd: work, env: { PATH: fakePath("claude", "codex"), CLAUDE_CONFIG_DIR: path.join(home, "cc") } });
      assert.equal(await main(["pair", "abcd-efgh-jkmn", "--server", claw.url, "--no-start"], a.c), EXIT.ok, a.errText());
      assert.deepEqual(seen.map((s) => s.body), [{ code: "abcd-efgh-jkmn", name: "box" }]);
      const toml = fs.readFileSync(path.join(home, "config", "agents.toml"), "utf8");
      const cfg = parseConfig(toml, { hostname: "box" });
      // (A claude agent also brings the machine's own Claude conversations, `claude-sessions`, by itself.)
      assert.deepEqual(cfg.agents.filter((x) => x.id !== "claude-sessions").map((x) => [x.id, x.roots, x.unattended]), [["claude", [work], false], ["codex", [work], false]]);
      assert.equal(cfg.server, claw.url);
      const saved = JSON.parse(fs.readFileSync(credentialsFile(a.c.dirs), "utf8"));
      assert.deepEqual([saved.kind, saved.token, saved.server, saved.device_name], ["grant", GRANT, claw.url, "box"]);
      assert.equal(fs.statSync(credentialsFile(a.c.dirs)).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(identityFile(a.c.dirs)), false, "the earlier connector id is forgotten: this grant registers anew");
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
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
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
