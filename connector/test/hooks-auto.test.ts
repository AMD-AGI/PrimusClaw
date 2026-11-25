// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector keeping the Claude Code hooks in place by itself (hooks-auto.ts, commands.ts `ensureClaudeHooks`): every start
 * of `run` adds the session and approval hooks to each Claude config directory it serves, pointing at the program running now,
 * without asking and with one line in its log; an explicit no (`hooks uninstall`, `--no-hooks`, `--no-approval-hooks`, a "no"
 * to the old one-time question) is kept across starts and upgrades. Only entries of ours change, the file is backed up once,
 * and writers running at the same time do not lose each other's entries.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { approvalSocketFile } from "../src/approvals.js";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { approvalHooksStatus, BACKUP_PREFIX, hooksStatus, installApprovalHooks, installHooks, settingsFile } from "../src/hooks.js";
import { hookPrefsFile, legacyOfferFile } from "../src/hooks-auto.js";
import { resolveDirs } from "../src/paths.js";
import { writeUpgradeState, readUpgradeState } from "../src/auto-upgrade.js";
import { VERSION } from "../src/version.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const stand = (name: string, where = tmpdir("cc-hookbin-")): string => { const f = path.join(where, name); fs.writeFileSync(f, "// stand-in\n"); return f; };
const commandsOf = (dir: string): string[] => {
  const doc = JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
  return Object.values<any>(doc.hooks ?? {}).flatMap((groups) => groups.flatMap((g: any) => g.hooks.map((h: any) => h.command as string)));
};
const ours = (dir: string) => commandsOf(dir).filter((c) => c.endsWith("--managed-by claw-connector"));
const MINE = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }], PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } };

/** A home with agents.toml, a sign-in for the stand-in Claw, and a Claude config directory (made unless `noDir`). */
function home(claw: FakeClaw, o: { noDir?: boolean } = {}) {
  const h = tmpdir();
  const work = tmpdir("w-");
  const cfgDir = path.join(h, "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "agents.toml"), `[[agents]]
id = "fake"
command = ${JSON.stringify(NODE)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
roots = [${JSON.stringify(work)}]
`);
  fs.writeFileSync(path.join(cfgDir, "credentials.json"), JSON.stringify({ v: 1, server: claw.url, kind: "key", key: "good-token", saved_at: "" }), { mode: 0o600 });
  const dir = path.join(h, "claude-config");
  if (!o.noDir) fs.mkdirSync(dir, { recursive: true });
  const bin = tmpdir("cc-hookbin-");
  const scripts = { hookScript: stand("terminal-hook.js", bin), approvalHookScript: stand("approval-hook.js", bin) };
  const mk = (extra: Partial<Ctx> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const c: Ctx = {
      dirs: resolveDirs({ CLAW_CONNECTOR_HOME: h } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: dir, PATH: "/nonexistent" },
      out: (l) => out.push(l), err: (l) => err.push(l), hostname: "box", node: NODE, ...scripts, ...extra,
    };
    return { c, text: () => out.join("\n"), errText: () => err.join("\n") };
  };
  return { home: h, dir, scripts, mk };
}

/** One start of the connector: `run` until it is online, then stopped; what it printed. */
async function start(claw: FakeClaw, a: ReturnType<ReturnType<typeof home>["mk"]>): Promise<string> {
  let connector: any;
  const n = claw.heartbeats.length;
  const running = main(["run"], { ...a.c, timing: { heartbeatMs: 100, pausePollMs: 40 }, onConnector: (cn) => { connector = cn; } });
  try {
    await claw.until("online", () => claw.heartbeats.length > n);
  } finally {
    connector?.stop();
    assert.equal(await running, EXIT.ok, a.errText());
  }
  return a.text();
}

describe("the connector keeps the Claude Code hooks in place by itself", () => {
  test("a start adds both sets to a Claude config directory that has none, pointing at this program; the next start changes nothing and says nothing", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      const a = s.mk();
      const said = await start(claw, a);
      assert.equal(hooksStatus(s.dir).installed, true);
      assert.equal(approvalHooksStatus(s.dir).installed, true);
      assert.ok(ours(s.dir).every((c) => c.startsWith(`'${NODE}' '${path.dirname(s.scripts.hookScript)}/`)), "this node and this install's scripts");
      assert.ok(ours(s.dir).filter((c) => c.includes("approval-hook.js")).every((c) => c.includes(approvalSocketFile(a.c.dirs.state))));
      const lines = said.split("\n").filter((l) => l.startsWith("Claude Code hooks:"));
      assert.equal(lines.length, 1, "one line in the log");
      assert.match(lines[0]!, /settings\.json: session hooks added, approval hooks added$/);
      assert.doesNotMatch(said, /claw-connector hooks install/, "no command to run is shown");
      assert.deepEqual(fs.readdirSync(s.dir).filter((n) => n.startsWith(BACKUP_PREFIX)), [], "nothing to back up in a new file");
      const bytes = fs.readFileSync(settingsFile(s.dir), "utf8");
      const again = await start(claw, s.mk());
      assert.doesNotMatch(again, /Claude Code hooks:/);
      assert.equal(fs.readFileSync(settingsFile(s.dir), "utf8"), bytes, "byte for byte");
    } finally { await claw.close(); }
  });

  test("a setup with the session hooks only gets the approval hooks; nothing else in the file changes, and it is backed up once", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      fs.writeFileSync(settingsFile(s.dir), JSON.stringify(MINE, null, 2));
      installHooks(s.dir, NODE, s.scripts.hookScript);
      // As an older connector left it: no backup of ours yet.
      for (const n of fs.readdirSync(s.dir)) if (n.startsWith(BACKUP_PREFIX)) fs.rmSync(path.join(s.dir, n));
      const before = fs.readFileSync(settingsFile(s.dir), "utf8");
      const said = await start(claw, s.mk());
      assert.match(said, /Claude Code hooks: .*settings\.json: approval hooks added$/m);
      assert.equal(approvalHooksStatus(s.dir).installed, true);
      const doc = JSON.parse(fs.readFileSync(settingsFile(s.dir), "utf8"));
      assert.equal(doc.model, "opus");
      assert.deepEqual(doc.hooks.Stop[0], MINE.hooks.Stop[0], "the user's Stop hook, as it was");
      assert.deepEqual(doc.hooks.PermissionRequest[0], MINE.hooks.PermissionRequest[0], "the user's PermissionRequest hook, matcher and all");
      assert.equal(commandsOf(s.dir).filter((c) => !c.endsWith("--managed-by claw-connector")).length, 2);
      const backups = fs.readdirSync(s.dir).filter((n) => n.startsWith(BACKUP_PREFIX));
      assert.equal(backups.length, 1);
      assert.match(backups[0]!, /^settings\.json\.bak-claw-\d{8}T\d{6}Z$/);
      assert.equal(fs.readFileSync(path.join(s.dir, backups[0]!), "utf8"), before, "the file as it was before the first change");
      assert.equal(fs.statSync(path.join(s.dir, backups[0]!)).mode & 0o777, 0o600);
      // A later change (another node) is not backed up again.
      const other = s.mk({ node: stand("node") });
      await start(claw, other);
      assert.equal(fs.readdirSync(s.dir).filter((n) => n.startsWith(BACKUP_PREFIX)).length, 1);
    } finally { await claw.close(); }
  });

  test("entries that name a node or scripts that moved (an upgrade, another node) are rewritten to this program", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      const old = tmpdir("old-install-");
      const oldNode = stand("node", old);
      const oldHook = stand("terminal-hook.js", old);
      installHooks(s.dir, oldNode, oldHook);
      fs.rmSync(old, { recursive: true });
      assert.equal(hooksStatus(s.dir).healthy, false);
      const said = await start(claw, s.mk());
      assert.match(said, /session hooks updated, approval hooks added/);
      assert.equal(hooksStatus(s.dir).healthy, true);
      assert.ok(!ours(s.dir).some((c) => c.includes(old)), "nothing names the old install");
      assert.equal(ours(s.dir).filter((c) => c.includes("terminal-hook.js")).length, 2, "rewritten in place, not added beside");
    } finally { await claw.close(); }
  });

  test("hooks uninstall --approvals is kept: no later start or upgrade adds them back; hooks install --approvals takes it back", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      await start(claw, s.mk());
      const u = s.mk();
      assert.equal(await main(["hooks", "uninstall", "--approvals"], u.c), EXIT.ok);
      assert.equal(approvalHooksStatus(s.dir).events.length, 0);
      assert.equal(JSON.parse(fs.readFileSync(hookPrefsFile(u.c.dirs), "utf8")).dirs[s.dir].approvals, "off");
      await start(claw, s.mk());
      await start(claw, s.mk());
      // The first run of a version this connector upgraded itself to, from another install.
      writeUpgradeState(u.c.dirs, { ...readUpgradeState(u.c.dirs), setup_pending: VERSION });
      const bin = tmpdir("new-install-");
      const upgraded = await start(claw, s.mk({ node: stand("node", bin), hookScript: stand("terminal-hook.js", bin), approvalHookScript: stand("approval-hook.js", bin) }));
      assert.match(upgraded, /session hooks updated$/m, "the session hooks follow the new install");
      assert.equal(approvalHooksStatus(s.dir).events.length, 0, "the approval hooks stay out");
      assert.equal(hooksStatus(s.dir).installed, true);
      const i = s.mk();
      assert.equal(await main(["hooks", "install", "--approvals"], i.c), EXIT.ok);
      assert.equal(approvalHooksStatus(s.dir).installed, true);
      assert.equal(await main(["hooks", "uninstall", "--approvals"], s.mk().c), EXIT.ok);
      const plain = s.mk();
      assert.equal(await main(["hooks", "install"], plain.c), EXIT.ok);
      assert.match(plain.text(), /the approval hooks stay out of .*, as you chose/);
      assert.equal(approvalHooksStatus(s.dir).events.length, 0, "hooks install without --approvals keeps that choice");
    } finally { await claw.close(); }
  });

  test("hooks uninstall, init --no-hooks and init --no-approval-hooks are kept across starts; init --hooks takes them back", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      await start(claw, s.mk());
      assert.equal(await main(["hooks", "uninstall"], s.mk().c), EXIT.ok);
      assert.equal(ours(s.dir).length, 0);
      assert.doesNotMatch(await start(claw, s.mk()), /Claude Code hooks:/);
      assert.equal(ours(s.dir).length, 0, "neither set comes back");

      const n = home(claw);
      const init = n.mk();
      assert.equal(await main(["init", "--no-hooks", "--no-probe"], init.c), EXIT.ok);
      assert.doesNotMatch(init.text(), /hooks install/);
      await start(claw, n.mk());
      assert.equal(fs.existsSync(settingsFile(n.dir)), false, "nothing written");

      const na = home(claw);
      assert.equal(await main(["init", "--no-approval-hooks", "--no-probe"], na.mk().c), EXIT.ok);
      await start(claw, na.mk());
      assert.equal(hooksStatus(na.dir).installed, true);
      assert.equal(approvalHooksStatus(na.dir).events.length, 0);
      assert.equal(await main(["init", "--hooks", "--no-probe"], na.mk().c), EXIT.ok);
      assert.equal(approvalHooksStatus(na.dir).installed, true, "--hooks takes the no back");

      // A no for every directory, said after a yes for one directory, wins there too.
      const later = home(claw);
      assert.equal(await main(["hooks", "install", "--approvals", "--config-dir", later.dir], later.mk().c), EXIT.ok);
      fs.writeFileSync(settingsFile(later.dir), "{}"); // taken out by hand
      assert.equal(await main(["init", "--no-hooks", "--no-probe"], later.mk().c), EXIT.ok);
      await start(claw, later.mk());
      assert.equal(ours(later.dir).length, 0, "the earlier yes for the directory does not bring them back");
    } finally { await claw.close(); }
  });

  test("a no to the one-time question of older versions is kept; CLAW_APPROVAL_HOOKS=off adds no approval hooks; no directory and no Claude Code: nothing is made", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      const dirs = s.mk().c.dirs;
      fs.mkdirSync(dirs.state, { recursive: true });
      fs.writeFileSync(legacyOfferFile(dirs), JSON.stringify({ v: 1, answered: { [s.dir]: { answer: "no", at: "2026-11-01T00:00:00Z" } } }));
      await start(claw, s.mk());
      assert.equal(hooksStatus(s.dir).installed, true);
      assert.equal(approvalHooksStatus(s.dir).events.length, 0);

      const e = home(claw);
      await start(claw, e.mk({ env: { CLAUDE_CONFIG_DIR: e.dir, PATH: "/nonexistent", CLAW_APPROVAL_HOOKS: "off" } }));
      assert.equal(hooksStatus(e.dir).installed, true);
      assert.equal(approvalHooksStatus(e.dir).events.length, 0);

      const none = home(claw, { noDir: true });
      assert.doesNotMatch(await start(claw, none.mk()), /Claude Code hooks:/);
      assert.equal(fs.existsSync(none.dir), false);
      // Claude Code installed but not run yet: its directory is made with the hooks in it.
      const bin = tmpdir("claude-bin-");
      fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
      await start(claw, none.mk({ env: { CLAUDE_CONFIG_DIR: none.dir, PATH: bin } }));
      assert.equal(approvalHooksStatus(none.dir).installed, true);
    } finally { await claw.close(); }
  });

  test("a settings file that cannot be merged into is left alone; the run still starts and says why in one line", async () => {
    const claw = await FakeClaw.start();
    try {
      const s = home(claw);
      fs.writeFileSync(settingsFile(s.dir), "{ not json");
      const said = await start(claw, s.mk());
      assert.match(said, /Claude Code hooks: .*not valid JSON/);
      assert.equal(fs.readFileSync(settingsFile(s.dir), "utf8"), "{ not json");
    } finally { await claw.close(); }
  });
});

describe("writers at the same time", () => {
  /** A process that installs both sets with its own node path and socket, as another connector (or `init`) would. */
  const writer = (dir: string, i: number, scripts: { hookScript: string; approvalHookScript: string }) => new Promise<number>((resolve) => {
    const code = `
      import { installHooks, installApprovalHooks } from ${JSON.stringify(path.join(here, "..", "src", "hooks.ts"))};
      for (let k = 0; k < 20; k++) {
        installHooks(${JSON.stringify(dir)}, ${JSON.stringify(NODE)}, ${JSON.stringify(scripts.hookScript)});
        installApprovalHooks(${JSON.stringify(dir)}, ${JSON.stringify(NODE)}, ${JSON.stringify(scripts.approvalHookScript)}, "/sock-${i}-" + k);
      }`;
    const p = spawn(NODE, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.join(here, ".."), stdio: ["ignore", "ignore", "inherit"] });
    p.on("exit", (c) => resolve(c ?? 1));
  });

  test("six writers at once: valid JSON, one entry of ours per event, the user's own entries kept, no temp or lock file left", async () => {
    const dir = tmpdir("cc-race-");
    fs.writeFileSync(settingsFile(dir), JSON.stringify(MINE, null, 2));
    const bin = tmpdir("cc-hookbin-");
    const scripts = { hookScript: stand("terminal-hook.js", bin), approvalHookScript: stand("approval-hook.js", bin) };
    const codes = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => writer(dir, i, scripts)));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    const doc = JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
    assert.equal(doc.model, "opus");
    assert.ok(commandsOf(dir).includes("mine.sh") && commandsOf(dir).includes("guard.sh"));
    assert.equal(hooksStatus(dir).installed, true);
    assert.equal(approvalHooksStatus(dir).installed, true);
    for (const [event, groups] of Object.entries<any>(doc.hooks)) {
      const mine = groups.flatMap((g: any) => g.hooks).filter((h: any) => String(h.command).endsWith("--managed-by claw-connector"));
      assert.equal(mine.length, event === "SessionEnd" ? 2 : 1, event); // SessionEnd: the session hook and the approval hook
    }
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "settings.json" && !n.startsWith(BACKUP_PREFIX)), [], "no temp or lock file left");
  });

  test("a writer waits for the lock another writer holds, and writes on top of what that one wrote", async () => {
    const dir = tmpdir("cc-wait-");
    fs.writeFileSync(settingsFile(dir), JSON.stringify(MINE, null, 2));
    const bin = tmpdir("cc-hookbin-");
    const scripts = { hookScript: stand("terminal-hook.js", bin), approvalHookScript: stand("approval-hook.js", bin) };
    const lock = `${settingsFile(dir)}.claw-connector.lock`;
    fs.writeFileSync(lock, String(process.pid));
    const code = `
      import { installApprovalHooks } from ${JSON.stringify(path.join(here, "..", "src", "hooks.ts"))};
      installApprovalHooks(${JSON.stringify(dir)}, ${JSON.stringify(NODE)}, ${JSON.stringify(scripts.approvalHookScript)}, "/s.sock");
      process.stdout.write(String(Date.now()));`;
    let finished = "";
    const child = spawn(NODE, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
    child.stdout!.on("data", (b) => { finished += String(b); });
    const exited = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    await new Promise((r) => setTimeout(r, 2500));
    // What the lock holder writes meanwhile: the other writer must not lose it.
    const doc = JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
    doc.written_under_lock = true;
    fs.writeFileSync(settingsFile(dir), JSON.stringify(doc, null, 2));
    const released = Date.now();
    fs.rmSync(lock);
    assert.equal(await exited, 0);
    assert.ok(Number(finished) >= released, "it wrote only after the lock was released");
    const after = JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
    assert.equal(after.written_under_lock, true);
    assert.equal(approvalHooksStatus(dir).installed, true);
  });

  test("an uninstall waits for a start that is writing the hooks right now, and takes them out after it; a start asks for the choice again under the lock", async () => {
    const dir = tmpdir("cc-uninstall-race-");
    fs.writeFileSync(settingsFile(dir), JSON.stringify(MINE, null, 2));
    const approvalScript = stand("approval-hook.js");
    const lock = `${settingsFile(dir)}.claw-connector.lock`;
    fs.writeFileSync(lock, String(process.pid)); // a start that holds the lock and has decided to install
    const code = `
      import { uninstallApprovalHooks } from ${JSON.stringify(path.join(here, "..", "src", "hooks.ts"))};
      uninstallApprovalHooks(${JSON.stringify(dir)});`;
    const child = spawn(NODE, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.join(here, ".."), stdio: ["ignore", "ignore", "inherit"] });
    const exited = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    await new Promise((r) => setTimeout(r, 2500));
    // What that start writes before it lets go of the lock (made beside, so the lock stays held throughout).
    const beside = tmpdir("cc-beside-");
    fs.copyFileSync(settingsFile(dir), settingsFile(beside));
    installApprovalHooks(beside, NODE, approvalScript, "/s.sock");
    fs.writeFileSync(settingsFile(dir), fs.readFileSync(settingsFile(beside), "utf8").replaceAll(`'${beside}'`, `'${dir}'`));
    assert.equal(approvalHooksStatus(dir).installed, true);
    fs.rmSync(lock);
    assert.equal(await exited, 0);
    assert.equal(approvalHooksStatus(dir).events.length, 0, "the uninstall wins");
    assert.ok(commandsOf(dir).includes("guard.sh"));
    // A start whose choice turned to no while it waited for the lock writes nothing.
    assert.equal(installApprovalHooks(dir, NODE, approvalScript, "/s.sock", () => false).changed, false);
    assert.equal(approvalHooksStatus(dir).events.length, 0);
  });

  test("a lock left by a writer that died is taken over", () => {
    const dir = tmpdir("cc-lock-");
    const lock = `${settingsFile(dir)}.claw-connector.lock`;
    fs.writeFileSync(lock, "99999999");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    installHooks(dir, NODE, stand("terminal-hook.js"));
    assert.equal(hooksStatus(dir).installed, true);
    assert.equal(fs.existsSync(lock), false);
  });
});
