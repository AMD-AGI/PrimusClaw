// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `status` and `run` say, before any phone session, that Claude's own settings start a session in bypassPermissions
 * and that the connector will therefore close it (mode_not_enforced). The cases are the ones measured against the real
 * claude-agent-acp 0.99.0: which file, which spelling, root, and the opt-outs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { claudeStartMode, noAskWarnings } from "../src/claude-mode.js";
import { main, type Ctx } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { resolveDirs } from "../src/paths.js";
import { FakeClaw } from "./support/fake-claw.js";
import { tmpdir } from "./support/harness.js";

const BYPASS = { permissions: { defaultMode: "bypassPermissions" } };
const write = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v)); };

/** A Claude config directory, a work directory (the root) and a managed settings path that does not exist yet. */
function layout() {
  const base = tmpdir("cm-");
  const claude = path.join(base, "claude");
  const work = path.join(base, "work");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return {
    base, claude, work, managed: path.join(base, "managed-settings.json"),
    user: path.join(claude, "settings.json"),
    project: path.join(work, ".claude", "settings.json"),
    local: path.join(work, ".claude", "settings.local.json"),
  };
}

const mode = (l: ReturnType<typeof layout>, env: NodeJS.ProcessEnv = {}, euid: number | null = 1000) =>
  claudeStartMode({ env: { CLAUDE_CONFIG_DIR: l.claude, ...env }, cwd: l.work, managedFile: l.managed, euid });

describe("Claude's own start mode, read like the Claude adapter reads it", () => {
  test("bypassPermissions in the user settings.json starts sessions in it, and names that file", () => {
    const l = layout();
    assert.deepEqual(mode(l), { bypass: false, file: null, unreadable: [] });
    write(l.user, BYPASS);
    assert.deepEqual(mode(l), { bypass: true, file: l.user, unreadable: [] });
  });

  test("the config directory is $CLAUDE_CONFIG_DIR, else ~/.claude of HOME", () => {
    const l = layout();
    write(path.join(l.base, ".claude", "settings.json"), BYPASS);
    assert.equal(claudeStartMode({ env: { HOME: l.base }, cwd: l.work, managedFile: l.managed, euid: 1000 }).bypass, true);
    assert.equal(claudeStartMode({ env: { HOME: l.base, CLAUDE_CONFIG_DIR: l.claude }, cwd: l.work, managedFile: l.managed, euid: 1000 }).bypass, false);
  });

  test("only the exact spelling counts", () => {
    const l = layout();
    for (const v of ["Bypass", "bypass", "BypassPermissions", "dontAsk", "acceptEdits", "auto", "default", 3]) {
      write(l.user, { permissions: { defaultMode: v } });
      assert.equal(mode(l).bypass, false, String(v));
    }
  });

  test("bypassPermissions from the repository's .claude files is ignored, and the user's file is not used instead", () => {
    const l = layout();
    write(l.project, BYPASS);
    assert.equal(mode(l).bypass, false);
    fs.rmSync(l.project);
    write(l.local, BYPASS);
    assert.equal(mode(l).bypass, false);
    write(l.user, BYPASS);
    assert.equal(mode(l).bypass, false, "a project/local bypass overrides the user's and is then dropped");
    fs.rmSync(l.local);
    write(l.project, { permissions: { defaultMode: "default" } });
    assert.equal(mode(l).bypass, false, "a project default overrides the user's bypass");
    write(l.project, { permissions: { allow: ["Read"] } });
    assert.equal(mode(l).bypass, true, "a project file without defaultMode leaves the user's");
  });

  test("the managed settings file wins over the others", () => {
    const l = layout();
    write(l.managed, BYPASS);
    assert.deepEqual(mode(l), { bypass: true, file: l.managed, unreadable: [] });
    write(l.user, BYPASS);
    write(l.managed, { permissions: { defaultMode: "default" } });
    assert.equal(mode(l).bypass, false);
  });

  test("root without IS_SANDBOX, and disableBypassPermissionsMode, keep the session out of bypass", () => {
    const l = layout();
    write(l.user, BYPASS);
    assert.equal(mode(l, {}, 0).bypass, false);
    assert.equal(mode(l, { IS_SANDBOX: "1" }, 0).bypass, true);
    write(l.project, { permissions: { disableBypassPermissionsMode: "disable" } });
    assert.equal(mode(l).bypass, false);
  });

  test("a settings file that is not JSON is reported, not taken as saying nothing", () => {
    const l = layout();
    write(l.user, "{ not json");
    assert.deepEqual(mode(l), { bypass: false, file: null, unreadable: [l.user] });
  });
});

describe("which agents are warned about", () => {
  const cfg = (l: ReturnType<typeof layout>, blocks: string, top = "") => parseConfig(`${top}\n${blocks.replaceAll("ROOT", JSON.stringify(l.work))}`);
  const warn = (l: ReturnType<typeof layout>, c: ReturnType<typeof parseConfig>, env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: l.claude }) =>
    noAskWarnings(c.agents, env, { managedFile: l.managed, euid: 1000 });

  test("a Claude agent without approval = never is warned about; with it, or with allow_unsafe_modes, it is not", () => {
    const l = layout();
    write(l.user, BYPASS);
    const one = warn(l, cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\n`));
    assert.equal(one.length, 1);
    assert.match(one[0]!, /^cc: sessions will be refused \(mode_not_enforced\): Claude defaults to bypassPermissions here \(permissions\.defaultMode in .*settings\.json\); set approval = "never" on this agent or change defaultMode$/);
    assert.ok(one[0]!.includes(l.user));
    assert.deepEqual(warn(l, cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\napproval = "never"\n`)), []);
    assert.deepEqual(warn(l, cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\n`, "allow_unsafe_modes = true")), []);
    assert.equal(warn(l, cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\napproval = "ask"\n`, "allow_unsafe_modes = true")).length, 1);
  });

  test("the claude-attach preset is checked too; Codex and custom agents are not", () => {
    const l = layout();
    write(l.user, BYPASS);
    const w = warn(l, cfg(l, `[[agents]]\nid = "att"\npreset = "claude-attach"\nroots = [ROOT]\n[[agents]]\nid = "cx"\npreset = "codex"\nroots = [ROOT]\n[[agents]]\nid = "mine"\ncommand = "x"\nask_mode = "a"\nroots = [ROOT]\n`));
    assert.deepEqual(w.map((s) => s.split(":")[0]), ["att"]);
  });

  test("the agent's own [agents.env] CLAUDE_CONFIG_DIR is the one read", () => {
    const l = layout();
    const other = path.join(l.base, "other");
    write(path.join(other, "settings.json"), BYPASS);
    const c = cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\n[agents.env]\nCLAUDE_CONFIG_DIR = ${JSON.stringify(other)}\n`);
    assert.equal(warn(l, c).length, 1);
    write(l.user, BYPASS);
    const d = cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\n[agents.env]\nCLAUDE_CONFIG_DIR = ${JSON.stringify(path.join(l.base, "empty"))}\n`);
    assert.deepEqual(warn(l, d), []);
  });

  test("an unreadable settings file is said, per agent", () => {
    const l = layout();
    write(l.user, "nope");
    const w = warn(l, cfg(l, `[[agents]]\nid = "cc"\npreset = "claude"\nroots = [ROOT]\n`));
    assert.deepEqual(w, [`cc: cannot tell whether Claude defaults to bypassPermissions: ${l.user} is not readable JSON`]);
  });
});

describe("status and run say it", () => {
  const setup = (approval = "") => {
    const l = layout();
    const home = path.join(l.base, "cc-home");
    write(path.join(home, "config", "agents.toml"), `[[agents]]\nid = "claude"\npreset = "claude"\nroots = [${JSON.stringify(l.work)}]\n${approval}`);
    write(l.user, BYPASS);
    const out: string[] = [];
    const err: string[] = [];
    const c: Ctx = {
      dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: l.claude },
      out: (s) => out.push(s), err: (s) => err.push(s), hostname: "box", claudeManagedSettings: l.managed, euid: 1000,
    };
    return { l, home, c, out, err };
  };

  test("status prints a warning line and lists it in --json", async () => {
    const t = setup();
    await main(["status"], t.c);
    assert.match(t.out.join("\n"), /\nwarning:    claude: sessions will be refused \(mode_not_enforced\)/);
    const j = setup();
    await main(["status", "--json"], j.c);
    assert.equal(JSON.parse(j.out.join("\n")).warnings.length, 1);
    const n = setup(`approval = "never"\n`);
    await main(["status", "--json"], n.c);
    assert.deepEqual(JSON.parse(n.out.join("\n")).warnings, []);
  });

  test("run prints it right after the line that names the agents", async () => {
    const claw = await FakeClaw.start();
    let connector: any;
    let running: Promise<number> | undefined;
    try {
      const t = setup();
      claw.tokens.add("good-token");
      await main(["login", "--server", claw.url, "--key", "good-token"], { ...t.c, out: () => {}, err: () => {} });
      running = main(["run"], { ...t.c, onConnector: (cn) => { connector = cn; }, timing: { heartbeatMs: 150, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 100 } });
      await claw.until("online", () => claw.online);
      const i = t.out.findIndex((s) => s.startsWith("connecting claude to "));
      assert.ok(i >= 0, t.out.join("\n"));
      assert.match(t.out[i + 1] ?? "", /^warning: claude: sessions will be refused \(mode_not_enforced\)/);
    } finally {
      connector?.stop();
      await running;
      await claw.close();
    }
  });
});
