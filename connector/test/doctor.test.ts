// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw-connector doctor` and the health a running connector reports (doctor.ts):
 *   H1  doctor prints one fix per problem: an agent's program missing, Claude Code and Codex not signed in, a root that cannot
 *       be written or does not exist; and exits 1. With everything in order it exits 0 and says so
 *   H2  a Codex model provider other than OpenAI needs its env_key, not `codex login`; a codex too old for `login status` is
 *       not called signed out
 *   H3  the machine: Node too old, HTTPS_PROXY and https_proxy different (or one empty), no service, a keep-alive script that
 *       nothing calls (and is fine when called recently or in the crontab), Claw not answering (with the proxy hint)
 *   H4  the PATH the installed service runs with is checked too: a program the shell finds but the service does not is a problem
 *   H5  the running connector sends the result in every agent's capabilities.health, machine problems in each, within the 4 KiB
 *       cap; it checks again when a doctor run asks (doctor signals it), and a check that throws keeps the connection up
 *   H6  `service ensure` (what keepalive.sh runs) leaves its time, and `service install` records the PATH it carried
 *   H2b a Claude key or cloud provider in the environment counts as signed in, whatever `claude auth status` says
 *   H8  a run checks the machine in a child process (`health-check`) with the agents it loaded, so a root removed later is
 *       reported, and at once when asked (what `doctor`'s signal does)
 *   H7  a probe that hangs, ignores SIGTERM and leaves a grandchild holding its pipes is ended with its whole group at its
 *       timeout or when the connector stops, and a stop is never held up by a check; heartbeats go on while a check hangs,
 *       and a root on a disk that does not answer gets no verdict in its time limit; a URL's password is never shown
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { main, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { agentHealth, checkAll, defaultDeps, installedServicePath, MAX_REPORTED, runProbe, shq, type DoctorDeps, type ProbeResult, type Report } from "../src/doctor.js";
import { processStart } from "../src/children.js";
import type { ProbeFn } from "../src/probe.js";
import { withHealth } from "../src/connector.js";
import { doctorFile, keepaliveStampFile, resolveDirs, serviceFile } from "../src/paths.js";
import { REMOTE_AGENT_LIMITS } from "../src/protocol.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, Harness, tmpdir } from "./support/harness.js";

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const CLI_TS = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A program on a PATH of its own that prints `out` and exits `code`. */
function program(dir: string, name: string, out: string, code = 0): void {
  fs.mkdirSync(dir, { recursive: true });
  // (echo is the shell's own: the PATH under test may hold nothing else)
  assert.ok(!out.includes("'"));
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho '${out}'\nexit ${code}\n`, { mode: 0o755 });
}

/** Deps that look at nothing real but the files under test: no crontab, no systemd, Claw answering. */
function deps(env: NodeJS.ProcessEnv, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return defaultDeps(env, {
    platform: "linux", home: tmpdir("doc-home-"), user: "me", nodeVersion: "22.12.0", uid: process.getuid!(),
    crontab: async () => null,
    exec: async (): Promise<ProbeResult> => ({ code: 1, out: "" }),
    get: async () => ({ status: 200 }),
    writable: (dir) => (fs.existsSync(dir) ? null : "ENOENT"),
    ...over,
  });
}

function ctx(home: string, env: NodeJS.ProcessEnv, doctor: DoctorDeps) {
  const out: string[] = [];
  const err: string[] = [];
  // (the adapter check of `doctor` starts each agent's adapter: here it answers ok without starting anything)
  const probe: ProbeFn = async (agents) => agents.map((a) => ({ agent: a.id, cwd: "", ok: true, modes: [a.askMode], problems: [], notes: [] }));
  const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env, out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", doctor, probe };
  return { c, text: () => out.join("\n"), errText: () => err.join("\n") };
}

/** A connector home with an agents.toml and a key sign-in. */
function home(toml: string): string {
  const h = tmpdir("doc-");
  fs.mkdirSync(path.join(h, "config"), { recursive: true });
  fs.writeFileSync(path.join(h, "config", "agents.toml"), toml);
  fs.writeFileSync(path.join(h, "config", "credentials.json"), JSON.stringify({ v: 1, server: "https://claw.test", kind: "device", identity_url: "https://id.test", client_id: "claw-connector", refresh_token: "r", saved_at: "" }), { mode: 0o600 });
  return h;
}

const codes = (r: Report) => r.problems.map((p) => `${p.agent ?? "-"}:${p.code}`);

describe("doctor", () => {
  test("H1 one fix per problem: a missing program, Claude and Codex signed out, a root not writable or gone; exit 1", async () => {
    const bin = tmpdir("doc-bin-");
    program(bin, "npx", "");
    program(bin, "claude", JSON.stringify({ loggedIn: false, authMethod: "none" }), 1);
    program(bin, "codex", "Not logged in", 1);
    const work = tmpdir("doc-work-");
    const locked = tmpdir("doc-locked-");
    const gone = path.join(tmpdir("doc-x-"), "gone");
    fs.mkdirSync(gone);
    const h = home(`
[[agents]]
id = "claude"
preset = "claude"
roots = [${JSON.stringify(work)}, ${JSON.stringify(locked)}]
[[agents]]
id = "codex"
preset = "codex"
roots = [${JSON.stringify(work)}, ${JSON.stringify(gone)}]
[[agents]]
id = "cursor"
preset = "cursor"
roots = [${JSON.stringify(work)}]
`);
    const env = { PATH: bin, CLAUDE_CONFIG_DIR: tmpdir("doc-cc-"), CODEX_HOME: tmpdir("doc-cx-") };
    // (agents.toml refuses a root that does not exist, so `doctor` says that; a running connector finds one removed later.)
    const parsed = parseConfig(fs.readFileSync(path.join(h, "config", "agents.toml"), "utf8"));
    fs.rmdirSync(gone);
    const running = await checkAll({ dirs: resolveDirs({ CLAW_CONNECTOR_HOME: h } as NodeJS.ProcessEnv), agents: parsed.agents, by: "run" }, deps(env));
    assert.match(running.problems.find((p) => p.code === "root_missing")?.fix ?? "", new RegExp(`^mkdir -p ${gone}`));
    fs.mkdirSync(gone);
    // `doctor` itself, with the folder gone: agents.toml cannot be read, and the fix is the folder, not an edit of the file.
    fs.rmdirSync(gone);
    const g = ctx(h, env, deps(env));
    assert.equal(await main(["doctor"], g.c), 1);
    assert.match(g.text(), new RegExp(`^FAIL {2}codex: ${gone} \\(a root of agent codex\\) does not exist\\n {6}fix: mkdir -p ${gone} `, "m"));
    assert.equal(shq("/a b/c'd"), `'/a b/c'\\''d'`, "a root with a space or a quote is one word in the fix");
    fs.mkdirSync(gone);
    const t = ctx(h, env, deps(env, { writable: (dir) => (dir === locked ? "EACCES" : dir === gone ? "EROFS" : fs.existsSync(dir) ? null : "ENOENT") }));
    assert.equal(await main(["doctor"], t.c), 1);
    const text = t.text();
    assert.match(text, /^FAIL {2}claude: Claude Code is not signed in on this machine\n {6}fix: claude auth login$/m);
    assert.match(text, /^FAIL {2}codex: Codex is not signed in on this machine\n {6}fix: codex login$/m);
    assert.match(text, /^FAIL {2}cursor: agent \(the program agent cursor runs\) is not on PATH\n {6}fix: install the Cursor CLI/m);
    assert.match(text, new RegExp(`^FAIL {2}claude: ${locked} \\(a root of agent claude\\) is not writable by me\\n {6}fix: chmod u\\+w ${locked}`, "m"));
    assert.match(text, new RegExp(`^FAIL {2}codex: ${gone} \\(a root of agent codex\\) is not writable by me \\(a read-only file system\\)\\n {6}fix: pick a root on a writable disk`, "m"));
    assert.match(text, /^ok {4}claude: npx is /m);
    // Every problem line is followed by exactly one fix line.
    const lines = text.split("\n");
    lines.forEach((l, i) => { if (/^(FAIL|warn) /.test(l)) assert.match(lines[i + 1] ?? "", /^ {6}fix: \S/, l); });
    // The report is kept for status and for the running connector.
    const kept = JSON.parse(fs.readFileSync(doctorFile(t.c.dirs), "utf8")) as Report;
    assert.equal(kept.by, "doctor");
    assert.deepEqual(codes(kept).filter((c) => !c.startsWith("-")).sort(),
      ["claude:agent_not_signed_in", "claude:root_not_writable", "codex:agent_not_signed_in", "codex:root_not_writable", "cursor:agent_cli_missing"]);
    // Someone else's folder: chmod is not theirs to run.
    const other = ctx(h, env, deps(env, { uid: 4242, writable: (dir) => (dir === locked ? "EACCES" : null) }));
    await main(["doctor"], other.c);
    assert.match(other.text(), new RegExp(`fix: pick a root you own in agents.toml \\(${locked} belongs to uid ${process.getuid!()}\\)`));
    const st = ctx(h, env, deps(env));
    await main(["status"], st.c);
    assert.match(st.text(), /^doctor: {5}\d+ problem\(s\) at .*; run: claw-connector doctor$/m);

    // Fixed: signed in, the folders back, a cursor `agent`, a service whose keep-alive ran a minute ago.
    program(bin, "claude", JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
    program(bin, "codex", "Logged in using ChatGPT");
    program(bin, "agent", "");
    fs.writeFileSync(serviceFile(t.c.dirs), JSON.stringify({ supervisor: "script" }));
    fs.writeFileSync(keepaliveStampFile(t.c.dirs), "x");
    const ok = ctx(h, env, deps(env));
    assert.equal(await main(["doctor"], ok.c), 0, ok.text());
    assert.match(ok.text(), /^No problems found\.$/m);
    assert.match(ok.text(), /^ok {4}claude: Claude Code is signed in$/m);
    assert.match(ok.text(), /^ok {4}codex: Codex can sign in$/m);
  });

  test("H2b a Claude key in the environment is signed in, whatever claude auth status says about an account", async () => {
    const bin = tmpdir("doc-bin-");
    program(bin, "npx", "");
    program(bin, "claude", JSON.stringify({ loggedIn: false, authMethod: "none" }), 1);
    const cfg = parseConfig(`[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(tmpdir("doc-w-"))}]\n`);
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("doc-") } as NodeJS.ProcessEnv);
    const env = { PATH: bin, CLAUDE_CONFIG_DIR: tmpdir("doc-cc-") };
    assert.ok(codes(await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps(env))).includes("claude:agent_not_signed_in"));
    // An apiKeyHelper in Claude's own settings too.
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ apiKeyHelper: "/usr/local/bin/key" }));
    assert.ok(!codes(await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps(env))).includes("claude:agent_not_signed_in"));
    fs.rmSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"));
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]) {
      assert.ok(!codes(await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ ...env, [k]: "1" }))).includes("claude:agent_not_signed_in"), k);
    }
  });

  test("H2 a model provider other than OpenAI needs its env_key, not codex login; an old codex is not called signed out", async () => {
    const bin = tmpdir("doc-bin-");
    program(bin, "npx", "");
    program(bin, "codex", "Logged in?", 1);
    const cx = tmpdir("doc-cx-");
    fs.writeFileSync(path.join(cx, "config.toml"), `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.test"\nenv_key = "GW_TOKEN"\n`);
    const cfg = parseConfig(`[[agents]]\nid = "codex"\npreset = "codex"\nroots = [${JSON.stringify(tmpdir("doc-w-"))}]\n`);
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("doc-") } as NodeJS.ProcessEnv);
    const without = await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: bin, CODEX_HOME: cx }));
    const p = without.problems.find((x) => x.code === "agent_not_signed_in");
    assert.ok(p, codes(without).join());
    assert.match(p.detail, /model provider "gw", which reads GW_TOKEN, and GW_TOKEN is not set/);
    assert.match(p.fix, /set GW_TOKEN for this agent/);
    const withKey = await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: bin, CODEX_HOME: cx, GW_TOKEN: "t" }));
    assert.ok(!codes(withKey).includes("codex:agent_not_signed_in"));
    // An env_key that is a pasted key, not a name, is never repeated.
    fs.writeFileSync(path.join(cx, "config.toml"), `model_provider = "gw"\n[model_providers.gw]\nenv_key = "sk-not-a-name/123"\n`);
    const pasted = await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: bin, CODEX_HOME: cx }));
    assert.ok(!JSON.stringify(pasted).includes("sk-not-a-name"), JSON.stringify(pasted.problems));
    assert.match(pasted.problems.find((x) => x.code === "agent_not_signed_in")?.detail ?? "", /env_key that is not a variable name/);
    fs.writeFileSync(path.join(cx, "config.toml"), `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.test"\nenv_key = "GW_TOKEN"\n`);
    // The agent's own [agents.env] counts: that is the environment its adapter gets.
    const ownEnv = parseConfig(`[[agents]]\nid = "codex"\npreset = "codex"\nroots = [${JSON.stringify(tmpdir("doc-w-"))}]\nenv = { GW_TOKEN = "t" }\n`);
    assert.ok(!codes(await checkAll({ dirs, agents: ownEnv.agents, by: "run" }, deps({ PATH: bin, CODEX_HOME: cx }))).includes("codex:agent_not_signed_in"));
    // OpenAI, and a codex whose `login status` answers something else (too old to have it): no verdict, even without auth.json
    // (its sign-in may be in the keyring).
    const plain = tmpdir("doc-cx-");
    const unknown = await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: bin, CODEX_HOME: plain }));
    assert.ok(!codes(unknown).includes("codex:agent_not_signed_in"), "no verdict from an answer it does not understand");
    assert.ok(!unknown.ok.some((l) => l.startsWith("codex: Codex")), "and no claim that it is signed in either");
    // No codex program at all: auth.json decides, unless the config keeps the sign-in in the keyring.
    const nocodex = tmpdir("doc-bin-");
    program(nocodex, "npx", "");
    const none = await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: nocodex, CODEX_HOME: plain }));
    assert.match(none.problems.find((x) => x.code === "agent_not_signed_in")?.fix ?? "", /^npm install -g @openai\/codex, then: codex login$/);
    fs.writeFileSync(path.join(plain, "config.toml"), `cli_auth_credentials_store = "keyring"\n`);
    assert.ok(!codes(await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: nocodex, CODEX_HOME: plain }))).includes("codex:agent_not_signed_in"));
    fs.rmSync(path.join(plain, "config.toml"));
    fs.writeFileSync(path.join(plain, "auth.json"), "{}");
    assert.ok(!codes(await checkAll({ dirs, agents: cfg.agents, by: "run" }, deps({ PATH: nocodex, CODEX_HOME: plain }))).includes("codex:agent_not_signed_in"));
  });

  test("H3 the machine: old Node, mismatched proxy variables, no service, a keep-alive nothing calls, Claw not answering", async () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("doc-") } as NodeJS.ProcessEnv);
    const env = { PATH: "", HTTPS_PROXY: "http://proxy.test:3128", https_proxy: "", HTTP_PROXY: "not a url" };
    const r = await checkAll({ dirs, agents: [], by: "doctor", server: "https://claw.test/api" },
      deps(env, { nodeVersion: "20.11.1", get: async () => ({ error: "fetch failed (connect ETIMEDOUT)" }) }));
    const by = Object.fromEntries(r.problems.map((p) => [p.code, p]));
    assert.match(by.node_too_old.detail, /20\.11\.1 is older than 22/);
    assert.match(by.proxy_mismatch.detail, /HTTPS_PROXY and https_proxy are set to different values \(one of them is empty\)/);
    assert.equal(by.proxy_mismatch.fix, 'export https_proxy="$HTTPS_PROXY"  (or unset the one you do not mean)');
    assert.equal(by.proxy_invalid.detail, "HTTP_PROXY is not a URL");
    assert.equal(by.no_service.fix, "claw-connector service install");
    assert.match(by.claw_unreachable.detail, /https:\/\/claw\.test\/api does not answer \(fetch failed/);
    assert.match(by.claw_unreachable.fix, /NODE_USE_ENV_PROXY=1/, "a proxy Node does not use is the likely cause");
    assert.equal(by.proxy_mismatch.severity, "warn");
    assert.equal(by.node_too_old.severity, "fail");

    // The script supervisor: nothing called keepalive.sh lately and no crontab line names it.
    fs.mkdirSync(dirs.state, { recursive: true });
    fs.writeFileSync(serviceFile(dirs), JSON.stringify({ supervisor: "script" }));
    const quiet = await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }));
    assert.match(quiet.problems.find((p) => p.code === "keepalive_not_scheduled")?.fix ?? "", /\*\/5 \* \* \* \* sh .*keepalive\.sh$/);
    const script = path.join(dirs.state, "keepalive.sh");
    const inCron = await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }, { crontab: async () => `# m h\n*/5 * * * * sh ${script}\n` }));
    assert.ok(!codes(inCron).includes("-:keepalive_not_scheduled"));
    const commented = await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }, { crontab: async () => `# */5 * * * * sh ${script}\n` }));
    assert.ok(codes(commented).includes("-:keepalive_not_scheduled"), "a commented-out line calls nothing");
    fs.writeFileSync(keepaliveStampFile(dirs), "x");   // called a moment ago (a startup hook, a CronJob)
    assert.ok(!codes(await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }))).includes("-:keepalive_not_scheduled"));
    const later = await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }, { now: () => Date.now() + 16 * 60_000 }));
    assert.ok(codes(later).includes("-:keepalive_not_scheduled"), "...but not for ever");

    // systemd without linger.
    fs.writeFileSync(serviceFile(dirs), JSON.stringify({ supervisor: "systemd" }));
    const sd = await checkAll({ dirs, agents: [], by: "run" }, deps({ PATH: "" }, { exec: async () => ({ code: 0, out: "no" }) }));
    assert.equal(sd.problems.find((p) => p.code === "linger_off")?.fix, "loginctl enable-linger me");
  });

  test("H4 the installed service's PATH must find each agent's program, not only this shell's", async () => {
    const shellBin = tmpdir("doc-bin-");
    program(shellBin, "npx", "");
    const h = home(`[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(tmpdir("doc-w-"))}]\nenv = { ANTHROPIC_API_KEY = "x" }\n`);
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: h } as NodeJS.ProcessEnv);
    fs.mkdirSync(dirs.state, { recursive: true });
    fs.writeFileSync(serviceFile(dirs), JSON.stringify({ supervisor: "script" }));
    fs.writeFileSync(keepaliveStampFile(dirs), "x");
    // What `service install --supervisor script` wrote from a shell whose PATH had no node.
    fs.writeFileSync(path.join(dirs.state, "keepalive.sh"), `#!/bin/sh\nexport PATH='/usr/bin:/bin'\nexec node cli.js service ensure\n`);
    assert.equal(await installedServicePath(dirs), "/usr/bin:/bin");
    const env = { PATH: shellBin };
    const t = ctx(h, env, deps(env));
    assert.equal(await main(["doctor"], t.c), 1);
    assert.match(t.text(), /^FAIL {2}claude: the installed service's PATH does not find npx, so the service cannot start agent claude\n {6}fix: claw-connector service install/m);
    // A connector running on this home is asked to check again (and a burst of asks is one check: Connector.recheckHealth).
    fs.writeFileSync(path.join(dirs.state, "connector.pid"), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
    const asked: number[] = [];
    const run = ctx(h, env, deps(env));
    run.c.askRecheck = (pid) => asked.push(pid);
    await main(["doctor"], run.c);
    assert.deepEqual(asked, [process.pid]);
    assert.match(run.text(), /The running connector checks the machine again now/);
    fs.rmSync(path.join(dirs.state, "connector.pid"));
    // Installed again from this shell: the service's PATH is the shell's.
    fs.writeFileSync(serviceFile(dirs), JSON.stringify({ supervisor: "script", path: shellBin }));
    const again = ctx(h, env, deps(env));
    assert.equal(await main(["doctor"], again.c), 0, again.text());
    // The systemd unit and the LaunchAgent are read the same way.
    const xdg = tmpdir("doc-xdg-");
    fs.mkdirSync(path.join(xdg, "systemd", "user"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "systemd", "user", "claw-connector.service"), `[Service]\nEnvironment="PATH=/opt/a b:/x%%y"\n`);
    fs.writeFileSync(serviceFile(dirs), JSON.stringify({ supervisor: "systemd" }));
    assert.equal(await installedServicePath(dirs, "/nohome", xdg), "/opt/a b:/x%y");
  });

  test("H5 the running connector sends its health in every agent's capabilities and checks again after a doctor run", async () => {
    let calls = 0;
    let report: Report = { checked_at: "2026-11-07T00:00:00.000Z", by: "run", ok: [], problems: [
      { code: "no_service", severity: "warn", detail: "not a service", fix: "claw-connector service install" },
      { code: "agent_not_signed_in", severity: "fail", agent: "fake2", detail: "Codex is not signed in on this machine", fix: "codex login" },
    ] };
    const h = await Harness.create({ secondToml: "", timing: { healthMinGapMs: 0 }, health: async () => { calls++; if (calls === 2) throw new Error("boom"); return report; } });
    try {
      await h.claw.until("a heartbeat with health", () => h.claw.heartbeats.some((b: any) => b.agents[0].capabilities.health));
      const hb = [...h.claw.heartbeats].reverse().find((b: any) => b.agents[0].capabilities.health);
      const caps = Object.fromEntries(hb.agents.map((a: any) => [a.agent_id, a.capabilities.health]));
      assert.deepEqual(caps.fake.problems.map((p: any) => [p.code, p.scope]), [["no_service", "machine"]]);
      assert.deepEqual(caps.fake2.problems.map((p: any) => [p.code, p.scope, p.fix]), [["agent_not_signed_in", "agent", "codex login"], ["no_service", "machine", "claw-connector service install"]],
        "its own failures first, then the machine's");
      assert.equal(calls, 1, "not again until a doctor run or the interval");
      // A doctor run asks again: checked again (that one throws, and the last report stays), and again after the next ask.
      report = { ...report, problems: [] };
      h.connector.recheckHealth();
      await h.claw.until("a second check", () => calls >= 2);
      assert.ok(h.claw.heartbeats.at(-1).agents[1].capabilities.health.problems.length === 2, "a failed check keeps the last report");
      h.connector.recheckHealth();
      await h.claw.until("the cleared report in a heartbeat", () => h.claw.heartbeats.at(-1).agents.every((a: any) => a.capabilities.health?.problems.length === 0));
      assert.equal(h.claw.online, true, "the connection stayed up throughout");
    } finally { await h.close(); }
  });

  test("H5b a long report fits in the capabilities cap, failures first", () => {
    const long = "x".repeat(400);
    const report: Report = { checked_at: "t", by: "run", ok: [], problems: Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, severity: i % 2 ? "fail" as const : "warn" as const, detail: long, fix: long })) };
    const health = agentHealth(report, "a");
    assert.equal(health.problems.length, MAX_REPORTED);
    assert.ok(health.problems.every((p) => p.detail.length <= 200 && p.fix.length <= 200));
    assert.ok(health.problems.slice(0, 6).every((p) => p.severity === "fail"));
    const caps = withHealth({ ask_mode: "default", roots: ["/r".repeat(100)] }, health);
    assert.ok(new TextEncoder().encode(JSON.stringify(caps)).length <= REMOTE_AGENT_LIMITS.maxCapabilitiesBytes / 2);
    assert.ok((caps.health as any).problems.length >= 1);
    // An agent that already says nearly 4 KiB (a long list of roots): no health at all, never a descriptor the server refuses.
    const big = { ask_mode: "default", roots: Array.from({ length: 8 }, (_, i) => `/${String(i).repeat(480)}`) };
    assert.ok(new TextEncoder().encode(JSON.stringify(big)).length < REMOTE_AGENT_LIMITS.maxCapabilitiesBytes);
    assert.deepEqual(withHealth(big, health), big);
    assert.deepEqual(withHealth(big, { checked_at: "t", problems: [] }), big);
  });

  test("H7 a hanging probe is ended with its whole group, at its timeout or at a stop, and never holds a stop up", async () => {
    const dir = tmpdir("doc-hang-");
    const pids = path.join(dir, "pids");
    // Ignores SIGTERM, and leaves a grandchild that holds the output pipe open.
    const script = path.join(dir, "hang");
    fs.writeFileSync(script, `#!/bin/sh
trap '' TERM
echo started
sleep 30 &
echo $! > ${pids}
wait
`, { mode: 0o755 });
    const t0 = Date.now();
    const r = await runProbe(script, [], { PATH: process.env.PATH }, undefined, 400);
    assert.ok(Date.now() - t0 < 5000, `answered in ${Date.now() - t0} ms`);
    assert.equal(r.code, null);
    assert.match(r.out, /started/);
    const grandchild = Number(fs.readFileSync(pids, "utf8"));
    for (let i = 0; i < 50 && processStart(grandchild) !== null; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(processStart(grandchild), null, "the grandchild went with the group");
    // A stop aborts it at once.
    const ctl = new AbortController();
    const pending = runProbe(script, [], { PATH: process.env.PATH }, ctl.signal, 60_000);
    await new Promise((res) => setTimeout(res, 150));
    const t1 = Date.now();
    ctl.abort();
    assert.equal((await pending).code, null);
    assert.ok(Date.now() - t1 < 2000);
    // The connector: a check that never ends does not hold its stop up.
    const h = await Harness.create({ health: () => new Promise<Report>(() => undefined) });
    await h.online();
    const t2 = Date.now();
    await h.stop();
    assert.ok(Date.now() - t2 < 5000, `stopped in ${Date.now() - t2} ms`);
    await h.close();

    // The connector keeps its connection while a check waits on a disk that does not answer: heartbeats go on.
    const slow = await Harness.create({ health: () => new Promise<Report>(() => undefined) });
    await slow.online();
    const n = slow.claw.heartbeats.length;
    await slow.claw.until("three more heartbeats while the check hangs", () => slow.claw.heartbeats.length >= n + 3);
    await slow.close();
    // ...and the check itself gives a root that does not answer no verdict, in its time limit, rather than waiting on it.
    const w = tmpdir("doc-w-");
    const hung = parseConfig(`[[agents]]\nid = "x"\ncommand = "true"\nask_mode = "default"\nroots = [${JSON.stringify(w)}]\n`);
    const t3 = Date.now();
    const r3 = await checkAll({ dirs: resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("doc-") } as NodeJS.ProcessEnv), agents: hung.agents, by: "run" },
      deps({ PATH: "/usr/bin:/bin" }, { writable: () => new Promise<string | null>(() => undefined), fsTimeoutMs: 200 }));
    assert.ok(Date.now() - t3 < 3000, `${Date.now() - t3} ms`);
    assert.ok(!r3.problems.some((p) => p.code.startsWith("root_")) && !r3.ok.some((l) => l.includes(w)), "neither a problem nor a pass");

    // A sign-in in the Claw URL (user info, a query or a fragment) is never printed.
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("doc-") } as NodeJS.ProcessEnv);
    const down = await checkAll({ dirs, agents: [], by: "doctor", server: "https://user:s3cret@claw.test/api" },
      deps({ PATH: "" }, { get: async () => ({ error: "fetch failed for https://user:s3cret@claw.test/api/health" }) }));
    assert.ok(!JSON.stringify(down).includes("s3cret"), JSON.stringify(down.problems));
    for (const server of ["https://claw.test/api?token=s3cret", "https://claw.test/api#s3cret"]) {
      const up = await checkAll({ dirs, agents: [], by: "doctor", server }, deps({ PATH: "" }));
      assert.ok(!JSON.stringify(up).includes("s3cret"), JSON.stringify(up.ok));
      assert.ok(up.ok.includes("Claw answers at https://claw.test/api"), JSON.stringify(up.ok));
    }
    // A company CA Node does not trust (measured: a fresh environment on the dev pod, "unable to get local issuer certificate").
    const tls = await checkAll({ dirs, agents: [], by: "doctor", server: "https://claw.test/api" },
      deps({ PATH: "" }, { get: async () => ({ error: "fetch failed (unable to get local issuer certificate)" }) }));
    const t = tls.problems.find((p) => p.code === "claw_tls_untrusted");
    assert.match(t?.fix ?? "", /^export NODE_USE_SYSTEM_CA=1 /);
    assert.ok(!codes(tls).includes("-:claw_unreachable"));
    assert.match(down.problems.find((p) => p.code === "claw_unreachable")?.detail ?? "", /^https:\/\/claw\.test\/api does not answer/);
  });

  test("H8 a run checks the machine in a child process with the agents it loaded: a root removed later is reported, at once when asked", { timeout: 120_000 }, async () => {
    const claw = await FakeClaw.start();
    claw.tokens.add("good-token");
    const base = tmpdir("doc-run-");
    const home = path.join(base, "home");
    const work = path.join(base, "work");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(home, "config", "agents.toml"), `[[agents]]\nid = "fake"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(ADAPTER)}]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
    // The child is this source tree's cli.ts under tsx (production: node and the bundled cli.js).
    const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { PATH: process.env.PATH, HOME: base, CLAW_CONNECTOR_HOME: home },
      out: () => {}, err: () => {}, hostname: "ci", node: TSX, cli: CLI_TS };
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], c), 0);
      running = main(["run"], { ...c, onConnector: (cn) => { connector = cn; } });
      const health = () => claw.heartbeats.at(-1)?.agents?.[0]?.capabilities?.health;
      await claw.until("a heartbeat with the child's report", () => health(), 60_000);
      assert.deepEqual(health().problems.map((p: any) => p.code), ["no_service"]);
      fs.rmdirSync(work);
      connector.recheckHealth();
      await claw.until("root_missing in a heartbeat", () => health()?.problems.some((p: any) => p.code === "root_missing"), 60_000);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  });

  test("H8b a probe the health-check child started dies with the child's group when the connector gives up on it", { timeout: 60_000 }, async () => {
    const dir = tmpdir("doc-nest-");
    const bin = path.join(dir, "bin");
    program(bin, "npx", "");
    const pidFile = path.join(dir, "claude.pid");
    // A `claude auth status` that never answers.
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`, { mode: 0o755 });
    const work = tmpdir("doc-w-");
    const agents = parseConfig(`[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(work)}]\nexisting_sessions = false\n`).agents;
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, "cc"), CLAW_CONNECTOR_HOME: path.join(dir, "home") };
    // What the connector does (commands.ts runHealth), with a time limit shorter than the probe's.
    const r = await runProbe(TSX, [CLI_TS, "health-check"], env, undefined, 4000, JSON.stringify({ agents }));
    assert.equal(r.code, null, "given up on");
    const probe = Number(fs.readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100 && processStart(probe) !== null; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(processStart(probe), null, "the probe went with the child's group");
  });

  test("H6 service ensure leaves its time, and service install records the PATH it carried", async () => {
    const h = home(`[[agents]]\nid = "x"\ncommand = "true"\nask_mode = "default"\nroots = [${JSON.stringify(tmpdir("doc-w-"))}]\n`);
    const cli = path.join(tmpdir("doc-cli-"), "cli.js");
    fs.writeFileSync(cli, "process.exit(0)\n");
    const env = { PATH: "/p/one:/p/two" };
    const t = ctx(h, env, deps(env));
    t.c.service = { platform: "linux", uid: 1000, user: "me", node: process.execPath, cli, systemdBooted: () => false };
    assert.equal(await main(["service", "install", "--supervisor", "script"], t.c), 0, t.errText());
    assert.equal(JSON.parse(fs.readFileSync(serviceFile(t.c.dirs), "utf8")).path, "/p/one:/p/two");
    assert.ok(fs.existsSync(keepaliveStampFile(t.c.dirs)), "install ran ensure, which left its time");
    await main(["service", "uninstall"], t.c);
  });
});

after(() => undefined);
