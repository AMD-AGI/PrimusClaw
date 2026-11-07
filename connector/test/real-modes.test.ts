// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A phone session against the REAL claude-agent-acp adapter, through `run`, as whoever runs the test: CI runs this
 * file once as the runner's own user and once as root (tests.yml, "Connector real adapter"), so it covers
 * {root, non-root} x {approval = "never", approval = "ask"}. Opening a session needs no model and no credentials
 * (no prompt is sent), and also with the user's own Claude settings defaulting to bypassPermissions. Skipped unless CLAW_REAL_CLAUDE_ACP names the adapter's dist/index.js
 * (npm i @agentclientprotocol/claude-agent-acp@0.99.0).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { resolveDirs } from "../src/paths.js";
import { FakeClaw } from "./support/fake-claw.js";
import { tmpdir } from "./support/harness.js";

const ADAPTER = process.env.CLAW_REAL_CLAUDE_ACP;
const skip = ADAPTER ? false : "set CLAW_REAL_CLAUDE_ACP to run against the real Claude adapter";
const euid = process.geteuid?.() ?? null;
const who = euid === 0 ? "root" : `uid ${euid}`;

// What the connector itself inherits reaches the adapter: an IS_SANDBOX here would hide the root case.
const saved = process.env.IS_SANDBOX;
before(() => { delete process.env.IS_SANDBOX; });
after(() => { if (saved !== undefined) process.env.IS_SANDBOX = saved; });

/**
 * `userBypass`: the user's own Claude settings default to bypassPermissions; `sandbox`: the connector itself runs with
 * IS_SANDBOX=1 (a container that sets it for everything), so root may use bypass too.
 */
async function openSession(approval: "never" | "ask", o: { userBypass?: boolean; sandbox?: boolean } = {}) {
  const base = tmpdir("rm-");
  const home = path.join(base, "home");
  const work = path.join(base, "work");
  const claude = path.join(base, "claude");
  for (const d of [path.join(home, "config"), work, claude]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claude, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  if (o.userBypass) fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  if (o.sandbox) process.env.IS_SANDBOX = "1";
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `
[[agents]]
id = "cc"
preset = "claude"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
roots = [${JSON.stringify(work)}]
approval = "${approval}"
[agents.env]
CLAUDE_CONFIG_DIR = ${JSON.stringify(claude)}
HOME = ${JSON.stringify(base)}
`);
  const out: string[] = [];
  const c: Ctx = {
    dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { HOME: base, CLAUDE_CONFIG_DIR: claude },
    out: (s) => out.push(s), err: (s) => out.push(s), hostname: "ci", claudeManagedSettings: path.join(base, "managed.json"),
  };
  const claw = await FakeClaw.start();
  let connector: any;
  let running: Promise<number> | undefined;
  try {
    claw.tokens.add("good-token");
    assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], { ...c, out: () => {}, err: () => {} }), EXIT.ok);
    running = main(["run"], { ...c, onConnector: (cn) => { connector = cn; } });
    await claw.until("online", () => claw.online, 30_000);
    const sid = claw.newSession("cc", work);
    const ev = await claw.until("session_started or session_closed", () => claw.eventsOf(sid).find((e) => e.type === "session_started" || e.type === "session_closed"), 120_000);
    const doctor: string[] = [];
    const code = await main(["doctor", "--json"], { ...c, out: (s) => doctor.push(s), err: (s) => doctor.push(s) });
    return { ev, out, doctor: { code, doc: JSON.parse(doctor.join("\n")) } };
  } finally {
    connector?.stop();
    await running;
    await claw.close();
    delete process.env.IS_SANDBOX;
  }
}

describe(`the real Claude adapter as ${who}`, { skip }, () => {
  test(`approval = "never": the session opens in bypassPermissions, and doctor agrees`, { timeout: 300_000 }, async () => {
    const r = await openSession("never");
    assert.equal(r.ev.type, "session_started", `${JSON.stringify(r.ev.data)}\n${r.out.join("\n")}`);
    assert.equal(r.ev.data.currentMode, "bypassPermissions");
    assert.equal(r.doctor.code, EXIT.ok, JSON.stringify(r.doctor.doc));
    assert.ok(r.doctor.doc.agents[0].modes.includes("bypassPermissions"));
  });

  test(`approval = "ask": the session opens in default, and doctor agrees`, { timeout: 300_000 }, async () => {
    const r = await openSession("ask");
    assert.equal(r.ev.type, "session_started", `${JSON.stringify(r.ev.data)}\n${r.out.join("\n")}`);
    assert.equal(r.ev.data.currentMode, "default");
    assert.equal(r.doctor.code, EXIT.ok, JSON.stringify(r.doctor.doc));
  });

  test(`approval = "ask" while the user's own settings default to bypassPermissions (and IS_SANDBOX is set): opens in default`, { timeout: 300_000 }, async () => {
    const r = await openSession("ask", { userBypass: true, sandbox: true });
    assert.equal(r.ev.type, "session_started", `${JSON.stringify(r.ev.data)}\n${r.out.join("\n")}`);
    assert.equal(r.ev.data.currentMode, "default");
    assert.equal(r.ev.data.unattended, false);
    assert.equal(r.doctor.code, EXIT.ok, JSON.stringify(r.doctor.doc));
    assert.ok(!r.doctor.doc.agents[0].modes.includes("bypassPermissions"), "the adapter leaves bypass out for an agent that asks");
  });

  test(`approval = "never" while the user's own settings default to bypassPermissions: opens in bypassPermissions`, { timeout: 300_000 }, async () => {
    const r = await openSession("never", { userBypass: true });
    assert.equal(r.ev.type, "session_started", `${JSON.stringify(r.ev.data)}\n${r.out.join("\n")}`);
    assert.equal(r.ev.data.currentMode, "bypassPermissions");
  });
});
